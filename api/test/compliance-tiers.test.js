"use strict";

// PROGRESSIVE KYC/FICA, PINNED. Behaviour is proven live in
// verification/compliance-live.js; these contracts stop it rotting:
// configurable limits (nothing hard-coded in the enforcement path), one
// enforcement rail, auditable EDD, and the wallet card showing status
// rather than tier arithmetic.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const COMPLIANCE = read("src", "services", "compliance-service.js");
const TX = read("src", "services", "transaction-service.js");
const ROUTES = read("src", "routes", "compliance.routes.js");
const ADMIN = read("src", "routes", "admin.routes.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("limits come from configuration, never from the enforcement path", () => {
  // Every enforcement decision reads the merged config...
  assert.match(COMPLIANCE, /async function assertCanReceiveAmount[\s\S]{0,600}loadComplianceConfig\(\)/);
  assert.match(COMPLIANCE, /async function assertCanSendAmount[\s\S]{0,600}loadComplianceConfig\(\)/);
  // ...which is DEFAULTS merged under platform_settings, admin-editable and
  // audit-logged on every change.
  assert.match(COMPLIANCE, /compliance_tier_limits/);
  assert.match(COMPLIANCE, /compliance_limits_updated/);
  assert.match(ADMIN, /router\.put\("\/compliance\/limits"/);
  // The old hard-coded thresholds stay dead.
  assert.doesNotMatch(TX, /200000/, "no hard-coded FICA threshold in the transaction rails");
});

test("the four levels exist and usage is ledger-derived", () => {
  assert.match(COMPLIANCE, /tiers: \{\s*0:/);
  assert.match(COMPLIANCE, /Unverified/);
  assert.match(COMPLIANCE, /Basic verified/);
  assert.match(COMPLIANCE, /Fully verified/);
  assert.match(COMPLIANCE, /enhanced_due_diligence/);
  // Usage comes from wallet_ledger, never a parallel tally.
  assert.match(COMPLIANCE, /FROM wallet_ledger wl[\s\S]{0,120}DATE_TRUNC\('month', NOW\(\)\)/);
});

test("enforcement rides the one transaction rail", () => {
  assert.match(TX, /assertCanSendAmount\(actor\.userId, amount\)/);
  assert.match(TX, /assertCanReceiveAmount\(status\.recipient\.userId, amount\)/);
  assert.match(TX, /reviewForEdd\(actor\.userId/);
});

test("EDD is automatic, audited, and tells the customer", () => {
  assert.match(COMPLIANCE, /UPDATE users SET edd_status = 'required'/);
  assert.match(COMPLIANCE, /INSERT INTO compliance_flags/);
  assert.match(COMPLIANCE, /action: "edd_triggered"/);
  assert.match(COMPLIANCE, /notificationType: "compliance_edd"/);
  assert.match(COMPLIANCE, /source of funds/i);
  assert.match(COMPLIANCE, /beneficial owner/i);
  // The team can resolve a flag, and resolving the last one clears the state.
  assert.match(ADMIN, /router\.post\("\/compliance\/flags\/:id\/resolve"/);
  assert.match(ADMIN, /edd_status = 'cleared'/);
});

test("tier 1 is a validated SA ID stored only as a hash", () => {
  assert.match(COMPLIANCE, /function validateSaIdNumber/);
  assert.match(COMPLIANCE, /sum % 10 !== 0/, "the Luhn check digit is verified");
  assert.match(COMPLIANCE, /createHash\("sha256"\)/);
  assert.doesNotMatch(COMPLIANCE, /INSERT INTO users[\s\S]{0,200}id_number[^_]/,
    "the raw ID number must never be stored");
});

test("the wallet card shows status, not tier arithmetic, with one door", () => {
  const row = APP.slice(APP.indexOf("function walletVerificationRow("));
  const body = row.slice(0, row.indexOf("\n}") + 2);
  assert.match(body, /Verified/);
  assert.match(body, /Limits &amp; Verification/);
  assert.doesNotMatch(body, /Tier \d/, "no tier numbers on the card");
  assert.match(APP, /function openLimitsVerificationModal/);
  // Inside the door: usage bars, the three levels, EDD explained, and the
  // instant tier 1 form plus the FICA door.
  assert.match(APP, /data-form="basic-verify"/);
  assert.match(APP, /data-action="fica-verification"/);
  assert.match(APP, /Enhanced due diligence/);
  // And the automatic early prompt.
  assert.match(APP, /promptNeeded/);
});
