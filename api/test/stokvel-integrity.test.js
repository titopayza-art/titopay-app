"use strict";

// Stokvel money integrity and join abuse.
//
// Three defects this pins, each named by what went wrong rather than by what
// the code now says.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = (...parts) => path.join(__dirname, "..", "src", ...parts);
const read = (...parts) => fs.readFileSync(SRC(...parts), "utf8");

/* ---------------------------------------- a total is counted, not paged */

test("group and member totals are summed in SQL, never over the capped display page", () => {
  const source = read("services", "stockvel-service.js");

  // contributionRows is a DISPLAY query and keeps its cap. Summing it was the
  // bug: ORDER BY created_at DESC LIMIT 500 drops the OLDEST rows, so a group
  // past 500 contributions watched its recorded savings go DOWN. Twenty members
  // contributing monthly cross 500 records inside 26 months.
  assert.match(source, /LIMIT 500/, "the register display stays capped");

  const totals = source.slice(source.indexOf("async function contributionTotals"));
  assert.match(totals.slice(0, 900), /SUM\(t\.amount\)/, "the group total comes from SUM");
  assert.match(totals.slice(0, 900), /FILTER \(WHERE t\.user_id = \$2::uuid\)/,
    "a member's own total is filtered in SQL, not over the fetched page");
  assert.match(totals.slice(0, 900), /status = 'completed'/, "only settled money counts");
  assert.match(totals.slice(0, 900), /service_code IN \('stockvel', 'stockvel_contribution'\)/,
    "both historic service codes still count, or old contributions vanish");

  // groupBalance must take the SQL total, not rebuild one from rows.
  const balance = source.slice(source.indexOf("async function groupBalance"));
  assert.match(balance.slice(0, 500), /await contributionTotals\(groupId\)/);
  assert.doesNotMatch(balance.slice(0, 500), /contributionRows\(/,
    "the balance must not be derived from the capped page again");

  // And the per-member figure on the detail screen.
  assert.match(source, /const \{ mine: myContribution \} = await contributionTotals\(groupId, userId\)/);
  assert.doesNotMatch(source, /contributions\.filter\(\(row\) => row\.user_id === userId\)/,
    "the old page-filtered member total must be gone");
});

/* ------------------------------- a post-commit failure is not a failure */

test("a failed audit write cannot report a completed transfer as failed", () => {
  const source = read("services", "transaction-service.js");

  // The money commits, then the audit line is written. An unguarded throw there
  // told the caller the payment failed on a payment that had SUCCEEDED, and the
  // customer's next move is to pay again. Observed for real: 28 contributions
  // committed, 141 ledger rows written, every call raised an error.
  const completion = source.slice(source.indexOf('action: "transaction_completed"') - 900);
  assert.match(completion.slice(0, 1600),
    /\}\)\.catch\(\(error\) => \{[\s\S]{0,320}audit log not written; the transfer still stands/,
    "the completion audit write must be guarded");

  const reversal = source.slice(source.indexOf('action: "transaction_reversed"') - 400);
  assert.match(reversal.slice(0, 1200),
    /\}\)\.catch\(\(error\) => \{[\s\S]{0,320}reversal audit log not written; the reversal still stands/,
    "the reversal audit write must be guarded the same way");

  // The pattern the codebase already used for notifications, and the reason.
  assert.match(source, /notification failure can never undo a transfer/);
});

/* --------------------------------------- guessing an invite code costs */

test("both ways into a stokvel are rate limited, in their own bucket", () => {
  const routes = read("routes", "stockvel.routes.js");
  const limits = read("middleware", "rate-limits.js");

  // SV + eight digits is 10^8, and the general fairness cap allowed 172,800
  // attempts a day from one address. A hit is instant active membership with no
  // approval, and full sight of the register: names, amounts, and the chat.
  assert.match(routes, /router\.post\("\/join", stokvelJoinLimiter, run\(/);
  assert.match(routes, /router\.post\("\/invitations\/:id\/accept", stokvelJoinLimiter, run\(/,
    "the invitation path passes its id straight to joinByCode, so it needs the same limit");

  assert.match(limits, /const stokvelJoinLimiter = rateLimit\(\{[\s\S]{0,200}sensitiveLimiterOptions/,
    "join uses the five-per-fifteen-minutes sensitive policy");
  assert.match(limits, /store: sharedStore\("stokvel-join"\)/,
    "its OWN store: sharing authLimiter's would let mistyped codes eat login attempts");
  assert.match(limits, /handler: rateLimitHandler\("stokvel_join", 15 \* 60\)/);
  assert.match(limits, /stokvelJoinLimiter,/, "and it is exported");

  // The sensitive key includes the authenticated identity, which is what stops
  // shared carrier NAT making one customer lock out another.
  assert.match(limits, /const authenticatedIdentity = req\.auth\?\.userId/);
});

test("the join limiter did not disturb the limits already protecting auth", () => {
  const limits = read("middleware", "rate-limits.js");
  // Regression guard: the new bucket must not have changed the existing ones.
  assert.match(limits, /const authLimiter = rateLimit\(\{[\s\S]{0,120}store: sharedStore\("auth"\)/);
  assert.match(limits, /const otpLimiter = rateLimit\(\{[\s\S]{0,200}store: sharedStore\("otp"\)/);
  assert.match(limits, /max: 5,/, "the sensitive policy is still five attempts");
  assert.match(limits, /windowMs: SENSITIVE_WINDOW_MS/);
  for (const name of ["authLimiter", "otpLimiter", "generalLimiter", "publicContactLimiter",
    "publicBookingLimiter", "registrationLimiter", "passwordResetLimiter", "pinLimiter",
    "accountRecoveryLimiter"]) {
    assert.match(limits, new RegExp(`${name}[,:]`), `${name} must still be exported`);
  }
});

/* ------------------------------------ the client half of the retry bug */

test("a stokvel contribution reuses its idempotency key across a retry", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");
  const fn = app.slice(app.indexOf("async function submitStockvelContribution"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // Minting a fresh key per submit meant the key could not cover the one case it
  // exists for: a contribution that succeeded but reported an error, where the
  // member taps again and pays twice.
  assert.doesNotMatch(body, /idempotencyKey: createClientTransactionKey/,
    "a key minted inside the request is regenerated on every retry");
  assert.match(body, /form\.dataset\.contributionKey \|\|= createClientTransactionKey\("stockvel_contribution"\)/,
    "minted once per attempt and held on the form");
  assert.match(body, /idempotencyKey: form\.dataset\.contributionKey/);
  assert.match(body, /delete form\.dataset\.contributionKey/,
    "cleared on success, so a second deliberate contribution is not mistaken for a repeat");

  // Order matters: the key must be cleared only AFTER the call resolves.
  assert.ok(body.indexOf("await api(") < body.indexOf("delete form.dataset.contributionKey"),
    "the key is cleared after the request succeeds, never before");
});
