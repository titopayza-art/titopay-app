"use strict";

// Opt-in customer login MFA (build 85). Off by default; when a customer turns
// it on, sign-in returns an email-OTP challenge instead of tokens. Enabling is
// refused for an account with no email, so no one can lock themselves out.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "login-mfa-test-access-secret-32-bytes-ok!";
process.env.JWT_REFRESH_SECRET ||= "login-mfa-test-refresh-secret-32-bytes-k!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");
const { login, setLoginMfaEnabled, getLoginMfaStatus } = require("../src/services/auth-service");

const stamp = Date.now().toString(36);
const PASSWORD = "Str0ngPass!2026";
const meta = { ipAddress: "127.0.0.1", userAgent: "node-test" };

async function makeUser({ withEmail }) {
  const id = crypto.randomUUID();
  const username = `mfa_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,'personal','MFA Test',$2,$3,$4,$5)`,
    [id, username, withEmail ? `${username}@t.local` : null, `+2771${Math.floor(1000000 + Math.random() * 8999999)}`, await hashPassword(PASSWORD)]
  );
  return { id, username };
}

test("default off: a customer signs in with tokens, no OTP", async () => {
  const { id, username } = await makeUser({ withEmail: true });
  try {
    const status = await getLoginMfaStatus(id);
    assert.equal(status.loginMfaEnabled, false, "MFA is off by default");
    const result = await login({ identifier: username, password: PASSWORD, scope: "customer" }, meta);
    assert.ok(result.accessToken, "a normal sign-in issues an access token");
    assert.ok(!result.otp_required, "no OTP step when MFA is off");
  } finally {
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
  }
});

test("enabled: sign-in returns an OTP challenge instead of tokens, and reverts on disable", async () => {
  const { id, username } = await makeUser({ withEmail: true });
  try {
    await setLoginMfaEnabled(id, true);
    const gated = await login({ identifier: username, password: PASSWORD, scope: "customer" }, meta);
    assert.equal(gated.otp_required, true, "sign-in now demands the login code");
    assert.ok(gated.challengeId, "an OTP challenge is issued");
    assert.ok(!gated.accessToken, "no token is handed out before the code is verified");

    await setLoginMfaEnabled(id, false);
    const open = await login({ identifier: username, password: PASSWORD, scope: "customer" }, meta);
    assert.ok(open.accessToken, "disabling MFA restores direct sign-in");
    assert.ok(!open.otp_required);
  } finally {
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
  }
});

test("no lockout: enabling is refused when the account has no email", async () => {
  const { id } = await makeUser({ withEmail: false });
  try {
    await assert.rejects(
      setLoginMfaEnabled(id, true),
      /email/i,
      "an account with no email must not be able to turn on an email login code"
    );
    const status = await getLoginMfaStatus(id);
    assert.equal(status.loginMfaEnabled, false);
    assert.equal(status.emailAvailable, false);
  } finally {
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
  }
});
