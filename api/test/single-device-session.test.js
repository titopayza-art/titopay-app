"use strict";

// ONE ACTIVE SESSION PER ACCOUNT, AND AN OTP BEFORE A NEW DEVICE GETS ONE.
//
// Before this, TitoPay had no single-session rule at all. Every revocation
// reason in the codebase - account_closed, idle_timeout, logout, logout_all,
// password_reset, refresh_rotated, remote_logout - fired somewhere other than
// sign-in, so a customer could hold unlimited live sessions on unlimited
// devices, each good for seven days. The admin portal said the opposite.
//
// The five things this file defends, in the order they matter:
//
//   1. signing in displaces every other session on the account;
//   2. the displaced device is told WHY, not just that it was signed out;
//   3. an unrecognised device must pass an OTP first, delivered to SMS AND
//      email, and no session exists until it does;
//   4. the device the code admits is the one that ASKED for it, never one the
//      redeeming request names;
//   5. refreshing a token is the same device continuing and displaces nothing.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

// THE DELIVERY PATH IS THE REAL ONE, POINTED AT A LOCAL COLLECTOR.
//
// The code is only ever stored hashed, so a test cannot read it out of the
// database - and stubbing the sender would skip exactly the code that decides
// which channels a new-device challenge reaches, which is one of the things
// this file has to prove. So the SMS and email providers are configured to
// post to a server inside this process. Both are the production code paths;
// only the endpoint differs.
const COLLECTOR_PORT = 47311;
process.env.EMAIL_PROVIDER = "api";
process.env.EMAIL_API_URL = `http://127.0.0.1:${COLLECTOR_PORT}/email`;
process.env.EMAIL_API_KEY = "test-email-key";
process.env.EMAIL_FROM_ADDRESS = "no-reply@test.local";
process.env.EMAIL_SMTP_HOST = "";
process.env.SMS_API_URL = `http://127.0.0.1:${COLLECTOR_PORT}/sms`;
process.env.SMS_API_KEY = "test-sms-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const auth = require("../src/services/auth-service");
const devices = require("../src/services/device-session-service");
const { hashPassword } = require("../src/lib/passwords");
const { sha256 } = require("../src/lib/crypto");

// Everything the platform tried to send, and the six digits inside it.
const delivered = [];
const collector = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const code = (body.match(/\b(\d{6})\b/) || [])[1] || "";
    delivered.push({ channel: req.url === "/sms" ? "sms" : "email", body, code });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `msg_${delivered.length}`, status: "sent" }));
  });
});
const collectorReady = new Promise((resolve) => collector.listen(COLLECTOR_PORT, "127.0.0.1", resolve));

// A sign-in that is expected to raise a challenge, with the delivery it caused.
async function challengeFrom(run) {
  await collectorReady;
  const before = delivered.length;
  const result = await run();
  return { result, sent: delivered.slice(before) };
}

const PASSWORD = "TestPassw0rd!2026";
const META = { ipAddress: "127.0.0.1", userAgent: "node-test" };

let sequence = 0;
async function makeCustomer({ phone = true, email = true } = {}) {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,$2,$3,$4,$5,'personal','active','verified',$6)`,
    [id, "Device Tester", `dev_${tag}`,
      email ? `dev_${tag}@test.local` : null,
      phone ? `+2782${tag}`.slice(0, 13) : null,
      await hashPassword(PASSWORD)]);
  return { id, username: `dev_${tag}`, user_type: "customer" };
}

// A device id is whatever the client stores. These are shaped like the real
// ones the app generates.
const deviceId = () => crypto.randomBytes(24).toString("base64url");

function signIn(user, extra = {}) {
  return auth.login({ identifier: user.username, password: PASSWORD, scope: "customer", ...extra }, META);
}

async function liveSessions(userId) {
  const { rows } = await pool.query(
    "SELECT id, revoked_reason FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  return rows;
}

async function latestChallenge(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM otp_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId]);
  return rows[0];
}

test("A SECOND SIGN-IN DISPLACES THE FIRST", async () => {
  const user = await makeCustomer();
  const first = await signIn(user, { deviceId: deviceId(), deviceName: "iPhone" });
  assert.ok(first.accessToken, "the first device signs in normally");
  assert.equal((await liveSessions(user.id)).length, 1);

  // Same account, different installation. It is unrecognised, but the account
  // now has a device on file, so this must be challenged rather than admitted.
  const { result: second } = await challengeFrom(() => signIn(user, { deviceId: deviceId(), deviceName: "Android" }));
  assert.equal(second.otp_required, true, "an unrecognised device is challenged");
  assert.equal(second.accessToken, undefined, "NO SESSION EXISTS UNTIL THE CODE IS PROVEN");
  assert.equal((await liveSessions(user.id)).length, 1, "the first device is still live while the code is unproven");
});

test("THE CODE FOR A NEW DEVICE GOES TO SMS AND EMAIL TOGETHER", async () => {
  const user = await makeCustomer();
  await signIn(user, { deviceId: deviceId() });
  const { sent } = await challengeFrom(() => signIn(user, { deviceId: deviceId() }));
  assert.deepEqual(sent.map((item) => item.channel).sort(), ["email", "sms"],
    "one channel is not enough for the code that guards a wallet");
  assert.equal(sent[0].code, sent[1].code, "and it is the SAME code on both, not two challenges");
  assert.match(sent[0].body, /verification code/i);
});

test("PROVING THE CODE ADMITS THE NEW DEVICE AND SIGNS THE OLD ONE OUT", async () => {
  const user = await makeCustomer();
  const oldDevice = deviceId();
  const newDevice = deviceId();
  const first = await signIn(user, { deviceId: oldDevice, deviceName: "iPhone" });
  const firstSessions = await liveSessions(user.id);

  const { sent } = await challengeFrom(() => signIn(user, { deviceId: newDevice, deviceName: "Android" }));
  const code = sent[0].code;
  const challenge = await latestChallenge(user.id);
  assert.equal(challenge.purpose, "new_device_login");

  const verified = await auth.verifyOtpLogin({ challengeId: challenge.id, otp: code, scope: "customer" }, META);
  assert.ok(verified.accessToken, "the new device is in");

  const after = await liveSessions(user.id);
  assert.equal(after.length, 1, "EXACTLY ONE LIVE SESSION");
  assert.notEqual(after[0].id, firstSessions[0].id, "and it is the new device's, not the old one's");

  const { rows: [revoked] } = await pool.query(
    "SELECT revoked_reason FROM sessions WHERE id = $1", [firstSessions[0].id]);
  assert.equal(revoked.revoked_reason, "signed_in_on_another_device");
  assert.ok(first.accessToken);
});

test("THE DISPLACED DEVICE IS TOLD WHY, NOT JUST THAT", async () => {
  // An ordinary expiry and being signed out by somebody else read identically
  // to a customer unless the API distinguishes them. This is the difference
  // between "please sign in again" and a security warning worth acting on.
  const user = await makeCustomer();
  const first = await signIn(user, { deviceId: deviceId() });
  const { sent } = await challengeFrom(() => signIn(user, { deviceId: deviceId() }));
  const challenge = await latestChallenge(user.id);
  await auth.verifyOtpLogin({ challengeId: challenge.id, otp: sent[0].code, scope: "customer" }, META);

  // The old device now tries to renew, which is what a phone left on a table
  // does by itself.
  await assert.rejects(
    () => auth.refreshTokens({ refreshToken: first.refreshToken }, META),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.details?.code, "session_displaced");
      assert.equal(error.message, "Your TitoPay account was logged in on another device.");
      return true;
    }
  );
});

test("THE CODE ADMITS THE DEVICE THAT ASKED FOR IT, NOT ONE THE REQUEST NAMES", async () => {
  // Otherwise an attacker who gets the victim to read out a code could enrol
  // their own installation with it and never be challenged again.
  const user = await makeCustomer();
  await signIn(user, { deviceId: deviceId() });
  const asking = deviceId();
  const attacker = deviceId();
  const { sent } = await challengeFrom(() => signIn(user, { deviceId: asking }));
  const challenge = await latestChallenge(user.id);
  await auth.verifyOtpLogin({ challengeId: challenge.id, otp: sent[0].code, scope: "customer", deviceId: attacker }, META);

  assert.equal(await devices.isKnownDevice(user, asking), true, "the device that asked is enrolled");
  assert.equal(await devices.isKnownDevice(user, attacker), false,
    "the device the redeeming request named is NOT");
});

test("a recognised device signs in with no code at all", async () => {
  const user = await makeCustomer();
  const phone = deviceId();
  await signIn(user, { deviceId: phone });
  const again = await signIn(user, { deviceId: phone });
  assert.ok(again.accessToken, "the same phone is not challenged again");
  assert.equal(again.otp_required, undefined);
  assert.equal((await liveSessions(user.id)).length, 1, "and it replaces its own session rather than stacking one");
});

test("REFRESHING A TOKEN DISPLACES NOTHING - it is the same device continuing", async () => {
  const user = await makeCustomer();
  const phone = deviceId();
  const session = await signIn(user, { deviceId: phone });
  const rotated = await auth.refreshTokens({ refreshToken: session.refreshToken }, META);
  assert.ok(rotated.accessToken);
  const live = await liveSessions(user.id);
  assert.equal(live.length, 1, "rotation replaces one session with one session");
  // And the rotated session still belongs to the same installation, so the
  // next sign-in on this phone is still recognised.
  assert.equal(await devices.isKnownDevice(user, phone), true);
});

test("AN ACCOUNT THE CODE CANNOT REACH IS REFUSED, NOT WAVED THROUGH", async () => {
  // The whole point of the OTP is that suppressing it must not be a way past
  // it. An account with no phone and no email has no channel, so a new device
  // is refused and told to contact support.
  const user = await makeCustomer({ phone: false, email: false });
  await signIn(user, { deviceId: deviceId() });
  await assert.rejects(
    () => signIn(user, { deviceId: deviceId() }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.details?.code, "otp_undeliverable");
      return true;
    }
  );
  assert.equal((await liveSessions(user.id)).length, 1, "the existing device keeps working");
});

test("an account with only one contact channel still gets the code there", async () => {
  const user = await makeCustomer({ phone: false });
  await signIn(user, { deviceId: deviceId() });
  const { sent } = await challengeFrom(() => signIn(user, { deviceId: deviceId() }));
  assert.deepEqual(sent.map((item) => item.channel), ["email"]);
});

test("THE FIRST DEVICE ON AN ACCOUNT ENROLS WITHOUT A CODE", async () => {
  // On the day this ships no account has a device on file, so requiring a code
  // from every device at once would demand working SMS and SMTP for the entire
  // customer base simultaneously and lock out anybody it failed to reach.
  const user = await makeCustomer();
  const first = await signIn(user, { deviceId: deviceId() });
  assert.ok(first.accessToken, "the first device is enrolled, not challenged");
  assert.equal(await latestChallenge(user.id), undefined, "no challenge was created");
});

test("A CLIENT THAT SENDS NO DEVICE ID IS STILL CHALLENGED ONCE THE ACCOUNT HAS ONE", async () => {
  // Otherwise omitting the field would be the way around the rule.
  const user = await makeCustomer();
  await signIn(user, { deviceId: deviceId() });
  const { result: anonymous } = await challengeFrom(() => signIn(user, {}));
  assert.equal(anonymous.otp_required, true, "no device id is not a free pass");
  assert.equal(anonymous.accessToken, undefined);
});

test("a malformed device id is treated as no device id, never as a match", async () => {
  const user = await makeCustomer();
  await signIn(user, { deviceId: deviceId() });
  for (const bad of ["", "short", "../../etc/passwd", "a".repeat(200), "has spaces in it"]) {
    const { result } = await challengeFrom(() => signIn(user, { deviceId: bad }));
    assert.equal(result.otp_required, true, `refused: ${JSON.stringify(bad)}`);
  }
});

test("THE RAW DEVICE ID IS NEVER STORED - only a hash of it", async () => {
  // A dump of trusted_devices must not be replayable against the login
  // endpoint to make an attacker's installation look familiar.
  const user = await makeCustomer();
  const phone = deviceId();
  await signIn(user, { deviceId: phone });
  const { rows } = await pool.query(
    "SELECT device_fingerprint FROM trusted_devices WHERE user_id = $1", [user.id]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].device_fingerprint, phone);
  assert.equal(rows[0].device_fingerprint, sha256(phone));
  const { rows: sessionRows } = await pool.query(
    "SELECT device_fingerprint FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
  assert.equal(sessionRows[0].device_fingerprint, sha256(phone));
});

test("the kill switch restores the previous behaviour without a deploy", async () => {
  // The failure this has to survive is an administrator who cannot sign in to
  // reach a console toggle, so the switch is an environment variable.
  const user = await makeCustomer();
  await signIn(user, { deviceId: deviceId() });
  process.env.SINGLE_SESSION = "off";
  try {
    const second = await signIn(user, { deviceId: deviceId() });
    assert.ok(second.accessToken, "no challenge while the rule is off");
    assert.equal((await liveSessions(user.id)).length, 2, "and sessions stack again, as they did before");
  } finally {
    delete process.env.SINGLE_SESSION;
  }
});

test.after(async () => {
  await new Promise((resolve) => collector.close(resolve));
  await pool.end().catch(() => null);
});
