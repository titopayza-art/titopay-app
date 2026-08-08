"use strict";

// A transaction row is an attempt. Only a wallet_ledger entry is money.
// These tests hold both halves of that line: the API must report what the
// ledger posted, and the statement must total nothing else.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "statement-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "statement-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const appSource = fs.readFileSync(path.join(__dirname, "../../app/app.js"), "utf8");
const apiSource = (...parts) => fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");

// Pull the real statement functions out of the PWA bundle and run them, so
// these assertions test the arithmetic the customer's PDF actually uses rather
// than a copy of it.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in app.js`);
  // Skip the parameter list first — a default like `item = {}` contains braces
  // of its own, so the body starts at the brace after the closing paren.
  let parens = 0;
  let cursor = source.indexOf("(", start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parens += 1;
    else if (source[cursor] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  let depth = 0;
  let index = source.indexOf("{", cursor);
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`could not close ${name}`);
}

const sandbox = vm.createContext({ Math, Number, String, Boolean, JSON });
for (const name of ["transactionIsCredit", "transactionPostedToWallet", "statementPostedAmount", "statementAttemptedAmount", "statementAmountNumber"]) {
  vm.runInContext(extractFunction(appSource, name), sandbox);
}
const {
  transactionIsCredit, transactionPostedToWallet,
  statementPostedAmount, statementAttemptedAmount, statementAmountNumber
} = sandbox;

// The eight rows from the reported statement: R500 and R200 top-ups, each
// carrying the R6 fee in `total`, none of which Peach ever confirmed.
const REJECTED_TOPUPS = [500, 500, 200, 200, 200, 500, 500, 200].map((amount, index) => ({
  id: `txn-${index}`,
  reference: `TP-TOPUP-REJECTED-${index}`,
  service_code: "wallet_top_up",
  direction: "credit",
  status: index % 2 === 0 ? "failed" : "pending",
  amount,
  fee: 6,
  total: amount + 6,
  wallet_posted: false,
  posted_amount: 0
}));

const CONFIRMED_TOPUP = {
  id: "txn-good",
  reference: "TP-TOPUP-CONFIRMED",
  service_code: "wallet_top_up",
  direction: "credit",
  status: "completed",
  amount: 500,
  fee: 6,
  total: 506,
  wallet_posted: true,
  posted_amount: 500
};

const SETTLED_PURCHASE = {
  id: "txn-airtime",
  reference: "TP-AIRTIME-1",
  service_code: "airtime",
  direction: "debit",
  status: "completed",
  amount: 100,
  fee: 2,
  total: 102,
  wallet_posted: true,
  posted_amount: -102
};

// The statement's own arithmetic, lifted verbatim from statementPdf.
function statementTotals(items) {
  const posted = items.filter(transactionPostedToWallet);
  const totalIn = posted.filter(transactionIsCredit).reduce((sum, item) => sum + statementAmountNumber(item), 0);
  const totalOut = posted.filter((item) => !transactionIsCredit(item)).reduce((sum, item) => sum + statementAmountNumber(item), 0);
  return { posted, attempts: items.filter((item) => !transactionPostedToWallet(item)), totalIn, totalOut, net: totalIn - totalOut };
}

/* ------------- failed payments can never increase a wallet total ---------- */

test("the eight rejected top-ups contribute nothing to TOTAL IN", () => {
  const totals = statementTotals(REJECTED_TOPUPS);
  assert.equal(totals.totalIn, 0);
  assert.equal(totals.totalOut, 0);
  assert.equal(totals.net, 0);
  // The exact figure the customer was shown must be impossible to reach.
  assert.notEqual(totals.totalIn, 2848);
});

test("no individual unconfirmed top-up is counted, whatever its status", () => {
  for (const status of ["pending", "processing", "failed", "cancelled", "declined", "expired", "reversed", ""]) {
    const row = { ...CONFIRMED_TOPUP, status, wallet_posted: false, posted_amount: 0 };
    assert.equal(transactionPostedToWallet(row), false, status || "(blank)");
    assert.equal(statementTotals([row]).totalIn, 0, status || "(blank)");
  }
});

test("a status of completed cannot override the ledger saying nothing posted", () => {
  // The decisive field is the ledger's, not the transaction's own status.
  const row = { ...CONFIRMED_TOPUP, status: "completed", wallet_posted: false, posted_amount: 0 };
  assert.equal(transactionPostedToWallet(row), false);
  assert.equal(statementTotals([row]).totalIn, 0);
});

test("attempts are still disclosed, just never totalled", () => {
  const totals = statementTotals([...REJECTED_TOPUPS, CONFIRMED_TOPUP]);
  assert.equal(totals.attempts.length, 8);
  assert.equal(totals.posted.length, 1);
  // Their attempted value stays available for the labelled disclosure block.
  assert.equal(statementAttemptedAmount(REJECTED_TOPUPS[0]), 506);
});

/* ------------------ only confirmed payments reach the totals -------------- */

test("only the confirmed top-up appears in TOTAL IN", () => {
  const totals = statementTotals([...REJECTED_TOPUPS, CONFIRMED_TOPUP]);
  assert.equal(totals.totalIn, 500);
  assert.equal(totals.net, 500);
});

test("a credit totals the amount, never amount plus fee", () => {
  // R500 into the wallet; the R6 fee rides on the card charge and never
  // becomes money received.
  assert.equal(statementAmountNumber(CONFIRMED_TOPUP), 500);
  assert.notEqual(statementAmountNumber(CONFIRMED_TOPUP), 506);
  assert.equal(statementTotals([CONFIRMED_TOPUP]).totalIn, 500);
});

test("a debit totals what actually left the wallet, fee included", () => {
  assert.equal(statementAmountNumber(SETTLED_PURCHASE), 102);
  const totals = statementTotals([CONFIRMED_TOPUP, SETTLED_PURCHASE]);
  assert.equal(totals.totalIn, 500);
  assert.equal(totals.totalOut, 102);
  assert.equal(totals.net, 398);
});

test("the statement net equals the sum of posted ledger movement", () => {
  const items = [...REJECTED_TOPUPS, CONFIRMED_TOPUP, SETTLED_PURCHASE];
  const ledgerNet = items.reduce((sum, item) => sum + Number(item.posted_amount || 0), 0);
  assert.equal(statementTotals(items).net, ledgerNet);
});

test("an API that cannot report the ledger falls back to the strictest reading", () => {
  // Older payloads carry no wallet_posted. A completed row is accepted; a
  // pending or failed one is not, and a credit still uses amount over total.
  const legacyPending = { direction: "credit", status: "pending", amount: 500, total: 506 };
  const legacyDone = { direction: "credit", status: "completed", amount: 500, total: 506 };
  assert.equal(transactionPostedToWallet(legacyPending), false);
  assert.equal(transactionPostedToWallet(legacyDone), true);
  assert.equal(statementPostedAmount(legacyDone), 500);
  assert.equal(statementTotals([legacyPending, legacyDone]).totalIn, 500);
});

test("posted_amount is trusted over amount when the two disagree", () => {
  // A partially settled or adjusted movement reports what the ledger holds.
  const row = { ...CONFIRMED_TOPUP, posted_amount: 450 };
  assert.equal(statementAmountNumber(row), 450);
});

/* --------------------------- the API's own answer ------------------------- */

test("the transactions API derives wallet_posted and posted_amount from the ledger", () => {
  const source = apiSource("services", "transaction-service.js");
  assert.match(source, /FROM wallet_ledger wl\s+WHERE wl\.transaction_id = t\.id AND wl\.wallet_id = t\.wallet_id/);
  assert.match(source, /\(posted\.entry_count > 0\) AS wallet_posted/);
  assert.match(source, /posted\.net_posted AS posted_amount/);
  // Signed by entry type, because every ledger entry is a balance delta.
  assert.match(source, /WHEN wl\.entry_type IN \('credit', 'release'\) THEN ABS\(wl\.amount\)/);
  assert.match(source, /WHEN wl\.entry_type IN \('debit', 'reserve'\) THEN -ABS\(wl\.amount\)/);
});

test("the wallet is credited in exactly one place, behind a verified success", () => {
  const source = apiSource("services", "peach-checkout-service.js");
  const credits = source.match(/applyWalletMovement\(/g) || [];
  assert.equal(credits.length, 1, "exactly one wallet movement call in the top-up service");
  // It sits after the success gate and credits `amount`, never `total`.
  assert.match(source, /if \(verified\.providerState !== "successful"\)/);
  assert.match(source, /entryType: "credit",\s*\n\s*amount: Number\(row\.amount\)/);
  // And behind a row lock plus a ledger existence check.
  assert.match(source, /SELECT \* FROM transactions WHERE id = \$1 FOR UPDATE/);
  assert.match(source, /FROM wallet_ledger\s+WHERE transaction_id = \$1 AND entry_type = 'credit'/);
});

test("a top-up row is created pending and is only ever marked failed on a provider error", () => {
  const source = apiSource("services", "peach-checkout-service.js");
  assert.match(source, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$8,\$9,'pending','credit'/);
  assert.match(source, /UPDATE transactions SET status='failed'[\s\S]{0,200}PROVIDER_REQUEST_FAILED/);
});

test("the emailed statement reads the wallet ledger, not the transaction table", () => {
  const source = apiSource("services", "wallet-service.js");
  assert.match(source, /money_in_total[\s\S]{0,400}FROM wallet_ledger wl/);
  assert.ok(!/FROM transactions[\s\S]{0,200}money_in/.test(source), "money in must never come from transactions");
});

test("the audit script is read-only", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "audit-topup-integrity.js"), "utf8");
  const withoutComments = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "DROP", "ALTER", "BEGIN", "COMMIT"]) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(withoutComments), `the audit must never ${verb}`);
  }
});

/* ------------------------------ presentation ------------------------------ */

test("Activity never dresses an unposted attempt as money in", () => {
  const source = appSource.slice(appSource.indexOf("function activityList("), appSource.indexOf("function transactionKey("));
  assert.match(source, /const settled = transactionPostedToWallet\(item\)/);
  assert.match(source, /attempted, no money moved/);
  // The credit colour class is gated on the ledger, not the direction alone.
  assert.match(source, /settled && direction === "credit" \? "credit" : ""/);
});

test("the statement totals and the payout report both filter on posted movement", () => {
  assert.match(appSource, /const posted = items\.filter\(transactionPostedToWallet\)/);
  assert.match(appSource, /const totalIn = posted\.filter\(transactionIsCredit\)/);
  assert.match(appSource, /if \(!key\.includes\("payout"\) && !key\.includes\("settlement"\)\) return false;\s*\n\s*return transactionPostedToWallet\(item\);/);
});

test("the CSV export carries the ledger columns a reconciliation needs", () => {
  assert.match(appSource, /"Posted To Wallet", "Wallet Movement"/);
});

/* ------------------- the Admin transaction monitoring console ------------- */

test("the admin transaction list also carries the ledger's answer", () => {
  const source = apiSource("services", "transaction-service.js");
  const projection = source.slice(source.indexOf("async function listAllTransactions"));
  assert.match(projection, /\(posted\.entry_count > 0\) AS wallet_posted/);
  assert.match(projection, /posted\.net_posted AS posted_amount/);
});

test("an unsettled transaction has nothing to reconcile", () => {
  const source = apiSource("services", "transaction-service.js");
  // A quoted fee on a failed attempt must not be compared against zero
  // collected revenue — that flagged every failed attempt for review.
  assert.match(source, /reconciliation_status: !row\.wallet_posted\s*\n\s*\? "not_settled"/);
  assert.match(source, /fee_charged: row\.wallet_posted \? Number\(row\.fee \|\| 0\) : 0/);
  assert.match(source, /financial_route: row\.wallet_posted[\s\S]{0,200}"No money moved"/);
});

test("the console totals fees actually charged, not fees quoted on attempts", () => {
  const adminSource = fs.readFileSync(path.join(__dirname, "../../admin/assets/admin.js"), "utf8");
  assert.match(adminSource, /const settled = rows\.filter\(\(row\) => row\.wallet_posted === true\)/);
  assert.match(adminSource, /const totalFees = settled\.reduce\(\(sum, row\) => sum \+ Number\(row\.fee_charged \?\? row\.fee \?\? 0\), 0\)/);
  assert.match(adminSource, /\["Fees Charged", money\(totalFees\)\]/);
  assert.ok(!/\["Fees in View"/.test(adminSource), "the misleading tile is gone");
  assert.match(adminSource, /\["Attempts \(no money moved\)", attemptCount\]/);
});

test("Reverse is live only where there is something to reverse", () => {
  const adminSource = fs.readFileSync(path.join(__dirname, "../../admin/assets/admin.js"), "utf8");
  // The control is always rendered, so the column never goes silently blank,
  // but it is only clickable where the ledger actually posted a movement.
  assert.match(adminSource, /function reverseActionCell/);
  assert.match(adminSource, /if \(!reason\) return `<button data-transaction-reverse=/);
  assert.match(adminSource, /return `<button type="button" disabled title=/);
  // The same three conditions the API enforces.
  assert.match(adminSource, /if \(row\.status === "reversed"\) return "Already reversed"/);
  assert.match(adminSource, /if \(row\.status !== "completed"\)/);
  assert.match(adminSource, /if \(row\.wallet_posted !== true\) return "Nothing to reverse — no wallet entry was posted"/);
});

test("the API refuses to reverse anything the ledger never posted", () => {
  const source = apiSource("services", "transaction-service.js");
  assert.match(source, /if \(transaction\.status !== "completed"\) \{\s*\n\s*throw new AppError\(409, "Only completed transactions can be reversed automatically"\)/);
  assert.match(source, /if \(!ledgerRows\.length\) throw new AppError\(409, "Transaction has no wallet ledger entries to reverse"\)/);
});
