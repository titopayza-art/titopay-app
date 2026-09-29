"use strict";

// THE RELEASE GATE: EVERY WAY THIS CAN FAIL, AND THE PROOF IT FAILS CLOSED.
//
// Two jobs.
//
// FIRST, the fail-closed matrix. Fourteen ways a banking integration can be
// incomplete or wrong, each asserted to produce a refusal rather than a guess.
// This is the list from the release-gate brief, turned into assertions.
//
// SECOND, the architecture contract. A fake, provider-neutral adapter is added
// here and NOWHERE in production code, with fake credentials and fake
// endpoints, to prove two things a future integration depends on: that a
// provider can be added without editing the core, and that adding one is still
// not enough to open a capability on its own.
//
// The fake adapter deliberately resembles no real institution. It is called
// `contract_fixture`, its endpoint is a `.invalid` host, which RFC 2606
// reserves precisely so it can never resolve, and its credentials are the
// string "fake".

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const states = require("../src/lib/banking-state");
const flags = require("../src/config/banking-flags");
const configContract = require("../src/config/banking-config-contract");
const approvalContract = require("../src/config/banking-approval-contract");
const banking = require("../src/services/banking-service");
const bankingProvider = require("../src/providers/banking-provider");
const { registerProvider, CAPABILITIES, describeProviders } = require("../src/providers");
const { pool } = require("../src/db/pool");

const API = path.join(__dirname, "..");
const CAPABILITY = "CUSTOMER_PAYMENT_INITIATION";
const KEY = "release-gate-signing-key-0123456789abcdef0123456789abcdef";
const APPROVER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const COUNTERSIGNER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REFERENCE = "CONTRACT-TEST-REF-2026";

/* ============================================================================
   13. THE FAKE PROVIDER-NEUTRAL ADAPTER
   ========================================================================== */

// Everything a real adapter would supply, and nothing a real adapter would need
// to be real. It implements the contract only: no HTTP, no credential, no
// provider vocabulary. Its whole purpose is to prove the core does not need to
// change when a provider arrives.
const FIXTURE = "contract_fixture";

const FIXTURE_CONFIG = Object.freeze({
  environment: "staging",
  baseUrl: "https://banking.example.invalid/v1", // RFC 2606 reserved: cannot resolve
  clientId: "fake",
  clientSecret: "fake"
});

// The provider's own status words, mapped to TitoPay's. This mapping is the
// ONLY place a provider vocabulary may live, and here it is invented for the
// test rather than copied from any real institution.
const FIXTURE_STATE_MAP = Object.freeze({
  OPENED: states.STATES.CREATED,
  AWAITING_PERSON: states.STATES.CONSENT_PENDING,
  PERSON_AGREED: states.STATES.AUTHORISED,
  SENT: states.STATES.PAYMENT_PENDING,
  DONE: states.STATES.SUCCESS,
  NOT_DONE: states.STATES.FAILED,
  REFUSED_BY_PERSON: states.STATES.REJECTED,
  RAN_OUT: states.STATES.EXPIRED,
  STOPPED: states.STATES.CANCELLED,
  GIVEN_BACK: states.STATES.REFUNDED
});

registerProvider({
  capability: CAPABILITIES.BANKING,
  key: FIXTURE,
  declaredCapabilities() {
    // A realistic adapter implements SOME capabilities, not all. Anything it
    // does not implement stays shut, which is the honest shape.
    const implemented = new Set([
      "CUSTOMER_PAYMENT_INITIATION", "PAYMENT_STATUS", "CONSENT_MANAGEMENT"
    ]);
    return flags.ALL_CAPABILITIES.map((capability) => ({
      capability,
      implemented: implemented.has(capability),
      configured: implemented.has(capability),
      reason: implemented.has(capability) ? null : "NOT_CONFIRMED"
    }));
  },
  configEnvironment() {
    return configContract.readDeclaredEnvironment(FIXTURE_CONFIG);
  },
  // The three it claims. None of them performs an operation: this is a contract
  // fixture, not a simulator, and a simulator would be a provider nobody bought.
  async initiateCustomerPayment() { return { accepted: true, canonicalState: states.STATES.CREATED }; },
  async getPaymentStatus() { return { canonicalState: states.STATES.PAYMENT_PENDING }; },
  async handleProviderCallback() { return { normalised: true }; }
});

async function seedApprovers() {
  for (const [id, label] of [[APPROVER, "rg1"], [COUNTERSIGNER, "rg2"]]) {
    await pool.query(
      `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
       VALUES ($1,$2,$3,$4,'super_admin','not-a-real-hash','active')
       ON CONFLICT (id) DO NOTHING`,
      [id, `Release Gate ${label}`, `release_gate_${label}`, `release_gate_${label}@example.invalid`]
    );
  }
}

async function approveFixture({ provider = FIXTURE, environment = "staging", capability = CAPABILITY } = {}) {
  await seedApprovers();
  const approvedAt = new Date(Date.now() - 60_000).toISOString();
  const countersignedBy = environment === "production" ? COUNTERSIGNER : null;
  const fields = {
    provider, capability, environment,
    approvedBy: APPROVER, approvalReference: REFERENCE, approvedAt
  };
  const signed = approvalContract.signApproval(fields, {
    countersignedBy, env: { BANKING_APPROVAL_SIGNING_KEY: KEY }
  });
  await pool.query(
    `INSERT INTO banking_capability_approvals
       (provider, capability, environment, approved, approved_by, approval_reference,
        approved_at, approval_signature, signature_algorithm, countersigned_by,
        countersigned_at, countersignature, audit_event_id)
     VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (provider, capability, environment) DO UPDATE SET
       approved = TRUE, approved_by = EXCLUDED.approved_by,
       approval_reference = EXCLUDED.approval_reference, approved_at = EXCLUDED.approved_at,
       approval_signature = EXCLUDED.approval_signature,
       signature_algorithm = EXCLUDED.signature_algorithm,
       countersigned_by = EXCLUDED.countersigned_by,
       countersignature = EXCLUDED.countersignature, revoked_at = NULL`,
    [provider, capability, environment, APPROVER, REFERENCE, approvedAt,
     signed.approvalSignature, signed.signatureAlgorithm, countersignedBy,
     countersignedBy ? approvedAt : null, signed.countersignature, crypto.randomUUID()]
  );
}

async function clearApprovals(provider = FIXTURE) {
  await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [provider]).catch(() => {});
}

function fullyOpenEnvironment(overrides = {}) {
  return {
    BANKING_INTEGRATION_ENABLED: "true",
    BANKING_PROVIDER: FIXTURE,
    BANKING_ENVIRONMENT: "staging",
    TITOPAY_ENV: "sandbox",
    BANKING_APPROVAL_SIGNING_KEY: KEY,
    [flags.capabilityFlagName(FIXTURE, CAPABILITY)]: "true",
    ...overrides
  };
}

async function entryFor(env, { provider = FIXTURE, capability = CAPABILITY } = {}) {
  const previous = process.env.BANKING_PROVIDER;
  process.env.BANKING_PROVIDER = provider;
  try {
    const report = await banking.getCapabilityReport({ env });
    return { report, entry: report.capabilities.find((c) => c.capability === capability) };
  } finally {
    if (previous === undefined) delete process.env.BANKING_PROVIDER;
    else process.env.BANKING_PROVIDER = previous;
  }
}

/* ============================================================================
   The control: a provider CAN be added without changing the core
   ========================================================================== */

test("CONTRACT: a new provider is added by registering an adapter, with no core change", async () => {
  // The fixture was registered above with `registerProvider` and nothing else.
  // No file in src/ was edited to accommodate it. This asserts the registry
  // sees it and that the core resolves it purely from configuration.
  const banking_ = describeProviders().find((entry) => entry.capability === "banking");
  assert.equal(banking_.variable, "BANKING_PROVIDER");

  try {
    await approveFixture();
    const { entry } = await entryFor(fullyOpenEnvironment());
    assert.equal(entry.available, true, "six open gates open the capability");
    assert.deepEqual(entry.gates, {
      implemented: true, configured: true, flagEnabled: true,
      environmentPermits: true, configEnvironmentBound: true, approved: true
    });
  } finally { await clearApprovals(); }
});

test("CONTRACT: a capability the adapter does not implement stays shut even when everything else is open", async () => {
  try {
    await approveFixture({ capability: "WITHDRAWAL" });
    const env = fullyOpenEnvironment({
      [flags.capabilityFlagName(FIXTURE, "WITHDRAWAL")]: "true"
    });
    const { entry } = await entryFor(env, { capability: "WITHDRAWAL" });
    assert.equal(entry.gates.approved, true, "approved");
    assert.equal(entry.gates.flagEnabled, true, "flagged on");
    assert.equal(entry.gates.implemented, false, "but not implemented");
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "NOT_CONFIRMED");
  } finally { await clearApprovals(); }
});

/* ============================================================================
   11. THE FAIL-CLOSED MATRIX
   ========================================================================== */

test("FAIL CLOSED: missing adapter -> refuse", async () => {
  const { entry } = await entryFor(
    fullyOpenEnvironment({ BANKING_PROVIDER: "a_provider_with_no_adapter" }),
    { provider: "a_provider_with_no_adapter" }
  );
  assert.equal(entry.available, false);
  assert.equal(entry.reason, "PROVIDER_NOT_REGISTERED");
});

test("FAIL CLOSED: adapter missing the capability -> refuse", async () => {
  try {
    await approveFixture({ capability: "PAYOUT" });
    const env = fullyOpenEnvironment({ [flags.capabilityFlagName(FIXTURE, "PAYOUT")]: "true" });
    const { entry } = await entryFor(env, { capability: "PAYOUT" });
    assert.equal(entry.available, false);
    assert.equal(entry.gates.implemented, false);
  } finally { await clearApprovals(); }
});

test("FAIL CLOSED: missing configuration -> refuse", async () => {
  // An adapter with the code and no configuration.
  const key = "release_gate_unconfigured";
  registerProvider({
    capability: CAPABILITIES.BANKING, key,
    declaredCapabilities() {
      return flags.ALL_CAPABILITIES.map((capability) => ({
        capability, implemented: true, configured: false, reason: "NOT_CONFIGURED"
      }));
    },
    configEnvironment() { return configContract.readDeclaredEnvironment({ environment: "staging" }); }
  });
  try {
    await approveFixture({ provider: key });
    const env = fullyOpenEnvironment({
      BANKING_PROVIDER: key, [flags.capabilityFlagName(key, CAPABILITY)]: "true"
    });
    const { entry } = await entryFor(env, { provider: key });
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "NOT_CONFIGURED");
  } finally { await clearApprovals(key); }
});

test("FAIL CLOSED: invalid configuration -> refuse", async () => {
  // Config present, environment declaration nonsense.
  const key = "release_gate_badconfig";
  registerProvider({
    capability: CAPABILITIES.BANKING, key,
    declaredCapabilities() {
      return flags.ALL_CAPABILITIES.map((capability) => ({
        capability, implemented: true, configured: true, reason: null
      }));
    },
    configEnvironment() { return configContract.readDeclaredEnvironment({ environment: "wherever" }); }
  });
  try {
    await approveFixture({ provider: key });
    const env = fullyOpenEnvironment({
      BANKING_PROVIDER: key, [flags.capabilityFlagName(key, CAPABILITY)]: "true"
    });
    const { entry } = await entryFor(env, { provider: key });
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "STORED_ENVIRONMENT_UNKNOWN");
  } finally { await clearApprovals(key); }
});

test("FAIL CLOSED: missing environment binding -> refuse", async () => {
  const key = "release_gate_unbound";
  registerProvider({
    capability: CAPABILITIES.BANKING, key,
    declaredCapabilities() {
      return flags.ALL_CAPABILITIES.map((capability) => ({
        capability, implemented: true, configured: true, reason: null
      }));
    },
    configEnvironment() { return configContract.readDeclaredEnvironment({ baseUrl: "https://x.invalid" }); }
  });
  try {
    await approveFixture({ provider: key });
    const env = fullyOpenEnvironment({
      BANKING_PROVIDER: key, [flags.capabilityFlagName(key, CAPABILITY)]: "true"
    });
    const { entry } = await entryFor(env, { provider: key });
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "STORED_ENVIRONMENT_MISSING");
  } finally { await clearApprovals(key); }
});

test("FAIL CLOSED: environment mismatch -> refuse", async () => {
  try {
    await approveFixture({ environment: "production" });
    // The fixture's stored config says staging; the runtime says production.
    const { entry } = await entryFor(fullyOpenEnvironment({
      BANKING_ENVIRONMENT: "production", TITOPAY_ENV: "production"
    }));
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "STORED_ENVIRONMENT_MISMATCH");
  } finally { await clearApprovals(); }
});

test("FAIL CLOSED: disabled flag -> refuse", async () => {
  try {
    await approveFixture();
    const env = fullyOpenEnvironment();
    delete env[flags.capabilityFlagName(FIXTURE, CAPABILITY)];
    const { entry } = await entryFor(env);
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "FLAG_DISABLED");
  } finally { await clearApprovals(); }
});

test("FAIL CLOSED: missing approval -> refuse", async () => {
  await clearApprovals();
  const { entry } = await entryFor(fullyOpenEnvironment());
  assert.equal(entry.available, false);
  assert.equal(entry.reason, "APPROVAL_MISSING");
});

test("FAIL CLOSED: revoked approval -> refuse", async () => {
  try {
    await approveFixture();
    await pool.query(
      "UPDATE banking_capability_approvals SET revoked_at = NOW(), revocation_reason = $2 WHERE provider = $1",
      [FIXTURE, "Agreement ended"]
    );
    const { entry } = await entryFor(fullyOpenEnvironment());
    assert.equal(entry.available, false);
    assert.equal(entry.reason, "APPROVAL_REVOKED");
  } finally { await clearApprovals(); }
});

test("FAIL CLOSED: unknown capability -> refuse", async () => {
  await assert.rejects(
    async () => banking.assertCapability("A_CAPABILITY_NOBODY_DEFINED", { env: fullyOpenEnvironment() }),
    (error) => error.details?.code === "CAPABILITY_NOT_SUPPORTED"
  );
});

test("FAIL CLOSED: unknown provider state -> IN_DOUBT, never success", () => {
  for (const unknown of ["SETTLED", "COMPLETE", "OK", "", null, undefined, 1, {}]) {
    assert.equal(states.toCanonicalState(unknown, FIXTURE_STATE_MAP), states.STATES.IN_DOUBT);
  }
  // And the mapped ones do work, so the test is not vacuous.
  assert.equal(states.toCanonicalState("DONE", FIXTURE_STATE_MAP), states.STATES.SUCCESS);
});

test("FAIL CLOSED: unknown environment -> refuse", async () => {
  for (const environment of ["qa", "uat", "prod", "PRODUCTION_2", ""]) {
    const { entry } = await entryFor(fullyOpenEnvironment({ BANKING_ENVIRONMENT: environment }));
    assert.equal(entry.available, false, `${environment || "(empty)"} must refuse`);
  }
});

test("FAIL CLOSED: a malformed provider event is refused safely", async () => {
  for (const bad of [{}, { eventId: "" }, { eventId: "   " }, { eventId: null }]) {
    await assert.rejects(
      async () => banking.recordProviderEvent({
        provider: FIXTURE, environment: "development", payload: {}, ...bad
      }),
      /required/i
    );
  }
});

test("FAIL CLOSED: a duplicate provider event has no second effect", async () => {
  const eventId = `rg-${crypto.randomBytes(8).toString("hex")}`;
  try {
    const first = await banking.recordProviderEvent({
      provider: FIXTURE, environment: "development", eventId, payload: { n: 1 }
    });
    assert.equal(first.duplicate, false);
    for (let i = 0; i < 5; i += 1) {
      const again = await banking.recordProviderEvent({
        provider: FIXTURE, environment: "development", eventId, payload: { n: 2 }
      });
      assert.equal(again.duplicate, true);
    }
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n, MIN((payload->>'n')::int) AS first FROM banking_provider_events WHERE provider=$1 AND event_id=$2",
      [FIXTURE, eventId]
    );
    assert.equal(rows[0].n, 1);
    assert.equal(rows[0].first, 1, "the first body stands");
  } finally {
    await pool.query("DELETE FROM banking_provider_events WHERE provider=$1", [FIXTURE]).catch(() => {});
  }
});

test("FAIL CLOSED: no silent fallback to another provider", async () => {
  // Naming a provider with no adapter must NOT quietly resolve to `none`, to
  // the fixture, or to anything else that happens to be registered.
  const { report } = await entryFor(
    fullyOpenEnvironment({ BANKING_PROVIDER: "nothing_registered_here" }),
    { provider: "nothing_registered_here" }
  );
  assert.equal(report.provider, "nothing_registered_here");
  assert.deepEqual(report.availableCapabilities, []);
});

test("FAIL CLOSED: there is no default live provider", () => {
  // The shipped default is `none`, and `none` implements nothing.
  assert.equal(flags.bankingProviderKey({}), "none");
  for (const entry of bankingProvider.declaredCapabilities()) {
    assert.equal(entry.implemented, false);
  }
});

/* ============================================================================
   7. RECONCILIATION SEAM, UNIMPLEMENTED AND HONEST
   ========================================================================== */

test("reconciliation is a seam that refuses, not a pretence that it works", async () => {
  // The shipped adapter refuses. The fixture does not implement it at all.
  await assert.rejects(
    async () => bankingProvider.reconcile({}),
    (error) => error.details?.code === "CAPABILITY_NOT_SUPPORTED"
  );
  const entry = (await entryFor(fullyOpenEnvironment(), { capability: "RECONCILIATION" })).entry;
  assert.equal(entry.available, false);
});

test("the banking layer holds no settlement assumption, window or matching rule", () => {
  const sources = [
    ["src", "lib", "banking-state.js"], ["src", "config", "banking-flags.js"],
    ["src", "config", "banking-config-contract.js"], ["src", "config", "banking-approval-contract.js"],
    ["src", "providers", "banking-provider.js"], ["src", "services", "banking-service.js"]
  ];
  for (const parts of sources) {
    const code = fs.readFileSync(path.join(API, ...parts), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//"))
      .map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
    for (const [label, pattern] of [
      ["a settlement window", /settlementWindow|T\+\d|businessDay|cutoffTime/i],
      ["a matching rule", /matchBy|reconcileBy|statementFormat/i],
      ["a provider status literal", /"(SETTLED|CLEARED|BOOKED|POSTED)"/]
    ]) {
      assert.doesNotMatch(code, pattern, `${parts.join("/")} must not contain ${label}`);
    }
  }
});

/* ============================================================================
   10. SECURITY BOUNDARY: no credential escapes
   ========================================================================== */

test("the capability report never returns provider configuration", async () => {
  try {
    await approveFixture();
    const { report } = await entryFor(fullyOpenEnvironment());
    const serialised = JSON.stringify(report);
    for (const secret of [
      FIXTURE_CONFIG.baseUrl, "clientSecret", "clientId", "baseUrl", "fake",
      KEY, "example.invalid"
    ]) {
      assert.ok(!serialised.includes(secret),
        `the report leaked "${secret}"; only names and booleans may cross this boundary`);
    }
    // What IS allowed out: the environment NAME.
    assert.equal(report.storedConfigEnvironment, "staging");
  } finally { await clearApprovals(); }
});

test("a refusal error never names a provider or carries a credential", async () => {
  await assert.rejects(
    async () => banking.assertCapability(CAPABILITY, { env: {} }),
    (error) => {
      const serialised = `${error.message} ${JSON.stringify(error.details || {})}`;
      for (const leak of ["fake", KEY, "example.invalid", "clientSecret"]) {
        assert.ok(!serialised.includes(leak), `error leaked ${leak}`);
      }
      // The customer-facing message names nobody at all.
      assert.doesNotMatch(error.message, /bank|provider|absa|peach|contract_fixture/i);
      return true;
    }
  );
});

test("no banking source reads a credential from the environment except the approval signing key", () => {
  const sources = [
    ["src", "lib", "banking-state.js"], ["src", "config", "banking-flags.js"],
    ["src", "config", "banking-config-contract.js"], ["src", "config", "banking-approval-contract.js"],
    ["src", "providers", "banking-provider.js"], ["src", "services", "banking-service.js"]
  ];
  const found = new Set();
  for (const parts of sources) {
    const code = fs.readFileSync(path.join(API, ...parts), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//"))
      .map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
    for (const match of code.matchAll(/env\.([A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CERT)[A-Z_]*)/g)) {
      found.add(match[1]);
    }
    for (const match of code.matchAll(/process\.env\.([A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CERT)[A-Z_]*)/g)) {
      found.add(match[1]);
    }
  }
  assert.deepEqual([...found], ["BANKING_APPROVAL_SIGNING_KEY"],
    "the banking layer may read exactly one secret, and it is not a provider credential");
});

/* ============================================================================
   3 & 15. PROVIDER NEUTRALITY, ACROSS THE WHOLE LAYER
   ========================================================================== */

test("no banking source names any institution, or holds a URL", () => {
  const sources = [
    ["src", "lib", "banking-state.js"], ["src", "config", "banking-flags.js"],
    ["src", "config", "banking-config-contract.js"], ["src", "config", "banking-approval-contract.js"],
    ["src", "providers", "banking-provider.js"], ["src", "services", "banking-service.js"]
  ];
  const names = ["absa", "peach", "docfox", "flash", "ott", "standard bank", "standard_bank",
                 "nedbank", "capitec", "fnb", "investec"];
  for (const parts of sources) {
    const raw = fs.readFileSync(path.join(API, ...parts), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//"))
      .map((l) => l.replace(/\s\/\/.*$/, "")).join("\n").toLowerCase();
    for (const name of names) {
      assert.ok(!code.includes(name), `${parts.join("/")} names ${name}`);
    }
    assert.doesNotMatch(code, /https?:\/\//, `${parts.join("/")} holds a URL`);
  }
});

test("there is exactly one provider registry and one banking state machine", () => {
  // A second registry or a second state machine is the failure mode this whole
  // architecture exists to avoid. Assert the files that could be duplicates
  // do not exist.
  for (const stray of [
    ["src", "banking"], ["src", "banking-integration"], ["src", "integrations", "banking"],
    ["src", "providers", "banking-registry.js"], ["src", "lib", "banking-states.js"]
  ]) {
    assert.equal(fs.existsSync(path.join(API, ...stray)), false,
      `${stray.join("/")} must not exist: one registry, one state machine`);
  }
  // And the registry the core uses is the original one.
  const service = fs.readFileSync(path.join(API, "src", "services", "banking-service.js"), "utf8");
  assert.match(service, /require\("\.\.\/providers"\)/);
});

/* ============================================================================
   8. THE EXISTING RAILS ARE NOT WIRED TO ANY OF THIS
   ========================================================================== */

test("no existing payment rail imports the banking layer", () => {
  const protectedFiles = [
    ["src", "services", "wallet-service.js"],
    ["src", "services", "transaction-service.js"],
    ["src", "services", "peach-checkout-service.js"],
    ["src", "services", "peach-withdrawal-service.js"],
    ["src", "services", "peach-payout-service.js"],
    ["src", "routes", "payments.routes.js"],
    ["src", "routes", "payouts.routes.js"],
    ["src", "routes", "wallet.routes.js"]
  ];
  for (const parts of protectedFiles) {
    const file = path.join(API, ...parts);
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, "utf8");
    for (const module of ["banking-service", "banking-provider", "banking-state",
                          "banking-flags", "banking-config-contract", "banking-approval-contract"]) {
      assert.ok(!code.includes(module),
        `${parts.join("/")} must not reference ${module}: the banking layer stays isolated`);
    }
  }
});

test("no route anywhere reaches the banking layer", () => {
  const routesDir = path.join(API, "src", "routes");
  for (const name of fs.readdirSync(routesDir)) {
    const code = fs.readFileSync(path.join(routesDir, name), "utf8");
    assert.ok(!code.includes("banking-service"), `${name} must not wire the banking layer`);
    assert.ok(!code.includes("banking-provider"), `${name} must not wire the banking adapter`);
  }
});

test("the POS provider CHECK is untouched, and its bank names are not duplicated", () => {
  const schema = fs.readFileSync(path.join(API, "src", "db", "schema.sql"), "utf8");
  // Pre-existing, out of scope, and left exactly as it was.
  assert.match(schema, /provider TEXT NOT NULL CHECK \(provider IN \('STANDARD_BANK', 'ABSA', 'NEDBANK', 'CAPITEC', 'OTHER'\)\)/);
  // And no banking table repeats the pattern.
  const bankingSection = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS banking_capability_approvals"));
  for (const bank of ["ABSA", "STANDARD_BANK", "NEDBANK", "CAPITEC"]) {
    assert.ok(!bankingSection.includes(bank),
      `no banking table may hard-code ${bank}`);
  }
});
