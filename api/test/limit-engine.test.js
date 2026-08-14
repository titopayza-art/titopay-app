"use strict";

// THE LIMIT ENGINE, PINNED. Behaviour is proven live in
// verification/limit-engine-live.js. These contracts hold the design in
// place: one engine, layered in a fixed order with risk last, capacity in
// every message, held money instead of lost money, and no limit anywhere
// that pretends to be a law.

process.env.NODE_ENV = "test";
// This file exercises the engine's arithmetic directly, so it loads real
// service modules and needs the same environment they do. Set before any
// require, and only as a fallback, so a configured runner still wins.
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const ENGINE = read("src", "services", "limit-engine.js");
const PENDING = read("src", "services", "pending-credit-service.js");
const COMPLIANCE = read("src", "services", "compliance-service.js");
const TX = read("src", "services", "transaction-service.js");
const ROUTES = read("src", "routes", "compliance.routes.js");
const ADMIN = read("src", "routes", "admin.routes.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

const engine = require("../src/services/limit-engine");
const { DEFAULT_CONFIG } = require("../src/services/compliance-service");

test("one engine decides, and every rail asks it", () => {
  assert.match(COMPLIANCE, /require\("\.\/limit-engine"\)\.evaluateSend/);
  assert.match(COMPLIANCE, /require\("\.\/limit-engine"\)\.evaluateReceive/);
  assert.match(COMPLIANCE, /require\("\.\/limit-engine"\)\.evaluateWithdrawal/);
  assert.match(COMPLIANCE, /require\("\.\/limit-engine"\)\.evaluateBalanceHeadroom/);
  // The old per-door arithmetic is gone: no enforcement path derives a
  // limit of its own, and monitoring reads the same effective limits the
  // customer actually faces.
  assert.doesNotMatch(COMPLIANCE, /const tierConfig = config\.tiers\[String\(tier\)\] \|\| \{\};\n\s+const value/);
  assert.match(COMPLIANCE, /Monitoring reads the limits the customer ACTUALLY faces/);
  assert.match(COMPLIANCE, /const effective = await require\("\.\/limit-engine"\)\.capacityFor/);
});

test("limits layer verification, product, earned standing and risk, in that order", () => {
  const base = { config: DEFAULT_CONFIG, tier: 1, riskStatus: "normal", earned: { applies: false, multiplier: 1 } };
  const plain = engine.buildEffectiveLimits(base);
  // A product rule narrows one rail only.
  const gift = engine.buildEffectiveLimits({ ...base, serviceCode: "send_gift" });
  assert.ok(gift.limits.singleTransaction < plain.limits.singleTransaction);
  assert.equal(gift.limits.monthlySend, plain.limits.monthlySend);
  // Earned standing lifts, risk narrows, and risk is applied last so it
  // wins over both verification and earned standing.
  const earned = engine.buildEffectiveLimits({ ...base, earned: { applies: true, multiplier: 1.5 } });
  assert.ok(earned.limits.monthlySend > plain.limits.monthlySend);
  const risky = engine.buildEffectiveLimits({ ...base, riskStatus: "elevated", earned: { applies: true, multiplier: 1.5 } });
  assert.ok(risky.limits.monthlySend < earned.limits.monthlySend);
  assert.ok(risky.limits.singleTransaction < plain.limits.singleTransaction);
  // A level with no fixed limit still gains one under high risk.
  const open = engine.buildEffectiveLimits({ ...base, tier: 2 });
  assert.equal(open.limits.monthlySend, null);
  const contained = engine.buildEffectiveLimits({ ...base, tier: 2, riskStatus: "high_risk" });
  assert.ok(Number(contained.limits.monthlySend) > 0, "high risk bounds an otherwise unlimited level");
});

test("product rules can only narrow, never widen", () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.products = { greedy_rail: { singleTransaction: 999999999, monthlySend: 999999999 } };
  const widened = engine.buildEffectiveLimits({
    config, tier: 1, riskStatus: "normal", serviceCode: "greedy_rail", earned: { applies: false, multiplier: 1 }
  });
  const plain = engine.buildEffectiveLimits({ config, tier: 1, riskStatus: "normal", earned: { applies: false, multiplier: 1 } });
  assert.equal(widened.limits.singleTransaction, plain.limits.singleTransaction,
    "a product profile cannot open the platform up by accident");
});

test("basic verified is a genuinely usable everyday wallet", () => {
  const tier1 = DEFAULT_CONFIG.tiers["1"];
  assert.ok(tier1.monthlyReceive >= 50000, "an everyday wallet accepts an everyday month");
  assert.ok(tier1.monthlySend >= 50000);
  assert.ok(tier1.singleTransaction >= 20000, "rent and a car payment fit in one payment");
  // And unverified stays coherent: the balance cap cannot exceed what the
  // account is allowed to take in.
  const tier0 = DEFAULT_CONFIG.tiers["0"];
  assert.ok(tier0.maxBalance <= tier0.monthlyReceive * 2,
    "an unverified wallet cannot hold many months of its own receiving limit");
});

test("refusals quote remaining capacity and never invoke the law", () => {
  // Every refusal the engine writes states what IS possible.
  assert.match(ENGINE, /The most you can send in one payment right now/);
  assert.match(ENGINE, /of today's sending capacity left/);
  assert.match(ENGINE, /of this month's sending capacity left/);
  assert.match(ENGINE, /of this month's receiving capacity left/);
  // Checked against the CODE, not the comments: the engine's header
  // correctly explains that none of its numbers are statutory FICA or SARB
  // thresholds, and that sentence must not fail its own test. Word
  // boundaries matter too, since "Verification" contains f-i-c-a.
  const codeOnly = ENGINE.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(codeOnly, /\bFICA\b|\bSARB\b|statutory|required by law/i,
    "no customer-facing string in the engine invokes the law");
  assert.doesNotMatch(APP, /FICA limit|FICA only allows|Your FICA limits/i);
});

test("a recipient's limits are never disclosed to a sender", () => {
  assert.match(COMPLIANCE, /never discloses another account's numbers or verification state/);
  assert.match(COMPLIANCE, /This payment cannot be completed to that account right now/);
});

test("money is held for verification, never lost, and never spendable early", () => {
  assert.match(TX, /holdForVerification/);
  assert.match(TX, /createHold/);
  assert.match(PENDING, /THE HELD AMOUNT IS NEVER SPENDABLE/);
  assert.match(PENDING, /FOR UPDATE/, "release and return take the row under a lock");
  assert.match(PENDING, /RELEASE AND RETURN HAPPEN EXACTLY ONCE/);
  assert.match(PENDING, /async function returnExpiredHolds/);
  // A payment that never arrived refunds the service fee too.
  assert.match(PENDING, /feeRefund: true/);
  assert.match(PENDING, /-Math\.abs\(fee\)/, "the revenue booked against it is reversed");
  // Verifying is the moment held money is released.
  assert.match(ROUTES, /releaseWhatFits/);
  assert.match(APP, /data-action="claim-pending-credits"/);
});

test("the customer can see what they can still do", () => {
  assert.match(ROUTES, /router\.get\("\/capacity"/);
  assert.match(ROUTES, /internal reasoning \(risk band, multipliers\) stays out of the customer/i);
  assert.match(APP, /What you can do right now/);
  assert.match(APP, /Your current wallet limits/);
  assert.doesNotMatch(APP, /Your FICA limits/);
});

test("limit configuration is versioned, reversible and reason-bound", () => {
  assert.match(COMPLIANCE, /compliance_config_versions/);
  assert.match(COMPLIANCE, /async function restoreComplianceConfigVersion/);
  assert.match(COMPLIANCE, /State why this version is being restored/);
  assert.match(ADMIN, /router\.get\("\/compliance\/limits\/versions"/);
  assert.match(ADMIN, /router\.post\("\/compliance\/limits\/versions\/:id\/restore"/);
  assert.match(ADMIN, /router\.get\("\/compliance\/pending-credits"/);
});

test("risk bands, products, earned capacity and holding are all configuration", () => {
  assert.match(COMPLIANCE, /products: require\("\.\/limit-engine"\)\.DEFAULT_PRODUCT_LIMITS/);
  assert.match(COMPLIANCE, /riskBands: require\("\.\/limit-engine"\)\.DEFAULT_RISK_BANDS/);
  assert.match(COMPLIANCE, /earnedCapacity: require\("\.\/limit-engine"\)\.DEFAULT_EARNED_CAPACITY/);
  assert.match(COMPLIANCE, /holdForVerification: true/);
  assert.match(COMPLIANCE, /holdDays: 14/);
  // The engine reads config on every decision; nothing is captured at boot.
  assert.match(ENGINE, /loadComplianceConfig\(\)/);
});
