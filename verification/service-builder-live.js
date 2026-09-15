"use strict";

/* SERVICE BUILDER API STORAGE, PROVEN OVER REAL HTTP.
 *
 * The console stores service definitions in the browser until
 * GET /admin/service-builder/services answers with a services array, then
 * switches to API storage on its own. This harness boots the real Express
 * app against the sandbox database and proves:
 *
 *   1. An admin with the "services" permission (engineering) can save a
 *      definition, list it back, and delete it — the exact contract the
 *      console module speaks (POST {service}, GET {services}, DELETE /:id).
 *   2. A realistic large definition (2.5MB — four branding images as data
 *      URIs) is accepted: the scoped parser works.
 *   3. The global 768kb JSON ceiling still stands on every other path — a
 *      2.5MB POST to a different admin endpoint is refused with 413.
 *   4. An admin whose role does NOT hold "services" (coo) is refused with
 *      403 on all three verbs. Storage moved server-side; access did not
 *      widen.
 *
 * Run: node verification/service-builder-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));

let passed = 0;
const TOTAL = 6;
function ok(label) { passed++; console.log(`  PASS  ${label}`); }

async function seedAdmin(role) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const accessJti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1, 'SB Harness Admin', $2, $3, $4, 'x', 'active')`,
    [adminId, `sb_${role}_${suffix}`, `sb-${role}-${suffix}@example.test`, role]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1, 'admin', $2, 'admin', 'x', $3, NOW() + INTERVAL '1 hour')`,
    [sessionId, adminId, accessJti]
  );
  const token = signAccessToken({ sub: adminId, sid: sessionId, jti: accessJti, typ: "admin" });
  return { adminId, sessionId, token };
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const engineering = await seedAdmin("engineering");
  const coo = await seedAdmin("coo");
  const id = `svc_harness_${Date.now().toString(36)}`;

  const call = (token, apiPath, options = {}) => fetch(`${base}${apiPath}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  try {
    // Four "images" totalling ~2.4MB of base64-looking padding: the realistic
    // worst case the console can produce.
    const fakeImage = `data:image/png;base64,${"A".repeat(600 * 1024)}`;
    const service = {
      sbVersion: 1, id, name: "Harness Airtime Service", status: "draft",
      branding: { icon: { dataUri: fakeImage }, banner: { dataUri: fakeImage }, thumbnail: { dataUri: fakeImage }, feature: { dataUri: fakeImage } }
    };

    const saved = await call(engineering.token, "/v1/admin/service-builder/services", { method: "POST", body: { service } });
    assert.equal(saved.status, 200, `save must succeed, got ${saved.status}`);
    ok("engineering admin saves a 2.5MB definition (four branding images) — the scoped parser accepts it");

    const list = await call(engineering.token, "/v1/admin/service-builder/services");
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.ok(Array.isArray(body.services), "GET must answer with a services array — that is what flips the console to API mode");
    const mine = body.services.find((item) => item.id === id);
    assert.ok(mine, "the saved definition is in the list");
    assert.equal(mine.name, "Harness Airtime Service");
    ok("GET answers { services: [...] } and carries the saved definition — the console switches to API storage on this shape");

    const big = await call(engineering.token, "/v1/admin/announcements", { method: "POST", body: { padding: "A".repeat(1024 * 1024) } });
    assert.equal(big.status, 413, `a 1MB body on another admin path must still be refused, got ${big.status}`);
    ok("a 1MB POST to a different admin endpoint still gets 413 — the global 768kb ceiling did not loosen");

    for (const [verb, apiPath, options] of [
      ["GET", "/v1/admin/service-builder/services", {}],
      ["POST", "/v1/admin/service-builder/services", { method: "POST", body: { service: { id, name: "x" } } }],
      ["DELETE", `/v1/admin/service-builder/services/${id}`, { method: "DELETE" }]
    ]) {
      const refused = await call(coo.token, apiPath, options);
      assert.equal(refused.status, 403, `coo lacks "services" and must get 403 on ${verb}, got ${refused.status}`);
    }
    ok("an admin without the services permission (coo) is refused on all three verbs");

    const gone = await call(engineering.token, `/v1/admin/service-builder/services/${id}`, { method: "DELETE" });
    assert.equal(gone.status, 200);
    const after = await (await call(engineering.token, "/v1/admin/service-builder/services")).json();
    assert.equal(after.services.find((item) => item.id === id), undefined);
    ok("delete removes the definition and the list no longer carries it");

    const { rows } = await pool.query(
      "SELECT action FROM audit_logs WHERE entity_type = 'service_builder_definition' AND metadata->>'serviceId' = $1 ORDER BY created_at", [id]);
    const actions = rows.map((row) => row.action);
    assert.ok(actions.includes("service_builder_definition_saved"), "save is audit-logged");
    assert.ok(actions.includes("service_builder_definition_deleted"), "delete is audit-logged");
    ok("save and delete both landed in the audit log");

    console.log(`\n${passed}/${TOTAL} checks passed.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    await pool.query("DELETE FROM service_builder_definitions WHERE id = $1", [id]);
    for (const admin of [engineering, coo]) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [admin.sessionId]);
      await pool.query("DELETE FROM admin_users WHERE id = $1", [admin.adminId]);
    }
  }
})();
