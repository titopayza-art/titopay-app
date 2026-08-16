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
  // Every enforcement decision goes through the limit engine, which reads
  // the merged config on every call (see limit-engine.test.js for the
  // layering contract)...
  const ENGINE = read("src", "services", "limit-engine.js");
  assert.match(ENGINE, /async function capacityFor[\s\S]{0,600}loadComplianceConfig\(\)/);
  assert.match(COMPLIANCE, /async function assertCanReceiveAmount[\s\S]{0,900}evaluateReceive/);
  assert.match(COMPLIANCE, /async function assertCanSendAmount[\s\S]{0,400}evaluateSend/);
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
  assert.match(COMPLIANCE, /edd_trigger/);
  // Usage comes from wallet_ledger, never a parallel tally.
  assert.match(COMPLIANCE, /FROM wallet_ledger wl[\s\S]{0,120}DATE_TRUNC\('month', NOW\(\)\)/);
});

test("enforcement rides the one transaction rail", () => {
  assert.match(TX, /assertCanSendAmount\(actor\.userId, amount, \{ serviceCode/);
  assert.match(TX, /assertCanReceiveAmount\(status\.recipient\.userId, amount, \{ serviceCode/);
  assert.match(TX, /reviewForEdd\(actor\.userId/);
});

test("EDD is automatic, audited, and tells the customer", () => {
  assert.match(COMPLIANCE, /edd_status = CASE WHEN \$2 = 'edd_review' THEN 'required'/);
  assert.match(COMPLIANCE, /INSERT INTO compliance_flags/);
  assert.match(COMPLIANCE, /action: "edd_triggered"/);
  assert.match(COMPLIANCE, /notificationType: "compliance_edd"/);
  assert.match(COMPLIANCE, /source of funds/i);
  assert.match(COMPLIANCE, /beneficial owner/i);
  // The team can resolve a flag, and resolving the last one clears the state.
  assert.match(ADMIN, /router\.post\("\/compliance\/flags\/:id\/resolve"/);
  assert.match(ADMIN, /edd_status = 'cleared'/);
});

test("tier 1 is a validated identity document stored only as a hash", () => {
  // SA ID keeps its full local validation...
  assert.match(COMPLIANCE, /function validateSaIdNumber/);
  assert.match(COMPLIANCE, /sum % 10 !== 0/, "the Luhn check digit is verified");
  // ...and no customer is assumed South African: passports and other
  // approved documents verify with an issuing country and date of birth.
  assert.match(COMPLIANCE, /documentTypes: \["sa_id", "passport", "other"\]/);
  assert.match(COMPLIANCE, /function normalizeDocumentNumber/);
  assert.match(COMPLIANCE, /ISO_COUNTRIES/);
  assert.match(COMPLIANCE, /kyc_verifications/, "every verification lands in the history table");
  assert.match(COMPLIANCE, /createHash\("sha256"\)/);
  assert.doesNotMatch(COMPLIANCE, /INSERT INTO users[\s\S]{0,200}id_number[^_]/,
    "the raw document number must never be stored");
  assert.doesNotMatch(COMPLIANCE, /kyc_document_number/,
    "no column exists that could hold the number in the clear");
});

test("the flow never brands basic verification as SA-only", () => {
  // The approved wording is "Identity verified", wherever it appears.
  assert.doesNotMatch(COMPLIANCE, /SA ID verified/);
  assert.doesNotMatch(APP, /SA ID verified/);
  assert.match(COMPLIANCE, /Identity verified\. Higher monthly transaction limits\./);
  // The app offers the document choice and the passport fields.
  assert.match(APP, /South African ID<\/option>/);
  assert.match(APP, /Passport<\/option>/);
  assert.match(APP, /Other approved identity document<\/option>/);
  assert.match(APP, /name="issuingCountry"/);
  assert.match(APP, /name="dateOfBirth"/);
  assert.match(APP, /KYC_COUNTRIES/);
});

test("the nine verification states exist and drive the wallet badge", () => {
  for (const state of ["unverified", "verification_in_progress", "basic_verified", "fully_verified",
    "verification_required", "under_review", "edd_required", "verification_failed", "restricted"]) {
    assert.match(COMPLIANCE, new RegExp(state), `state ${state} exists`);
  }
  assert.match(COMPLIANCE, /function verificationStateFor/);
  // The registration default never reads as an in-flight review.
  assert.match(COMPLIANCE, /"pending" is the registration default/);
  // The badge follows the backend state dynamically.
  assert.match(APP, /VERIFICATION_TONES/);
  assert.match(APP, /c\.verificationState && c\.verificationLabel/);
});

test("the limits screen shows the full limit set with the approved copy", () => {
  assert.match(APP, /Your limits depend on your verification status, risk profile and applicable TitoPay compliance requirements\./);
  // Every limit type is stated once, as a ceiling, in the primary card.
  for (const row of ["Send per payment", "Send per day", "Send per month", "Receive per month",
    "Withdraw per payment", "Withdraw per month", "Maximum wallet balance"]) {
    assert.ok(APP.includes(row), `the limits card shows ${row}`);
  }
});

test("the wallet card shows status, not tier arithmetic, with one door", () => {
  const row = APP.slice(APP.indexOf("function walletVerificationRow("));
  const body = row.slice(0, row.indexOf("\n}") + 2);
  assert.match(body, /Fully Verified/);
  assert.match(body, /Basic Verified/);
  assert.match(body, /Verify Identity/, "tier 0 shows a call to action, not a shaming label");
  assert.match(body, /Limits &amp; Verification/);
  assert.doesNotMatch(body, /Tier \d/, "no tier numbers on the card");
  // Fully Verified must never read as unlimited. The top level genuinely has
  // no standing cap, so the copy is allowed to SAY that — what it may never do
  // is say it on its own, without the supervision that still applies.
  // Scoped to the limit copy: "unlimited email campaigns" and an "Unlimited"
  // placeholder on a coupon's redemption count are unrelated and legitimate.
  const limitCopy = APP.slice(APP.indexOf("function limitRow"), APP.indexOf("async function submitBasicVerify"));
  assert.doesNotMatch(limitCopy.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"),
    /[Uu]nlimited/, "no wallet limit is ever offered to a customer as unlimited");
  assert.match(APP, /No fixed monthly transaction limit\. \$\{supervision\}/,
    "the one place that says there is no cap says supervision continues in the same breath");
  assert.match(APP, /const supervision = "Risk assessment, transaction monitoring and applicable TitoPay compliance requirements still apply\."/);
  assert.match(APP, /function openLimitsVerificationModal/);
  // Inside the door: usage bars, the three levels, EDD explained, and the
  // instant tier 1 form plus the FICA door.
  assert.match(APP, /data-form="basic-verify"/);
  assert.match(APP, /data-action="fica-verification"/);
  assert.match(APP, /Enhanced due diligence/);
  // And the automatic early prompt.
  assert.match(APP, /promptNeeded/);
});

test("risk status is a separate, escalation-only axis with four levels", () => {
  assert.match(COMPLIANCE, /const RISK_ORDER = \["normal", "elevated", "high_risk", "edd_review"\]/);
  assert.match(COMPLIANCE, /function riskRank/);
  assert.match(COMPLIANCE, /async function setRiskStatus/);
  assert.match(COMPLIANCE, /action: "risk_status_changed"/, "every movement is audit-logged");
  // Signals only escalate; lowering is a compliance decision through
  // setRiskStatus with an actor.
  assert.match(COMPLIANCE, /riskRank\(target\) > riskRank\(user\.risk_status\)/);
  // Internal ratings are never shown to the customer.
  assert.match(COMPLIANCE, /Customer-safe review state only/);
  assert.doesNotMatch(APP, /high[_ ]risk/i, "internal risk ratings must not appear in the app");
});

test("monitoring, screening and ongoing CDD are wired and configurable", () => {
  assert.match(COMPLIANCE, /velocityCount24h/);
  assert.match(COMPLIANCE, /structuringMarginPercent/);
  assert.match(COMPLIANCE, /repeated_near_limit/);
  assert.match(COMPLIANCE, /async function screenUser/);
  assert.match(COMPLIANCE, /compliance_screening_list/);
  assert.match(COMPLIANCE, /ongoing_cdd/);
  assert.match(COMPLIANCE, /cdd: \{ reviewMonths/);
  const ADMIN2 = read("src", "routes", "admin.routes.js");
  assert.match(ADMIN2, /router\.post\("\/compliance\/screening\/run"/);
  assert.match(ADMIN2, /router\.post\("\/compliance\/users\/:id\/risk"/);
});

test("the full limit set is enforced on every rail, configurable end to end", () => {
  assert.match(COMPLIANCE, /dailySend/);
  assert.match(COMPLIANCE, /maxBalance/);
  assert.match(COMPLIANCE, /singleWithdrawal/);
  assert.match(COMPLIANCE, /monthlyWithdraw/);
  const WITHDRAW = read("src", "services", "peach-withdrawal-service.js");
  assert.match(WITHDRAW, /assertCanWithdraw\(actor\.userId, amount\)/);
  const CHECKOUT = read("src", "services", "peach-checkout-service.js");
  assert.match(CHECKOUT, /assertBalanceHeadroom\(actor\.userId, amount\)/);
});

test("no number is presented as a statutory FICA threshold", () => {
  assert.match(COMPLIANCE, /not.*statutory/i);
  assert.match(COMPLIANCE, /RMCP/);
  assert.match(COMPLIANCE, /disclaimer/);
  assert.match(APP, /status\.disclaimer/, "the app shows the RMCP disclaimer in Limits and Verification");
});
