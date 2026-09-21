"use strict";

// TITOPAY CORE MUST NOT KNOW WHO SUPPLIES A CAPABILITY.
//
// The rule this enforces is one sentence: provider-specific code may know its
// provider, TitoPay core must not. An adapter named for a company is correct;
// a limit engine, a ledger or a verification service that imports one is
// vendor lock-in with a require statement.
//
// It checks CODE, not comments. A comment that explains which company a
// capability is bought from today is documentation, and documentation is not
// coupling. A `require("../services/<vendor>-service")` in a core module is.
//
// The core list below is explicit rather than "everything except". A file is
// added to it when it is genuinely TitoPay's own business logic, so that
// adding a provider-shaped file cannot silently widen the exemption.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const API = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(API, ...parts), "utf8");

// Strip line comments and block comments so prose about a vendor does not
// count as a dependency on one.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

// The companies TitoPay currently integrates with or holds a credential slot
// for. Matched case-insensitively, on the name only, so "flash" as an English
// word in a comment is already excluded by codeOnly above.
// `absa` joins the list with the banking capability, so that the day an
// adapter is written the boundary is already being enforced against it. It is
// currently a bank name in a SUPPORTED_BANKS list and two POS CHECK
// constraints, none of which is core, and that is the point: it must not
// spread further.
const PROVIDER_NAMES = ["peach", "docfox", "flash", "ott", "absa"];

// TitoPay's own business logic. Money rules, limits, verification, and the API
// surface that is not a provider callback.
const CORE_FILES = [
  ["src", "services", "transaction-service.js"],
  ["src", "services", "compliance-service.js"],
  ["src", "services", "limit-engine.js"],
  ["src", "services", "wallet-service.js"],
  ["src", "services", "pricing-service.js"],
  ["src", "services", "business-verification-service.js"],
  ["src", "routes", "payouts.routes.js"],
  ["src", "routes", "compliance.routes.js"],
  ["src", "routes", "kyc.routes.js"]
];

test("no provider name appears in TitoPay core code", () => {
  const offenders = [];
  for (const parts of CORE_FILES) {
    const file = path.join(API, ...parts);
    if (!fs.existsSync(file)) continue;
    const code = codeOnly(fs.readFileSync(file, "utf8")).toLowerCase();
    for (const name of PROVIDER_NAMES) {
      if (code.includes(name)) offenders.push(`${parts.join("/")} mentions "${name}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `core business logic must depend on capabilities, not companies:\n  ${offenders.join("\n  ")}`);
});

test("the registry itself is brand free, so adding a provider never edits it", () => {
  const code = codeOnly(read("src", "providers", "index.js")).toLowerCase();
  for (const name of PROVIDER_NAMES) {
    assert.ok(!code.includes(name), `src/providers/index.js must not name ${name}`);
  }
  // Which adapter answers by default is the adapter's own declaration.
  assert.match(read("src", "providers", "index.js"), /adapter\.isDefault/);
  assert.match(read("src", "providers", "index.js"), /declaredDefaults/);
});

test("core reaches a provider by capability, through the one resolver", () => {
  // The two core modules that used to import a payout company by name.
  const transactions = read("src", "services", "transaction-service.js");
  assert.match(transactions, /require\("\.\.\/providers\/payout-provider"\)/);
  assert.match(transactions, /assertPayoutAvailable\(await payoutAvailability\(\)\)/);

  const payouts = read("src", "routes", "payouts.routes.js");
  assert.match(payouts, /require\("\.\.\/providers\/payout-provider"\)/);
  assert.match(payouts, /processPayout\(/);

  const payments = read("src", "routes", "payments.routes.js");
  assert.match(payments, /require\("\.\.\/providers\/payment-provider"\)/);
  assert.match(payments, /processPayment\(/);

  // Identity assurance is asked of the capability, never of a vendor.
  const compliance = read("src", "services", "compliance-service.js");
  assert.match(compliance, /require\("\.\.\/providers\/kyc-provider"\)/);
  assert.match(compliance, /await verifyIdentity\(\{/);
  assert.doesNotMatch(codeOnly(compliance), /verifyWith[A-Z]/,
    "an assurance call must never be named after the company that answers it");
});

test("the banking capability names no bank, and refuses everything", () => {
  const banking = read("src", "providers", "banking-provider.js");
  const code = codeOnly(banking).toLowerCase();
  for (const name of PROVIDER_NAMES) {
    assert.ok(!code.includes(name), `banking-provider.js must not name ${name}`);
  }
  // Every operation refuses, with a state rather than an excuse.
  for (const operation of [
    "initiateCustomerPayment", "getPaymentStatus", "handleProviderCallback",
    "verifyAccount", "getAccountInformation", "getTransactionHistory",
    "initiatePayout", "initiateWithdrawal", "reconcile"
  ]) {
    assert.match(banking, new RegExp(`${operation}: notSupported`),
      `${operation} must refuse rather than pretend`);
  }
  assert.match(banking, /CAPABILITY_NOT_SUPPORTED/);
  // And the shipped default is an adapter that implements nothing.
  assert.match(banking, /key: "none"/);
  assert.match(banking, /isDefault: true/);
});

test("the banking layer holds no bank name in its configuration or state machine", () => {
  for (const parts of [["src", "config", "banking-flags.js"], ["src", "lib", "banking-state.js"],
                       ["src", "services", "banking-service.js"]]) {
    const code = codeOnly(read(...parts)).toLowerCase();
    for (const name of PROVIDER_NAMES) {
      assert.ok(!code.includes(name), `${parts.join("/")} must not name ${name}`);
    }
  }
});

test("an unbought capability refuses, and never fabricates a result", () => {
  const vas = read("src", "providers", "vas-provider.js");
  // No stub token, no fake reference, no mocked success.
  for (const operation of ["purchaseAirtime", "purchaseData", "purchaseElectricity"]) {
    assert.match(vas, new RegExp(`${operation}: notAvailable`),
      `${operation} must refuse rather than pretend`);
  }
  assert.match(vas, /throw new AppError\(503/);

  const kyc = read("src", "providers", "kyc-provider.js");
  // The internal identity check reports what it actually is.
  assert.match(kyc, /assurance: "structural"/);
  assert.match(kyc, /checkedAgainstRegister: false/);
  // And a business can never be auto-verified without a register lookup.
  const businessBlock = kyc.slice(kyc.indexOf("async verifyBusiness"), kyc.indexOf("async verifyBusiness") + 600);
  assert.match(businessBlock, /status: "review_required"/);
  assert.doesNotMatch(businessBlock, /status: "verified"/);
});

test("no identity verification vendor is hardcoded as the chosen one", () => {
  const admin = read("..", "admin", "admin.js");
  const routes = read("src", "routes", "admin.routes.js");
  // The routing row for identity verification is unrouted until a supplier is
  // actually contracted. A credential slot is not a decision.
  assert.match(routes, /key: "kyc", label: "Identity Verification", defaultProvider: NOT_ROUTED/);
  assert.match(routes, /const NOT_ROUTED = "none"/);
  // And an operator can say "no supplier" without picking one at random.
  assert.match(routes, /label: "Not configured"/);
  assert.ok(admin.length > 0);
});

test("verification statuses are TitoPay's, not a provider's vocabulary", () => {
  const { VERIFICATION_STATUSES, normalizeVerificationStatus } = require("../src/providers/kyc-provider");
  assert.deepEqual(VERIFICATION_STATUSES,
    ["pending", "verified", "review_required", "failed", "rejected"]);
  // A provider's own wording is normalised, and anything unrecognised is sent
  // to a human rather than guessed into a pass.
  assert.equal(normalizeVerificationStatus("VERIFIED"), "verified");
  assert.equal(normalizeVerificationStatus("Review Required"), "review_required");
  assert.equal(normalizeVerificationStatus("APPROVED_WITH_CONDITIONS"), "review_required");
  assert.equal(normalizeVerificationStatus(""), "review_required");
  assert.notEqual(normalizeVerificationStatus("something-new"), "verified");
});

test("no credential is exported from the provider layer", () => {
  const dir = path.join(API, "src", "providers");
  for (const name of fs.readdirSync(dir)) {
    const source = read("src", "providers", name);
    assert.doesNotMatch(source, /process\.env\.[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD)/,
      `${name} must not read a credential; adapters delegate to the service that holds them`);
  }
});
