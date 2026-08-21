"use strict";

// REGULATORY RED LINES.
//
// TitoPay's licensing position rests on staying what it is: a payments
// technology platform that is not a bank, not a lender, not an FSP and not an
// investment product. The regulatory audit (August 2026) found the codebase
// clean on every count and recommended pinning that position with tests, the
// same way statutory-threshold language is already pinned - so the safe
// position can never erode silently, one harmless-looking string at a time.
//
// Three pins:
//   1. Customer-visible copy never CLAIMS a banking, deposit, interest,
//      investment or credit capability. Denials ("TitoPay does not offer
//      credit") and generic money education are allowed; claims are not, so
//      comments are stripped and the patterns are claim-shaped.
//   2. The STOCKVEL_FEATURES capability gate stays complete and all-false.
//      Enabling any entry is a deliberate legal decision, not a drive-by edit.
//   3. A wallet can never spend more than it holds - the guard that keeps
//      "no credit exists" true in the ledger, not just in the copy.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
const APP = read("pwa/app.js");
const INDEX = read("pwa/index.html");
const LISTING = read("store/listing/store-listing-copy.md");
const TRANSACTIONS = read("api/src/services/transaction-service.js");

// Strip comments so a warning ABOUT forbidden language never trips the scan
// that exists to enforce it.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((line) => !line.trim().startsWith("//"))
  .map((line) => line.replace(/\s\/\/[^"'`]*$/, "")).join("\n");

test("customer copy never claims banking, deposit, interest, investment or credit capability", () => {
  const FORBIDDEN = [
    /savings account/i,
    /current account/i,
    /digital bank/i,
    /\bneobank/i,
    /\bdeposit(s|ed|ing)?\b/i,
    /(?<!not )(?<!never )earn (interest|a return|returns)/i,
    /interest on your (wallet|balance|money)/i,
    /(wallet|balance|money) (grows|will grow)/i,
    /grow your (money|wallet|balance|savings)/i,
    /store your money/i,
    /TitoPay (Bank|Banking|Savings|Credit|Loans|Lending|Finance|Invest)/,
    /apply for (a |an )?(loan|credit|advance|overdraft)/i,
    /borrow (money|cash|from)/i,
    /buy now,? pay later/i,
    /salary advance/i,
    /we (pay|offer|add) interest/i
  ];
  for (const source of [stripComments(APP), INDEX, LISTING]) {
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(source, pattern, `forbidden banking/credit claim: ${pattern}`);
    }
  }
});

test("the affirmative denials the audit relies on stay in the copy", () => {
  assert.match(APP, /TitoPay does not offer credit or loans/);
  assert.match(APP, /TitoPay does not add interest or a return/);
  assert.match(APP, /general education, not financial advice/);
});

test("the stokvel capability gate is complete and every entry is off", () => {
  const block = APP.match(/const STOCKVEL_FEATURES = \{([\s\S]*?)\};/);
  assert.ok(block, "STOCKVEL_FEATURES gate must exist");
  const REQUIRED = [
    "investmentPortfolios", "investmentAdvice", "interestBearingBalances",
    "wealthManagement", "portfolioRecommendations", "riskProfiling",
    "assetAllocation", "insuranceProducts", "memberLending",
    "creditScoring", "buyNowPayLater"
  ];
  for (const key of REQUIRED) {
    assert.match(block[1], new RegExp(`${key}:\\s*false`),
      `${key} must be present and false - enabling it is a legal decision, not an edit`);
  }
  assert.doesNotMatch(block[1], /:\s*true/, "no gated capability may be switched on in code");
});

test("stokvel copy says stokvel, not savings-account vocabulary", () => {
  const visible = stripComments(APP);
  assert.doesNotMatch(visible, /[Ss]avings groups?/,
    'customer copy uses "stokvel group", never "savings group"');
  assert.match(APP, /Your stokvel groups/);
});

test("a wallet can never spend more than it holds", () => {
  assert.match(TRANSACTIONS,
    /if \(Number\(wallet\.available_balance\) < debitTotal\) throw new AppError\(400, "Insufficient balance"\)/,
    "the insufficient-balance guard is what keeps 'no credit exists' true in the ledger");
});

test("the proof-of-account letter is a wallet letter, not a bank artifact", () => {
  assert.match(APP, /Download a letter confirming your TitoPay wallet\./);
  assert.doesNotMatch(stripComments(APP), /official stamped letter/i);
  assert.match(APP, /TitoPay is not a bank\. This letter confirms a TitoPay wallet, not a bank account\./);
});
