"use strict";
// THE ENDPOINT, THROUGH THE REAL ROUTER, WITH A REAL TOKEN.
//
// "The co-parent adding feature is not there" can mean three different things:
// the app is old, the server is old, or the route exists but does not answer.
// The service-level harness proves the logic; this proves the WIRE - that
// /v1/tito-kids/children/:id/managers is mounted, authenticated, and returns
// the shape the panel needs to draw an "Add a co-parent" button.
//
//   POSTGRES_URL=... node verification/titokids-http.js
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { app } = require("../api/src/app");
const { pool } = require("../api/src/db/pool");
const { signAccessToken } = require("../api/src/lib/jwt");
const kids = require("../api/src/services/titokids-service");

const TAG = "tkhttp";
const ids = { parent: randomUUID(), wallet: randomUUID(), co: randomUUID(), coWallet: randomUUID() };
let passed = 0;
const ok = (m) => { passed += 1; console.log("  ✓ " + m); };

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await pool.query(
      `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
       VALUES ($1,'personal','${TAG} Parent','${TAG}_parent','${TAG}_p@example.invalid','27110002201','x','active',FALSE,'approved'),
              ($2,'personal','${TAG} CoParent','${TAG}_co','${TAG}_c@example.invalid','27110002202','x','active',FALSE,'approved')`,
      [ids.parent, ids.co]);
    await pool.query(
      `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
       VALUES ($1,$2,$3,'personal','ZAR',100,0,'active'),($4,$5,$6,'personal','ZAR',100,0,'active')`,
      [ids.wallet, String(Date.now()).slice(-9), ids.parent, ids.coWallet, String(Date.now() + 5).slice(-9), ids.co]);

    // requireAuth checks a live session row, not just a signature — so seed one,
    // exactly as a real sign-in would.
    const sessionId = randomUUID();
    const accessJti = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
       VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
      [sessionId, ids.parent, accessJti]);
    const token = signAccessToken({ sub: ids.parent, sid: sessionId, jti: accessJti, typ: "customer" });
    const call = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      let payload = null;
      try { payload = await response.json(); } catch (error) { payload = null; }
      return { status: response.status, payload };
    };

    const child = await kids.addChild(ids.parent, { fullName: "Aiden", relationship: "parent" });

    const list = await call(`/v1/tito-kids/children/${child.id}/managers`);
    assert.equal(list.status, 200, `GET managers returned ${list.status} — the route is not mounted`);
    assert.equal(list.payload.isOwner, true, "the parent is reported as owner, which is what draws Add a co-parent");
    assert.deepEqual(list.payload.items, [], "no co-parents yet");
    ok("GET /v1/tito-kids/children/:id/managers answers 200 with isOwner true");

    const invite = await call(`/v1/tito-kids/children/${child.id}/managers`, {
      method: "POST", body: { contact: `@${TAG}_co` } });
    assert.equal(invite.status, 201, `POST managers returned ${invite.status}`);
    assert.equal(invite.payload.guardian.status, "invited");
    ok("POST invites a co-parent and returns the invitation");

    const invites = await call("/v1/tito-kids/invitations");
    assert.equal(invites.status, 200);
    ok("GET /v1/tito-kids/invitations answers 200");

    const after = await call(`/v1/tito-kids/children/${child.id}/managers`);
    assert.equal(after.payload.items.length, 1, "the invitation is listed against the child");
    ok("the invitation comes back on the child's manager list");

    console.log("\n" + "=".repeat(78));
    console.log(`  ALL ${passed} CHECKS PASSED — the co-parent endpoints are live on the wire.`);
    console.log("=".repeat(78) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1)", [[ids.parent, ids.co]]).catch(() => {});
    await pool.query("DELETE FROM titokids_guardians WHERE invited_by = ANY($1) OR user_id = ANY($1)", [[ids.parent, ids.co]]).catch(() => {});
    await pool.query("DELETE FROM titokids_children WHERE parent_user_id = $1", [ids.parent]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [[ids.parent, ids.co]]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id = ANY($1)", [[ids.parent, ids.co]]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.parent, ids.co]]).catch(() => {});
    server.close();
    await pool.end();
  }
})();
