"use strict";

// Fixes from the 21 August 2026 bug audit (six-dimension correctness sweep),
// batch A1: the lockout/critical set. Each test pins one fix — behavioral
// against the real database where the flow allows, source pins where not.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "bug-audit-test-access-secret-32-bytes-ok!";
process.env.JWT_REFRESH_SECRET ||= "bug-audit-test-refresh-secret-32-bytes-k";

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
const pwa = (...p) => fs.readFileSync(path.join(API, "..", "pwa", ...p), "utf8");
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const stamp = Date.now().toString(36);

/* ---- Finding: SMS-OTP password reset broke when the account-id leak was closed ---- */

test("password reset completes with challengeId alone — no account id required", async () => {
  const userId = crypto.randomUUID();
  const username = `reset_${stamp}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash)
     VALUES ($1,'personal','Reset Test',$2,$3,$4)`,
    [userId, username, `${username}@t.local`, await hashPassword("OldStrong#2026a")]
  );
  const challengeId = crypto.randomUUID();
  const code = "618402";
  await pool.query(
    `INSERT INTO otp_codes (id, user_type, user_id, purpose, code_hash, expires_at, attempts)
     VALUES ($1,'customer',$2,'password_reset',$3, NOW() + INTERVAL '5 minutes', 0)`,
    [challengeId, userId, sha256(code)]
  );
  try {
    // The exact shape the fixed PWA sends: challengeId + otp + newPassword,
    // and deliberately NO accountId — the server derives the account from the
    // proven challenge.
    await confirmPasswordReset(
      { challengeId, otp: code, newPassword: "NewStrong#2026b", userType: "customer" },
      { ipAddress: "127.0.0.1" }
    );
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id=$1", [userId]);
    assert.equal(await verifyPassword("NewStrong#2026b", rows[0].password_hash), true,
      "the new password must be live after a challengeId-only confirm");
  } finally {
    await pool.query("DELETE FROM otp_codes WHERE user_id=$1", [userId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  }
});

test("the PWA reset confirm keys on the challenge, not a leaked account id (source pin)", () => {
  const app = pwa("app.js");
  const fn = app.slice(app.indexOf("async function confirmReset"), app.indexOf("async function confirmReset") + 1200);
  assert.match(fn, /if \(!saved \|\| !saved\.challengeId\)/,
    "confirmReset must gate on the challengeId the server actually returns");
  assert.doesNotMatch(fn, /accountId: saved\.accountId/,
    "the request body must not depend on an accountId the response no longer carries");
});

/* ---- Finding: login OTP input capped at 6 while email codes go up to 8 ---- */

test("the sign-in OTP input accepts the full configurable code length (source pin)", () => {
  const app = pwa("app.js");
  const form = app.slice(app.indexOf("function otpForm"), app.indexOf("function otpForm") + 900);
  assert.match(form, /name="otp"[^>]*maxlength="8"/, "an 8-digit emailed code must be typeable");
  assert.match(form, /name="otp"[^>]*pattern="\[0-9\]\{6,8\}"/, "and validated as 6-8 digits");
  assert.match(form, /data-action="resend-login-otp"/, "a stuck user can request a fresh code");
});

/* ---- Finding: login_mfa_enabled existed only in the migration (fresh-install crash) ---- */

test("login_mfa_enabled exists in all three schema copies", () => {
  assert.match(read("src", "db", "schema.sql"), /login_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE/,
    "a fresh install from schema.sql must have the column");
  assert.match(read("src", "services", "auth-service.js"),
    /ADD COLUMN IF NOT EXISTS login_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE/,
    "the runtime self-heal must add it too");
  assert.match(read("src", "db", "migrations", "20260821_login_mfa.up.sql"),
    /login_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE/i, "and the migration remains the deploy path");
});

/* ---- Finding: global Email OTP switch could lock out MFA users and admins ---- */

test("sign-in challenges force past the global Email OTP switch (source pin)", () => {
  const auth = read("src", "services", "auth-service.js");
  const site = auth.slice(auth.indexOf("adminAuthenticationRequiresOtp || customerRequiresLoginOtp"));
  assert.match(site.slice(0, 700), /\{ force: true \}/,
    "the per-user opt-in / admin mode is the authorization; the global switch must not 409 sign-in");
});

/* ---- Finding: pooled email-OTP challenge ignored a silently-skipped queue ---- */

test("a sign-in code whose email never queued fails loudly and revokes the challenge (source pin)", () => {
  const svc = read("src", "services", "email-otp-service.js");
  assert.match(svc, /if\(!queueJob\|\|queueJob\.skipped\)\{/,
    "the pooled path must check the queue result like the transactional path does");
  assert.match(svc, /Verification emails are paused right now/,
    "and tell the user something actionable instead of 'code sent'");
});

/* ---- Finding: legacy verify-otp door skipped the account-status re-check ---- */

test("verify-otp re-checks account status before issuing a session (source pin)", () => {
  const auth = read("src", "services", "auth-service.js");
  const fn = auth.slice(auth.indexOf("async function verifyOtpLogin"), auth.indexOf("async function verifyOtpLogin") + 3600);
  assert.match(fn, /if \(!user\) throw new AppError\(404, "Account not found"\);\s*\/\/[^\n]*\n[^\n]*\n\s*assertActive\(user\);/,
    "a suspension between challenge and code must block the session, matching the email door");
});

/* ---- Finding: `npm run db:migrate` did not run migrations ---- */

test("db:migrate runs the migration runner, not schema init", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["db:migrate"], "node scripts/apply-migrations.js",
    "the industry-standard name must do the industry-standard thing");
});

/* ---- Finding: SA decimal-comma amounts read as 100x or NaN ---- */

test("parseAmount reads South African decimal commas correctly", () => {
  const app = pwa("app.js");
  const src = app.match(/function parseAmount[\s\S]*?\n\}/)[0];
  const parseAmount = new Function(`${src}; return parseAmount;`)();
  assert.equal(parseAmount("1,50"), 1.5, "'1,50' is one rand fifty, never R150");
  assert.equal(parseAmount("1 250,75"), 1250.75);
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("1,234"), 1234, "a 3-digit comma group is a thousands separator");
  assert.ok(Number.isNaN(parseAmount("abc")));
  // Every customer-typed amount goes through it: no comma-stripping parser remains.
  assert.doesNotMatch(app, /replace\(\/\[\^\\d\.\]\/g, ""\)/,
    "the 100x comma-stripping parsers must be gone");
});

/* ---- Finding: isoDate() shifted every SAST date back a day ---- */

test("isoDate returns the customer's local calendar date", () => {
  const app = pwa("app.js");
  const src = app.match(/function isoDate[\s\S]*?\n\}/)[0];
  const isoDate = new Function(`${src}; return isoDate;`)();
  // Local midnight in any UTC-positive zone used to come back as yesterday.
  assert.equal(isoDate(new Date(2026, 7, 21)), "2026-08-21",
    "21 August at local midnight is 21 August, in Johannesburg too");
  assert.equal(isoDate(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(isoDate("nonsense"), "");
});

/* ---- Finding: profile photo submit re-read a disabled form ---- */

test("submitProfilePhoto uses the FormData captured before the fields were disabled (source pin)", () => {
  const app = pwa("app.js");
  assert.match(app, /await submitProfilePhoto\(form, formData\);/,
    "the dispatcher hands over its pre-capture, like submitFica");
  assert.match(app, /async function submitProfilePhoto\(form, formData\)[\s\S]{0,400}formData \|\| new FormData\(form\)/,
    "and the handler prefers it over rebuilding from a disabled form");
});
