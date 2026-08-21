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
  // A level with no standing limit still gains one under high risk.
  const open = engine.buildEffectiveLimits({ ...base, tier: 2 });
  assert.equal(open.limits.monthlySend, null);
  assert.equal(open.limits.singleTransaction, null);
  const contained = engine.buildEffectiveLimits({ ...base, tier: 2, riskStatus: "high_risk" });
  assert.ok(Number(contained.limits.monthlySend) > 0, "high risk bounds an otherwise unlimited level");
  assert.ok(Number(contained.limits.singleTransaction) > 0, "on every rail, not just the monthly one");
});

test("a monthly VOLUME limit is never reused as a balance, daily or withdrawal limit", () => {
  // The distinction that is easiest to lose. monthlySend and monthlyReceive
  // measure volume moved over a calendar month. maxBalance is stored value.
  // singleTransaction is one payment. dailySend is a rolling day. The
  // withdrawal rails are cash out. Setting any of them FROM the monthly
  // figure is how a platform accidentally lets a wallet hold, or move in one
  // payment, what it was only ever meant to move over thirty days.
  const MONTHLY = [25000, 200000];
  for (const level of ["0", "1"]) {
    const t = DEFAULT_CONFIG.tiers[level];
    assert.ok(MONTHLY.includes(t.monthlySend), `tier ${level}: monthly volume is one of the two published figures`);
    assert.equal(t.monthlySend, t.monthlyReceive, `tier ${level}: one monthly transaction figure, both directions`);
    for (const key of ["singleTransaction", "dailySend", "singleWithdrawal", "monthlyWithdraw", "maxBalance"]) {
      assert.ok(!MONTHLY.includes(t[key]),
        `tier ${level}: ${key} is a different concept and must not carry a monthly transaction figure`);
      assert.ok(Number(t[key]) < Number(t.monthlySend),
        `tier ${level}: ${key} is narrower than the month it sits inside`);
    }
  }
  // And a wallet may never HOLD what it is allowed to move in a month: stored
  // value is a float and safeguarding question, not a volume one.
  for (const level of ["0", "1"]) {
    const t = DEFAULT_CONFIG.tiers[level];
    assert.ok(t.maxBalance <= t.monthlyReceive / 2,
      `tier ${level}: a wallet is not a place to park a month's throughput`);
  }
  // The engine enforces them as different things too: balance headroom is its
  // own evaluation, and monthly volume comes from the ledger, not the balance.
  assert.match(ENGINE, /async function evaluateBalanceHeadroom/);
  // Build 88 anchored the month boundary to South African time: DATE_TRUNC
  // runs on the SAST clock and the result converts back to a UTC instant.
  assert.match(COMPLIANCE, /FROM wallet_ledger wl[\s\S]{0,200}DATE_TRUNC\('month', NOW\(\) AT TIME ZONE 'Africa\/Johannesburg'\) AT TIME ZONE 'Africa\/Johannesburg'/);
});

test("three levels, and the ladder climbs on every rail", () => {
  // THREE. Enhanced due diligence is a review that can open on any level, not
  // a fourth rung, so a fourth tier must never appear in config.
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.tiers), ["0", "1", "2"]);

  const [unverified, basic, full] = ["0", "1", "2"].map((k) => DEFAULT_CONFIG.tiers[k]);
  assert.equal(unverified.monthlyReceive, 25000);
  assert.equal(unverified.monthlySend, 25000);
  assert.equal(basic.monthlyReceive, 200000);
  assert.equal(basic.monthlySend, 200000);
  // The top level carries NO standing limit on any rail.
  for (const key of ["monthlyReceive", "monthlySend", "singleTransaction", "dailySend",
    "singleWithdrawal", "monthlyWithdraw", "maxBalance"]) {
    assert.equal(full[key], null, `fully verified has no standing ${key}`);
  }
  // A rung that allows less than the one below it is a ladder nobody climbs.
  for (const key of ["monthlyReceive", "monthlySend", "singleTransaction", "dailySend",
    "singleWithdrawal", "monthlyWithdraw", "maxBalance"]) {
    assert.ok(Number(basic[key]) > Number(unverified[key]),
      `${key}: verifying must be worth doing`);
  }
  // "No fixed monthly limit" is never implemented as "no controls". Every one
  // of these still applies at the top level, and the config says so.
  const source0 = read("src", "services", "compliance-service.js");
  for (const control of ["risk banding", "transaction monitoring", "screening",
    "enhanced due diligence", "ongoing customer due diligence", "account status"]) {
    assert.ok(source0.toLowerCase().includes(control),
      `the top level remains subject to ${control}`);
  }
  // Proven, not just documented: risk gives the unlimited level real ceilings.
  const top = engine.buildEffectiveLimits({
    config: DEFAULT_CONFIG, tier: 2, riskStatus: "high_risk", earned: { applies: false, multiplier: 1 } });
  for (const key of ["monthlySend", "monthlyReceive", "singleTransaction", "dailySend"]) {
    assert.ok(Number(top.limits[key]) > 0, `high risk bounds ${key} at the top level`);
  }

  // And no number here may be presented as a statutory threshold.
  const source = read("src", "services", "compliance-service.js");
  assert.doesNotMatch(source, /R?(25|200)[ ,]?000[^\n]{0,60}(statutory|required by law|FICA limit)/i);
  assert.match(source, /None of these is a statutory FICA or SARB threshold/);
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

test("every level's ladder is internally coherent", () => {
  // A ladder fails quietly when its rungs disagree: a wallet that may hold
  // five months of what it can receive, or a daily limit above the monthly
  // one, is a configuration mistake nobody notices until it is exploited.
  for (const level of ["0", "1"]) {
    const t = DEFAULT_CONFIG.tiers[level];
    assert.ok(t.dailySend <= t.monthlySend, `tier ${level}: a day cannot allow more than a month`);
    assert.ok(t.singleTransaction <= t.dailySend, `tier ${level}: one payment cannot exceed a day`);
    assert.ok(t.singleWithdrawal <= t.singleTransaction, `tier ${level}: cash out is never looser than paying`);
    assert.ok(t.monthlyWithdraw <= t.monthlySend, `tier ${level}: withdrawals cannot exceed sending`);
    assert.ok(t.maxBalance <= t.monthlyReceive * 2,
      `tier ${level}: a wallet cannot hold many months of its own receiving limit`);
  }
});

test("the ladder is set above the assurance, and says so out loud", () => {
  const tier1 = DEFAULT_CONFIG.tiers["1"];
  // Everyday life must fit: a salary in, rent out, groceries and gifts.
  assert.ok(tier1.monthlyReceive >= 20000, "a month's income lands without a wall");
  assert.ok(tier1.singleTransaction >= 8000, "rent goes in one payment");
  // These limits are deliberately set ABOVE the identity assurance the
  // platform currently holds, which is a business decision rather than an
  // accident. The file has to state the trade-off, so that raising the
  // numbers can never be mistaken for having raised the assurance.
  const source = read("src", "services", "compliance-service.js");
  assert.match(source, /ABOVE the assurance the platform currently holds/i);
  assert.match(source, /no document image and no liveness check/i);
  assert.match(source, /Unverified means NOTHING is known about the customer/i);
  // Per payment stays a fraction of the month on both limited rungs: it is
  // the control that costs honest customers the least and fraud the most.
  for (const key of ["0", "1"]) {
    const tier = DEFAULT_CONFIG.tiers[key];
    assert.ok(tier.singleTransaction <= tier.monthlySend * 0.6,
      `tier ${key}: one payment cannot be most of a month`);
  }
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

test("held money lives in the suspense wallet, so the ledger always balances", () => {
  const WALLET = read("src", "services", "wallet-service.js");
  assert.match(WALLET, /async function getSuspenseWallet/);
  assert.match(WALLET, /THE SUSPENSE WALLET/);
  // Hold credits it, release and return debit it: every leg has a pair.
  assert.match(PENDING, /getSuspenseWallet\(client\)[\s\S]{0,400}entryType: "credit"/);
  assert.match(PENDING, /Out of suspense, into the recipient/);
  assert.match(PENDING, /Out of suspense, back to the sender/);
  assert.match(read("src", "db", "schema.sql"), /'9000000001', NULL, 'system'/);
});

test("both sides are told, and the notice never becomes a phishing template", () => {
  // The sender's money left without arriving; they hear about it.
  assert.match(PENDING, /title: `\$\{value\} is on hold for/);
  assert.match(PENDING, /has been delivered/);
  // In-app only, deliberately, and the copy inoculates against the scam
  // that shares its shape.
  assert.match(PENDING, /IN-APP ONLY, DELIBERATELY/);
  assert.match(PENDING, /never ask you to claim money through a link/);
  assert.doesNotMatch(PENDING, /queueEmail|queueRawEmail/,
    "no email template exists for a claim-your-money notice");
});

test("earned capacity cannot be farmed by paying yourself", () => {
  assert.match(ENGINE, /minDistinctCounterparties/);
  assert.match(ENGINE, /minTransactionValue/);
  assert.match(ENGINE, /COUNT\(DISTINCT t\.metadata->>'recipientWalletId'\)/);
  assert.match(ENGINE, /Paying yourself proves nothing/);
  assert.doesNotMatch(ENGINE, /minCompletedTransactions/,
    "a raw transaction count is farmable and is gone");
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
  // Four questions in the order a person asks them: what are my limits,
  // what have I used, what is left, and how do I get more.
  assert.match(APP, /LIMITS AND VERIFICATION, IN THE ORDER A PERSON ASKS/);
  assert.match(APP, /Your current limits/);
  assert.match(APP, /This month/);
  assert.match(APP, /You can still/);
  // A limit and remaining capacity are visibly different things.
  assert.match(APP, /function limitRow/);
  assert.match(APP, /function remainingTile/);
  // One call to action, and the detail moved behind its own door.
  assert.match(APP, /verify-cta/);
  assert.match(APP, /data-action="verification-levels"/);
  assert.match(APP, /async function openVerificationLevelsModal/);
  // Never unlimited, and never a bare statement that a level has no cap.
  assert.doesNotMatch(APP, /No fixed monthly limits/);
  assert.match(APP, /No fixed monthly transaction limit/);
  assert.match(APP, /still apply/, "and the supervision that continues is said in the same sentence");
  assert.match(APP, /Not a level you choose/, "enhanced due diligence is a process, not a tier");
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
  assert.match(COMPLIANCE, /holdDays: 7/);
  // The engine reads config on every decision; nothing is captured at boot.
  assert.match(ENGINE, /loadComplianceConfig\(\)/);
});

test("no amount is presented as a statutory threshold, anywhere a customer can read", () => {
  // The failure mode this guards against is a sentence, not a bug: telling a
  // customer that R25 000 is what FICA, SARB, the FSCA or PASA allows. None of
  // these figures is a statutory threshold, none has been approved by a
  // regulator, and claiming either would be a compliance problem that no test
  // of the arithmetic would ever catch.
  // Comments are stripped first, because the two files carry comments whose
  // whole purpose is to DENY these claims ("no number here is a statutory
  // FICA or SARB threshold"), and a scan that cannot tell a denial from a
  // claim would fail on the very sentence that makes the code correct.
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
  const CUSTOMER_TEXT = [COMPLIANCE, APP, ROUTES].map(stripComments);
  const FORBIDDEN = [
    /FICA (limit|allows|threshold)/i,
    /SARB (limit|allows|threshold)/i,
    /FSCA (limit|allows|threshold)/i,
    /PASA (limit|allows|threshold)/i,
    /statutory (limit|threshold|amount)s? of R/i,
    /regulatory (limit|threshold) of R/i,
    /(required|allowed|permitted) by law/i,
    /cash threshold/i,
    /approved by (the )?(regulator|SARB|FSCA|FIC)\b/i
  ];
  for (const source of CUSTOMER_TEXT) {
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(source, pattern, `forbidden claim: ${pattern}`);
    }
  }
  // The disclaimer says what the amounts actually are. It lives in the content
  // service now, because it is admin-editable, and the same scan covers it.
  const CONTENT = read("src", "services", "limits-content-service.js");
  for (const pattern of FORBIDDEN) {
    assert.doesNotMatch(stripComments(CONTENT).replace(/FORBIDDEN_CLAIMS[\s\S]*?\n\];/, ""), pattern,
      `forbidden claim in the editable copy defaults: ${pattern}`);
  }
  assert.match(CONTENT, /These are TitoPay operational limits based on its risk management and compliance framework\. They are not statutory thresholds\./);
  // The limits screen attributes the numbers to TitoPay, not to a regulator,
  // and the app still ships the same sentence for when it cannot reach us.
  assert.match(CONTENT, /Your limits depend on your verification status, risk profile and applicable TitoPay compliance requirements\./);
  assert.match(APP, /Your limits depend on your verification status, risk profile and applicable TitoPay compliance requirements\./);
});

test("the product access level is a separate concept from compliance status", () => {
  const { productAccessLevel, ACCESS_LEVELS, DEFAULT_CONFIG: CONFIG } = require("../src/services/compliance-service");
  // Exactly three, published with their position so nothing has to infer a
  // fourth from a tier number.
  assert.deepEqual(Object.keys(ACCESS_LEVELS), ["0", "1", "2"]);
  const levels = ["0", "1", "2"].map((t) => productAccessLevel(CONFIG, Number(t)));
  assert.deepEqual(levels.map((l) => l.key), ["limited_access", "basic_verified", "fully_verified"]);
  assert.deepEqual(levels.map((l) => l.position), [1, 2, 3]);
  assert.deepEqual(levels.map((l) => l.of), [3, 3, 3]);
  assert.deepEqual(levels.map((l) => l.label), ["Limited Access", "Basic Verified", "Fully Verified"]);

  // ONE monthly transaction limit per level, and it is the VOLUME rail.
  assert.deepEqual(levels.map((l) => l.monthlyTransactionLimit), [25000, 200000, null]);
  for (const level of levels) {
    const tier = CONFIG.tiers[String(level.position - 1)];
    for (const other of ["maxBalance", "singleTransaction", "dailySend", "singleWithdrawal", "monthlyWithdraw"]) {
      if (tier[other] === null) continue;
      assert.notEqual(level.monthlyTransactionLimit, tier[other],
        `${level.key}: the monthly transaction limit is not the ${other}`);
    }
  }
  // The top level says what still applies, in the payload, so a client that
  // renders only the number cannot drop the caveat.
  assert.match(levels[2].monthlyTransactionLimitNote, /No fixed monthly transaction limit/);
  assert.match(levels[2].monthlyTransactionLimitNote, /still apply/);

  // An access level never grants anything by itself: risk is applied last and
  // narrows every level, including the one with no fixed limit.
  assert.match(ENGINE, /4\. RISK\s+risk is applied LAST and always wins/);
  const topUnderRisk = engine.buildEffectiveLimits({
    config: CONFIG, tier: 2, riskStatus: "high_risk", earned: { applies: false, multiplier: 1 } });
  assert.ok(Number(topUnderRisk.limits.monthlySend) > 0, "a compliance decision binds the top level too");
});

test("enhanced due diligence is never claimed for a whole level", () => {
  // EDD is a specific process that applies where it applies, on any level.
  // Labelling every fully verified customer as having been through it would
  // be a fabricated compliance status.
  const tier2 = DEFAULT_CONFIG.tiers["2"];
  assert.doesNotMatch(String(tier2.description), /enhanced due diligence/i);
  assert.doesNotMatch(String(tier2.label), /enhanced/i);
  // The app says the same thing where it explains EDD.
  assert.match(APP, /Not a level you choose/);
  // And no level is described as "FICA verification", which is a documentary
  // review, not a generic technical verification status.
  for (const level of ["0", "1", "2"]) {
    assert.doesNotMatch(String(DEFAULT_CONFIG.tiers[level].description), /\bFICA\b/i,
      `tier ${level} does not use FICA as a verification status`);
  }
});

test("the source still states plainly that none of these amounts is statutory", () => {
  // The scan above deliberately ignores comments, so the denial they carry
  // needs its own assertion or it could be deleted without anything noticing.
  assert.match(COMPLIANCE, /None of these is a statutory FICA or SARB threshold/);
  assert.match(ENGINE, /None of the numbers here are statutory FICA or SARB thresholds/);
});
