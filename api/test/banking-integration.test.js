"use strict";

// THE BANKING FOUNDATION, PROVED CLOSED.
//
// Almost every assertion here is that something does NOT happen: no capability
// is available, no state reaches SUCCESS by accident, no duplicate callback has
// a second effect, no flag defaults on. That is the right shape for this build.
// The banking layer's entire job today is to be a correct seam that refuses,
// and a test suite for a seam is a test suite about refusals.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const states = require("../src/lib/banking-state");
const flags = require("../src/config/banking-flags");
const bankingProvider = require("../src/providers/banking-provider");
const banking = require("../src/services/banking-service");
const { inspectBanking } = require("../src/config/deployment-safety");
const { pool } = require("../src/db/pool");

/* ===================================================== canonical state machine */

test("the canonical states are TitoPay's eleven, and nothing else", () => {
  assert.deepEqual(states.ALL_STATES, [
    "CREATED", "CONSENT_PENDING", "AUTHORISED", "PAYMENT_PENDING", "SUCCESS",
    "FAILED", "REJECTED", "EXPIRED", "IN_DOUBT", "CANCELLED", "REFUNDED"
  ]);
});

test("exactly one state may credit a wallet", () => {
  assert.deepEqual(states.CREDITING_STATES, ["SUCCESS"]);
  assert.equal(states.creditsWallet("SUCCESS"), true);
  for (const state of states.ALL_STATES.filter((s) => s !== "SUCCESS")) {
    assert.equal(states.creditsWallet(state), false, `${state} must never credit`);
  }
});

test("every canonical state maps to a transaction status the platform already writes", () => {
  const existing = new Set(["pending", "processing", "completed", "failed", "cancelled", "refunded"]);
  for (const state of states.ALL_STATES) {
    const mapped = states.transactionStatusFor(state);
    assert.ok(existing.has(mapped), `${state} maps to "${mapped}", which is not an existing status`);
  }
  // The two that carry the most weight.
  assert.equal(states.transactionStatusFor("SUCCESS"), "completed");
  assert.equal(states.transactionStatusFor("IN_DOUBT"), "processing");
});

test("an unrecognised provider state becomes IN_DOUBT, never a terminal one", () => {
  const mapping = { PAID: "SUCCESS", DECLINED: "FAILED" };
  assert.equal(states.toCanonicalState("PAID", mapping), "SUCCESS");
  assert.equal(states.toCanonicalState("DECLINED", mapping), "FAILED");
  // Everything a bank might invent tomorrow.
  for (const unknown of ["SOMETHING_NEW", "", null, undefined, "  ", "success_ish", 42, {}]) {
    assert.equal(states.toCanonicalState(unknown, mapping), "IN_DOUBT",
      `"${String(unknown)}" must land in IN_DOUBT`);
  }
});

test("a provider state mapped to a word that is not a canonical state is IN_DOUBT", () => {
  // A mapping typo must not open a hole.
  assert.equal(states.toCanonicalState("PAID", { PAID: "SUCCEEDED" }), "IN_DOUBT");
  assert.equal(states.toCanonicalState("PAID", { PAID: "" }), "IN_DOUBT");
});

test("IN_DOUBT never becomes SUCCESS by default, but may on evidence", () => {
  // It is reachable, because a status query can resolve it. What must not exist
  // is a path that reaches it without one, and that is the caller's contract.
  assert.equal(states.canTransition("IN_DOUBT", "SUCCESS"), true);
  // And it is not reachable from anywhere that has already finished.
  for (const terminal of ["FAILED", "REJECTED", "EXPIRED", "CANCELLED"]) {
    assert.equal(states.canTransition(terminal, "SUCCESS"), false,
      `${terminal} must never become SUCCESS`);
  }
});

test("terminal states do not reopen, except SUCCESS to REFUNDED", () => {
  for (const terminal of states.TERMINAL_STATES) {
    for (const target of states.ALL_STATES) {
      if (target === terminal) continue;
      const allowed = states.canTransition(terminal, target);
      if (terminal === "SUCCESS" && target === "REFUNDED") {
        assert.equal(allowed, true, "a settled payment may be refunded");
      } else {
        assert.equal(allowed, false, `${terminal} -> ${target} must be refused`);
      }
    }
  }
});

test("a repeated report of the same state is a no-op, not an error", () => {
  for (const state of states.ALL_STATES) {
    assert.equal(states.canTransition(state, state), true);
  }
});

test("CREATED cannot jump straight to SUCCESS", () => {
  // A payment must have been authorised or submitted before it can settle.
  assert.equal(states.canTransition("CREATED", "SUCCESS"), false);
  assert.equal(states.canTransition("CONSENT_PENDING", "SUCCESS"), false);
});

/* ================================================================== the flags */

test("every banking flag defaults OFF on an empty environment", () => {
  const env = {};
  assert.equal(flags.bankingIntegrationEnabled(env), false);
  assert.equal(flags.bankingEnvironment(env), null);
  assert.equal(flags.bankingProviderKey(env), "none");
  for (const capability of flags.ALL_CAPABILITIES) {
    assert.equal(flags.capabilityFlagEnabled("any_provider", capability, env), false);
  }
});

test("only the exact string \"true\" enables a flag", () => {
  for (const value of ["1", "yes", "on", "TRUE", "True", "true ", " true", "", "0", "no"]) {
    assert.equal(
      flags.bankingIntegrationEnabled({ BANKING_INTEGRATION_ENABLED: value }), false,
      `"${value}" must not enable a bank rail`
    );
  }
  assert.equal(flags.bankingIntegrationEnabled({ BANKING_INTEGRATION_ENABLED: "true" }), true);
});

test("the master switch overrides every capability flag", () => {
  const env = {
    BANKING_INTEGRATION_ENABLED: "false",
    BANKING_EXAMPLE_BANK_WITHDRAWAL_ENABLED: "true"
  };
  assert.equal(flags.capabilityFlagEnabled("example_bank", "WITHDRAWAL", env), false);
});

test("flag names are derived from the provider key, so adding a bank edits no file", () => {
  assert.equal(
    flags.capabilityFlagName("example_bank", "CUSTOMER_PAYMENT_INITIATION"),
    "BANKING_EXAMPLE_BANK_CUSTOMER_PAYMENT_INITIATION_ENABLED"
  );
  // Punctuation in a provider key cannot produce a variable name that collides
  // with another provider's.
  assert.equal(flags.capabilityFlagName("a-b.c", "PAYOUT"), "BANKING_A_B_C_PAYOUT_ENABLED");
});

test("an unknown capability can never be flagged on", () => {
  const env = { BANKING_INTEGRATION_ENABLED: "true", BANKING_X_SOMETHING_ELSE_ENABLED: "true" };
  assert.equal(flags.capabilityFlagEnabled("x", "SOMETHING_ELSE", env), false);
});

/* ============================================================ the environment gate */

test("banking refuses unless both environments are declared and agree", () => {
  const cases = [
    [{}, false, "BANKING_ENVIRONMENT_NOT_DECLARED"],
    [{ BANKING_ENVIRONMENT: "production" }, false, "TITOPAY_ENV_NOT_DECLARED"],
    [{ TITOPAY_ENV: "production" }, false, "BANKING_ENVIRONMENT_NOT_DECLARED"],
    [{ BANKING_ENVIRONMENT: "production", TITOPAY_ENV: "sandbox" }, false,
      "PRODUCTION_BANKING_ON_NON_PRODUCTION_DEPLOYMENT"],
    [{ BANKING_ENVIRONMENT: "staging", TITOPAY_ENV: "production" }, false,
      "NON_PRODUCTION_BANKING_ON_PRODUCTION_DEPLOYMENT"],
    [{ BANKING_ENVIRONMENT: "production", TITOPAY_ENV: "production" }, true, null],
    [{ BANKING_ENVIRONMENT: "staging", TITOPAY_ENV: "sandbox" }, true, null]
  ];
  for (const [env, permitted, reason] of cases) {
    const decision = banking.environmentDecision(env);
    assert.equal(decision.permitted, permitted, `${JSON.stringify(env)} -> permitted ${decision.permitted}`);
    assert.equal(decision.reason, reason);
  }
});

/* ============================================================== the adapter itself */

test("the shipped default adapter implements nothing and says so", () => {
  const declared = bankingProvider.declaredCapabilities();
  assert.equal(declared.length, flags.ALL_CAPABILITIES.length);
  for (const entry of declared) {
    assert.equal(entry.implemented, false, `${entry.capability} must not claim to be implemented`);
    assert.equal(entry.configured, false);
    assert.equal(entry.reason, "NO_PROVIDER_CONFIGURED");
  }
});

test("every banking operation refuses with CAPABILITY_NOT_SUPPORTED", async () => {
  const operations = [
    ["initiateCustomerPayment", [{ userId: "u" }, {}]],
    ["getPaymentStatus", [{ userId: "u" }, "ref"]],
    ["handleProviderCallback", [{}]],
    ["verifyAccount", [{ userId: "u" }, {}]],
    ["getAccountInformation", [{ userId: "u" }, {}]],
    ["getTransactionHistory", [{ userId: "u" }, {}]],
    ["initiatePayout", [{ userId: "u" }, {}]],
    ["initiateWithdrawal", [{ userId: "u" }, {}]],
    ["reconcile", [{}]]
  ];
  for (const [name, args] of operations) {
    await assert.rejects(
      async () => bankingProvider[name](...args),
      (error) => {
        assert.equal(error.statusCode, 503, `${name} status`);
        assert.equal(error.details?.code, "CAPABILITY_NOT_SUPPORTED", `${name} code`);
        // The customer is never told a supplier was involved.
        assert.doesNotMatch(error.message, /bank|provider|absa|peach/i, `${name} message names nobody`);
        return true;
      },
      `${name} must refuse`
    );
  }
});

test("verifyAccount is a contract, not an implementation", async () => {
  // There is no bank account verification in TitoPay. This proves the seam
  // exists and that it refuses, rather than returning a fabricated pass.
  await assert.rejects(
    async () => bankingProvider.verifyAccount({ userId: "u" }, { accountNumber: "1234567890", branchCode: "632005" }),
    (error) => error.details?.code === "CAPABILITY_NOT_SUPPORTED"
  );
});

test("the banking capability resolves to an adapter, so the layer is wired and shut", () => {
  // `none` is registered as the default, which is why an unconfigured server is
  // a working server rather than one that throws on every capability check.
  assert.equal(bankingProvider.bankingCapabilityConfigured(), true);
});

/* ========================================================== the four gate report */

test("no capability is available on a server with nothing configured", async () => {
  const report = await banking.getCapabilityReport({ env: {} });
  assert.equal(report.provider, "none");
  assert.equal(report.integrationEnabled, false);
  assert.deepEqual(report.availableCapabilities, []);
  for (const entry of report.capabilities) {
    assert.equal(entry.available, false, `${entry.capability} must be unavailable`);
    assert.equal(entry.reason, "BANKING_INTEGRATION_DISABLED");
  }
});

test("no capability is available even with every flag and environment set, because nothing is implemented or approved", async () => {
  const env = {
    BANKING_INTEGRATION_ENABLED: "true",
    BANKING_ENVIRONMENT: "staging",
    TITOPAY_ENV: "sandbox",
    BANKING_PROVIDER: "none"
  };
  for (const capability of flags.ALL_CAPABILITIES) {
    env[flags.capabilityFlagName("none", capability)] = "true";
  }
  const report = await banking.getCapabilityReport({ env });
  assert.equal(report.environmentPermitted, true);
  assert.deepEqual(report.availableCapabilities, [],
    "flags alone must never make a bank rail available");
  for (const entry of report.capabilities) {
    assert.equal(entry.gates.flagEnabled, true, "the flag gate is open");
    assert.equal(entry.gates.implemented, false, "and the code gate is shut");
    assert.equal(entry.available, false);
  }
});

test("assertCapability refuses before anything is written", async () => {
  for (const capability of flags.ALL_CAPABILITIES) {
    await assert.rejects(
      async () => banking.assertCapability(capability, { env: {} }),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.details?.code, "CAPABILITY_NOT_SUPPORTED");
        return true;
      }
    );
  }
});

test("assertCapability refuses a capability that is not one of TitoPay's", async () => {
  await assert.rejects(
    async () => banking.assertCapability("MAKE_UP_A_RAIL", { env: {} }),
    (error) => error.details?.code === "CAPABILITY_NOT_SUPPORTED"
  );
});

/* ================================================== deployment safety, banking part */

test("an untouched deployment gains no new warnings at all", () => {
  // This is the one that keeps every existing server's /health count stable.
  assert.deepEqual(inspectBanking({}), []);
  assert.deepEqual(inspectBanking({ TITOPAY_ENV: "production", PEACH_PAYMENTS_MODE: "production" }), []);
});

test("a banking environment contradicting the deployment BLOCKS", () => {
  const found = inspectBanking({ TITOPAY_ENV: "production", BANKING_ENVIRONMENT: "staging" });
  assert.equal(found.length, 1);
  assert.equal(found[0].blocking, true);
  assert.match(found[0].text, /same world as the deployment/);

  const reverse = inspectBanking({ TITOPAY_ENV: "sandbox", BANKING_ENVIRONMENT: "production" });
  assert.equal(reverse[0].blocking, true);
});

test("a half configured banking layer warns and never blocks", () => {
  const cases = [
    { BANKING_INTEGRATION_ENABLED: "true" },
    { BANKING_INTEGRATION_ENABLED: "true", BANKING_PROVIDER: "none" },
    { BANKING_PROVIDER: "example_bank" },
    { BANKING_ENVIRONMENT: "nonsense" },
    { BANKING_EXAMPLE_WITHDRAWAL_ENABLED: "true", BANKING_PROVIDER: "example" }
  ];
  for (const env of cases) {
    const found = inspectBanking(env);
    assert.ok(found.length > 0, `${JSON.stringify(env)} should say something`);
    for (const entry of found) {
      assert.equal(entry.blocking, false,
        `${JSON.stringify(env)} must warn, not block: ${entry.text}`);
    }
  }
});

test("matching environments produce no complaint", () => {
  assert.deepEqual(
    inspectBanking({ TITOPAY_ENV: "production", BANKING_ENVIRONMENT: "production", BANKING_PROVIDER: "x", BANKING_INTEGRATION_ENABLED: "true" }),
    []
  );
});

/* ====================================================== the sidecar, against the DB */

// These need a database. They prove the constraints that the money safety
// argument rests on: one intent per transaction, idempotency by unique
// constraint, one row per provider event however many times it is delivered.

async function seedTransaction() {
  const userId = crypto.randomUUID();
  const walletId = crypto.randomUUID();
  const transactionId = crypto.randomUUID();
  const reference = `TP-BANKTEST-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, password_hash, account_type)
     VALUES ($1,'Banking Test',$2,$3,$4,'x','personal')`,
    [userId, `bt_${crypto.randomBytes(5).toString("hex")}`,
     `bt_${crypto.randomBytes(5).toString("hex")}@example.com`,
     `+2782${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  // wallet_number is constrained to 1-10 digits, and (user_id, kind) is unique.
  await pool.query(
    "INSERT INTO wallets (id, user_id, wallet_number, kind, available_balance) VALUES ($1,$2,$3,'personal',0)",
    [walletId, userId, String(1000000000 + Math.floor(Math.random() * 8999999999)).slice(0, 10)]
  );
  await pool.query(
    `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference)
     VALUES ($1,$2,$3,'wallet_top_up',100,0,100,'pending','credit',$4)`,
    [transactionId, userId, walletId, reference]
  );
  return { userId, walletId, transactionId, reference };
}

async function cleanup(seed) {
  await pool.query("DELETE FROM banking_provider_events WHERE intent_id IN (SELECT id FROM banking_payment_intents WHERE transaction_id = $1)", [seed.transactionId]).catch(() => {});
  await pool.query("DELETE FROM banking_state_transitions WHERE intent_id IN (SELECT id FROM banking_payment_intents WHERE transaction_id = $1)", [seed.transactionId]).catch(() => {});
  await pool.query("DELETE FROM banking_payment_intents WHERE transaction_id = $1", [seed.transactionId]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE id = $1", [seed.transactionId]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = $1", [seed.walletId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = $1", [seed.userId]).catch(() => {});
}

test("an intent is idempotent: the same key returns the original, never a second", async () => {
  const seed = await seedTransaction();
  try {
    const key = `idem-${crypto.randomBytes(6).toString("hex")}`;
    const args = {
      transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
      environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
      amount: 100, currency: "ZAR", idempotencyKey: key
    };
    const first = await banking.createIntent(null, args);
    assert.equal(first.created, true);
    const second = await banking.createIntent(null, args);
    assert.equal(second.created, false, "a retry must not open a second conversation");
    assert.equal(second.intent.id, first.intent.id);

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM banking_payment_intents WHERE transaction_id = $1",
      [seed.transactionId]
    );
    assert.equal(rows[0].n, 1);
  } finally {
    await cleanup(seed);
  }
});

test("concurrent creates with one key produce exactly one intent", async () => {
  const seed = await seedTransaction();
  try {
    const key = `race-${crypto.randomBytes(6).toString("hex")}`;
    const args = {
      transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
      environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
      amount: 100, currency: "ZAR", idempotencyKey: key
    };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => banking.createIntent(null, args))
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    assert.ok(succeeded.length > 0, "at least one create must succeed");
    assert.equal(succeeded.filter((r) => r.value.created).length, 1,
      "exactly one caller may create the intent");

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM banking_payment_intents WHERE transaction_id = $1",
      [seed.transactionId]
    );
    assert.equal(rows[0].n, 1);
  } finally {
    await cleanup(seed);
  }
});

test("a second intent cannot attach to a transaction that already has one", async () => {
  const seed = await seedTransaction();
  try {
    await banking.createIntent(null, {
      transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
      environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
      amount: 100, currency: "ZAR", idempotencyKey: `a-${crypto.randomBytes(4).toString("hex")}`
    });
    await assert.rejects(
      async () => banking.createIntent(null, {
        transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
        environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
        amount: 100, currency: "ZAR", idempotencyKey: `b-${crypto.randomBytes(4).toString("hex")}`
      }),
      /duplicate key|unique/i,
      "the database must refuse a second intent for one transaction"
    );
  } finally {
    await cleanup(seed);
  }
});

test("an illegal transition is refused and the intent does not move", async () => {
  const seed = await seedTransaction();
  try {
    const { intent } = await banking.createIntent(null, {
      transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
      environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
      amount: 100, currency: "ZAR", idempotencyKey: `t-${crypto.randomBytes(4).toString("hex")}`
    });
    assert.equal(intent.canonical_state, "CREATED");

    // CREATED cannot settle. This is the assertion that a bank saying "paid"
    // out of nowhere does not credit anybody.
    await assert.rejects(
      async () => banking.transitionIntent(null, intent.id, "SUCCESS", { source: "test" }),
      (error) => {
        assert.equal(error.details?.code, "ILLEGAL_STATE_TRANSITION");
        return true;
      }
    );

    const { rows } = await pool.query(
      "SELECT canonical_state FROM banking_payment_intents WHERE id = $1", [intent.id]
    );
    assert.equal(rows[0].canonical_state, "CREATED", "a refused transition changes nothing");
  } finally {
    await cleanup(seed);
  }
});

test("a legal path is recorded in full, and a terminal state will not reopen", async () => {
  const seed = await seedTransaction();
  try {
    const { intent } = await banking.createIntent(null, {
      transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
      environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
      amount: 100, currency: "ZAR", idempotencyKey: `p-${crypto.randomBytes(4).toString("hex")}`
    });
    await banking.transitionIntent(null, intent.id, "CONSENT_PENDING", { source: "consent_requested" });
    await banking.transitionIntent(null, intent.id, "AUTHORISED", { source: "consent_granted" });
    await banking.transitionIntent(null, intent.id, "PAYMENT_PENDING", { source: "instruction_submitted" });
    await banking.transitionIntent(null, intent.id, "SUCCESS", { source: "status_query", providerStatus: "PAID" });

    const history = await pool.query(
      "SELECT from_state, to_state, source FROM banking_state_transitions WHERE intent_id = $1 ORDER BY created_at",
      [intent.id]
    );
    assert.deepEqual(history.rows.map((r) => r.to_state),
      ["CREATED", "CONSENT_PENDING", "AUTHORISED", "PAYMENT_PENDING", "SUCCESS"]);

    // And it stays settled.
    await assert.rejects(
      async () => banking.transitionIntent(null, intent.id, "FAILED", { source: "late_callback" }),
      (error) => error.details?.code === "ILLEGAL_STATE_TRANSITION"
    );
  } finally {
    await cleanup(seed);
  }
});

test("a repeated report of the current state changes nothing and does not throw", async () => {
  const seed = await seedTransaction();
  try {
    const { intent } = await banking.createIntent(null, {
      transactionId: seed.transactionId, userId: seed.userId, provider: "test_bank",
      environment: "development", capability: "CUSTOMER_PAYMENT_INITIATION",
      amount: 100, currency: "ZAR", idempotencyKey: `r-${crypto.randomBytes(4).toString("hex")}`
    });
    const result = await banking.transitionIntent(null, intent.id, "CREATED", { source: "duplicate_callback" });
    assert.equal(result.changed, false);
    assert.equal(result.reason, "ALREADY_IN_STATE");
  } finally {
    await cleanup(seed);
  }
});

test("a duplicate provider event is recorded once, however many times it arrives", async () => {
  const provider = "test_bank";
  const eventId = `evt-${crypto.randomBytes(8).toString("hex")}`;
  try {
    const first = await banking.recordProviderEvent({
      provider, environment: "development", eventId, eventType: "payment.updated",
      signatureVerified: true, payload: { hello: "world" }
    });
    assert.equal(first.duplicate, false);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const repeat = await banking.recordProviderEvent({
        provider, environment: "development", eventId, eventType: "payment.updated",
        signatureVerified: true, payload: { hello: "world" }
      });
      assert.equal(repeat.duplicate, true, "a redelivery must be a duplicate");
    }

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]
    );
    assert.equal(rows[0].n, 1);
  } finally {
    await pool.query("DELETE FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]).catch(() => {});
  }
});

test("concurrent delivery of one event still records one row", async () => {
  const provider = "test_bank";
  const eventId = `evtrace-${crypto.randomBytes(8).toString("hex")}`;
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      banking.recordProviderEvent({
        provider, environment: "development", eventId, signatureVerified: true, payload: {}
      })
    ));
    assert.equal(results.filter((r) => !r.duplicate).length, 1,
      "exactly one delivery may be the first");
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]
    );
    assert.equal(rows[0].n, 1);
  } finally {
    await pool.query("DELETE FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]).catch(() => {});
  }
});

test("banking webhook idempotency does not live in platform_settings", async () => {
  const provider = "test_bank";
  const eventId = `evtsettings-${crypto.randomBytes(8).toString("hex")}`;
  try {
    await banking.recordProviderEvent({
      provider, environment: "development", eventId, signatureVerified: true, payload: {}
    });
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM platform_settings WHERE key LIKE '%' || $1 || '%'",
      [eventId]
    );
    assert.equal(rows[0].n, 0, "no settings row may be created for a banking event");
  } finally {
    await pool.query("DELETE FROM banking_provider_events WHERE provider = $1 AND event_id = $2",
      [provider, eventId]).catch(() => {});
  }
});

test("a bare approval row is not an approval, and opens nothing", async () => {
  // The gate that stops a database write, or a compromised console, from
  // starting a bank rail on its own. Since build 59 an approval must also carry
  // attribution and a signature keyed by a server-side secret, so the row
  // inserted here is not even an approval, let alone an activation.
  const provider = "test_bank_approval";
  try {
    await pool.query(
      `INSERT INTO banking_capability_approvals (provider, capability, environment, approved, approved_at)
       VALUES ($1,'WITHDRAWAL','staging',TRUE,NOW())
       ON CONFLICT (provider, capability, environment) DO UPDATE SET approved = TRUE`,
      [provider]
    );
    const report = await banking.getCapabilityReport({
      env: {
        BANKING_INTEGRATION_ENABLED: "true", BANKING_PROVIDER: provider,
        BANKING_ENVIRONMENT: "staging", TITOPAY_ENV: "sandbox",
        BANKING_TEST_BANK_APPROVAL_WITHDRAWAL_ENABLED: "true"
      }
    });
    const withdrawal = report.capabilities.find((entry) => entry.capability === "WITHDRAWAL");
    assert.equal(withdrawal.gates.flagEnabled, true, "the flag gate is open");
    assert.equal(withdrawal.gates.approved, false,
      "an unsigned, unattributed row must not count as an approval");
    assert.equal(withdrawal.available, false,
      "and with no adapter implementing it either, the capability stays shut");
    // Named a provider the registry has no adapter for. The report says exactly
    // that rather than reporting what some other adapter implements.
    assert.equal(withdrawal.reason, "PROVIDER_NOT_REGISTERED");
  } finally {
    await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [provider]).catch(() => {});
  }
});

test("a revoked approval closes the gate again", async () => {
  const provider = "test_bank_revoked";
  try {
    await pool.query(
      `INSERT INTO banking_capability_approvals (provider, capability, environment, approved, approved_at, revoked_at)
       VALUES ($1,'PAYOUT','staging',TRUE,NOW(),NOW())`,
      [provider]
    );
    const report = await banking.getCapabilityReport({
      env: {
        BANKING_INTEGRATION_ENABLED: "true", BANKING_PROVIDER: provider,
        BANKING_ENVIRONMENT: "staging", TITOPAY_ENV: "sandbox"
      }
    });
    const payout = report.capabilities.find((entry) => entry.capability === "PAYOUT");
    assert.equal(payout.gates.approved, false, "a revoked approval is not an approval");
  } finally {
    await pool.query("DELETE FROM banking_capability_approvals WHERE provider = $1", [provider]).catch(() => {});
  }
});

test("no banking table holds a balance", async () => {
  // A structural guarantee rather than a promise in a comment: if somebody adds
  // a balance column to a banking table, this fails.
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name LIKE 'banking_%'
        AND (column_name LIKE '%balance%' OR column_name = 'available' OR column_name LIKE '%ledger%')`
  );
  assert.deepEqual(rows, [], "banking tables must never carry a balance or a ledger");
});
