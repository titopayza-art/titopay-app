"use strict";

// ACTIVATION MOVES TO THE CONSOLE, WITHOUT MOVING THE SAFETY.
//
// Whether TitoPay can sell airtime used to be one hardcoded boolean in an
// adapter file, so switching the VAS rail on, changing supplier, or killing it
// during a supplier outage all needed a code change and a release. That is the
// wrong place for an operational decision: the person who knows the supplier
// is down on a Friday night is not the person holding a deploy key.
//
// It now reads the Integration Centre as well — enabled, configured, and a
// connection test that passed, all Super Admin only and audited.
//
// THE PROPERTY THIS FILE EXISTS TO PIN is that the two are an AND, never an
// OR. The console can close the gate and can never open one the code cannot
// honour, because the adapter's declaration is not a preference — it is the
// presence of code that speaks the supplier's protocol, which no configuration
// field brings into existence. A console switch that published a service with
// no adapter behind it would debit a customer, receive a 503, classify it as
// unknown rather than refused, and hold their money against a voucher that can
// never exist.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { pool } = require("../src/db/pool");
const activation = require("../src/providers/capability-activation");
const vas = require("../src/providers/vas-provider");

const KEY = "integration_flash";

async function setIntegration(value) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2::JSONB, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(value)]
  );
  await activation.refreshCapabilityActivation();
}

let original = null;

test.before(async () => {
  const { rows } = await pool.query("SELECT value FROM platform_settings WHERE key = $1", [KEY]);
  original = rows[0] ? rows[0].value : null;
});

test.after(async () => {
  if (original) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1,$2::JSONB,NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [KEY, JSON.stringify(original)]);
  } else {
    await pool.query("DELETE FROM platform_settings WHERE key = $1", [KEY]);
  }
  await activation.refreshCapabilityActivation();
  await pool.end();
});

test("SWITCHING IT ON IN THE CONSOLE CANNOT PUBLISH A RAIL THE CODE CANNOT SEND", async () => {
  // The whole point. Every field an operator controls is set to the most
  // permissive value there is — enabled, configured, connection test passed —
  // and the answer is still no, because no adapter declares it can purchase.
  await setIntegration({
    label: "Flash", enabled: true, configured: true, environment: "production",
    health: { status: "connected", lastTestedAt: new Date().toISOString() }
  });
  assert.equal(activation.capabilityActivated("vas"), true,
    "the operator's half is satisfied");
  assert.equal(vas.vasCanPurchase(), false,
    "and the rail is still closed, because no adapter can send a purchase");
});

test("switching it off closes the gate regardless of the adapter", async () => {
  // The half that is genuinely useful today: a kill switch that needs no
  // release. Proving it needs an adapter whose own answer is true, and a
  // monkeypatch cannot supply one — vas-provider destructures
  // providerAttribute at require time, so reassigning the export changes
  // nothing. The first version of this test did exactly that and reported a
  // failure that was its own.
  //
  // A real adapter is registered instead and selected the way production
  // selects one, through VAS_PROVIDER, which configuredKey reads on every
  // call. That makes this the same path an operator takes.
  const { registerProvider, CAPABILITIES } = require("../src/providers");
  registerProvider({
    capability: CAPABILITIES.VAS,
    key: "activation-test-adapter",
    canPurchase: true,
    purchaseAirtime: async () => ({ token: "unused" }),
    purchaseData: async () => ({ token: "unused" }),
    purchaseElectricity: async () => ({ token: "unused" }),
    async listProducts() { return { products: [] }; }
  });
  const previous = process.env.VAS_PROVIDER;
  process.env.VAS_PROVIDER = "activation-test-adapter";
  try {
    await setIntegration({
      label: "Flash", enabled: true, configured: true, environment: "production",
      health: { status: "connected", lastTestedAt: new Date().toISOString() }
    });
    assert.equal(vas.vasCanPurchase(), true, "both halves satisfied, so the rail is open");

    await setIntegration({
      label: "Flash", enabled: false, configured: true, environment: "production",
      health: { status: "connected", lastTestedAt: new Date().toISOString() }
    });
    assert.equal(vas.vasCanPurchase(), false,
      "an operator disabling it closes the rail without a deploy");
  } finally {
    if (previous === undefined) delete process.env.VAS_PROVIDER;
    else process.env.VAS_PROVIDER = previous;
  }
});

test("every half-configured state reads as off", async () => {
  // Fail closed, in every direction. A service briefly not offered is a
  // disappointment; a service offered that cannot transact takes money.
  const cases = [
    ["enabled but never tested", { enabled: true, configured: true, health: { status: "not_tested" } }],
    ["enabled but the test failed", { enabled: true, configured: true, health: { status: "failed" } }],
    ["tested but not configured", { enabled: true, configured: false, health: { status: "connected" } }],
    ["configured but not enabled", { enabled: false, configured: true, health: { status: "connected" } }],
    ["nothing set at all", {}],
  ];
  for (const [name, value] of cases) {
    await setIntegration({ label: "Flash", environment: "production", ...value });
    assert.equal(activation.capabilityActivated("vas"), false, name);
  }
});

test("a missing settings row is off, not on", async () => {
  await pool.query("DELETE FROM platform_settings WHERE key = $1", [KEY]);
  await activation.refreshCapabilityActivation();
  assert.equal(activation.capabilityActivated("vas"), false,
    "no integration row means nobody switched it on");
  assert.equal(vas.vasCanPurchase(), false);
});

test("nothing about today's behaviour changed", async () => {
  // The regression that matters to a live platform. Before this existed, the
  // five VAS services were served as coming soon. They still are, and for the
  // same reason, whatever the console says.
  const catalogue = require("../src/services/service-management-service");
  await setIntegration({
    label: "Flash", enabled: true, configured: true, environment: "production",
    health: { status: "connected", lastTestedAt: new Date().toISOString() }
  });
  const report = catalogue.capabilityReport().find((entry) => entry.capability === "vas");
  assert.equal(report.live, false, "the catalogue still reports the rail as not live");
  assert.ok(report.services.includes("airtime") && report.services.includes("electricity"),
    "and still names the services it holds back");
});

test("the console can only ever close the gate, asserted on the source", () => {
  // An OR here would be the whole safety property gone, and it is one
  // character away from an AND. Pinned in the file rather than left to review.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "providers", "vas-provider.js"), "utf8");
  assert.match(source,
    /vasCanPurchase: \(\) => Boolean\(providerAttribute\(CAPABILITIES\.VAS, "canPurchase", false\)\)\s*\n\s*&& capabilityActivated\(CAPABILITIES\.VAS\)/,
    "the adapter's declaration and the operator's switch must both be required");
  assert.ok(!/canPurchase[^\n]*\|\|\s*capabilityActivated/.test(source),
    "an OR would let the console publish a rail the code cannot send");
});

test("the cache fails closed when the database cannot be read", async () => {
  // A failed refresh keeps the last known answer rather than inventing one,
  // and the answer before anything is known is false.
  const store = require("../src/providers/capability-activation");
  assert.equal(typeof store.capabilityActivated, "function");
  const detail = store.activationDetail("vas");
  assert.equal(detail.capability, "vas");
  assert.deepEqual(detail.sources, ["integration_flash"],
    "the console rows that can activate this capability are named, not guessed");
});
