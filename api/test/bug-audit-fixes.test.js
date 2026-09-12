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

/* ================= Batch A2: money correctness (source pins) ================= */

test("reversing a transaction closes any open pending-credit hold (no double-pay)", () => {
  const src = read("src", "services", "transaction-service.js");
  const fn = src.slice(src.indexOf("async function reverseTransaction"));
  assert.match(fn, /UPDATE pending_credits[\s\S]{0,220}status = 'returned'[\s\S]{0,320}status = 'awaiting_verification'/,
    "the hold must be closed inside the reversal transaction so the expiry sweep can never pay the sender twice");
});

test("the reversal claws back what revenue actually collected, not just the payer fee", () => {
  const src = read("src", "services", "transaction-service.js");
  const fn = src.slice(src.indexOf("async function reverseTransaction"));
  assert.match(fn, /SUM\(fee_collected\)/, "the clawback sums the transaction's real revenue rows");
  assert.doesNotMatch(fn, /-Math\.abs\(Number\(transaction\.fee\)\)/,
    "the payer-fee-only clawback (which left recipient-fee revenue standing) must be gone");
});

test("limit checks are re-run under a per-user lock inside the money transaction", () => {
  const tx = read("src", "services", "transaction-service.js");
  const wd = read("src", "services", "peach-withdrawal-service.js");
  assert.match(tx, /pg_advisory_xact_lock\(hashtext\(\$1\)\)", \[`limits:\$\{actor\.userId\}`\]/,
    "two concurrent sends must serialize on the sender's limits");
  assert.match(wd, /pg_advisory_xact_lock\(hashtext\(\$1\)\)", \[`limits:\$\{actor\.userId\}`\]/,
    "withdrawals consume the same limit pool, so they take the same lock");
});

test("a dynamic QR sale admits exactly one payer (atomic claim)", () => {
  const src = read("src", "services", "qr-service.js");
  assert.match(src, /UPDATE qr_codes SET status = 'paid'[^"]*WHERE id = \$1 AND status = 'active' RETURNING id/,
    "the claim happens before money moves and only one scanner can win it");
  assert.match(src, /SET status = 'active'[^"]*WHERE id = \$1 AND status = 'paid'/,
    "a failed charge puts the claim back so the sale stays payable");
});

test("a TitoKids request is decided exactly once (atomic claim before funding)", () => {
  const src = read("src", "services", "titokids-service.js");
  const fn = src.slice(src.indexOf("async function decideRequest"));
  assert.match(fn, /WHERE id = \$1 AND status = 'requested'\s*RETURNING id/,
    "two parents answering at once must not both fund the child");
  assert.match(fn, /SET status = 'requested', decided_by = NULL/,
    "a failed funding returns the request so it is not stranded approved-but-unfunded");
});

test("a ticket admits exactly one scan at the gate", () => {
  const src = read("src", "services", "ticketing-service.js");
  assert.match(src, /SET status = 'scanned', scanned_at = NOW\(\), scanned_by = \$2, updated_at = NOW\(\)\s*WHERE id = \$1 AND status = 'valid'/,
    "two simultaneous scans of one ticket must not both approve entry");
});

test("the user's spending wallet never resolves to a TitoKids custody wallet", () => {
  for (const file of ["peach-withdrawal-service.js", "pending-credit-service.js", "book-activation-service.js", "event-campaign-service.js"]) {
    const src = read("src", "services", file);
    assert.doesNotMatch(src, /FROM wallets WHERE user_id = \$1 ORDER BY created_at/,
      `${file} must filter kind <> 'system' when picking the oldest wallet`);
  }
  assert.match(read("src", "services", "ticketing-service.js"), /AND kind <> 'system'/,
    "ticketing's no-preference wallet pick excludes custody wallets");
});

test("monthly limits roll at South African midnight, not 02:00", () => {
  for (const file of ["compliance-service.js", "limit-engine.js"]) {
    const src = read("src", "services", file);
    assert.match(src, /DATE_TRUNC\('month', NOW\(\) AT TIME ZONE 'Africa\/Johannesburg'\) AT TIME ZONE 'Africa\/Johannesburg'/,
      `${file} must truncate in SAST wall-clock and anchor the boundary back to a real instant`);
  }
});

test("a zero-priced fee-only service refuses cleanly instead of erroring in the ledger", () => {
  const src = read("src", "services", "transaction-service.js");
  assert.match(src, /if \(!\(debitTotal > 0\)\) throw new AppError\(400, "This service is not priced yet/,
    "an operator pricing mistake must be a clean refusal, never a 500");
});
