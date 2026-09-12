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

test("the generic verify-otp door completes an email login code, and only a login one", async () => {
  const { verifyOtpLogin } = require("../src/services/auth-service");
  const { id } = await makeUser({ withEmail: true });
  const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  const code = "734291";
  const loginCh = crypto.randomUUID();
  const unlockCh = crypto.randomUUID();
  await pool.query(
    `INSERT INTO otp_codes (id, user_type, user_id, purpose, code_hash, expires_at, attempts)
     VALUES ($1,'customer',$3,'email_otp:login',$4, NOW() + INTERVAL '5 minutes', 0),
            ($2,'customer',$3,'email_otp:wallet_unlock',$4, NOW() + INTERVAL '5 minutes', 0)`,
    [loginCh, unlockCh, id, sha256(code)]
  );
  try {
    // The phone posts every sign-in code here; an email login challenge must
    // complete through the bridge and issue a session.
    const result = await verifyOtpLogin({ challengeId: loginCh, otp: code, scope: "customer" }, meta);
    assert.ok(result.accessToken, "the emailed login code signs the customer in");
    // Replay of the used code is refused.
    await assert.rejects(
      verifyOtpLogin({ challengeId: loginCh, otp: code, scope: "customer" }, meta),
      /already been used/i
    );
    // A non-login email code must not be redeemable through this door — and
    // must not be consumed by the attempt.
    await assert.rejects(
      verifyOtpLogin({ challengeId: unlockCh, otp: code, scope: "customer" }, meta),
      /not found/i,
      "a wallet-unlock email code must never mint a session here"
    );
    const { rows } = await pool.query("SELECT used_at FROM otp_codes WHERE id=$1", [unlockCh]);
    assert.equal(rows[0].used_at, null, "the unlock code survives untouched");
  } finally {
    await pool.query("DELETE FROM otp_codes WHERE user_id=$1", [id]);
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
