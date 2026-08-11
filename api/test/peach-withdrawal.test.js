"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "withdrawal-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "withdrawal-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const payoutService = require("../src/services/peach-payout-service");
const withdrawalService = require("../src/services/peach-withdrawal-service");

const source = (...parts) => fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");

/* ------------------------------------------- the documented Peach contract */

test("Payout amounts are converted to the minor units Peach documents", () => {
  // "The amount allocated for the payout, in minor currency (that is, cents)
  // where 3443 is 34.43 in the major currency."
  assert.equal(payoutService.toMinorUnits(34.43), 3443);
  assert.equal(payoutService.toMinorUnits(500), 50000);
  assert.equal(payoutService.toMinorUnits(0.1 + 0.2), 30); // no float drift
  assert.equal(payoutService.toMinorUnits(1000.005), 100001);
  assert.equal(payoutService.fromMinorUnits(3443), 34.43);
});

test("A payout entry is built in cents, never in rands", () => {
  const entry = payoutService.buildPayoutEntry({
    payoutId: "84920878-fc32-494f-8e30-6a2465c9a456",
    currency: "ZAR", amount: 500, accountNumber: "62771234567", branchCode: "250655",
    reference: "Rent money", bankName: "FNB", accountHolder: "Test User", payoutMethod: "realtime-eft"
  });
  assert.equal(entry.amount, 50000, "R500 must be sent as 50000 cents");
  assert.equal(entry.currency, "ZAR");
  assert.equal(entry.payoutMethod, "realtime-eft");
});

test("Peach's documented constraints are enforced before a request is sent", () => {
  const base = {
    currency: "ZAR", amount: 500, accountNumber: "62771234567", branchCode: "250655",
    reference: "Rent", bankName: "FNB", accountHolder: "Test User", payoutMethod: "realtime-eft"
  };
  const rejects = (patch, why) => assert.throws(
    () => payoutService.buildPayoutEntry({ ...base, ...patch }), /PAYOUT_DETAILS_INCOMPLETE|incomplete/i, why
  );
  rejects({ amount: 5 }, "below the 1000-cent minimum");
  rejects({ amount: 5000001 }, "above the 500000000-cent maximum");
  rejects({ branchCode: "25065" }, "branch code must be 6 digits");
  rejects({ branchCode: "abcdef" }, "branch code must be digits");
  rejects({ bankName: "MY LOCAL BANK" }, "bank must be one Peach supports");
  rejects({ accountNumber: "" }, "account number is required");
  rejects({ payoutMethod: "instant-eft" }, "payoutMethod is an enum of one");
  rejects({ currency: "USD" }, "only ZAR");
  rejects({ payoutId: "NOT-A-UUID" }, "payoutId must be a v4 UUID");
});

test("R5,000,000 is the documented maximum and R10 the minimum", () => {
  assert.equal(payoutService.MIN_PAYOUT_CENTS, 1000);
  assert.equal(payoutService.MAX_PAYOUT_CENTS, 500000000);
  const ok = (rands) => payoutService.buildPayoutEntry({
    currency: "ZAR", amount: rands, accountNumber: "1", branchCode: "250655",
    reference: "Ref", bankName: "ABSA", accountHolder: "Test User", payoutMethod: "realtime-eft"
  });
  assert.equal(ok(10).amount, 1000);
  assert.equal(ok(5000000).amount, 500000000);
});

test("References are reduced to the alphabet Peach accepts", () => {
  // ^(?! )[A-Za-z0-9 ]{1,20}(?<! )$ — a TitoPay reference has hyphens.
  const clean = payoutService.toPayoutReference("TP-WD-MSJ0QT8V-F015C7A1");
  assert.match(clean, /^[A-Za-z0-9 ]{1,20}$/);
  assert.doesNotMatch(clean, /-/);
  assert.equal(payoutService.toPayoutReference("   "), "TitoPay", "never empty");
  assert.ok(payoutService.toPayoutReference("x".repeat(50)).length <= 20);
  assert.doesNotMatch(payoutService.toPayoutReference(" leading"), /^ /);
});

test("Account holder names are reduced to the pattern Peach accepts", () => {
  // An apostrophe is outside Peach's alphabet. It becomes a space rather than
  // being dropped, and the saved value is shown back to the customer so they
  // can correct it if their bank has it differently.
  const holder = payoutService.toAccountHolder("Thabo O'Brien-Smith");
  assert.equal(holder, "Thabo O Brien-Smith");
  assert.match(holder, /^[a-zA-Z0-9]([ .-](?![ .-])|[a-zA-Z0-9]){0,48}[a-zA-Z0-9]$/);
  assert.equal(payoutService.toAccountHolder("A"), "", "too short is rejected, not padded");
  assert.ok(payoutService.toAccountHolder("x".repeat(80)).length <= 50);
});

test("Only the 24 banks Peach lists are accepted", () => {
  assert.equal(payoutService.SUPPORTED_BANKS.length, 24);
  assert.equal(payoutService.normalizeBankName("capitec bank"), "CAPITEC BANK");
  assert.equal(payoutService.normalizeBankName("  FNB  "), "FNB");
  assert.equal(payoutService.normalizeBankName("Bank of Nowhere"), "");
});

/* ------------------------------------------------------- status mapping */

test("Peach's payout statuses map to TitoPay states without inventing outcomes", () => {
  const map = withdrawalService.transactionStatusForPayout;
  assert.equal(map("successful"), "completed");
  assert.equal(map("failed"), "failed");
  assert.equal(map("cancelled"), "cancelled");
  assert.equal(map("reversed"), "failed");
  // The two non-outcomes must never become a customer-visible failure.
  assert.equal(map("pending"), "processing");
  assert.equal(map("processing"), "processing");
  // Anything unrecognised is treated as still in flight, never as an outcome.
  assert.equal(map("something-new"), "processing");
  assert.equal(map(""), "processing");
  assert.equal(map(undefined), "processing");
});

test("Peach accepting the request is not a completed withdrawal", () => {
  const create = source("services", "peach-withdrawal-service.js");
  const submit = create.slice(create.indexOf("async function submitWithdrawalToPeach"), create.indexOf("function submissionIsDefiniteRejection"));
  // The status written after submission comes from Peach's own payout status,
  // which is `pending` on creation — it is never hard-coded to completed.
  assert.match(submit, /transactionStatusForPayout\(payoutStatus\)/);
  assert.doesNotMatch(submit, /status\s*=\s*['"]completed['"]/);
});

/* -------------------------------------------------------- money safety */

test("An uncertain submission never releases the debit", () => {
  const isDefinite = withdrawalService.submissionIsDefiniteRejection;
  // Peach validated and said no: nothing exists, release is safe.
  assert.equal(isDefinite({ details: { providerStatus: 400 } }), true);
  assert.equal(isDefinite({ details: { code: "PAYOUT_DETAILS_INCOMPLETE" } }), true);
  // Might have been created: releasing could pay the customer twice.
  assert.equal(isDefinite({ details: { providerStatus: 500 } }), false);
  assert.equal(isDefinite({ details: { providerStatus: 503 } }), false);
  assert.equal(isDefinite({ details: { providerStatus: 408 } }), false, "timeout is not a rejection");
  assert.equal(isDefinite({ details: { providerStatus: 429 } }), false, "throttling is not a rejection");
  assert.equal(isDefinite({}), false, "a network error is never a definite no");
});

test("The reversal amount is read from the ledger, never from the caller", () => {
  const release = source("services", "peach-withdrawal-service.js");
  const fn = release.slice(release.indexOf("async function releaseWithdrawalFunds"), release.indexOf("async function applyPayoutOutcome"));
  // Row lock first.
  assert.match(fn, /SELECT \* FROM transactions WHERE id = \$1 FOR UPDATE/);
  // Terminal transactions no-op.
  assert.match(fn, /TERMINAL_TRANSACTION_STATUSES\.has\(row\.status\)/);
  // A second reversal is impossible even if the status were rewound.
  assert.match(fn, /entry_type = 'credit' AND metadata->>'stage' = 'withdrawal_reversed'/);
  // The credited amount is summed from the actual debit rows.
  assert.match(fn, /entry_type = 'debit' AND metadata->>'stage' = 'withdrawal_submitted'/);
  assert.match(fn, /amount: debited/);
  // Never a caller-supplied figure.
  assert.doesNotMatch(fn, /amount: (patch|verified|payload)\./);
});

test("The debit happens in the same transaction as the balance check", () => {
  const create = source("services", "peach-withdrawal-service.js");
  const fn = create.slice(create.indexOf("async function createWithdrawal"), create.indexOf("async function submitWithdrawalToPeach"));
  const beginAt = fn.indexOf('client.query("BEGIN")');
  const lockAt = fn.indexOf("FOR UPDATE");
  const checkAt = fn.indexOf("INSUFFICIENT_BALANCE");
  const debitAt = fn.indexOf('entryType: "debit"');
  const commitAt = fn.indexOf('client.query("COMMIT")');
  assert.ok(beginAt > -1 && lockAt > beginAt, "the wallet is locked inside the transaction");
  assert.ok(checkAt > lockAt, "the balance is checked after the lock");
  assert.ok(debitAt > checkAt, "the debit follows the check");
  assert.ok(commitAt > debitAt, "all of it commits together");
  // And Peach is only contacted after the commit.
  assert.ok(fn.indexOf("submitWithdrawalToPeach") > commitAt, "Peach is called after the commit, not while holding the lock");
});

test("Insufficient balance is refused before Peach is contacted", () => {
  const create = source("services", "peach-withdrawal-service.js");
  const fn = create.slice(create.indexOf("async function createWithdrawal"), create.indexOf("async function submitWithdrawalToPeach"));
  assert.match(fn, /INSUFFICIENT_BALANCE/);
  assert.match(fn, /No wallet debit was made/);
  // The check covers amount AND fee.
  assert.match(fn, /available \+ 0\.005 < total/);
});

test("A successful payout moves no money — the debit already happened", () => {
  const apply = source("services", "peach-withdrawal-service.js");
  const fn = apply.slice(apply.indexOf('if (nextStatus === "completed")'), apply.indexOf('if (nextStatus === "failed"'));
  assert.doesNotMatch(fn, /applyWalletMovement/);
  assert.match(fn, /TERMINAL_TRANSACTION_STATUSES\.has\(row\.status\)/);
});

/* ------------------------------------------------------------- security */

test("The withdrawal request never accepts bank details from the browser", () => {
  const routes = source("routes", "payouts.routes.js");
  const create = source("services", "peach-withdrawal-service.js");
  // The route passes the body through; the service reads ONLY a saved account.
  assert.match(create, /listBankAccountRecord\(actor\.userId, payload\.bankAccountId\)/);
  for (const field of ["payload.accountNumber", "payload.branchCode", "payload.bankName", "payload.accountHolder"]) {
    assert.ok(!create.includes(field), `${field} must never be taken from the request body`);
  }
  assert.match(routes, /requireAuth/);
});

test("Bank account numbers are never returned in full", () => {
  const accounts = source("services", "payout-account-service.js");
  const publicShape = accounts.slice(accounts.indexOf("function publicAccount"), accounts.indexOf("function listSupportedBanks"));
  assert.match(publicShape, /maskAccountNumber\(row\.account_number\)/);
  // The only raw exposure is the last four digits, which identify the account
  // to its owner and nothing more.
  assert.doesNotMatch(publicShape, /accountNumber: row\.account_number/);

  const { maskAccountNumber } = accounts.includes("maskAccountNumber") ? require("../src/services/payout-account-service") : {};
  assert.equal(maskAccountNumber("62771234567"), "••••4567");
  assert.equal(maskAccountNumber(""), "");
});

test("Nothing in the withdrawal path returns a credential to the caller", () => {
  for (const file of [
    ["services", "peach-withdrawal-service.js"],
    ["services", "payout-account-service.js"],
    ["routes", "payouts.routes.js"],
    ["routes", "payout-webhook.routes.js"]
  ]) {
    const text = source(...file);
    for (const secret of ["clientSecret", "access_token"]) {
      assert.ok(!new RegExp(`res\\.json\\([^)]*${secret}`).test(text), `${file.join("/")} must not serialise ${secret}`);
    }
  }
});

/* -------------------------------------------------------------- webhook */

test("The payout webhook decides nothing on its own", () => {
  const hook = source("routes", "payout-webhook.routes.js");
  const settle = source("services", "peach-withdrawal-service.js");
  const fn = settle.slice(settle.indexOf("async function settleWithdrawalFromWebhook"));
  // The body's status is never used; only the payoutId is read, and the real
  // status is fetched from Peach.
  assert.match(hook, /settleWithdrawalFromWebhook\(\{ payoutId \}\)/);
  assert.match(fn, /verifyWithPeach\(row\)/);
  assert.ok(!/payload\.status/.test(fn), "the webhook's own status claim must never be used");
  // An unknown payout is answered the same way as a known one.
  assert.match(hook, /res\.status\(202\)/);
});

test("A withdrawal is only ever settled from Peach's own answer", () => {
  const settle = source("services", "peach-withdrawal-service.js");
  const verify = settle.slice(settle.indexOf("async function verifyWithPeach"), settle.indexOf("async function findWithdrawalForActor"));
  assert.match(verify, /queryPayoutRequest\(payoutRequestId\)/);
  assert.match(verify, /findPayoutInResponse\(payload, metadata\.payoutId\)/);
  assert.match(verify, /normalizePayoutStatus\(entry\.status\)/);
});

/* -------------------------------------------------- the gate that changed */

test("The withdrawal flag is gone because the lifecycle now exists", () => {
  const gate = source("services", "transaction-service.js");
  // The flag itself is gone: no declaration, no read, no throw. Only the
  // comment explaining why it existed remains.
  assert.doesNotMatch(gate, /const PAYOUT_PROCESSING_ENABLED/, "the placeholder flag must be removed, not bypassed");
  assert.doesNotMatch(gate, /if \(!PAYOUT_PROCESSING_ENABLED\)/);
  assert.doesNotMatch(gate, /code: "PAYOUT_PROCESSING_NOT_ENABLED"/);
  assert.doesNotMatch(gate, /Withdrawals are not open yet/);
  // The safety it stood in for: the wallet-debit endpoint still cannot be used.
  const live = gate.slice(gate.indexOf("async function assertLiveTransactionSupported"));
  assert.match(live.slice(0, 1200), /PEACH_PAYOUT_SERVICES\.has\(normalizedServiceCode\)[\s\S]{0,240}USE_WITHDRAWAL_FLOW/);
  // The provider link is still checked at the fee preview.
  const launched = gate.slice(gate.indexOf("async function assertServiceLaunched"), gate.indexOf("async function assertLiveTransactionSupported"));
  assert.match(launched, /payoutAvailability\(\)/);
  assert.match(launched, /assertPayoutAvailable/);
});

test("Personal withdrawals and business payouts share one lifecycle", () => {
  for (const code of ["withdraw", "withdraw_money_to_bank", "bank_withdrawal", "bank_transfer"]) {
    assert.ok(withdrawalService.PERSONAL_WITHDRAWAL_SERVICES.has(code), `${code} is a personal withdrawal`);
    assert.ok(withdrawalService.isWithdrawalService(code));
  }
  for (const code of ["payouts", "business_payout", "merchant_payout", "merchant_payouts", "seller_payout"]) {
    assert.ok(withdrawalService.BUSINESS_PAYOUT_SERVICES.has(code), `${code} is a business payout`);
    assert.ok(withdrawalService.isWithdrawalService(code));
  }
  assert.equal(withdrawalService.isWithdrawalService("wallet_transfer"), false);
  assert.equal(withdrawalService.isWithdrawalService("wallet_top_up"), false);
});

test("The business Payouts tile has an approved price", () => {
  // Its service code is "payouts"; without a schedule entry a fee preview
  // auto-created a zero-fee rule and business payouts would have been free.
  const pricing = source("services", "pricing-service.js");
  assert.match(pricing, /\["payouts", "Business Payout", 0, 0, 1\.5\]/);
});
