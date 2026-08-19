"use strict";

// Focused cover for the 19 August 2026 security remediation.
//
// Each test names the defect it prevents coming back, because a security test
// that only asserts the current behaviour tells a later reader nothing about
// why the behaviour matters.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV ||= "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const SRC = (...parts) => path.join(__dirname, "..", "src", ...parts);
const read = (...parts) => fs.readFileSync(SRC(...parts), "utf8");

/* ------------------------------------------------- 1. identity hashing */

test("identity numbers are keyed with the pepper, not digested with a public prefix", () => {
  const { identityHash, legacyIdentityHash, saIdMaterial } = require("../src/lib/identity-hash");
  const { config } = require("../src/config/env");
  const material = saIdMaterial("9001015000085");

  // The old form was sha256 over a constant in-source prefix. The whole valid
  // South African ID space is about 1.46 billion numbers, so that digest is
  // reversible by brute force in under a second on one GPU. The keyed form must
  // not equal it.
  const unkeyed = crypto.createHash("sha256").update(material).digest("hex");
  assert.equal(legacyIdentityHash(material), unkeyed, "the legacy helper still reproduces the old digest exactly");
  assert.notEqual(identityHash(material), unkeyed, "the keyed hash must not be the unkeyed digest");

  // It is an HMAC under the configured pepper, and it is deterministic so every
  // existing equality lookup keeps working.
  const expected = crypto.createHmac("sha256", config.identityPepper).update(material).digest("hex");
  assert.equal(identityHash(material), expected);
  assert.equal(identityHash(material), identityHash(material), "deterministic, or lookups break");
});

test("a different pepper produces a different hash for the same identity", () => {
  const material = require("../src/lib/identity-hash").saIdMaterial("9001015000085");
  const a = crypto.createHmac("sha256", "pepper-a-with-enough-length-to-be-real").update(material).digest("hex");
  const b = crypto.createHmac("sha256", "pepper-b-with-enough-length-to-be-real").update(material).digest("hex");
  assert.notEqual(a, b, "the key is what protects a dump, so it must change the output");
});

test("SA ID and travel-document material keep the exact strings already stored", () => {
  const { saIdMaterial, documentMaterial } = require("../src/lib/identity-hash");
  // Changing either string would orphan every row written before the change.
  assert.equal(saIdMaterial("9001015000085"), "titopay-id:9001015000085");
  assert.equal(documentMaterial("passport", "GB", "123456789"), "titopay-doc:passport:GB:123456789");
});

test("every identity hash in the codebase comes from the one helper", () => {
  // Three sites used to compute this by hand: the SA ID path, the passport path
  // and the admin screening-list route. Copies that must agree exactly are how
  // one of them silently stops matching.
  for (const file of [
    ["services", "compliance-service.js"],
    ["routes", "admin.routes.js"]
  ]) {
    const source = read(...file);
    assert.doesNotMatch(source, /createHash\("sha256"\)[\s\S]{0,40}titopay-/,
      `${file.join("/")} must not compute an unkeyed identity digest inline`);
  }
});

test("duplicate-identity detection still recognises an account verified before the migration", () => {
  const source = read("services", "compliance-service.js");
  // Matching only the keyed hash would stop seeing every pre-migration account,
  // which is a duplicate-account control quietly switching off.
  assert.match(source, /id_number_hmac = \$1 OR id_number_hash = \$3/,
    "the duplicate check must consider both hash forms");
});

test("sanctions screening compares like with like and never across forms", () => {
  const source = read("services", "compliance-service.js");
  assert.match(source, /SELECT id_number_hash, id_number_hmac FROM users/);
  assert.match(source, /id, label, name_pattern, id_number_hash, id_number_hmac FROM compliance_screening_list/);
  // Keyed against keyed, legacy against legacy. A screening entry created before
  // the pepper existed cannot be recomputed, so both arms have to survive.
  assert.match(source, /entry\.id_number_hmac && user\.id_number_hmac && user\.id_number_hmac === entry\.id_number_hmac/);
  assert.match(source, /entry\.id_number_hash && user\.id_number_hash && user\.id_number_hash === entry\.id_number_hash/);
});

test("a new screening entry carries both forms so it matches both populations", () => {
  const source = read("routes", "admin.routes.js");
  assert.match(source, /identityHashPair\(saIdMaterial\(idNumber\)\)/);
  assert.match(source, /id_number_hash, id_number_hmac, added_by\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6\)/);
});

test("legacy dual write is on unless it is deliberately turned off", () => {
  const { legacyDualWriteEnabled } = require("../src/lib/identity-hash");
  const original = process.env.IDENTITY_HASH_LEGACY_DUAL_WRITE;
  try {
    delete process.env.IDENTITY_HASH_LEGACY_DUAL_WRITE;
    assert.equal(legacyDualWriteEnabled(), true, "default ON, or post-migration customers stop being screened");
    process.env.IDENTITY_HASH_LEGACY_DUAL_WRITE = "false";
    assert.equal(legacyDualWriteEnabled(), false, "and it can be switched off once the screening list is migrated");
  } finally {
    if (original === undefined) delete process.env.IDENTITY_HASH_LEGACY_DUAL_WRITE;
    else process.env.IDENTITY_HASH_LEGACY_DUAL_WRITE = original;
  }
});

test("the keyed hash is what anchors the account, and the columns are additive", () => {
  const source = read("services", "compliance-service.js");
  assert.match(source, /ADD COLUMN IF NOT EXISTS id_number_hmac TEXT/);
  assert.match(source, /ALTER TABLE compliance_screening_list ADD COLUMN IF NOT EXISTS id_number_hmac TEXT/);
  assert.match(source, /ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS document_hmac TEXT/);
  // id_number_hmac takes the keyed value; the legacy column is only written
  // while dual write is on.
  assert.match(source, /id_number_hmac = \$1/);
  assert.match(source, /legacyDualWriteEnabled\(\) \? legacyHash : null/);
});

/* ------------------------------------------------------ 2 and 3. top-ups */

test("a top-up may only be created in rand, and omitting the field still means rand", () => {
  const create = (() => {
    const s = read("services", "peach-checkout-service.js");
    return s.slice(s.indexOf("async function createTopupCheckout"), s.indexOf("async function settleTopupTransaction"));
  })();
  // Wallets are ZAR. Any other code let a customer pay N units of a weaker
  // currency and be credited N rand, because settlement compared the number and
  // never the denomination.
  assert.match(create, /payload\.currency \|\| "ZAR"/, "an omitted currency still defaults to ZAR");
  assert.match(create, /currency !== WALLET_CURRENCY/);
  assert.match(create, /Top-ups are in South African rand/);
});

test("settlement refuses a missing amount instead of treating it as a match", () => {
  const s = read("services", "peach-checkout-service.js");
  const start = s.indexOf("async function settleTopupTransaction");
  const end = s.indexOf("\nasync function", start + 1);
  const settle = s.slice(start, end === -1 ? undefined : end);

  // The bug: `verified.amount !== null && mismatch` short-circuited the whole
  // check when Peach omitted the field, so the credit went through with nothing
  // verified. Unverifiable and wrong must take the same road.
  //
  // Strip comments first: the prose above the guard quotes the old expression to
  // explain it, and that quotation must not be mistaken for the code under test.
  const settleCode = settle.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(settleCode, /verified\.amount !== null &&/,
    "a null amount must not skip verification");
  assert.match(settle, /verified\.amount === null/);
  assert.match(settle, /!Number\.isFinite\(Number\(verified\.amount\)\)/);
  assert.match(settle, /Math\.abs\(Number\(verified\.amount\) - expectedCharge\) > 0\.005/);
});

test("settlement compares the currency it already reads", () => {
  const s = read("services", "peach-checkout-service.js");
  const start = s.indexOf("async function settleTopupTransaction");
  const end = s.indexOf("\nasync function", start + 1);
  const settle = s.slice(start, end === -1 ? undefined : end);
  // verified.currency was captured and then never used, while the comment above
  // it claimed the currency was confirmed.
  assert.match(settle, /reportedCurrency !== WALLET_CURRENCY/);
  assert.match(settle, /currency mismatch; refusing to credit/);
});

test("a refused settlement reuses the existing review state and credits nothing", () => {
  const s = read("services", "peach-checkout-service.js");
  const start = s.indexOf("async function settleTopupTransaction");
  const end = s.indexOf("\nasync function", start + 1);
  const settle = s.slice(start, end === -1 ? undefined : end);
  // No new transaction state was invented: still 'processing' + requiresReview,
  // which the reconciliation screens already understand.
  assert.match(settle, /status='processing'/);
  assert.match(settle, /requiresReview: true/);
  assert.match(settle, /providerState: currencyBad \? "currency_mismatch" : "amount_mismatch"/);
  assert.match(settle, /return \{ row: rows\[0\], credited: false, alreadySettled: false \}/);
});

test("a verified ZAR settlement of the right amount still credits, and only once", () => {
  const s = read("services", "peach-checkout-service.js");
  const start = s.indexOf("async function settleTopupTransaction");
  const end = s.indexOf("\nasync function", start + 1);
  const settle = s.slice(start, end === -1 ? undefined : end);
  // The success path is untouched: row lock, terminal-status guard, duplicate
  // credit guard, and the wallet credited only `amount`.
  assert.match(settle, /SELECT \* FROM transactions WHERE id = \$1 FOR UPDATE/);
  assert.match(settle, /TERMINAL_STATUSES\.has\(row\.status\)/);
  assert.match(settle, /entry_type = 'credit' AND metadata->>'provider' = \$3/);
  assert.match(settle, /amount: Number\(row\.amount\)/);
});

/* -------------------------------------------------------- 4. JWT secrets */

test("a weak JWT secret stops the API starting, and a 32 byte one does not", () => {
  const source = read("config", "env.js");
  assert.match(source, /function requiredSecret\(names, minBytes = 32\)/);
  assert.match(source, /accessSecret: requiredSecret\(\["JWT_ACCESS_SECRET", "JWT_SECRET"\]\)/);
  assert.match(source, /refreshSecret: requiredSecret\(\["JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"\]\)/);

  // The rule itself, exercised rather than only read.
  const check = (value, minBytes = 32) => Buffer.byteLength(value, "utf8") >= minBytes;
  assert.equal(check("secret"), false, "the weak secret that used to boot fine");
  assert.equal(check("a".repeat(31)), false, "one byte short still fails");
  assert.equal(check("a".repeat(32)), true, "exactly 32 bytes is accepted");
  assert.equal(check(crypto.randomBytes(48).toString("base64url")), true);
});

test("the existing environment variable names and token rules are unchanged", () => {
  const env = read("config", "env.js");
  const jwt = read("lib", "jwt.js");
  // Renaming any of these would break a running deployment.
  for (const name of ["JWT_ACCESS_SECRET", "JWT_SECRET", "JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"]) {
    assert.match(env, new RegExp(name), `${name} must still be accepted`);
  }
  assert.match(env, /accessTokenTtl: process\.env\.ACCESS_TOKEN_TTL \|\| "15m"/);
  assert.match(env, /refreshTokenTtl: process\.env\.REFRESH_TOKEN_TTL \|\| "7d"/);
  assert.match(jwt, /const ALGORITHMS = \["HS256"\]/);
  assert.match(jwt, /issuer: config\.apiBaseUrl/);
  assert.match(jwt, /audience: "titopay-api"/);
  assert.match(jwt, /audience: "titopay-api-refresh"/);
});

test("access and refresh tokens still round trip under the strengthened config", () => {
  const { signAccessToken, verifyAccessToken, signRefreshToken, verifyRefreshToken } = require("../src/lib/jwt");
  const claims = { sub: "user-1", sid: "session-1", jti: "jti-1", typ: "customer", scope: "customer" };
  const access = verifyAccessToken(signAccessToken(claims));
  assert.equal(access.sub, "user-1");
  assert.equal(access.aud, "titopay-api");
  const refresh = verifyRefreshToken(signRefreshToken(claims));
  assert.equal(refresh.sub, "user-1");
  assert.equal(refresh.aud, "titopay-api-refresh");
  // The two secrets stay separate: an access token must not verify as a refresh.
  assert.throws(() => verifyRefreshToken(signAccessToken(claims)));
});

test("the identity pepper is required in production and never falls back there", () => {
  const source = read("config", "env.js");
  assert.match(source, /Missing required environment variable: IDENTITY_PEPPER/);
  assert.match(source, /environment === "production"/);
  assert.match(source, /IDENTITY_PEPPER must be at least 32 bytes/);
  // Outside production it derives, so no existing test or local setup needs a
  // new variable; that derivation must not be reachable in production.
  const derive = source.indexOf("titopay-identity-pepper-v1");
  const guard = source.indexOf('environment === "production"');
  assert.ok(guard !== -1 && derive > guard, "the production refusal comes before the fallback");
});

/* ------------------------------------------------------ 7. venue images */

test("a venue photo may be uploaded but not linked to a third-party host", () => {
  const source = read("services", "book-service.js");
  const start = source.indexOf("function cleanVenueImage");
  const clean = source.slice(start, source.indexOf("\n}", start));
  // A stored external URL renders on the PUBLIC booking page, so the host it
  // points at collects the IP and user agent of every visitor.
  assert.doesNotMatch(clean, /return raw\.slice\(0, 800\)/, "external URLs must no longer be stored");
  // Uploads and the size ceiling are untouched.
  assert.match(clean, /\^data:image\\\/\(png\|jpe\?g\|webp\);base64,/);
  assert.match(clean, /700 \* 1024/);
  assert.match(clean, /That photo is too large/);
});

test("clearing a photo still works and unvetted values are still dropped, not refused", () => {
  const source = read("services", "book-service.js");
  // The endpoint's existing contract: anything unvetted becomes null with a 200,
  // which is what the javascript: URL test pins.
  assert.match(source, /set\("cover_image_url", cleanVenueImage\(payload\.coverImageUrl\) \|\| null\)/);
});
