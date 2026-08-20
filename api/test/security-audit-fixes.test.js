"use strict";

// Fixes from the 20 August 2026 security audit (six-dimension adversarial
// sweep). Each test pins one finding, driven against the real database where
// the flow allows, or against the source where the sink is not directly
// callable.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "audit-test-access-secret-with-len-32-bytes!";
process.env.JWT_REFRESH_SECRET ||= "audit-test-refresh-secret-with-len-32-byte";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");
const { requestPasswordReset } = require("../src/services/auth-service");
const { confirmEmailPasswordReset } = require("../src/services/email-centre-service");

const API = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(API, ...p), "utf8");
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const stamp = Date.now().toString(36);

/* ---- Finding: email-link reset bypassed the password strength policy ---- */

test("email-link reset enforces the strength policy (business account, weak password refused)", async () => {
  const bizId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash)
     VALUES ($1,'business','Audit Biz',$2,$3,$4)`,
    [bizId, `audit_biz_${stamp}`, `audit_biz_${stamp}@t.local`, await hashPassword("StrongOld#2026Pw")]
  );
  const token = `tok_${stamp}_${crypto.randomBytes(6).toString("hex")}`;
  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_type, user_id, token_hash, expires_at)
     VALUES ($1,'customer',$2,$3, NOW() + INTERVAL '10 minutes')`,
    [crypto.randomUUID(), bizId, sha256(token)]
  );
  try {
    await assert.rejects(
      confirmEmailPasswordReset(token, "1234", { ipAddress: "127.0.0.1" }),
      /at least|characters|password/i,
      "a 4-char password on a business account must be refused by the policy, not accepted"
    );
    // The token must survive the rejection (rolled back), so a real reset works.
    const { rows } = await pool.query("SELECT used_at FROM password_reset_tokens WHERE token_hash=$1", [sha256(token)]);
    assert.equal(rows[0].used_at, null, "a policy rejection must not consume the reset link");
  } finally {
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id=$1", [bizId]);
    await pool.query("DELETE FROM users WHERE id=$1", [bizId]);
  }
});

test("both reset doors call the strength policy (source pin)", () => {
  const email = read("src", "services", "email-centre-service.js");
  assert.match(email, /const policyProblem = passwordPolicyProblem\(newPassword, \{ accountType \}\)/,
    "the email-link door must run the same policy the OTP door does");
  assert.match(read("src", "services", "auth-service.js"), /passwordPolicyProblem\(newPassword/,
    "the OTP door still runs it too");
});

/* ---- Finding: reset request was an existence + internal-UUID oracle ---- */

test("an unknown identifier gets a uniform reset response, with no existence signal and no UUID", async () => {
  // Behavioural on the unknown path (creates no row, sends no SMS). The known
  // path needs a live SMS provider to complete, so its equal shape is pinned
  // at the source below.
  const miss = await requestPasswordReset({ identifier: `no_such_user_${stamp}` }, { ipAddress: "127.0.0.1" });
  assert.equal(miss.accountId, undefined, "no internal UUID to an unauthenticated caller");
  assert.equal(miss.userId, undefined);
  assert.equal(miss.accepted, undefined, "the old {accepted:true} tell is gone");
  assert.ok(miss.challengeId, "a synthetic challengeId is returned");
  assert.equal(miss.otpRequired, true);
  assert.ok(miss.maskedDestination, "and a decoy masked destination");
});

test("the known-user reset response no longer leaks the internal UUID (source pin)", () => {
  const auth = read("src", "services", "auth-service.js");
  const fn = auth.slice(auth.indexOf("async function requestPasswordReset"), auth.indexOf("async function confirmPasswordReset"));
  // The unauthenticated reset must not return accountId/userId. (The separate
  // authenticated requestPasswordChangeOtp legitimately returns the caller's
  // own id and is outside this function.)
  assert.doesNotMatch(fn, /return \{ accountId: user\.id, userId: user\.id/,
    "requestPasswordReset must not return the internal user UUID");
  assert.match(fn, /return \{ \.\.\.challenge \}/, "it returns only the challenge (challengeId + masked destination)");
});

/* ---- Finding: ticket admission codes used Math.random ---- */

test("ticket codes are minted with a CSPRNG, not Math.random", () => {
  const src = read("src", "services", "ticketing-service.js");
  assert.match(src, /const code = String\(randomInt\(10 \*\* digits\)\)/, "admission codes come from crypto.randomInt");
  assert.doesNotMatch(src, /Math\.floor\(Math\.random\(\) \* \(10 \*\* digits\)\)/,
    "the predictable Math.random code line must be gone");
});

/* ---- Finding: rate-limit store failed OPEN on a counter-write error ---- */

test("the rate-limit store degrades to in-memory counting on error, never fully open", () => {
  const src = read("src", "lib", "rate-limit-store.js");
  const inc = src.slice(src.indexOf("async increment(key)"), src.indexOf("async decrement(key)"));
  assert.doesNotMatch(inc, /return \{ totalHits: 1, resetTime/, "the constant fail-open return in increment must be gone");
  assert.match(inc, /return this\.fallbackIncrement\(key, 1\)/,
    "on error increment falls back to the in-memory counter, which still enforces a ceiling");
});

/* ---- Finding: withdrawal fee debited but never booked to revenue ---- */

test("withdrawal books the fee to revenue at settlement success, once, idempotently", () => {
  const src = read("src", "services", "peach-withdrawal-service.js");
  assert.match(src, /async function recordWithdrawalFeeRevenue/, "there is a fee-revenue booking for withdrawals");
  const fn = src.slice(src.indexOf("async function recordWithdrawalFeeRevenue"));
  const body = fn.slice(0, fn.indexOf("\n// Apply what Peach"));
  assert.match(body, /SELECT id FROM revenue_ledger WHERE transaction_id = \$1/, "idempotent on revenue_ledger");
  assert.match(body, /INSERT INTO revenue_ledger/, "it writes the revenue ledger row");
  assert.match(body, /getRevenueWallet/, "and credits the revenue wallet");
  // Booked in the completed branch only, after the customer debit, never at submission or on failure.
  const settle = src.slice(src.indexOf('if (nextStatus === "completed")'));
  assert.match(settle.slice(0, 900), /recordWithdrawalFeeRevenue\(client, row\)/,
    "the fee is booked at settlement success, so a failed+reversed withdrawal collects nothing");
});

/* ---- Finding: refresh path did not enforce session expiry ---- */

test("the refresh path enforces the session's expires_at", () => {
  const src = read("src", "services", "auth-service.js");
  const fn = src.slice(src.indexOf("async function refreshTokens"));
  assert.match(fn.slice(0, 700), /s\.expires_at > NOW\(\)/,
    "a lapsed session must not be refreshable; the access path already enforces this");
});
