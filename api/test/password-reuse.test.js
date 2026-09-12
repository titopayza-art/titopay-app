"use strict";

// A RESET THAT ACCEPTS THE OLD PASSWORD IS THEATRE.
//
// Somebody resets a password because the old one may be in someone else's
// hands. Until 20 August 2026 both reset flows and the logged-in change flow
// accepted the OLD password as the "new" one, so the single thing a reset
// exists to do - make the leaked credential stop working - silently did not
// happen. Found by the operator, not by an audit.
//
// The rule these tests hold: every flow that sets a credential refuses one
// matching the current credential, and refuses it BEFORE consuming the OTP or
// reset token, so trying again with a real new password costs nothing.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "reuse-test-access-secret-with-len-32-bytes!";
process.env.JWT_REFRESH_SECRET ||= "reuse-test-refresh-secret-with-len-32-bytes";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { hashPassword, verifyPassword } = require("../src/lib/passwords");
const { confirmPasswordReset } = require("../src/services/auth-service");

const API = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(API, ...p), "utf8");

const stamp = Date.now().toString(36);
const userId = crypto.randomUUID();
const OLD_PASSWORD = "Leaked#Old2026Password";
const NEW_PASSWORD = "Fresh#New2026Password";
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

async function mintResetChallenge(otp) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO otp_codes (id, user_type, user_id, purpose, code_hash, channels, attempts, resend_count, expires_at, metadata)
     VALUES ($1, 'customer', $2, 'password_reset', $3, '{email}', 0, 0, NOW() + INTERVAL '5 minutes', '{}'::jsonb)`,
    [id, userId, sha256(otp)]
  );
  return id;
}

test.before(async () => {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash)
     VALUES ($1, 'personal', 'Reuse Test Customer', $2, $3)`,
    [userId, `reuse_${stamp}`, await hashPassword(OLD_PASSWORD)]
  );
});

test.after(async () => {
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

test("resetting to the OLD password is refused, in words that say why", async () => {
  const challengeId = await mintResetChallenge("111222");
  await assert.rejects(
    confirmPasswordReset(
      { challengeId, otp: "111222", newPassword: OLD_PASSWORD },
      { ipAddress: "127.0.0.1", userAgent: "reuse-test" }
    ),
    /different from your current one/,
    "the exact flaw: a leaked password resurrected by the flow meant to kill it"
  );
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  assert.ok(await verifyPassword(OLD_PASSWORD, rows[0].password_hash),
    "nothing changed on refusal");
});

test("the refusal does not burn the OTP: the same code then works with a real new password", async () => {
  const challengeId = await mintResetChallenge("333444");
  await assert.rejects(
    confirmPasswordReset(
      { challengeId, otp: "333444", newPassword: OLD_PASSWORD },
      { ipAddress: "127.0.0.1", userAgent: "reuse-test" }
    ),
    /different from your current one/
  );
  const { rows: otpAfterRefusal } = await pool.query("SELECT used_at, attempts FROM otp_codes WHERE id = $1", [challengeId]);
  assert.equal(otpAfterRefusal[0].used_at, null, "a refused reuse must not consume the code");
  assert.equal(Number(otpAfterRefusal[0].attempts), 0, "nor count as a failed attempt");

  await confirmPasswordReset(
    { challengeId, otp: "333444", newPassword: NEW_PASSWORD },
    { ipAddress: "127.0.0.1", userAgent: "reuse-test" }
  );
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  assert.ok(await verifyPassword(NEW_PASSWORD, rows[0].password_hash), "the new password landed");
  assert.ok(!(await verifyPassword(OLD_PASSWORD, rows[0].password_hash)), "and the leaked one is dead");

  const { rows: otpAfterSuccess } = await pool.query("SELECT used_at FROM otp_codes WHERE id = $1", [challengeId]);
  assert.ok(otpAfterSuccess[0].used_at, "success consumes the code as before");
});

test("every credential-setting flow carries the check, before its token is consumed", () => {
  // The email-link flow (password_reset_tokens) has no exported entry point
  // this test can drive without a mail round trip, so its ordering is pinned
  // at the source: the reuse check must come before the token is marked used,
  // inside the same transaction, so a refusal rolls back and the link
  // survives for a second try.
  const emailCentre = read("src", "services", "email-centre-service.js");
  const flow = emailCentre.slice(emailCentre.indexOf("async function confirmEmailPasswordReset"));
  const checkAt = flow.indexOf("assertNewCredentialDiffers");
  const consumeAt = flow.indexOf("SET used_at=NOW()");
  assert.ok(checkAt > -1, "the email-link reset checks for reuse");
  assert.ok(checkAt < consumeAt, "and refuses BEFORE the link is consumed");

  const auth = read("src", "services", "auth-service.js");
  const reset = auth.slice(auth.indexOf("async function confirmPasswordReset"));
  const authCheckAt = reset.indexOf("assertNewCredentialDiffers");
  const otpProofAt = reset.indexOf("sha256(payload.otp)");
  const authConsumeAt = reset.indexOf("SET used_at = NOW()");
  assert.ok(authCheckAt > -1, "the OTP reset checks for reuse");
  assert.ok(otpProofAt < authCheckAt,
    "but only AFTER the OTP is proven, or the flow becomes a password oracle for anyone");
  assert.ok(authCheckAt < authConsumeAt, "and before the code is consumed");

  // One copy of the check, in the passwords lib, like every shared rule since
  // the copy-pasted-key incident.
  assert.match(read("src", "lib", "passwords.js"), /async function assertNewCredentialDiffers/);
});
