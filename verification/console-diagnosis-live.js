"use strict";

/* THE DIAGNOSIS IS THE SAME ANSWER WHETHER YOU HAVE A SHELL OR NOT.
 *
 * The point of this change is not that an endpoint exists. It is that the tool
 * which names the real cause of a broken console page stopped requiring SSH,
 * and that the two ways of reaching it can never drift apart.
 *
 *  1. The endpoint answers, and it is super admin only.
 *  2. A non-super admin is refused, because the report carries real table
 *     names and real Postgres errors.
 *  3. The endpoint and the shared service return the same shape.
 *  4. It only READS. The save probes are attempted and always rolled back, so
 *     running it leaves no row behind.
 *  5. A genuinely missing table is detected, named, and attributed to the
 *     console page it breaks.
 *  6. A genuinely failing query is reported with the real Postgres message,
 *     which is exactly what the console hides from operators.
 *  7. It never throws, whatever it finds.
 *  8. Database Health asks the same question, from the same map.
 *
 * Run: node verification/console-diagnosis-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };
const admins = [];

async function seedAdmin(role) {
  const id = crypto.randomUUID();
  const session = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,$2,$3,$4,$5,'x','active')`,
    [id, `Diag ${role} ${TAG}`, `diag_${role}_${TAG}`, `diag_${role}_${TAG}@example.invalid`, role]);
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'admin',$2,'admin','x',$3, NOW() + INTERVAL '1 hour')`,
    [session, id, jti]);
  admins.push(id);
  return { id, token: signAccessToken({ sub: id, sid: session, jti, typ: "admin", role, scope: "admin" }) };
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const service = require(path.join(API, "src", "services", "console-diagnosis-service.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, apiPath) => {
    const response = await fetch(`${base}${apiPath}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  try {
    const superAdmin = await seedAdmin("super_admin");
    const support = await seedAdmin("customer_support");

    // 1 + 2. It answers for a super admin, and only for a super admin.
    const refused = await call(support.token, "/v1/admin/diagnostics/console");
    assert.equal(refused.status, 403, `a non-super admin is refused: ${JSON.stringify(refused.data)}`);
    const allowed = await call(superAdmin.token, "/v1/admin/diagnostics/console");
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    ok("the diagnosis answers a super admin and refuses everyone else");

    // 3. Endpoint and service agree, because they are the same code.
    const direct = await service.runConsoleDiagnosis({ actorId: superAdmin.id });
    const served = allowed.data.diagnosis;
    assert.deepEqual(Object.keys(served).sort(), Object.keys(direct).sort());
    assert.equal(served.apiBuild, direct.apiBuild);
    assert.deepEqual(served.pages.map((p) => p.page), direct.pages.map((p) => p.page));
    assert.deepEqual(served.writes.map((w) => w.what), direct.writes.map((w) => w.what));
    ok("the endpoint and the shell script read the same answer, from the same service");

    // 4. It leaves nothing behind. The save probes are real writes.
    assert.ok(served.writes.length >= 4, "the save buttons are actually attempted");
    const { rows: leftovers } = await pool.query(
      "SELECT key FROM platform_settings WHERE key LIKE '__diagnose_probe%'");
    assert.deepEqual(leftovers, [], "no probe row survives the rollback");
    const { rows: versionLeftovers } = await pool.query(
      "SELECT id FROM compliance_config_versions WHERE config_key = '__diagnose_probe'");
    assert.deepEqual(versionLeftovers, [], "and no probe configuration version either");
    const { rows: auditLeftovers } = await pool.query(
      "SELECT id FROM audit_logs WHERE action = 'diagnose_probe'");
    assert.deepEqual(auditLeftovers, [], "and no probe audit row either");
    ok("every save probe is attempted and rolled back, so running it changes nothing");

    // 5 + 6. A real fault is found, named, and attributed to a page. Proven by
    //        creating one rather than by trusting the code to notice.
    await pool.query("ALTER TABLE beneficiaries RENAME TO beneficiaries_diag_" + TAG);
    let broken;
    try {
      broken = await service.runConsoleDiagnosis({ actorId: superAdmin.id });
    } finally {
      await pool.query("ALTER TABLE beneficiaries_diag_" + TAG + " RENAME TO beneficiaries");
    }
    const brokenPage = broken.pages.find((page) => page.missing.includes("beneficiaries"));
    assert.ok(brokenPage, "a missing table is detected");
    assert.equal(brokenPage.page, "Beneficiaries", "and attributed to the page it breaks");
    assert.equal(broken.verdict.ok, false);
    assert.match(broken.verdict.headline, /missing tables/i);
    assert.match(broken.verdict.guidance, /db\/init\.js/);
    ok("a genuinely missing table is found, named, and attributed to the page it breaks");

    // The real Postgres message reaches the operator, which is precisely what
    // the console's own error handling strips out.
    await pool.query("ALTER TABLE compliance_flags RENAME TO compliance_flags_diag_" + TAG);
    let failing;
    try {
      failing = await service.runConsoleDiagnosis({ actorId: superAdmin.id });
    } finally {
      await pool.query("ALTER TABLE compliance_flags_diag_" + TAG + " RENAME TO compliance_flags");
    }
    const failed = failing.probes.find((probe) => !probe.ok);
    assert.ok(failed, "a failing query is reported rather than swallowed");
    assert.match(failed.error.message, /does not exist/i, "with the real database error");
    assert.equal(failed.error.code, "42P01", "and the Postgres error code");
    assert.equal(failed.page, "Compliance Dashboard", "against the page that will break");
    ok("a failing query carries the real Postgres error, which the console deliberately hides");

    // 7. Never throws. Confirmed by the two runs above, which both returned a
    //    report while the schema was deliberately broken underneath them.
    assert.equal(typeof broken.verdict.headline, "string");
    assert.equal(typeof failing.verdict.headline, "string");
    ok("a broken schema produces a report rather than an exception");

    // 8. Database Health asks the same question, and says what each table is for.
    const health = await call(superAdmin.token, "/v1/admin/module-health");
    assert.equal(health.status, 200);
    const required = new Set(Object.values(service.PAGE_TABLES).flat());
    assert.equal(health.data.tables.length, required.size,
      "Database Health checks exactly the diagnosis map, not a stale list of its own");
    assert.ok(health.data.tables.length > 40, `and that map is not fifteen tables (${health.data.tables.length})`);
    assert.equal(health.data.build, direct.apiBuild, "and reports the build the console is talking to");
    const attributed = health.data.tables.find((row) => row.table_name === "compliance_flags");
    assert.ok(attributed.pages.includes("Compliance Dashboard"),
      "each table says which page it stands behind");
    ok("Database Health checks the same map and says what each table is for");

    // The diagnosis carries the two facts that would have answered the live
    // maintenance failure without a shell.
    assert.ok(Array.isArray(direct.notes.platformSettingsColumns));
    assert.ok(direct.notes.platformSettingsColumns.includes("updated_by"));
    assert.ok(Number.isFinite(direct.notes.platformSettingsForeignKeys));
    assert.ok(direct.providers.some((p) => p.capability === "kyc"));
    ok("it reports the shape of platform_settings and which provider supplies which capability");

    console.log(`\n  ${passed}/8 console diagnosis checks passed. The answer no longer needs a shell.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    // Never leave a renamed table behind, whatever went wrong above.
    for (const table of ["beneficiaries", "compliance_flags"]) {
      await pool.query(`ALTER TABLE IF EXISTS ${table}_diag_${TAG} RENAME TO ${table}`).catch(() => {});
    }
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::UUID[])", [admins]).catch(() => {});
    await pool.query("DELETE FROM admin_users WHERE id = ANY($1::UUID[])", [admins]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
