"use strict";

/* THE SECURITY WARNING A CUSTOMER READS, END TO END.
 *
 * The unit tests call the normalisers directly. This boots the real API and
 * exercises the parts that only exist once the server is listening:
 *
 *   1. GET /v1/security-content answers a SIGNED-OUT visitor. The screens that
 *      carry this copy are reachable before anyone has an account, and the
 *      route sits behind mountVersionedRoutes ahead of the lookup routes, which
 *      put a requireAuth on the bare /v1 prefix. An earlier public endpoint was
 *      mounted beside the health routes and answered only on the unversioned
 *      path -- reachable by nothing the app ever calls.
 *   2. The unversioned path does NOT answer, so nobody can "fix" a future
 *      mounting mistake by pointing the app at it.
 *   3. An admin with the security permission saves new wording, and the very
 *      next public read serves it. Console and customer see one thing.
 *   4. A blank field comes back as the shipped default rather than an empty
 *      security card, through the database rather than in memory.
 *   5. An icon outside the allowlist is stored as "shield".
 *   6. The write is refused without the security permission, and the read is
 *      unaffected by that refusal.
 *   7. The admin read reports whether anything is stored and who stored it, so
 *      the console can tell an operator they are about to write the first
 *      version rather than revise a colleague's.
 *   8. The change is in the audit log WITH the wording, so "what did the app
 *      tell my customer that day" is answerable.
 *
 * Run: node verification/security-content-live.js
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
const {
  SECURITY_CONTENT_KEY,
  SECURITY_CONTENT_DEFAULTS
} = require(path.join(API, "src", "services", "security-content-service.js"));

let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };

async function seedAdmin(role, label) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'x', 'active')`,
    [adminId, label, `sec_${suffix}`, `sec-${suffix}@example.test`, role]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1, 'admin', $2, 'admin', 'x', $3, NOW() + INTERVAL '1 hour')`,
    [sessionId, adminId, jti]
  );
  return {
    adminId,
    sessionId,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signAccessToken({ sub: adminId, sid: sessionId, jti, typ: "admin" })}`
    }
  };
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const publicRead = async () => {
    const response = await fetch(`${base}/v1/security-content`);
    assert.equal(response.status, 200, `the public read answered ${response.status}`);
    const body = await response.json();
    assert.equal(body.ok, true);
    return body.content;
  };

  let owner = null;
  let clerk = null;
  const created = [];

  try {
    // Start from a platform that has never saved this setting.
    await pool.query("DELETE FROM platform_settings WHERE key = $1", [SECURITY_CONTENT_KEY]);

    // 1. A signed-out visitor is served the shipped copy.
    const anonymous = await publicRead();
    assert.equal(anonymous.cardBody, SECURITY_CONTENT_DEFAULTS.cardBody);
    assert.equal(anonymous.tips.length, SECURITY_CONTENT_DEFAULTS.tips.length);
    ok("GET /v1/security-content answers a visitor with no token, serving the shipped copy");

    // 2. The unversioned path is not a second front door.
    const unversioned = await fetch(`${base}/security-content`);
    assert.notEqual(unversioned.status, 200,
      "the bare /security-content path must not answer: the app only ever calls /v1");
    ok(`the unversioned /security-content path does not answer (${unversioned.status}), so the /v1 mount is the only one`);

    owner = await seedAdmin("owner", "Security Content Owner");
    clerk = await seedAdmin("support_agent", "Support Agent Without Security");
    created.push(owner, clerk);

    // 7a. Nothing stored yet: the console must be told so.
    const emptyRecord = await fetch(`${base}/v1/admin/security-content`, { headers: owner.headers });
    const emptyText = await emptyRecord.text();
    assert.equal(emptyRecord.status, 200, emptyText);
    const emptyBody = JSON.parse(emptyText);
    assert.equal(emptyBody.stored, false, "an unsaved platform reports stored:false");
    assert.equal(emptyBody.updatedAt, null);
    assert.equal(emptyBody.content.title, SECURITY_CONTENT_DEFAULTS.title);
    ok("the console is told nothing is stored yet, so it can say 'saving publishes the first version'");

    // 6. A write without the security permission is refused.
    const refused = await fetch(`${base}/v1/admin/security-content`, {
      method: "PUT",
      headers: clerk.headers,
      body: JSON.stringify({ content: { cardBody: "An agent should not be able to write this." } })
    });
    assert.equal(refused.status, 403, `expected 403, got ${refused.status}`);
    assert.equal((await publicRead()).cardBody, SECURITY_CONTENT_DEFAULTS.cardBody,
      "the refused write must not have landed");
    ok("an admin without the security permission is refused 403 and changes nothing");

    // 3, 4, 5. A real save, with one blank field and one impossible icon.
    const authored = {
      eyebrow: "Security Alert",
      title: "A scam is doing the rounds",
      cardHeading: "",
      cardBody: "TitoPay will never send you a link asking you to reconfirm your PIN. Delete the message and tell us.",
      acknowledgeLabel: "I understand",
      tipsEyebrow: "What to do right now",
      tips: [
        { title: "Do not tap the link", body: "Open TitoPay from your home screen instead.", icon: "ban" },
        { title: "Report it to us", body: "Send us the message from Support inside the app.", icon: "definitely-not-an-icon" }
      ]
    };
    const saved = await fetch(`${base}/v1/admin/security-content`, {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({ content: authored })
    });
    assert.equal(saved.status, 200, await saved.text());


    const served = await publicRead();
    assert.equal(served.cardBody, authored.cardBody, "the customer reads what the admin wrote");
    assert.equal(served.title, authored.title);
    ok("wording saved in the console is served on the very next public read");

    assert.equal(served.cardHeading, SECURITY_CONTENT_DEFAULTS.cardHeading,
      "a field saved blank must render the shipped default, never an empty card");
    ok("a field saved blank comes back as the shipped default, through the database");

    assert.equal(served.tips.length, 2);
    assert.equal(served.tips[0].icon, "ban", "a permitted icon survives the round trip");
    assert.equal(served.tips[1].icon, "shield", "an icon this app cannot draw is stored as a shield");
    ok("an unknown icon is stored as 'shield' rather than rejected or rendered broken");

    // 7b. Now it is stored, and by whom.
    const record = await (await fetch(`${base}/v1/admin/security-content`, { headers: owner.headers })).json();
    assert.equal(record.stored, true);
    assert.ok(record.updatedAt, "the console can show when it was last saved");
    assert.equal(record.updatedBy, "Security Content Owner", "and who saved it");
    ok("the console can tell stored copy from the shipped defaults, with the author and the date");

    // 8. The audit log carries the wording, not just the fact of a change.
    const { rows: audit } = await pool.query(
      `SELECT actor_id, entity_id, metadata FROM audit_logs
        WHERE action = 'security_content_updated' AND metadata->>'settingKey' = $1
        ORDER BY created_at DESC LIMIT 1`,
      [SECURITY_CONTENT_KEY]
    );
    assert.equal(audit.length, 1, "the change is in the audit log");
    assert.equal(audit[0].actor_id, owner.adminId);
    // entity_id is a UUID column. Writing the settings key into it made the
    // whole PUT answer 500 AFTER the copy had already been stored.
    assert.equal(audit[0].entity_id, null, "a platform setting has no UUID entity");
    assert.equal(audit[0].metadata.cardBody, authored.cardBody,
      "the log carries the wording, so what the app said that day is answerable");
    assert.equal(audit[0].metadata.tipCount, 2);
    ok("the audit log records who changed the security copy AND what it was changed to");

    // A malformed payload is refused rather than becoming the live warning.
    const malformed = await fetch(`${base}/v1/admin/security-content`, {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({ content: { cardBody: { toString: "nope" } } })
    });
    assert.equal(malformed.status, 400, `expected 400, got ${malformed.status}`);
    assert.equal((await publicRead()).cardBody, authored.cardBody,
      "the refused write left the live copy alone");
    ok("a payload whose body is not text is refused 400, never stored as '[object Object]'");

    console.log(`\n  ${passed}/${passed} security content checks passed\n`);
  } finally {
    await pool.query("DELETE FROM audit_logs WHERE action = 'security_content_updated'");
    await pool.query("DELETE FROM platform_settings WHERE key = $1", [SECURITY_CONTENT_KEY]);
    for (const admin of created) {
      if (!admin) continue;
      await pool.query("DELETE FROM sessions WHERE id = $1", [admin.sessionId]);
      await pool.query("DELETE FROM admin_users WHERE id = $1", [admin.adminId]);
    }
    server.close();
    await pool.end();
  }
})().catch((error) => {
  console.error("\n  FAIL  " + error.message);
  console.error(error.stack);
  process.exit(1);
});
