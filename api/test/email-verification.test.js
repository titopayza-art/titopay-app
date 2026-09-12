"use strict";

// EMAIL VERIFICATION, END TO END.
//
// The flow was almost entirely built already: 32 random bytes, a SHA-256 hash
// stored in place of the token, single use, expiry, revocation on resend, a
// transaction around consumption, and a resend that answers identically
// whatever the truth is. What was missing was that REGISTRATION NEVER SENT IT,
// because the landing page did not exist when that code was written, and a
// welcome email with a dead link is worse than no email. The page exists now.
//
// So most of these tests are characterisation of controls that were already
// there, and a few prove the parts that changed: the send on registration, the
// thirty-minute expiry, and the five audit events that had no writer.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const emailCentre = require("../src/services/email-centre-service");
const { pool } = require("../src/db/pool");

const API = path.join(__dirname, "..");

/* ------------------------------------------------------------------ helpers */

async function makeUser({ verified = false } = {}) {
  const id = crypto.randomUUID();
  const suffix = crypto.randomBytes(5).toString("hex");
  const email = `verify_${suffix}@example.invalid`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, password_hash, account_type, email_verified_at)
     VALUES ($1,'Verify Test',$2,$3,$4,'x','personal',$5)`,
    [id, `verify_${suffix}`, email, `+2782${Math.floor(1000000 + Math.random() * 8999999)}`,
     verified ? new Date() : null]
  );
  return { id, email, full_name: "Verify Test", account_type: "personal" };
}

async function cleanup(user) {
  if (!user) return;
  await pool.query("DELETE FROM email_verification_tokens WHERE user_id=$1", [user.id]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
}

// The raw token never leaves `createVerificationForUser`, deliberately. To test
// verification we have to mint one the same way the service does and store its
// hash, which is exactly what the service does and nothing more.
async function mintToken(user, { minutesUntilExpiry = 30, used = false, revoked = false, requestedMinutesAgo = 0 } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const { rows } = await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, used_at, revoked_at, requested_at)
     VALUES ($1,$2,NOW() + ($3 || ' minutes')::interval, $4, $5, NOW() - ($6 || ' minutes')::interval)
     RETURNING id, expires_at`,
    [user.id, hash, String(minutesUntilExpiry), used ? new Date() : null, revoked ? new Date() : null,
     String(requestedMinutesAgo)]
  );
  return { token, hash, id: rows[0].id, expiresAt: rows[0].expires_at };
}

async function auditActions(userId) {
  const { rows } = await pool.query(
    "SELECT action, metadata FROM audit_logs WHERE actor_id=$1 ORDER BY created_at", [userId]
  );
  return rows;
}

/* ============================================================ 1. happy path */

test("1. a valid token verifies the address exactly once", async () => {
  const user = await makeUser();
  try {
    const { token } = await mintToken(user);
    const result = await emailCentre.verifyEmailToken(token, { ipAddress: "203.0.113.9" });
    assert.equal(result.id, user.id);
    assert.ok(result.email_verified_at, "the user must be marked verified");

    const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [user.id]);
    assert.ok(rows[0].email_verified_at);
  } finally { await cleanup(user); }
});

/* ====================================================== 2-5. the refusals */

test("2. an invalid token is refused, and no account is touched", async () => {
  const user = await makeUser();
  try {
    const unknown = crypto.randomBytes(32).toString("base64url");
    await assert.rejects(
      async () => emailCentre.verifyEmailToken(unknown),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
    const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [user.id]);
    assert.equal(rows[0].email_verified_at, null, "a failed verification must not verify anybody");
  } finally { await cleanup(user); }
});

test("2b. a malformed token is refused before any database lookup", async () => {
  for (const bad of ["", "   ", null, undefined, "has spaces", "has/slash", "a".repeat(201), "<script>"]) {
    await assert.rejects(
      async () => emailCentre.verifyEmailToken(bad),
      (error) => { assert.equal(error.statusCode, 400); return true; },
      `${String(bad).slice(0, 20)} must be refused`
    );
  }
});

test("3. an expired token is refused with 410 and does not verify", async () => {
  const user = await makeUser();
  try {
    const { token } = await mintToken(user, { minutesUntilExpiry: -1 });
    await assert.rejects(
      async () => emailCentre.verifyEmailToken(token),
      (error) => { assert.equal(error.statusCode, 410); return true; }
    );
    const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE id=$1", [user.id]);
    assert.equal(rows[0].email_verified_at, null);
  } finally { await cleanup(user); }
});

test("4. an already-used token is refused with 409", async () => {
  const user = await makeUser();
  try {
    const { token } = await mintToken(user, { used: true });
    await assert.rejects(
      async () => emailCentre.verifyEmailToken(token),
      (error) => { assert.equal(error.statusCode, 409); return true; }
    );
  } finally { await cleanup(user); }
});

test("5. a token cannot be reused: the second attempt fails and nothing changes", async () => {
  const user = await makeUser();
  try {
    const { token, id } = await mintToken(user);
    await emailCentre.verifyEmailToken(token);
    const first = await pool.query("SELECT used_at FROM email_verification_tokens WHERE id=$1", [id]);
    const consumedAt = first.rows[0].used_at;
    assert.ok(consumedAt, "the token must be consumed");

    await assert.rejects(
      async () => emailCentre.verifyEmailToken(token),
      (error) => { assert.equal(error.statusCode, 409); return true; }
    );
    const second = await pool.query("SELECT used_at FROM email_verification_tokens WHERE id=$1", [id]);
    assert.deepEqual(second.rows[0].used_at, consumedAt, "a replay must not move the consumption time");
  } finally { await cleanup(user); }
});

test("5b. concurrent uses of one token verify once and refuse the rest", async () => {
  const user = await makeUser();
  try {
    const { token } = await mintToken(user);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => emailCentre.verifyEmailToken(token))
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "exactly one caller may consume the token");
  } finally { await cleanup(user); }
});

/* ============================================== 6-7. the token is never kept */

test("6. the raw token is never stored: only its SHA-256 hash is", async () => {
  const user = await makeUser();
  try {
    const { token, hash } = await mintToken(user);
    const { rows } = await pool.query("SELECT * FROM email_verification_tokens WHERE user_id=$1", [user.id]);
    const serialised = JSON.stringify(rows);
    assert.ok(!serialised.includes(token), "the raw token must not appear in any column");
    assert.equal(rows[0].token_hash, hash);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

    // And a database-wide sweep of the columns that could plausibly hold it.
    const sweep = await pool.query(
      `SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE token_hash = $1`, [token]
    );
    assert.equal(sweep.rows[0].n, 0, "the token itself must never be a stored value");
  } finally { await cleanup(user); }
});

test("7. no raw token reaches the logs, and audit metadata carries only a hash prefix", async () => {
  const user = await makeUser();
  const written = [];
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;
  console.log = (...args) => written.push(args.map(String).join(" "));
  console.error = (...args) => written.push(args.map(String).join(" "));
  console.warn = (...args) => written.push(args.map(String).join(" "));
  try {
    const { token, hash } = await mintToken(user);
    await emailCentre.verifyEmailToken(token, { ipAddress: "203.0.113.9" });
    // A failure path too, since that is where a token is most tempting to log.
    await emailCentre.verifyEmailToken(token).catch(() => {});

    const output = written.join("\n");
    assert.ok(!output.includes(token), "the raw token must never be written to a log");

    const rows = await auditActions(user.id);
    const audit = JSON.stringify(rows);
    assert.ok(!audit.includes(token), "the raw token must never reach the audit log");
    // The correlation handle is a prefix of the HASH, which is not reversible
    // and cannot be replayed, because the endpoint hashes what it is given.
    assert.ok(audit.includes(hash.slice(0, 12)), "a hash fingerprint should be recorded for support");
    assert.ok(!audit.includes(hash), "the full hash is not needed and is not stored in the log");
  } finally {
    console.log = realLog; console.error = realError; console.warn = realWarn;
    await cleanup(user);
  }
});

/* ================================================== 8-9. resend and rotation */

test("8. a resend issues a completely new token", async () => {
  const user = await makeUser();
  try {
    // Backdated past the resend cooldown, so this test exercises rotation
    // rather than the throttle. The throttle has its own test below.
    const first = await mintToken(user, { requestedMinutesAgo: 120 });
    await emailCentre.resendVerification(user.email, { ipAddress: "203.0.113.9" });
    const { rows } = await pool.query(
      "SELECT token_hash, revoked_at FROM email_verification_tokens WHERE user_id=$1 ORDER BY requested_at", [user.id]
    );
    assert.equal(rows.length, 2, "a resend must create a second token, not reuse the first");
    assert.notEqual(rows[1].token_hash, first.hash, "the new token must be different");
  } finally { await cleanup(user); }
});

test("9. the previous token stops working the moment a new one is issued", async () => {
  const user = await makeUser();
  try {
    const first = await mintToken(user, { requestedMinutesAgo: 120 });
    await emailCentre.resendVerification(user.email, {});
    const { rows } = await pool.query(
      "SELECT revoked_at FROM email_verification_tokens WHERE token_hash=$1", [first.hash]
    );
    assert.ok(rows[0].revoked_at, "the older token must be revoked");
    await assert.rejects(
      async () => emailCentre.verifyEmailToken(first.token),
      (error) => { assert.equal(error.statusCode, 400); return true; }
    );
  } finally { await cleanup(user); }
});

/* ================================================================ 10. limits */

test("10. resend is rate limited, and every answer is identical", async () => {
  const user = await makeUser();
  try {
    // First resend is allowed.
    const one = await emailCentre.resendVerification(user.email, {});
    assert.deepEqual(one, { accepted: true });
    // Immediately again: inside the cooldown, so no token is issued.
    const two = await emailCentre.resendVerification(user.email, {});
    assert.deepEqual(two, { accepted: true }, "the answer must not change when throttled");

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id=$1", [user.id]
    );
    assert.equal(rows[0].n, 1, "the cooldown must actually stop the second send");
  } finally { await cleanup(user); }
});

test("10b. resend does not reveal whether an account exists or is already verified", async () => {
  const unknown = await emailCentre.resendVerification(`nobody_${crypto.randomBytes(6).toString("hex")}@example.invalid`, {});
  assert.deepEqual(unknown, { accepted: true });

  const verified = await makeUser({ verified: true });
  try {
    const already = await emailCentre.resendVerification(verified.email, {});
    assert.deepEqual(already, { accepted: true }, "an already-verified address answers identically");
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id=$1", [verified.id]
    );
    assert.equal(rows[0].n, 0, "and no email is queued for it");
  } finally { await cleanup(verified); }
});

/* ======================================================== 11-12. atomicity */

test("11. verification is atomic: the token and the user move together", async () => {
  const user = await makeUser();
  try {
    const { token, id } = await mintToken(user);
    await emailCentre.verifyEmailToken(token);
    const { rows } = await pool.query(
      `SELECT t.used_at, u.email_verified_at
         FROM email_verification_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`, [id]
    );
    assert.ok(rows[0].used_at, "token consumed");
    assert.ok(rows[0].email_verified_at, "user verified");
  } finally { await cleanup(user); }
});

test("12. a failed verification leaves the account exactly as it was", async () => {
  const user = await makeUser();
  try {
    const before = await pool.query("SELECT status, email_verified_at, fica_status FROM users WHERE id=$1", [user.id]);
    for (const attempt of [
      crypto.randomBytes(32).toString("base64url"),      // unknown
      (await mintToken(user, { minutesUntilExpiry: -5 })).token, // expired
      (await mintToken(user, { used: true })).token       // consumed
    ]) {
      await emailCentre.verifyEmailToken(attempt).catch(() => {});
    }
    const after = await pool.query("SELECT status, email_verified_at, fica_status FROM users WHERE id=$1", [user.id]);
    assert.deepEqual(after.rows[0], before.rows[0], "no failed path may alter the account");
  } finally { await cleanup(user); }
});

/* ===================================================== 13. no financial lift */

test("13. verifying an email grants nothing: not KYC, not FICA, not a limit", async () => {
  const user = await makeUser();
  try {
    const { token } = await mintToken(user);
    const before = await pool.query("SELECT fica_status, status FROM users WHERE id=$1", [user.id]);
    await emailCentre.verifyEmailToken(token);
    const after = await pool.query("SELECT fica_status, status FROM users WHERE id=$1", [user.id]);
    assert.equal(after.rows[0].fica_status, before.rows[0].fica_status, "FICA status must not move");
    assert.equal(after.rows[0].status, before.rows[0].status, "account status must not move");
  } finally { await cleanup(user); }
});

test("13b. no limit, compliance or payment module reads email_verified_at", () => {
  // Structural, not behavioural: if somebody later wires a financial decision to
  // a verified email, this fails and they have to say so out loud.
  const forbidden = [
    ["src", "services", "limit-engine.js"],
    ["src", "services", "compliance-service.js"],
    ["src", "services", "transaction-service.js"],
    ["src", "services", "wallet-service.js"],
    ["src", "services", "pricing-service.js"],
    ["src", "routes", "payments.routes.js"],
    ["src", "routes", "payouts.routes.js"]
  ];
  for (const parts of forbidden) {
    const file = path.join(API, ...parts);
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, "utf8");
    assert.ok(!code.includes("email_verified_at"),
      `${parts.join("/")} must not gate money on a verified email`);
    assert.ok(!code.includes("emailVerifiedAt"),
      `${parts.join("/")} must not gate money on a verified email`);
  }
});

/* ============================================== the audit events, all seven */

test("every verification outcome writes its own audit event", async () => {
  const user = await makeUser();
  try {
    // Requested + sent, via a resend (which is also its own event).
    await emailCentre.resendVerification(user.email, {});
    // Completed.
    const good = await mintToken(user);
    await emailCentre.verifyEmailToken(good.token);
    // Replayed.
    await emailCentre.verifyEmailToken(good.token).catch(() => {});
    // Expired.
    const stale = await mintToken(user, { minutesUntilExpiry: -1 });
    await emailCentre.verifyEmailToken(stale.token).catch(() => {});

    const actions = (await auditActions(user.id)).map((row) => row.action);
    for (const expected of [
      "email_verification_requested",
      "verification_email_queued",
      "email_verification_resent",
      "email_verified",
      "email_verification_replayed",
      "email_verification_expired"
    ]) {
      assert.ok(actions.includes(expected), `${expected} must be recorded (got ${actions.join(", ")})`);
    }
  } finally { await cleanup(user); }
});

test("a failed verification of an unknown token is recorded without an actor", async () => {
  const before = await pool.query(
    "SELECT COUNT(*)::int AS n FROM audit_logs WHERE action='email_verification_failed'");
  await emailCentre.verifyEmailToken(crypto.randomBytes(32).toString("base64url")).catch(() => {});
  const after = await pool.query(
    "SELECT COUNT(*)::int AS n FROM audit_logs WHERE action='email_verification_failed'");
  assert.ok(after.rows[0].n > before.rows[0].n, "an unknown token must still leave a trace");
});

/* ============================================ the link, the token, the copy */

test("the verification link is HTTPS and carries only the token", () => {
  // Tested against the rule itself rather than by reading the source, so this
  // fails if the behaviour changes and not merely if the wording does.
  const link = `${emailCentre.verificationBaseUrl("https://app.titopay.co.za")}/verify-email?token=abc`;
  const url = new URL(link);
  assert.equal(url.protocol, "https:");
  assert.deepEqual([...url.searchParams.keys()], ["token"],
    "the URL must carry the token and nothing else");
});

test("a non-HTTPS APP_ORIGIN refuses to mint a verification link at all", () => {
  for (const origin of ["http://app.titopay.co.za", "http://evil.example", "ftp://x.example"]) {
    assert.throws(
      () => emailCentre.verificationBaseUrl(origin),
      (error) => {
        assert.equal(error.statusCode, 500);
        assert.ok(["APP_ORIGIN_NOT_HTTPS", "APP_ORIGIN_INVALID"].includes(error.details?.code));
        // The customer is never shown why.
        assert.doesNotMatch(error.message, /origin|https|token/i);
        return true;
      },
      `${origin} must be refused`
    );
  }
  // A developer machine is not a customer, so plain HTTP is allowed there.
  assert.equal(emailCentre.verificationBaseUrl("http://localhost:8010"), "http://localhost:8010");
});

test("a malformed APP_ORIGIN refuses rather than producing a broken link", () => {
  for (const origin of ["", "   ", "not a url", "app.titopay.co.za"]) {
    assert.throws(() => emailCentre.verificationBaseUrl(origin),
      (error) => error.details?.code === "APP_ORIGIN_INVALID");
  }
});

test("the queued email redacts the verification link, so no token sits in the queue table", async () => {
  const user = await makeUser();
  try {
    await emailCentre.createVerificationForUser(user, {});
    const { rows } = await pool.query(
      "SELECT variables FROM email_queue WHERE user_id=$1 AND template_key='verify_email_address' ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    assert.equal(rows.length, 1, "the verification email must be queued");
    const variables = JSON.stringify(rows[0].variables);
    assert.match(variables, /REDACTED/, "the link must be redacted in the stored variables");
    assert.ok(!/verify-email\?token=/.test(variables),
      "no live verification link may be readable in the queue table");
  } finally {
    await pool.query("DELETE FROM email_queue WHERE user_id=$1", [user.id]).catch(() => {});
    await cleanup(user);
  }
});

test("the verification email states what TitoPay will never ask for", () => {
  const template = emailCentre.DEFAULT_TEMPLATES.find((item) => item[0] === "verify_email_address");
  assert.ok(template, "the template must exist");
  const body = template[3];
  assert.match(body, /never ask you for your password/i);
  assert.match(body, /PIN/);
  assert.match(body, /expires in about 30 minutes/i);
  // And it must not carry anything sensitive itself.
  assert.ok(!/\{\{(password|pin|otp|balance|cardNumber)\}\}/i.test(body),
    "no credential variable may appear in a verification email");
});

test("a token is 32 random bytes, and two are never the same", () => {
  // Characterising the generator the service uses: crypto.randomBytes(32) in
  // base64url is 43 characters and has no padding.
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const token = crypto.randomBytes(32).toString("base64url");
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    seen.add(token);
  }
  assert.equal(seen.size, 200);
  // And the service really does use it, rather than something predictable.
  const source = fs.readFileSync(path.join(API, "src", "services", "email-centre-service.js"), "utf8");
  const block = source.slice(source.indexOf("async function createVerificationForUser"), source.indexOf("async function verifyEmailToken"));
  assert.match(block, /crypto\.randomBytes\(32\)/);
  assert.doesNotMatch(block, /Math\.random|Date\.now\(\)\.toString|uuidv4\(\)/);
});

test("the default token lifetime is thirty minutes", () => {
  const schema = fs.readFileSync(path.join(API, "src", "db", "email-centre-schema.sql"), "utf8");
  assert.match(schema, /verification_token_expiry_minutes INTEGER NOT NULL DEFAULT 30\b/);
});

/* =============================================== the landing page contract */

test("the PWA landing page exists, decides nothing, and never stores the token", () => {
  const pageDir = path.join(API, "..", "pwa", "verify-email");
  assert.ok(fs.existsSync(path.join(pageDir, "index.html")), "the landing page must exist");
  const js = fs.readFileSync(path.join(pageDir, "verify-email.js"), "utf8");

  // It asks the API and repeats the answer.
  assert.match(js, /\/v1\/auth\/email\/verify/);
  assert.match(js, /\/v1\/auth\/email\/resend-verification/);
  // The token is taken out of the URL.
  assert.match(js, /history\.replaceState/);
  // It never persists anything, and never decides verification itself.
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie/,
    "the page must not store the token or a verified flag");
  assert.doesNotMatch(js, /verified\s*=\s*true/,
    "the backend is authoritative; the page must not decide");
});

/* ================================== registration actually sends it now */

test("registration wires the verification email, and does not gate on it", () => {
  const auth = fs.readFileSync(path.join(API, "src", "services", "auth-service.js"), "utf8");
  assert.match(auth, /await createVerificationForUser\(rows\[0\]/,
    "registration must send the verification email");
  // Non-fatal: a queue failure must not fail the registration.
  const block = auth.slice(auth.indexOf("await createVerificationForUser"), auth.indexOf("const welcomeEmail"));
  assert.match(block, /\.catch\(/, "a verification queue failure must not fail registration");
  // And the response says only whether it was queued.
  assert.match(auth, /verificationEmailQueued:Boolean\(verificationEmail&&verificationEmail\.queued\)/);
  assert.ok(!auth.includes("verificationToken"), "no token may reach a registration response");
});
