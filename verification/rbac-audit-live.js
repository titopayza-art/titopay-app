"use strict";

/* A ROLE CHANGE THAT SAVED AND THEN REPORTED FAILURE.
 *
 * audit_logs.entity_id is a uuid column. PUT /v1/admin/roles/:role passed the
 * role NAME into it, so Postgres rejected the audit insert -- after the new
 * permissions had already been written to platform_settings. A Super Admin
 * changing what a role may do saw a server error, the change stood, and nothing
 * was logged. This is the same defect that was found in the security content
 * save, one route away from it, and it was found by looking for a second
 * instance after the first.
 *
 * The fix is in writeAuditLog rather than only at the two call sites: a
 * non-UUID identifier now travels in the metadata as entityKey instead of
 * costing the whole audit record. This proves the route, the log and the guard.
 *
 * Run: node verification/rbac-audit-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src/db/pool.js"));
const { signAccessToken } = require(path.join(API, "src/lib/jwt.js"));
const { splitEntityId } = require(path.join(API, "src/services/audit-service.js"));
let pass = 0; const ok = (m) => { pass++; console.log("  PASS  " + m); };
(async () => {
  const { app } = require(path.join(API, "src/app.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminId = crypto.randomUUID(), sessionId = crypto.randomUUID(), jti = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);

  /* THIS HARNESS EDITS A ROLE EVERY OTHER HARNESS DEPENDS ON.
   *
   * admin_role_permission_overrides is one shared row, and "coo" is the role
   * the ticketing and campaign harnesses sign in as. An earlier draft restored
   * it at the end of the try block, so the one run that failed an assertion
   * left coo holding security+engineering and nothing else. Two unrelated
   * harnesses then failed with 403 and a crash, and the cause was three files
   * away. The prior value is captured before anything can throw and put back in
   * the finally, which runs whatever happens. */
  const priorOverrides = await pool.query(
    "SELECT value FROM platform_settings WHERE key='admin_role_permission_overrides'");

  try {
    // The unit of the fix, exercised directly.
    assert.deepEqual(splitEntityId("coo", { permissions: ["a"] }),
      { id: null, metadata: { permissions: ["a"], entityKey: "coo" } });
    const uuid = crypto.randomUUID();
    assert.deepEqual(splitEntityId(uuid, { x: 1 }), { id: uuid, metadata: { x: 1 } });
    assert.deepEqual(splitEntityId(null, { x: 1 }), { id: null, metadata: { x: 1 } });
    assert.deepEqual(splitEntityId("", {}), { id: null, metadata: {} });
    ok("splitEntityId keeps UUIDs in the column and moves a slug to the metadata");

    await pool.query(
      `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
       VALUES ($1,'RBAC Audit Harness',$2,$3,'super_admin','x','active')`,
      [adminId, `rbac_${suffix}`, `rbac-${suffix}@example.test`]);
    await pool.query(
      `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
       VALUES ($1,'admin',$2,'admin','x',$3, NOW() + INTERVAL '1 hour')`, [sessionId, adminId, jti]);
    const headers = { "Content-Type": "application/json",
      Authorization: `Bearer ${signAccessToken({ sub: adminId, sid: sessionId, jti, typ: "admin" })}` };

    // The route that answered 500 over a change it had already made.
    const res = await fetch(`${base}/v1/admin/roles/coo`, {
      method: "PUT", headers, body: JSON.stringify({ permissions: ["security", "engineering"] }) });
    const text = await res.text();
    assert.equal(res.status, 200, `PUT /v1/admin/roles/coo answered ${res.status}: ${text}`);
    ok("PUT /v1/admin/roles/coo answers 200 instead of 500");

    const { rows } = await pool.query(
      `SELECT entity_id, metadata FROM audit_logs
        WHERE action='admin_role_permissions_updated' AND actor_id=$1 ORDER BY created_at DESC LIMIT 1`, [adminId]);
    assert.equal(rows.length, 1, "the role change is in the audit log at all");
    assert.equal(rows[0].entity_id, null, "no slug was forced into the uuid column");
    assert.equal(rows[0].metadata.role, "coo", "the log says WHICH role changed");
    assert.deepEqual(rows[0].metadata.permissions, ["security", "engineering"], "and what it changed to");
    ok("the change is logged, with the role named and its new permissions");

    console.log(`\n  ${pass}/${pass} RBAC audit checks passed\n`);
  } finally {
    const tidy = async (q, p) => { try { await pool.query(q, p); } catch (e) { console.error("  cleanup: " + e.message); } };
    if (priorOverrides.rows[0]) {
      await tidy("UPDATE platform_settings SET value=$1::JSONB WHERE key='admin_role_permission_overrides'",
        [JSON.stringify(priorOverrides.rows[0].value)]);
    } else {
      await tidy("DELETE FROM platform_settings WHERE key='admin_role_permission_overrides'");
    }
    await tidy("DELETE FROM audit_logs WHERE actor_id=$1", [adminId]);
    await tidy("DELETE FROM sessions WHERE id=$1", [sessionId]);
    await tidy("DELETE FROM admin_users WHERE id=$1", [adminId]);
    server.close(); await pool.end();
  }
})().catch((e) => { console.error("\n  FAIL  " + e.message); process.exit(1); });
