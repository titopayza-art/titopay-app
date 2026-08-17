"use strict";

// GATE 5: STORED CONFIGURATION MUST DECLARE ITS OWN ENVIRONMENT, AND IT MUST MATCH.
//
// The weakness this closes was the last one the Phase 3.5 audit recorded.
// TitoPay resolves integration credentials STORED-CONFIG-FIRST: a
// `platform_settings.integration_*` row beats the environment variable. Every
// environment check written before this one reads the VARIABLE, so a sandbox
// configuration restored into a production database would have passed all of
// them, used sandbox credentials, and reported nothing wrong, because from
// their point of view nothing was.
//
// The fixtures below are test-only. THEY ARE NOT A PROVIDER. They implement no
// operation, hold no credential, reach no network and are registered nowhere in
// production code. They exist so the seven required scenarios can be proved
// against the real gate rather than against a description of it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contract = require("../src/config/banking-config-contract");
const flags = require("../src/config/banking-flags");
const banking = require("../src/services/banking-service");
const { registerProvider, CAPABILITIES } = require("../src/providers");
const { pool } = require("../src/db/pool");

const API = path.join(__dirname, "..");
const CAPABILITY = "CUSTOMER_PAYMENT_INITIATION";

/* ============================================================================
   The test-only fixtures
   ========================================================================== */

// A stored configuration exactly as an operator would save one, minus the
// secrets, which this gate never reads and never needs.
function storedConfigFor(environment, extra = {}) {
  return { environment, baseUrl: "https://example.invalid/api", ...extra };
}

// A fixture adapter: fully implemented and configured, so gates 1 and 2 are
// open and gate 5 is the one under test. It performs no operation.
function registerFixture(key, storedConfig) {
  registerProvider({
    capability: CAPABILITIES.BANKING,
    key,
    declaredCapabilities() {
      return flags.ALL_CAPABILITIES.map((capability) => ({
        capability, implemented: true, configured: true, reason: null
      }));
    },
    // Exactly what a real adapter will do: read its own stored config, run it
    // through the contract, return the decision and never the config.
    configEnvironment() {
      return contract.readDeclaredEnvironment(storedConfig);
    }
  });
  return key;
}

const FIXTURES = {
  sandboxConfig: registerFixture("fixture_cfg_staging", storedConfigFor("staging")),
  productionConfig: registerFixture("fixture_cfg_production", storedConfigFor("production")),
  missingEnvironment: registerFixture("fixture_cfg_missing", { baseUrl: "https://example.invalid/api" }),
  unknownEnvironment: registerFixture("fixture_cfg_unknown", storedConfigFor("playpen")),
  ambiguous: registerFixture("fixture_cfg_ambiguous", storedConfigFor("staging", { mode: "production" })),
  noDeclaration: (() => {
    // An adapter that simply does not implement configEnvironment(). The check
    // must not be skippable by omission.
    const key = "fixture_cfg_undeclared";
    registerProvider({
      capability: CAPABILITIES.BANKING,
      key,
      declaredCapabilities() {
        return flags.ALL_CAPABILITIES.map((capability) => ({
          capability, implemented: true, configured: true, reason: null
        }));
      }
    });
    return key;
  })(),
  throws: (() => {
    const key = "fixture_cfg_throws";
    registerProvider({
      capability: CAPABILITIES.BANKING,
      key,
      declaredCapabilities() {
        return flags.ALL_CAPABILITIES.map((capability) => ({
          capability, implemented: true, configured: true, reason: null
        }));
      },
      configEnvironment() { throw new Error("configuration unreadable"); }
    });
    return key;
  })()
};

async function withProvider(key, fn) {
  const previous = process.env.BANKING_PROVIDER;
  process.env.BANKING_PROVIDER = key;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.BANKING_PROVIDER;
    else process.env.BANKING_PROVIDER = previous;
  }
}

function runtimeEnv(key, { banking: bankingEnvironment, deployment }) {
  const env = {
    BANKING_INTEGRATION_ENABLED: "true",
    BANKING_PROVIDER: key,
    TITOPAY_ENV: deployment,
    [flags.capabilityFlagName(key, CAPABILITY)]: "true"
  };
  if (bankingEnvironment !== undefined) env.BANKING_ENVIRONMENT = bankingEnvironment;
  return env;
}

async function approve(provider, environment) {
  await pool.query(
    `INSERT INTO banking_capability_approvals
       (provider, capability, environment, approved, approved_at, approval_reference)
     VALUES ($1,$2,$3,TRUE,NOW(),'FIXTURE')
     ON CONFLICT (provider, capability, environment)
     DO UPDATE SET approved = TRUE, revoked_at = NULL`,
    [provider, CAPABILITY, environment]
  );
}

async function clearApprovals(provider) {
  await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [provider]).catch(() => {});
}

// Evaluate one scenario end to end and return the capability entry.
async function evaluate(key, { banking: bankingEnvironment, deployment, approveIn }) {
  return withProvider(key, async () => {
    try {
      if (approveIn) await approve(key, approveIn);
      const report = await banking.getCapabilityReport({
        env: runtimeEnv(key, { banking: bankingEnvironment, deployment })
      });
      return {
        report,
        entry: report.capabilities.find((c) => c.capability === CAPABILITY)
      };
    } finally {
      await clearApprovals(key);
    }
  });
}

/* ============================================================================
   3. The seven required scenarios
   ========================================================================== */

test("SCENARIO 1: sandbox config + sandbox runtime -> gate 5 passes", async () => {
  const { entry } = await evaluate(FIXTURES.sandboxConfig, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.configEnvironmentBound, true, "the binding gate must pass");
  assert.equal(entry.gates.environmentPermits, true, "the runtime pairing must pass");
  assert.equal(entry.available, true, "and with every other gate open, the capability opens");
});

test("SCENARIO 2: production config + production runtime -> gate 5 passes", async () => {
  const { entry } = await evaluate(FIXTURES.productionConfig, {
    banking: "production", deployment: "production", approveIn: "production"
  });
  assert.equal(entry.gates.configEnvironmentBound, true);
  assert.equal(entry.gates.environmentPermits, true);
  assert.equal(entry.available, true);
});

test("SCENARIO 3: sandbox config + production runtime -> DENIED", async () => {
  // The exact hazard: platform_settings copied from sandbox into production.
  const { entry, report } = await evaluate(FIXTURES.sandboxConfig, {
    banking: "production", deployment: "production", approveIn: "production"
  });
  assert.equal(entry.gates.environmentPermits, true, "the variables agree with each other");
  assert.equal(entry.gates.configEnvironmentBound, false, "but the stored configuration does not");
  assert.equal(entry.reason, "STORED_ENVIRONMENT_MISMATCH");
  assert.equal(entry.available, false);
  assert.equal(report.storedConfigEnvironment, "staging", "and the report names the wrong world");
});

test("SCENARIO 4: production config + sandbox runtime -> DENIED", async () => {
  const { entry, report } = await evaluate(FIXTURES.productionConfig, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.environmentPermits, true);
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.reason, "STORED_ENVIRONMENT_MISMATCH");
  assert.equal(entry.available, false);
  assert.equal(report.storedConfigEnvironment, "production");
});

test("SCENARIO 5: missing stored environment -> DENIED", async () => {
  const { entry } = await evaluate(FIXTURES.missingEnvironment, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.reason, "STORED_ENVIRONMENT_MISSING");
  assert.equal(entry.available, false);
});

test("SCENARIO 6: unknown stored environment -> DENIED", async () => {
  const { entry } = await evaluate(FIXTURES.unknownEnvironment, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.reason, "STORED_ENVIRONMENT_UNKNOWN");
  assert.equal(entry.available, false);
});

test("SCENARIO 7: unknown runtime environment -> DENIED", async () => {
  // BANKING_ENVIRONMENT is not one of the three. The runtime gate catches it
  // first, which is correct: an operator should be sent to the variable, not to
  // the configuration.
  const { entry } = await evaluate(FIXTURES.sandboxConfig, {
    banking: "playpen", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.environmentPermits, false);
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.available, false);
});

test("SCENARIO 7b: BANKING_ENVIRONMENT absent entirely -> DENIED", async () => {
  const { entry } = await evaluate(FIXTURES.sandboxConfig, {
    banking: undefined, deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.environmentPermits, false);
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.available, false);
});

/* ============================================================================
   Adversarial: ambiguity, omission, and failure to read
   ========================================================================== */

test("a self-contradicting configuration is ambiguous, and ambiguity is refused", async () => {
  // environment: staging, mode: production. Never resolved in favour of either.
  const { entry } = await evaluate(FIXTURES.ambiguous, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.reason, "STORED_ENVIRONMENT_AMBIGUOUS");
  assert.equal(entry.available, false,
    "a config that disagrees with itself must not be resolved in either direction");
});

test("an adapter that omits configEnvironment() is refused, not waved through", async () => {
  const { entry } = await evaluate(FIXTURES.noDeclaration, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.implemented, true, "the code exists");
  assert.equal(entry.gates.configured, true, "the configuration resolves");
  assert.equal(entry.gates.configEnvironmentBound, false, "but it never said which world it is for");
  assert.equal(entry.reason, "CONFIG_ENVIRONMENT_NOT_DECLARED");
  assert.equal(entry.available, false, "the gate must not be skippable by omission");
});

test("an adapter that throws while reading its configuration is refused", async () => {
  const { entry } = await evaluate(FIXTURES.throws, {
    banking: "staging", deployment: "sandbox", approveIn: "staging"
  });
  assert.equal(entry.gates.configEnvironmentBound, false);
  assert.equal(entry.reason, "CONFIG_ENVIRONMENT_NOT_DECLARED");
  assert.equal(entry.available, false);
});

test("the shipped none adapter declares no stored configuration", () => {
  const declaration = require("../src/providers/banking-provider").configEnvironment();
  assert.equal(declaration.ok, false);
  assert.equal(declaration.environment, null);
  assert.equal(declaration.reason, "NO_PROVIDER_CONFIGURED");
});

/* ============================================================================
   2. NOTHING IS INFERRED
   ========================================================================== */

test("environment is never inferred from a URL", () => {
  for (const url of [
    "https://sandbox.example.invalid/api",
    "https://api-test.example.invalid",
    "https://playpen.bank.invalid/v1",
    "https://production.example.invalid",
    "https://live.example.invalid"
  ]) {
    const result = contract.readDeclaredEnvironment({ baseUrl: url });
    assert.equal(result.ok, false, `${url} must not establish an environment`);
    assert.equal(result.reason, "STORED_ENVIRONMENT_MISSING");
  }
});

test("environment is never inferred from a credential name or key format", () => {
  const configs = [
    { clientId: "sandbox_client_123" },
    { apiKeyName: "PRODUCTION_KEY" },
    { keyPrefix: "test_" },
    { clientId: "live_abc", clientSecret: "sk_live_xyz" },
    { credentialLabel: "staging credentials" }
  ];
  for (const config of configs) {
    const result = contract.readDeclaredEnvironment(config);
    assert.equal(result.ok, false, `${JSON.stringify(config)} must not establish an environment`);
    assert.equal(result.reason, "STORED_ENVIRONMENT_MISSING");
  }
});

test("environment is never inferred from a provider or host name", () => {
  for (const config of [
    { provider: "somebank_sandbox" },
    { hostname: "sandbox.somebank.invalid" },
    { name: "Some Bank (Production)" }
  ]) {
    const result = contract.readDeclaredEnvironment(config);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "STORED_ENVIRONMENT_MISSING");
  }
});

test("a config full of production signals with no declaration is still MISSING", () => {
  // The adversarial case: everything screams production, and the contract
  // refuses to agree, because agreeing would teach everyone that guessing works.
  const result = contract.readDeclaredEnvironment({
    baseUrl: "https://api.production.somebank.invalid/v2",
    clientId: "live_production_client",
    clientSecret: "sk_live_real",
    entityId: "PROD-0001",
    note: "this is the production configuration"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "STORED_ENVIRONMENT_MISSING");
  assert.equal(result.environment, null);
});

test("the contract module contains no inference machinery at all", () => {
  const source = fs.readFileSync(path.join(API, "src", "config", "banking-config-contract.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
  // No URL parsing, no host inspection, no key-prefix matching.
  for (const [label, pattern] of [
    ["URL parsing", /new URL\(|\.hostname|\.host\b|parse\s*\(/],
    ["a literal environment guess", /includes\(\s*["'](sandbox|production|test|live|prod)["']/],
    ["a key-format test", /startsWith\(\s*["'](sk_|pk_|test|live)/],
    ["a URL literal", /https?:\/\//]
  ]) {
    assert.doesNotMatch(source, pattern, `the contract must not contain ${label}`);
  }
});

/* ============================================================================
   The contract itself, directly
   ========================================================================== */

test("readDeclaredEnvironment accepts only the three environments, exactly", () => {
  for (const environment of contract.VALID_ENVIRONMENTS) {
    const result = contract.readDeclaredEnvironment({ environment });
    assert.equal(result.ok, true, `${environment} must be accepted`);
    assert.equal(result.environment, environment);
  }
  for (const bad of ["", "  ", "sandbox", "prod", "PRODUCTIONX", "dev", null, undefined, 1, {}, []]) {
    const result = contract.readDeclaredEnvironment({ environment: bad });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("case and whitespace are normalised, but nothing else is forgiven", () => {
  assert.equal(contract.readDeclaredEnvironment({ environment: "  PRODUCTION " }).environment, "production");
  assert.equal(contract.readDeclaredEnvironment({ environment: "Staging" }).environment, "staging");
  // "sandbox" is a DEPLOYMENT word, not a banking-config word. It is not silently
  // translated into staging or development.
  assert.equal(contract.readDeclaredEnvironment({ environment: "sandbox" }).ok, false);
});

test("a missing or malformed config is refused with its own reason", () => {
  assert.equal(contract.readDeclaredEnvironment(null).reason, "STORED_CONFIG_MISSING");
  assert.equal(contract.readDeclaredEnvironment(undefined).reason, "STORED_CONFIG_MISSING");
  assert.equal(contract.readDeclaredEnvironment("production").reason, "STORED_CONFIG_INVALID");
  assert.equal(contract.readDeclaredEnvironment([{ environment: "production" }]).reason, "STORED_CONFIG_INVALID");
});

test("every contradiction field is detected, not just the canonical one", () => {
  for (const field of contract.CONTRADICTION_FIELDS.filter((f) => f !== "environment")) {
    const result = contract.readDeclaredEnvironment({ environment: "staging", [field]: "production" });
    assert.equal(result.reason, "STORED_ENVIRONMENT_AMBIGUOUS",
      `a disagreeing "${field}" must be caught`);
  }
  // Agreement is not ambiguity.
  assert.equal(contract.readDeclaredEnvironment({ environment: "staging", mode: "staging" }).ok, true);
});

test("bindStoredEnvironment requires an exact match, both ways", () => {
  const staging = { environment: "staging" };
  assert.equal(contract.bindStoredEnvironment({ storedConfig: staging, bankingEnvironment: "staging" }).bound, true);
  assert.equal(contract.bindStoredEnvironment({ storedConfig: staging, bankingEnvironment: "production" }).bound, false);
  assert.equal(contract.bindStoredEnvironment({ storedConfig: staging, bankingEnvironment: "development" }).bound, false);
  // An unresolved runtime is reported as a runtime problem, not a config one.
  assert.equal(
    contract.bindStoredEnvironment({ storedConfig: staging, bankingEnvironment: "" }).reason,
    "RUNTIME_ENVIRONMENT_UNKNOWN"
  );
  assert.equal(
    contract.bindStoredEnvironment({ storedConfig: staging, bankingEnvironment: "sandbox" }).reason,
    "RUNTIME_ENVIRONMENT_UNKNOWN"
  );
});

test("normaliseAdapterDeclaration fails closed on anything malformed", () => {
  for (const bad of [null, undefined, "production", 42, [], {}, { ok: true }, { ok: true, environment: "" },
                     { ok: true, environment: "sandbox" }, { ok: false, environment: "production" }]) {
    const result = contract.normaliseAdapterDeclaration(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must not bind`);
  }
  assert.equal(contract.normaliseAdapterDeclaration({ ok: true, environment: "production" }).ok, true);
});

/* ============================================================================
   The gate is load bearing
   ========================================================================== */

test("the availability expression includes the binding gate", () => {
  const source = fs.readFileSync(path.join(API, "src", "services", "banking-service.js"), "utf8");
  assert.match(source, /gates\.configEnvironmentBound/);
  const conjunction = source.match(/const available = [^;]+;/)[0];
  for (const gate of ["implemented", "configured", "flagEnabled", "environmentPermits",
                      "configEnvironmentBound", "approved"]) {
    assert.ok(conjunction.includes(`gates.${gate}`), `the AND must include ${gate}`);
  }
});

test("no credential can reach the capability report", async () => {
  const { report } = await evaluate(FIXTURES.productionConfig, {
    banking: "production", deployment: "production", approveIn: "production"
  });
  const serialised = JSON.stringify(report);
  for (const secret of ["clientSecret", "apiKey", "password", "example.invalid", "baseUrl"]) {
    assert.ok(!serialised.includes(secret),
      `the report leaked ${secret}; only the environment NAME may cross this boundary`);
  }
});
