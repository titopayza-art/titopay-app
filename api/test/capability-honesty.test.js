"use strict";

// WHAT TITOPAY SAYS IT DOES MUST BE WHAT TITOPAY CAN DO.
//
// Two claims were being made on evidence that did not support them, in the two
// places a platform makes claims: what a level GRANTS, and what the catalogue
// OFFERS. Neither was a bug in the usual sense — every line worked exactly as
// written. Both were numbers and flags that had drifted away from the thing
// they described, with nothing but memory holding them together.
//
//   1. "Basic Verified" granted a R200 000 month on an identity check that
//      confirms a document number is well formed and unused, and nothing more.
//   2. Six services were published as active while the capability behind them
//      had no adapter that could send a purchase.
//
// The fix in both cases is the same shape, and this file pins that shape: the
// SUPPLIER declares what it can actually do, and TitoPay reads the declaration
// on every use. A claim can then only be as strong as its evidence, and it
// strengthens by itself the day the evidence does.
//
// The assurance half is proven in limit-engine.test.js, next to the arithmetic
// it bounds. This file holds the catalogue half and the shared principle.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const REGISTRY = read("src", "providers", "index.js");

const vas = require("../src/providers/vas-provider");
const kyc = require("../src/providers/kyc-provider");
const services = require("../src/services/service-management-service");

// The services whose tiles promised a rail TitoPay cannot supply today.
const VAS_SERVICES = ["airtime", "data", "electricity", "voucher", "airtime-data", "pay-bills"];

test("an adapter declares what it can do, and core reads the declaration rather than the name", () => {
  // The rule the provider layer is built on survives this change: core may ask
  // HOW STRONG a capability is, never WHO supplies it.
  assert.match(REGISTRY, /NO PROVIDER NAME MAY APPEAR IN\s*(\/\/)?\s*CORE BUSINESS LOGIC/);
  assert.match(REGISTRY, /function providerAttribute/);
  // Neither reader branches on a provider key.
  const engine = read("src", "services", "limit-engine.js");
  const catalogue = read("src", "services", "service-management-service.js");
  for (const [name, source] of [["the limit engine", engine], ["the catalogue", catalogue]]) {
    for (const provider of ["peach", "flash", "docfox", "internal"]) {
      assert.doesNotMatch(source, new RegExp(`["'\`]${provider}`, "i"),
        `${name} names no provider: it reads a declared capability, not a company`);
    }
  }
});

test("a service is not published as active while its capability cannot transact", async () => {
  // The declaration this rests on. Both shipped VAS adapters say the same
  // thing, and the honest one is the one that can list a catalogue but not
  // sell from it: authenticating is not transacting.
  assert.equal(vas.vasCanPurchase(), false,
    "no VAS provider is contracted, so nothing can be bought today");

  const catalogue = await services.listServices({ audience: "all", includeDisabled: true });
  const byCode = new Map(catalogue.map((row) => [row.service_code, row]));

  let found = 0;
  for (const code of VAS_SERVICES) {
    const row = byCode.get(code);
    if (!row) continue;   // not every deployment seeds every tile
    found += 1;
    assert.notEqual(row.status, "active",
      `${code}: a customer must not be offered a service that would refuse at the till`);
    // COMING SOON, NOT HIDDEN. The service is real and it is coming; the app
    // already has an honest place for that, and deleting the tile would throw
    // away the roadmap along with the false claim.
    assert.equal(row.status, "coming_soon", `${code}: the roadmap is kept, the claim is not`);
    assert.equal(row.capabilityLive, false);
    assert.match(String(row.unavailableReason), /No provider is contracted/i);
  }
  assert.ok(found >= 4, "the VAS tiles are in the catalogue and were checked");

  // Everything NOT backed by an uncontracted capability is untouched. A gate
  // that quietly took the rest of the catalogue down with it would be a far
  // worse failure than the one it fixes.
  const wallet = byCode.get("send-money") || byCode.get("qr-pay");
  assert.ok(wallet, "the wallet rails are still catalogued");
  assert.equal(wallet.status, "active", "a rail TitoPay does supply is still offered");
  assert.equal(wallet.unavailableReason, undefined, "and carries no unavailability of its own");
});

test("the gate is derived on every read, so it cannot be left behind", async () => {
  // The failure this prevents is not "the flag is wrong today" — it is "the
  // flag was set by hand once and nothing moves it again". Proven by moving
  // the declaration and watching the catalogue follow, with no data change.
  const registry = require("../src/providers/index");
  const original = registry.providerAttribute;
  try {
    registry.providerAttribute = (capability, name, fallback) =>
      (capability === "vas" && name === "canPurchase" ? true : original(capability, name, fallback));
    // Re-read through a fresh require of the reader so the stub is in force.
    delete require.cache[require.resolve("../src/providers/vas-provider")];
    const patched = require("../src/providers/vas-provider");
    assert.equal(patched.vasCanPurchase(), true, "the stub stands in for a contracted provider");

    delete require.cache[require.resolve("../src/services/service-management-service")];
    const catalogueWithProvider = require("../src/services/service-management-service");
    const rows = await catalogueWithProvider.listServices({ audience: "all", includeDisabled: true });
    const airtime = rows.find((row) => row.service_code === "airtime");
    if (airtime) {
      assert.equal(airtime.unavailableReason, undefined,
        "contract a provider and the catalogue stops gating, with no deploy and no row to edit");
    }
  } finally {
    registry.providerAttribute = original;
    delete require.cache[require.resolve("../src/providers/vas-provider")];
    delete require.cache[require.resolve("../src/services/service-management-service")];
    require("../src/providers/vas-provider");
  }
});

test("the app's own copy does not promise a rail that is marked coming soon", () => {
  // The tour is read by every new customer before they reach the Services tab.
  // It named airtime and electricity as things they can buy, which made the
  // "Coming soon" badge they met a minute later look like a broken app rather
  // than an honest one.
  const app = read("..", "pwa", "app.js");
  const tour = app.slice(app.indexOf("function howItWorksSteps"),
    app.indexOf("function howItWorksSteps") + 12000);
  assert.doesNotMatch(tour, /[Bb]uy airtime and electricity/,
    "the tour no longer sells a rail the Services tab will not open");
  assert.match(tour, /Coming soon until/,
    "and it says plainly when those services will be available instead");

  // The shipped catalogue the app falls back to offline must agree with the
  // API, or a customer with no signal sees the old claim.
  for (const file of [["..", "services-default.json"], ["..", "pwa", "services-default.json"]]) {
    const items = JSON.parse(read(...file)).items;
    for (const code of VAS_SERVICES) {
      const item = items.find((entry) => entry.service_code === code);
      if (!item) continue;
      assert.notEqual(item.status, "active",
        `${file.join("/")}: ${code} must not be active in the offline catalogue either`);
    }
  }
});

test("identity and VAS are the same problem, and are solved the same way", () => {
  // Stated as a contract so the next capability TitoPay buys is added this way
  // rather than as another flag someone has to remember.
  assert.equal(typeof kyc.identityAssurance, "function", "the identity capability declares its strength");
  assert.equal(typeof vas.vasCanPurchase, "function", "the VAS capability declares whether it can transact");
  assert.ok(kyc.IDENTITY_ASSURANCE.includes("structural") && kyc.IDENTITY_ASSURANCE.includes("verified"),
    "assurance is a named scale, not a boolean, because identity checks differ in strength");
  // Both default to the weakest answer when nothing is wired, so a missing
  // provider narrows the platform instead of silently opening it.
  assert.equal(require("../src/providers/index").providerAttribute("card", "anything", "weakest"), "weakest");
});
