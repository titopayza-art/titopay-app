"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { pwaFile } = require("./pwa-path");

test("authentication methods are strict, uppercase and default to PUSH", () => {
  const service = read("src/services/authentication-preference-service.js");
  assert.match(service, /AUTHENTICATION_METHODS = Object\.freeze\(\["PUSH", "EMAIL", "SMS"\]\)/);
  assert.match(service, /FALLBACK_ORDER = Object\.freeze\(\["PUSH", "EMAIL", "SMS"\]\)/);
  assert.match(service, /trim\(\)\.toUpperCase\(\)/);
  assert.match(service, /must be PUSH, EMAIL or SMS/);

  const schema = read("src/db/schema.sql");
  const migration = read("src/db/migrations/20260805_authentication_preference.up.sql");
  for (const source of [schema, migration]) {
    assert.match(source, /preferred_authentication_method TEXT NOT NULL DEFAULT 'PUSH'/);
    assert.match(source, /authentication_method_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    assert.match(source, /last_successful_authentication_at TIMESTAMPTZ/);
    assert.match(source, /last_failed_authentication_at TIMESTAMPTZ/);
    assert.doesNotMatch(source, /otp[^\n]*(preferred_authentication_method|authentication_method_updated_at)/i);
  }
});

test("preference reads and verified changes are authenticated, rate limited and additive", () => {
  const routes = read("src/routes/auth.routes.js");
  assert.match(routes, /router\.get\("\/me\/authentication-preference", requireAuth/);
  assert.match(routes, /router\.post\("\/me\/authentication-preference\/request", requireAuth, otpLimiter/);
  assert.match(routes, /router\.put\("\/me\/authentication-preference", requireAuth, otpLimiter/);
  assert.match(routes, /confirmAuthenticationPreferenceChange/);

  const auth = read("src/services/auth-service.js");
  assert.match(auth, /preferredAuthenticationMethod: user\.preferred_authentication_method \|\| "PUSH"/);
  assert.match(auth, /authenticationMethodUpdatedAt:/);
  assert.match(auth, /lastSuccessfulAuthenticationAt:/);
  assert.match(auth, /lastFailedAuthenticationAt:/);
});

test("wallet unlock auto-selects the saved preference and preserves legacy channel input", () => {
  const routes = read("src/routes/security.routes.js");
  const service = read("src/services/authentication-preference-service.js");
  assert.match(routes, /req\.body\?\.authenticationMethod \|\| \(legacyChannel \|\| undefined\)/);
  assert.match(routes, /requestChallenge\(\{/);
  assert.match(routes, /message: "For your security, please verify your identity\."/);
  assert.match(routes, /returnTo: "\/wallet"/);
  assert.match(service, /orderedCandidates\(preferredMethod\)/);
  assert.match(service, /\[preferredMethod, \.\.\.FALLBACK_ORDER\.filter/);
  assert.match(service, /action: "authentication_fallback_used"/);
  assert.match(service, /action: purpose === WALLET_PURPOSE \? "wallet_unlock_failed"/);
  assert.match(service, /action: "sms_otp_sent"/);
  assert.match(service, /action: "wallet_unlocked"/);
});

test("customer sign-in OTP is opt-in and off by default; Admin OTP follows only the saved Admin mode", () => {
  const auth = read("src/services/auth-service.js");
  // Admin OTP is still governed solely by the persisted admin mode.
  assert.match(auth, /adminAuthenticationRequiresOtp = scope === "admin" &&\s*Boolean\(adminPolicy\?\.otpRequired\)/);
  // Customer login OTP now exists, but is gated on the per-user opt-in flag AND
  // an email to receive the code — so it is off for every account by default.
  assert.match(auth, /customerRequiresLoginOtp = scope === "customer" &&\s*Boolean\(user\.login_mfa_enabled\) &&\s*Boolean\(user\.email\)/);
  assert.match(auth, /if \(adminAuthenticationRequiresOtp \|\| customerRequiresLoginOtp\) \{/);
  assert.match(auth, /createEmailOtpChallenge\(user, "login"/);
  // The switch defaults to off at the database level, so no existing account is
  // affected until it opts in.
  assert.match(read("src/db/migrations/20260821_login_mfa.up.sql"), /login_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
});

test("wallet-unlock Email OTP is enabled once without overriding later Admin choices", () => {
  const schema = read("src/db/email-centre-schema.sql");
  assert.match(schema, /wallet_unlock_email_otp_initialized BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /SET email_otp_enabled = TRUE/);
  assert.match(schema, /JSONB_SET\(COALESCE\(email_otp_events/);
  assert.match(schema, /'\{wallet_unlock\}', 'true'::JSONB/);
  assert.match(schema, /wallet_unlock_email_otp_initialized = FALSE/);
});

test("Email OTP can verify authentication-method changes; customer login OTP is a separate opt-in", () => {
  const schema = read("src/db/email-centre-schema.sql");
  const auth = read("src/services/auth-service.js");
  assert.match(schema, /authentication_preference_email_otp_initialized BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /'\{optional_mfa\}', 'true'::JSONB/);
  assert.match(schema, /authentication_preference_email_otp_initialized = FALSE/);
  // The login-OTP gate is a distinct, per-user opt-in — the authentication-
  // method change flow does not turn it on.
  assert.match(auth, /customerRequiresLoginOtp = scope === "customer" &&\s*Boolean\(user\.login_mfa_enabled\)/);
  assert.doesNotMatch(auth, /adminAuthenticationRequiresOtp \|\| await shouldRequireLoginOtp/);
});

test("the PWA does not disguise expired sessions as default Push Authentication", () => {
  const app = fs.readFileSync(pwaFile("app.js"), "utf8");
  assert.match(app, /clearAuth\(\);[\s\S]*Your TitoPay session has expired\. Please sign in again\./);
  assert.doesNotMatch(app, /catch \(error\) \{[\s\S]{0,160}preference = \{[\s\S]{0,160}method: currentAuthenticationMethod/);
  assert.match(app, /Authentication preferences could not be loaded/);
});

test("wallet OTPs are hash-only, single use, expiring and brute-force protected", () => {
  const service = read("src/services/authentication-preference-service.js");
  const emailOtp = read("src/services/email-otp-service.js");
  const auth = read("src/services/auth-service.js");
  assert.match(auth, /sha256\(code\)/);
  assert.match(auth, /config\.otpTtlSeconds/);
  assert.match(service, /SELECT \* FROM otp_codes[\s\S]*FOR UPDATE/);
  assert.match(service, /if \(row\.used_at\) throw new AppError\(409, "OTP already used"\)/);
  assert.match(service, /if \(new Date\(row\.expires_at\).*"OTP expired"/);
  assert.match(service, /Number\(row\.attempts\) >= config\.maxOtpAttempts/);
  assert.match(service, /UPDATE otp_codes SET used_at = NOW\(\)/);
  assert.match(service, /if \(verification\.error\) \{[\s\S]*await client\.query\("COMMIT"\)/);
  assert.match(service, /SET expires_at = NOW\(\)[\s\S]*AND used_at IS NULL/);
  assert.match(emailOtp, /sha256\(code\)/);
  assert.doesNotMatch(service, /console\.(?:log|info|error)\([^\n]*(?:otp|code)\b/i);
});

test("wallet OTP rate limits are isolated by authenticated user and endpoint", () => {
  const limits = read("src/middleware/rate-limits.js");
  const auth = read("src/services/auth-service.js");
  const app = fs.readFileSync(pwaFile("app.js"), "utf8");
  assert.match(limits, /req\.auth\?\.userId/);
  assert.match(limits, /body\.challengeId/);
  assert.match(limits, /req\.route\?\.path \|\| req\.path/);
  assert.match(limits, /maximumAttempts: req\.rateLimit\?\.limit/);
  assert.match(limits, /attemptsRemaining: 0/);
  assert.match(auth, /remainingAttempts: config\.maxOtpAttempts/);
  assert.match(app, /Incorrect OTP\. \$\{remainingAttempts\}/);
  assert.match(app, /Try again in \$\{waitValue\}/);
  assert.match(app, /You have \$\{remainingAttempts\} verification/);
});

test("admin customer list exposes authentication preference and verification timestamps", () => {
  const api = read("src/routes/admin.routes.js");
  const admin = read("../admin/assets/admin.js");
  assert.match(api, /u\.preferred_authentication_method/);
  assert.match(api, /authentication_verification_status/);
  assert.match(api, /last_successful_authentication_at/);
  assert.match(api, /last_failed_authentication_at/);
  assert.match(admin, /label: "Authentication"/);
  assert.match(admin, /preferred_authentication_method/);
  assert.match(admin, /authentication_method_updated_at/);
});
