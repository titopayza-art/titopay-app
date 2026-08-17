"use strict";

// PHASE 3.5 SAFETY AUDIT, AS EXECUTABLE ASSERTIONS.
//
// The Phase 3 suite proves the layer behaves. This one proves it cannot be made
// to misbehave. Every test below is adversarial: it takes a control and tries
// to get past it, one control at a time, and asserts that the attempt fails.
//
// The central technique is GATE INDEPENDENCE. It is not enough that a fully
// closed system stays closed; that would pass even if four of the five gates
// were dead code. So each test opens FOUR gates and shuts exactly ONE, and
// asserts the capability is still unavailable. Five tests, five single points
// of failure, none of which is load bearing on its own.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const states = require("../src/lib/banking-state");
const flags = require("../src/config/banking-flags");
const banking = require("../src/services/banking-service");
const { pool } = require("../src/db/pool");

const API = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(API, ...parts), "utf8");

// Comments are documentation, not coupling. Same rule the provider-boundary
// test has always used.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

const BANKING_SOURCES = [
  ["src", "lib", "banking-state.js"],
  ["src", "config", "banking-flags.js"],
  ["src", "providers", "banking-provider.js"],
  ["src", "services", "banking-service.js"]
];

/* ============================================================================
   1. CAPABILITY GATES — five, each independently sufficient to refuse
   ========================================================================== */

// A TEST-ONLY ADAPTER, AND WHY IT HAS TO EXIST.
//
// The shipped `none` adapter implements nothing, so `implemented` is false
// forever, so `available` is false forever. That makes every "shut one gate and
// check it refuses" test VACUOUS: it would pass with the other four gates
// deleted, because the answer was already no.
//
// Mutation testing caught exactly that. Deleting `gates.flagEnabled` from the
// availability conjunction broke nothing, because nothing could tell the
// difference. So the gates are tested against a stub that declares itself fully
// implemented and configured, which lets the suite prove BOTH directions: all
// five gates open really does mean available, and shutting any ONE of them
// really does close it.
//
// This adapter exists only in this test file. It is never registered by
// production code, it performs no operation, and it moves nothing.
const { registerProvider, CAPABILITIES: PROVIDER_CAPABILITIES } = require("../src/providers");

const PROVIDER = "audit_stub";
const CAPABILITY = "CUSTOMER_PAYMENT_INITIATION";

registerProvider({
  capability: PROVIDER_CAPABILITIES.BANKING,
  key: PROVIDER,
  declaredCapabilities() {
    return flags.ALL_CAPABILITIES.map((capability) => ({
      capability, implemented: true, configured: true, reason: null
    }));
  }
});

// The registry resolves the adapter from the REAL process environment, so a
// test that wants the stub to answer has to say so there. Saved and restored
// around each use, so no test leaks configuration into another.
function withStubProvider(run) {
  const previous = process.env.BANKING_PROVIDER;
  process.env.BANKING_PROVIDER = PROVIDER;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.BANKING_PROVIDER;
      else process.env.BANKING_PROVIDER = previous;
    });
}

function openEnvironment(overrides = {}) {
  return {
    BANKING_INTEGRATION_ENABLED: "true",
    BANKING_PROVIDER: PROVIDER,
    BANKING_ENVIRONMENT: "staging",
    TITOPAY_ENV: "sandbox",
    [flags.capabilityFlagName(PROVIDER, CAPABILITY)]: "true",
    ...overrides
  };
}

async function approve(provider, capability, environment) {
  await pool.query(
    `INSERT INTO banking_capability_approvals
       (provider, capability, environment, approved, approved_at, approval_reference)
     VALUES ($1,$2,$3,TRUE,NOW(),'AUDIT-TEST')
     ON CONFLICT (provider, capability, environment)
     DO UPDATE SET approved = TRUE, revoked_at = NULL`,
    [provider, capability, environment]
  );
}

async function clearApprovals(provider) {
  await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [provider]).catch(() => {});
}

async function entryFor(env) {
  const report = await banking.getCapabilityReport({ env });
  return { report, entry: report.capabilities.find((c) => c.capability === CAPABILITY) };
}

// THE CONTROL. If this does not pass, every refusal test below is vacuous:
// they would be observing a system that was never capable of saying yes.
test("CONTROL: all five gates open really does make a capability available", async () => {
  await withStubProvider(async () => {
    try {
      await approve(PROVIDER, CAPABILITY, "staging");
      const { entry } = await entryFor(openEnvironment());
      assert.deepEqual(entry.gates, {
        implemented: true, configured: true, flagEnabled: true,
        environmentPermits: true, approved: true
      });
      assert.equal(entry.available, true, "five open gates must open the capability");
      assert.equal(entry.reason, null);
    } finally {
      await clearApprovals(PROVIDER);
    }
  });
});

// Register the two stubs that isolate gates 1 and 2 from each other. The
// shipped `none` adapter shuts BOTH, so using it would let either gate be
// deleted from the conjunction undetected: mutation testing caught that too.
// Each stub shuts exactly one.
function registerStub(key, { implemented, configured, reason }) {
  registerProvider({
    capability: PROVIDER_CAPABILITIES.BANKING,
    key,
    declaredCapabilities() {
      return flags.ALL_CAPABILITIES.map((capability) => ({
        capability, implemented, configured, reason
      }));
    }
  });
}
registerStub("audit_stub_unimplemented", { implemented: false, configured: true, reason: "NOT_IMPLEMENTED" });
registerStub("audit_stub_unconfigured", { implemented: true, configured: false, reason: "NOT_CONFIGURED" });

// Run `fn` with a specific adapter selected in the real process environment.
async function withProvider(key, fn) {
  const previous = process.env.BANKING_PROVIDER;
  process.env.BANKING_PROVIDER = key;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BANKING_PROVIDER;
    else process.env.BANKING_PROVIDER = previous;
  }
}

function environmentFor(key, overrides = {}) {
  return {
    BANKING_INTEGRATION_ENABLED: "true",
    BANKING_PROVIDER: key,
    BANKING_ENVIRONMENT: "staging",
    TITOPAY_ENV: "sandbox",
    [flags.capabilityFlagName(key, CAPABILITY)]: "true",
    ...overrides
  };
}

test("GATE 1 (implemented): configured but NOT implemented -> refused", async () => {
  // Credentials present, code absent. The failure `configured` alone cannot
  // express, and the reason gate 1 has to be its own boolean.
  const key = "audit_stub_unimplemented";
  await withProvider(key, async () => {
    try {
      await approve(key, CAPABILITY, "staging");
      const { entry } = await entryFor(environmentFor(key));
      assert.equal(entry.gates.configured, true, "the configuration resolves");
      assert.equal(entry.gates.implemented, false, "and the code does not exist");
      assert.equal(entry.gates.flagEnabled, true, "flag gate open");
      assert.equal(entry.gates.environmentPermits, true, "environment gate open");
      assert.equal(entry.gates.approved, true, "approval gate open");
      assert.equal(entry.available, false, "a missing implementation alone must refuse");
      assert.equal(entry.reason, "NOT_IMPLEMENTED");
    } finally {
      await clearApprovals(key);
    }
  });
});

test("GATE 1b: the shipped adapter shuts implementation for every capability", async () => {
  try {
    await approve(PROVIDER, CAPABILITY, "staging");
    const { entry } = await entryFor(openEnvironment());
    assert.equal(entry.gates.implemented, false);
    assert.equal(entry.available, false);
  } finally {
    await clearApprovals(PROVIDER);
  }
});

test("GATE 2 (configured): implemented but NOT configured -> refused", async () => {
  // Code present, credentials absent. The failure `implemented` alone cannot
  // express, and the mirror image of the gate 1 test above.
  const key = "audit_stub_unconfigured";
  await withProvider(key, async () => {
    try {
      await approve(key, CAPABILITY, "staging");
      const { entry } = await entryFor(environmentFor(key));
      assert.equal(entry.gates.implemented, true, "the code exists");
      assert.equal(entry.gates.configured, false, "and the configuration does not");
      assert.equal(entry.gates.flagEnabled, true, "flag gate open");
      assert.equal(entry.gates.environmentPermits, true, "environment gate open");
      assert.equal(entry.gates.approved, true, "approval gate open");
      assert.equal(entry.available, false, "missing configuration alone must refuse");
      assert.equal(entry.reason, "NOT_CONFIGURED");
    } finally {
      await clearApprovals(key);
    }
  });
});

test("GATE 3 (flag): shut alone -> refused", async () => {
  await withStubProvider(async () => {
    try {
      await approve(PROVIDER, CAPABILITY, "staging");
      const env = openEnvironment();
      delete env[flags.capabilityFlagName(PROVIDER, CAPABILITY)];
      const { entry } = await entryFor(env);

      assert.equal(entry.gates.implemented, true, "implementation gate open");
      assert.equal(entry.gates.configured, true, "configuration gate open");
      assert.equal(entry.gates.environmentPermits, true, "environment gate open");
      assert.equal(entry.gates.approved, true, "approval gate open");
      assert.equal(entry.gates.flagEnabled, false, "flag gate shut");
      assert.equal(entry.available, false, "the flag alone must refuse");
      assert.equal(entry.reason, "FLAG_DISABLED");
    } finally {
      await clearApprovals(PROVIDER);
    }
  });
});

test("GATE 3b (master switch): shut alone -> every capability refused", async () => {
  await withStubProvider(async () => {
    try {
      for (const capability of flags.ALL_CAPABILITIES) await approve(PROVIDER, capability, "staging");
      const { report } = await entryFor(openEnvironment({ BANKING_INTEGRATION_ENABLED: "false" }));
      for (const entry of report.capabilities) {
        assert.equal(entry.gates.implemented, true, `${entry.capability} code exists`);
        assert.equal(entry.gates.approved, true, `${entry.capability} is approved`);
        assert.equal(entry.gates.flagEnabled, false, `${entry.capability} must be flag-shut`);
        assert.equal(entry.available, false, `${entry.capability} must refuse`);
      }
    } finally {
      await clearApprovals(PROVIDER);
    }
  });
});

test("GATE 4 (environment): shut alone -> refused", async () => {
  await withStubProvider(async () => {
    try {
      await approve(PROVIDER, CAPABILITY, "production");
      // Production banking on a sandbox deployment. Approved for production, so
      // the approval gate is genuinely open for the environment being asked about.
      const { entry, report } = await entryFor(
        openEnvironment({ BANKING_ENVIRONMENT: "production", TITOPAY_ENV: "sandbox" })
      );
      assert.equal(entry.gates.implemented, true, "implementation gate open");
      assert.equal(entry.gates.flagEnabled, true, "flag gate open");
      assert.equal(entry.gates.environmentPermits, false, "environment gate shut");
      assert.equal(entry.available, false, "the environment alone must refuse");
      assert.equal(report.environmentReason, "PRODUCTION_BANKING_ON_NON_PRODUCTION_DEPLOYMENT");
    } finally {
      await clearApprovals(PROVIDER);
    }
  });
});

test("GATE 5 (approval): shut alone -> refused", async () => {
  await withStubProvider(async () => {
    await clearApprovals(PROVIDER);
    const { entry } = await entryFor(openEnvironment());

    assert.equal(entry.gates.implemented, true, "implementation gate open");
    assert.equal(entry.gates.configured, true, "configuration gate open");
    assert.equal(entry.gates.flagEnabled, true, "flag gate open");
    assert.equal(entry.gates.environmentPermits, true, "environment gate open");
    assert.equal(entry.gates.approved, false, "approval gate shut");
    assert.equal(entry.available, false, "the approval alone must refuse");
    assert.equal(entry.reason, "NOT_APPROVED");
  });
});

test("GATE 5e: a revoked approval shuts the gate with everything else open", async () => {
  await withStubProvider(async () => {
    try {
      await approve(PROVIDER, CAPABILITY, "staging");
      await pool.query(
        "UPDATE banking_capability_approvals SET revoked_at = NOW() WHERE provider = $1 AND capability = $2",
        [PROVIDER, CAPABILITY]
      );
      const { entry } = await entryFor(openEnvironment());
      assert.equal(entry.gates.approved, false, "a revoked approval is not an approval");
      assert.equal(entry.available, false);
    } finally {
      await clearApprovals(PROVIDER);
    }
  });
});

test("assertCapability opens only when all five gates are open", async () => {
  await withStubProvider(async () => {
    try {
      await approve(PROVIDER, CAPABILITY, "staging");
      // Positive: it resolves rather than throwing.
      const resolved = await banking.assertCapability(CAPABILITY, { env: openEnvironment() });
      assert.equal(resolved.provider, PROVIDER);
      assert.equal(resolved.environment, "staging");

      // Negative: shut each gate in turn, one at a time.
      const noFlag = openEnvironment();
      delete noFlag[flags.capabilityFlagName(PROVIDER, CAPABILITY)];
      const singleFailures = [
        ["master flag", openEnvironment({ BANKING_INTEGRATION_ENABLED: "false" })],
        ["capability flag", noFlag],
        ["environment", openEnvironment({ BANKING_ENVIRONMENT: "production" })],
        ["environment undeclared", openEnvironment({ TITOPAY_ENV: "" })]
      ];
      for (const [label, env] of singleFailures) {
        await assert.rejects(
          async () => banking.assertCapability(CAPABILITY, { env }),
          (error) => error.details?.code === "CAPABILITY_NOT_SUPPORTED",
          `${label} must refuse`
        );
      }
    } finally {
      await clearApprovals(PROVIDER);
    }
    // And with the approval removed, it refuses too.
    await assert.rejects(
      async () => banking.assertCapability(CAPABILITY, { env: openEnvironment() }),
      (error) => error.details?.code === "CAPABILITY_NOT_SUPPORTED"
    );
  });
});

test("GATE 5b: an approval for a DIFFERENT environment does not open this one", async () => {
  try {
    // Approved for production; asking about staging.
    await approve(PROVIDER, CAPABILITY, "production");
    const report = await banking.getCapabilityReport({ env: openEnvironment() });
    const entry = report.capabilities.find((c) => c.capability === CAPABILITY);
    assert.equal(entry.gates.approved, false,
      "an approval is scoped to one environment and must not leak into another");
  } finally {
    await clearApprovals(PROVIDER);
  }
});

test("GATE 5c: an approval for a DIFFERENT capability does not open this one", async () => {
  try {
    await approve(PROVIDER, "PAYOUT", "staging");
    const report = await banking.getCapabilityReport({ env: openEnvironment() });
    const initiation = report.capabilities.find((c) => c.capability === CAPABILITY);
    const payout = report.capabilities.find((c) => c.capability === "PAYOUT");
    assert.equal(initiation.gates.approved, false, "approval must not leak between capabilities");
    assert.equal(payout.gates.approved, true, "the approved capability is the one approved");
  } finally {
    await clearApprovals(PROVIDER);
  }
});

test("GATE 5d: an approval for a DIFFERENT provider does not open this one", async () => {
  try {
    await approve("some_other_bank", CAPABILITY, "staging");
    const report = await banking.getCapabilityReport({ env: openEnvironment() });
    const entry = report.capabilities.find((c) => c.capability === CAPABILITY);
    assert.equal(entry.gates.approved, false, "approval must not leak between providers");
  } finally {
    await clearApprovals("some_other_bank");
  }
});

test("the availability expression requires all five gates and nothing less", () => {
  const source = codeOnly(read("src", "services", "banking-service.js"));
  // The exact conjunction, so a gate cannot be quietly dropped from it.
  for (const gate of ["implemented", "configured", "flagEnabled", "environmentPermits", "approved"]) {
    assert.match(source, new RegExp(`gates\\.${gate}`), `the AND must include ${gate}`);
  }
  // No short circuit that could bypass the conjunction.
  assert.doesNotMatch(source, /available\s*=\s*true/, "availability must never be assigned true directly");
  assert.doesNotMatch(source, /FORCE|OVERRIDE|BYPASS|SKIP_GATE/i, "no override path may exist");
});

test("assertCapability refuses on every single-gate failure, before writing anything", async () => {
  const shutOneGate = [
    ["flag", openEnvironment({ BANKING_INTEGRATION_ENABLED: "false" })],
    ["environment", openEnvironment({ BANKING_ENVIRONMENT: "production" })],
    ["environment-undeclared", openEnvironment({ TITOPAY_ENV: "" })],
    ["approval", openEnvironment()]
  ];
  for (const [label, env] of shutOneGate) {
    await assert.rejects(
      async () => banking.assertCapability(CAPABILITY, { env }),
      (error) => {
        assert.equal(error.statusCode, 503, `${label} status`);
        assert.equal(error.details?.code, "CAPABILITY_NOT_SUPPORTED", `${label} code`);
        return true;
      },
      `${label} must refuse`
    );
  }
});

/* ============================================================================
   2. FINANCIAL ISOLATION
   ========================================================================== */

test("no banking source file writes to any financial table", () => {
  for (const parts of BANKING_SOURCES) {
    const code = codeOnly(read(...parts));
    for (const table of ["transactions", "wallets", "wallet_ledger", "revenue_ledger"]) {
      const writes = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, "i");
      assert.doesNotMatch(code, writes,
        `${parts.join("/")} must never write to ${table}`);
    }
  }
});

test("no banking source file imports a money-moving service", () => {
  for (const parts of BANKING_SOURCES) {
    const code = codeOnly(read(...parts));
    for (const service of [
      "wallet-service", "transaction-service", "pricing-service",
      "peach-checkout-service", "peach-withdrawal-service", "peach-payout-service"
    ]) {
      assert.doesNotMatch(code, new RegExp(`require\\([^)]*${service}`),
        `${parts.join("/")} must not import ${service}`);
    }
  }
});

test("no banking source file calls a wallet movement primitive", () => {
  for (const parts of BANKING_SOURCES) {
    const code = codeOnly(read(...parts));
    for (const primitive of [
      "applyWalletMovement", "getPrimaryWalletForUser", "getRevenueWallet",
      "settleTopupTransaction", "recordTopupFeeRevenue", "available_balance",
      "reserved_balance", "balance_after"
    ]) {
      assert.ok(!code.includes(primitive),
        `${parts.join("/")} must not reference ${primitive}`);
    }
  }
});

test("the banking service touches banking tables and nothing else", () => {
  const code = codeOnly(read("src", "services", "banking-service.js"));
  const tables = new Set();
  for (const match of code.matchAll(/(?:FROM|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)) {
    tables.add(match[1].toLowerCase());
  }
  for (const table of tables) {
    assert.ok(table.startsWith("banking_"),
      `the banking service reached a non-banking table: ${table}`);
  }
  assert.ok(tables.size >= 4, "it should touch its own four tables");
});

test("no banking table has a foreign key into a wallet or ledger table", async () => {
  const { rows } = await pool.query(`
    SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid::regclass::text LIKE 'banking%'
  `);
  const forbidden = ["wallets", "wallet_ledger", "revenue_ledger"];
  for (const row of rows) {
    assert.ok(!forbidden.includes(row.parent),
      `${row.conname} links a banking table to ${row.parent}`);
  }
  // The one financial link that IS allowed, because an intent must describe a
  // real transaction, is a read-only reference and cannot alter it.
  assert.ok(rows.some((r) => r.parent === "transactions"),
    "an intent must reference the transaction it describes");
});

test("no banking table carries a balance, an amount authority or a ledger column", async () => {
  const { rows } = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'banking_%'
       AND (column_name LIKE '%balance%' OR column_name LIKE '%ledger%'
            OR column_name IN ('debit', 'credit', 'entry_type', 'balance_after'))
  `);
  assert.deepEqual(rows, [], "banking tables must never hold ledger or balance data");
});

test("the banking layer cannot mark a transaction successful: it never updates one", () => {
  const code = codeOnly(read("src", "services", "banking-service.js"));
  assert.doesNotMatch(code, /status\s*=\s*'completed'/i);
  assert.doesNotMatch(code, /UPDATE\s+transactions/i);
});

test("the intent amount is evidence, not authority: it is never summed or compared to a balance", () => {
  const code = codeOnly(read("src", "services", "banking-service.js"));
  assert.doesNotMatch(code, /SUM\s*\(/i, "the banking layer must never aggregate money");
  assert.doesNotMatch(code, /\bbalance\b/i);
});

/* ============================================================================
   3. STATE MACHINE
   ========================================================================== */

test("every state has a documented meaning, and there are no orphan meanings", () => {
  for (const state of states.ALL_STATES) {
    const meaning = states.STATE_MEANINGS[state];
    assert.ok(meaning && meaning.length > 20, `${state} needs a documented meaning`);
  }
  assert.deepEqual(
    Object.keys(states.STATE_MEANINGS).sort(),
    [...states.ALL_STATES].sort(),
    "the meanings and the states must be the same set"
  );
});

test("every ordered pair of states is explicitly allowed or refused, with no undefined answer", () => {
  for (const from of states.ALL_STATES) {
    for (const to of states.ALL_STATES) {
      const answer = states.canTransition(from, to);
      assert.equal(typeof answer, "boolean", `${from} -> ${to} must be a decision, not undefined`);
    }
  }
  // And the transition table covers every state as a source.
  assert.deepEqual(
    Object.keys(states.ALLOWED_TRANSITIONS).sort(),
    [...states.ALL_STATES].sort()
  );
});

test("an unknown state on either side fails closed", () => {
  for (const bad of ["", null, undefined, "SUCCESS ", "success", "MADE_UP", 0, {}]) {
    assert.equal(states.canTransition(bad, "SUCCESS"), false, `from ${String(bad)}`);
    assert.equal(states.canTransition("CREATED", bad), false, `to ${String(bad)}`);
  }
});

test("no terminal state regresses to a non-terminal one", () => {
  const nonTerminal = states.ALL_STATES.filter((s) => !states.TERMINAL_STATES.includes(s));
  for (const terminal of states.TERMINAL_STATES) {
    for (const target of nonTerminal) {
      assert.equal(states.canTransition(terminal, target), false,
        `${terminal} must not regress to ${target}`);
    }
  }
});

test("SUCCESS is reachable only from states where money could already be in flight", () => {
  const sources = states.ALL_STATES.filter((from) =>
    from !== "SUCCESS" && states.canTransition(from, "SUCCESS"));
  assert.deepEqual(sources.sort(), ["AUTHORISED", "IN_DOUBT", "PAYMENT_PENDING"],
    "nothing else may settle");
});

test("IN_DOUBT is the sink for every unknown, and resolves only by explicit call", () => {
  // Nothing maps into SUCCESS by default.
  const mapping = {};
  for (const word of ["ok", "OK", "SUCCESS", "success", "PAID", "COMPLETE", "1", "true"]) {
    assert.equal(states.toCanonicalState(word, mapping), "IN_DOUBT",
      `an unmapped "${word}" must not settle`);
  }
  // Even a mapping that points at a non-state cannot produce one.
  assert.equal(states.toCanonicalState("X", { X: "SUCCESS " }), "IN_DOUBT");
  assert.equal(states.toCanonicalState("X", { X: null }), "IN_DOUBT");
});

test("the state machine is not a second financial state machine", () => {
  const code = codeOnly(read("src", "lib", "banking-state.js"));
  const lower = code.toLowerCase();

  // It holds no money data and no money operation.
  for (const word of ["balance", "debit", "ledger", "amount", "fee", "currency"]) {
    assert.ok(!lower.includes(word), `banking-state.js must not know about ${word}`);
  }

  // "credit" appears, and must: CREDITING_STATES and creditsWallet() are the
  // safety marker naming the one state that may result in a credit. What must
  // NOT be there is the ability to perform one. So: no database, no network,
  // no persistence of any kind. It is a pure module and this proves it.
  // Matched as CONSTRUCTS, not as words: the state meanings are prose and the
  // word "query" appears in one of them, describing where evidence comes from.
  assert.doesNotMatch(code, /require\s*\(/, "banking-state.js must import nothing");
  for (const [label, pattern] of [
    ["a database pool", /\bpool\s*\./],
    ["a database call", /\.\s*query\s*\(/],
    ["SQL", /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|SELECT\s+.+\s+FROM|DELETE\s+FROM)\b/i],
    ["network access", /\bfetch\s*\(/],
    ["asynchrony", /\b(async|await)\s/]
  ]) {
    assert.doesNotMatch(code, pattern,
      `banking-state.js must be pure: it must not contain ${label}`);
  }
  // And every use of "credit" in executable code is one of the two safety
  // identifiers. String literals are excluded: STATE_MEANINGS is documentation
  // that happens to live in a string so a test can check it exists.
  const withoutStrings = code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  const stray = withoutStrings
    .replace(/CREDITING_STATES|creditsWallet/g, "")
    .match(/credit/gi);
  assert.equal(stray, null,
    "every mention of credit in code must be the CREDITING_STATES / creditsWallet marker");
  assert.match(code, /CREDITING_STATES/, "the marker must exist");
  // And it maps onto the existing statuses rather than defining new ones.
  const existing = new Set(["pending", "processing", "completed", "failed", "cancelled", "refunded"]);
  for (const status of Object.values(states.TRANSACTION_STATUS)) {
    assert.ok(existing.has(status), `${status} is not an existing transaction status`);
  }
});

/* ============================================================================
   4 & 5. PROVIDER ISOLATION AND REGISTRY
   ========================================================================== */

test("no banking source file contains a bank name, URL, credential or provider schema", () => {
  for (const parts of BANKING_SOURCES) {
    const code = codeOnly(read(...parts));
    const lower = code.toLowerCase();
    for (const name of ["absa", "peach", "docfox", "flash", "ott", "standard_bank", "nedbank", "capitec"]) {
      assert.ok(!lower.includes(name), `${parts.join("/")} must not name ${name}`);
    }
    // No endpoint of any kind.
    assert.doesNotMatch(code, /https?:\/\//, `${parts.join("/")} must not hold a URL`);
    // No credential read.
    assert.doesNotMatch(code, /process\.env\.[A-Z_]*(SECRET|KEY|TOKEN|PASSWORD|CERT)/,
      `${parts.join("/")} must not read a credential`);
    // No provider-shaped object names.
    for (const schema of ["PaymentConsentRequest", "RequestConsentResponse", "PaymentInstruction"]) {
      assert.ok(!code.includes(schema), `${parts.join("/")} must not know ${schema}`);
    }
  }
});

test("no public API route names a provider, and banking adds no route at all", () => {
  const routesDir = path.join(API, "src", "routes");
  for (const name of fs.readdirSync(routesDir)) {
    const code = codeOnly(fs.readFileSync(path.join(routesDir, name), "utf8"));
    // Route PATHS must never carry a provider name. (Handler internals for the
    // existing Peach webhook are out of scope; this checks declared paths.)
    for (const match of code.matchAll(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)) {
      const routePath = match[2].toLowerCase();
      for (const provider of ["absa", "peach", "docfox", "flash", "ott"]) {
        assert.ok(!routePath.includes(provider),
          `${name} declares route ${match[2]}, which names ${provider}`);
      }
    }
    // And nothing in routes references the banking layer yet.
    assert.ok(!code.toLowerCase().includes("banking-service"),
      `${name} must not wire the banking layer in Phase 3`);
  }
});

test("an unconfigured provider resolves to the None adapter, which refuses", () => {
  const provider = require("../src/providers/banking-provider");
  assert.equal(flags.bankingProviderKey({}), "none");
  assert.equal(provider.bankingCapabilityConfigured(), true, "the capability resolves");
  for (const entry of provider.declaredCapabilities()) {
    assert.equal(entry.implemented, false);
  }
});

test("naming a provider that has no adapter does not activate it", async () => {
  try {
    // Every gate an operator controls is opened, and the name is invented.
    await approve("a_bank_that_does_not_exist", CAPABILITY, "staging");
    const report = await banking.getCapabilityReport({
      env: {
        BANKING_INTEGRATION_ENABLED: "true",
        BANKING_PROVIDER: "a_bank_that_does_not_exist",
        BANKING_ENVIRONMENT: "staging",
        TITOPAY_ENV: "sandbox",
        [flags.capabilityFlagName("a_bank_that_does_not_exist", CAPABILITY)]: "true"
      }
    });
    assert.deepEqual(report.availableCapabilities, [],
      "a name in configuration is not an integration");
    const entry = report.capabilities.find((c) => c.capability === CAPABILITY);
    assert.equal(entry.reason, "PROVIDER_NOT_REGISTERED");
  } finally {
    await clearApprovals("a_bank_that_does_not_exist");
  }
});

/* ============================================================================
   7. IDEMPOTENCY — adversarial
   ========================================================================== */

test("a redelivered event with a DIFFERENT body is still one row and does not overwrite", async () => {
  const provider = "audit_idem";
  const eventId = `evt-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await banking.recordProviderEvent({
      provider, environment: "development", eventId,
      signatureVerified: true, payload: { amount: 100, state: "PENDING" }
    });
    // A tampered replay claiming success.
    const replay = await banking.recordProviderEvent({
      provider, environment: "development", eventId,
      signatureVerified: true, payload: { amount: 999999, state: "SUCCESS" }
    });
    assert.equal(replay.duplicate, true);

    const { rows } = await pool.query(
      "SELECT payload FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.amount, 100, "the first body stands; a replay cannot rewrite it");
    assert.equal(rows[0].payload.state, "PENDING");
  } finally {
    await pool.query("DELETE FROM banking_provider_events WHERE provider = $1", [provider]).catch(() => {});
  }
});

test("an unsigned event is recorded as unsigned and never silently trusted", async () => {
  const provider = "audit_unsigned";
  const eventId = `evt-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await banking.recordProviderEvent({
      provider, environment: "development", eventId, payload: {}
      // signatureVerified omitted
    });
    const { rows } = await pool.query(
      "SELECT signature_verified FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]
    );
    assert.equal(rows[0].signature_verified, false,
      "an unstated signature must default to unverified");
  } finally {
    await pool.query("DELETE FROM banking_provider_events WHERE provider = $1", [provider]).catch(() => {});
  }
});

test("an event id is required: a blank one cannot create an untracked row", async () => {
  for (const bad of ["", "   ", null, undefined]) {
    await assert.rejects(
      async () => banking.recordProviderEvent({
        provider: "audit_blank", environment: "development", eventId: bad, payload: {}
      }),
      /required/i,
      `"${String(bad)}" must be refused`
    );
  }
});

test("an idempotency key is required to open an intent", async () => {
  for (const bad of ["", "   ", null, undefined]) {
    await assert.rejects(
      async () => banking.createIntent(null, {
        transactionId: crypto.randomUUID(), userId: crypto.randomUUID(),
        provider: "audit", environment: "development",
        capability: CAPABILITY, amount: 10, currency: "ZAR", idempotencyKey: bad
      }),
      /required/i
    );
  }
});

test("a non-positive or non-finite amount cannot open an intent", async () => {
  for (const bad of [0, -1, -0.01, NaN, Infinity, "abc", null]) {
    await assert.rejects(
      async () => banking.createIntent(null, {
        transactionId: crypto.randomUUID(), userId: crypto.randomUUID(),
        provider: "audit", environment: "development", capability: CAPABILITY,
        amount: bad, currency: "ZAR", idempotencyKey: `k-${crypto.randomBytes(4).toString("hex")}`
      }),
      /greater than zero/i,
      `amount ${String(bad)} must be refused`
    );
  }
});

test("an intent for a transaction that does not exist is refused by the foreign key", async () => {
  await assert.rejects(
    async () => banking.createIntent(null, {
      transactionId: crypto.randomUUID(), userId: crypto.randomUUID(),
      provider: "audit", environment: "development", capability: CAPABILITY,
      amount: 100, currency: "ZAR", idempotencyKey: `orphan-${crypto.randomBytes(4).toString("hex")}`
    }),
    /foreign key|violates/i,
    "an intent must never be the only trace of a payment"
  );
});

/* ============================================================================
   9. ENVIRONMENT SAFETY — the full matrix
   ========================================================================== */

test("the environment pairing is an allow list: every combination is stated", () => {
  const deployments = ["production", "sandbox", "development", "staging", "", "PRODUCTION", "prod", "test"];
  const bankings = ["production", "staging", "development", "", "sandbox", "PRODUCTION", "nonsense"];
  const permitted = [];
  for (const deployment of deployments) {
    for (const bankingEnv of bankings) {
      const decision = banking.environmentDecision({
        TITOPAY_ENV: deployment, BANKING_ENVIRONMENT: bankingEnv
      });
      if (decision.permitted) permitted.push(`${deployment}/${bankingEnv}`);
    }
  }
  // Exactly three pairs may pass, and no others. TITOPAY_ENV is case-normalised,
  // so PRODUCTION is the same deployment as production.
  assert.deepEqual(permitted.sort(), [
    "PRODUCTION/PRODUCTION",
    "PRODUCTION/production",
    "production/PRODUCTION",
    "production/production",
    "sandbox/development",
    "sandbox/staging"
  ].sort());
});

test("production banking is impossible on anything but a production deployment", () => {
  for (const deployment of ["sandbox", "development", "staging", "", "test"]) {
    const decision = banking.environmentDecision({
      TITOPAY_ENV: deployment, BANKING_ENVIRONMENT: "production"
    });
    assert.equal(decision.permitted, false, `production banking must not run on ${deployment || "(unset)"}`);
  }
});

test("a production deployment refuses development and staging banking", () => {
  for (const bankingEnv of ["development", "staging"]) {
    const decision = banking.environmentDecision({
      TITOPAY_ENV: "production", BANKING_ENVIRONMENT: bankingEnv
    });
    assert.equal(decision.permitted, false);
    assert.equal(decision.reason, "NON_PRODUCTION_BANKING_ON_PRODUCTION_DEPLOYMENT");
  }
});

test("an unknown deployment environment fails closed rather than falling through", () => {
  const decision = banking.environmentDecision({
    TITOPAY_ENV: "somewhere_new", BANKING_ENVIRONMENT: "production"
  });
  assert.equal(decision.permitted, false);
  assert.equal(decision.reason, "UNKNOWN_DEPLOYMENT_ENVIRONMENT");
});

/* ============================================================================
   10. PRODUCTION SAFETY
   ========================================================================== */

test("on a fully declared production deployment with no banking config, everything is shut", async () => {
  const report = await banking.getCapabilityReport({
    env: {
      TITOPAY_ENV: "production", PEACH_PAYMENTS_MODE: "production",
      DOCFOX_MODE: "production", OTT_MODE: "production"
    }
  });
  assert.equal(report.integrationEnabled, false);
  assert.equal(report.provider, "none");
  assert.deepEqual(report.availableCapabilities, []);
});

test("no admin route and no admin console page can write a banking flag or approval", () => {
  const adminRoutes = codeOnly(read("src", "routes", "admin.routes.js"));
  const adminConsole = codeOnly(read("..", "admin", "admin.js"));
  for (const [label, source] of [["admin.routes.js", adminRoutes], ["admin.js", adminConsole]]) {
    assert.ok(!source.includes("banking_capability_approvals"),
      `${label} must not write an approval row`);
    assert.ok(!/BANKING_[A-Z0-9_]*ENABLED/.test(source),
      `${label} must not touch a banking flag`);
  }
});

test("no frontend can select a banking provider", () => {
  const pwa = read("..", "pwa", "app.js");
  assert.ok(!/BANKING_PROVIDER|bankingProvider|banking-provider/.test(pwa),
    "the PWA must not know a banking provider exists");
});

test("the flags are read from the environment only, never from the database", () => {
  const code = codeOnly(read("src", "config", "banking-flags.js"));
  assert.doesNotMatch(code, /pool|query|platform_settings|SELECT/i,
    "a flag must not be readable or writable from the database");
});

test("no real credential is required for the layer to load and report", async () => {
  // Proved by this whole file running with no banking variable set at all.
  const report = await banking.getCapabilityReport({ env: {} });
  assert.ok(report, "the report is produced with no credentials whatsoever");
  assert.deepEqual(report.availableCapabilities, []);
});
