"use strict";

// THE BANKING CAPABILITY, FROM TITOPAY'S SIDE.
//
// The adapter in `src/providers/banking-provider.js` answers "can this supplier
// do it?". This file answers the question that actually decides whether a rail
// runs, which is a different and stricter one: "is TitoPay willing, configured,
// permitted AND approved to do it, with this supplier, in this environment?"
//
// FOUR GATES. ALL FOUR, EVERY TIME.
//
//   1. implemented        the adapter exports the operation
//   2. flagEnabled        a server side flag says so (NOT the admin console)
//   3. environmentPermits the banking environment is declared and agrees with
//                         the deployment's own declared environment
//   4. approved           an approval record names this capability, this
//                         provider, this environment, and has not been revoked
//
// Any one of them false means unavailable. There is no combination that adds up
// to "probably fine", no override flag, and no ordering in which a missing gate
// is skipped. Default closed: a server with nothing configured reports every
// capability unavailable, which is exactly what TitoPay is today.
//
// WHY FOUR RATHER THAN ONE. Each gate fails a different way in real life. Code
// can exist for a rail nobody bought. A contract can exist for code nobody
// wrote. Credentials can be present in the wrong environment. And an operator
// can be certain a thing is agreed when the agreement is for something else.
// Requiring all four means no single mistake, and no single compromised
// surface, can start money moving through a bank.
//
// WHAT THIS FILE MAY NOT DO, EVER: credit a wallet, debit a wallet, write to
// wallet_ledger or revenue_ledger, or decide that a payment succeeded. It
// records where a bank conversation has got to. Money continues to move only
// through the transaction and wallet services that already own it, under the
// controls they already carry.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const bankingState = require("../lib/banking-state");
const flags = require("../config/banking-flags");
const bankingProvider = require("../providers/banking-provider");
const { configuredKey, CAPABILITIES: PROVIDER_CAPABILITIES } = require("../providers");

// Which adapter the provider registry has actually resolved for this process.
// Always read from the real environment, because that is what the registry
// itself reads when it answers a call.
function registryProviderKey() {
  return configuredKey(PROVIDER_CAPABILITIES.BANKING);
}

const CAPABILITY_NOT_SUPPORTED = "CAPABILITY_NOT_SUPPORTED";

// The customer never learns which supplier is unavailable, or that one was
// involved at all. Same wording every unavailable service uses.
function unavailable(details = {}) {
  return new AppError(
    503,
    "This service is not available right now. Please try again later.",
    { code: CAPABILITY_NOT_SUPPORTED, ...details }
  );
}

/* ------------------------------------------------------------ gate 3: env */

// A banking rail may only run when the banking environment is DECLARED and
// agrees with the deployment's own declared environment.
//
// `production` banking on a `sandbox` deployment would take real customers to a
// test bank. `sandbox` banking on a `production` deployment would take test
// credentials to a real one. Both are refused here rather than discovered
// later. `staging` and `development` are only ever permitted on a deployment
// that is not production.
function environmentDecision(env = process.env) {
  const banking = flags.bankingEnvironment(env);
  const deployment = String(env.TITOPAY_ENV || "").trim().toLowerCase();

  if (!banking) return { permitted: false, reason: "BANKING_ENVIRONMENT_NOT_DECLARED", banking: null, deployment: deployment || null };
  if (!deployment) return { permitted: false, reason: "TITOPAY_ENV_NOT_DECLARED", banking, deployment: null };
  if (banking === "production" && deployment !== "production") {
    return { permitted: false, reason: "PRODUCTION_BANKING_ON_NON_PRODUCTION_DEPLOYMENT", banking, deployment };
  }
  if (banking !== "production" && deployment === "production") {
    return { permitted: false, reason: "NON_PRODUCTION_BANKING_ON_PRODUCTION_DEPLOYMENT", banking, deployment };
  }
  return { permitted: true, reason: null, banking, deployment };
}

/* ------------------------------------------------------- gate 4: approval */

// Approvals are read fresh rather than cached. They change rarely, they are
// read on a path that is already talking to a bank, and a revocation that takes
// effect on the next call is worth more than the query it costs.
async function loadApprovals(provider, environment) {
  if (!provider || !environment) return new Map();
  const { rows } = await pool.query(
    `SELECT capability, approved, approval_reference, approved_at, revoked_at
       FROM banking_capability_approvals
      WHERE provider = $1 AND environment = $2`,
    [provider, environment]
  ).catch((error) => {
    // A missing table or an unreachable database must not read as "approved".
    // It reads as what it is: unknown, and therefore refused.
    console.error("[banking] approvals could not be read; treating every capability as unapproved", {
      provider, environment, reason: error?.message || "unknown"
    });
    return { rows: [] };
  });
  const map = new Map();
  for (const row of rows) {
    map.set(row.capability, {
      approved: Boolean(row.approved) && !row.revoked_at,
      approvalReference: row.approval_reference || null,
      approvedAt: row.approved_at || null,
      revokedAt: row.revoked_at || null
    });
  }
  return map;
}

/* ------------------------------------------------------- the report itself */

// What every capability's four gates currently say. This is what the admin
// console shows, what the boot log summarises, and what `assertCapability`
// consults. It reads no credential and returns none.
async function getCapabilityReport({ env = process.env } = {}) {
  const provider = flags.bankingProviderKey(env);
  const integrationEnabled = flags.bankingIntegrationEnabled(env);
  const environment = environmentDecision(env);

  // What the adapter says it implements. `declaredCapabilities` is synchronous
  // and database free by contract; if a future adapter throws here, that is
  // reported as implementing nothing rather than allowed to take the report out.
  //
  // THE ADAPTER IS RESOLVED FROM process.env, NOT FROM `env`. The provider
  // registry reads the real environment, because which adapter is loaded is a
  // property of the process, not of a question somebody is asking it. So when
  // the two disagree the honest answer is that the provider named in `env` has
  // no adapter answering for it, rather than quietly reporting what a
  // DIFFERENT provider implements. In production the two are the same object
  // and this is a no-op; it matters when a caller passes a hypothetical
  // environment, which is exactly when a wrong answer would be most misleading.
  const registryKey = registryProviderKey();
  const adapterAnswersThisProvider = registryKey === provider;

  let declared = [];
  if (adapterAnswersThisProvider) {
    try {
      declared = bankingProvider.declaredCapabilities() || [];
    } catch (error) {
      console.error("[banking] adapter could not declare its capabilities", {
        provider, reason: error?.message || "unknown"
      });
      declared = [];
    }
  }
  const declaredByName = new Map(declared.map((entry) => [entry.capability, entry]));

  const approvals = environment.banking ? await loadApprovals(provider, environment.banking) : new Map();

  const capabilities = flags.ALL_CAPABILITIES.map((capability) => {
    const adapter = declaredByName.get(capability)
      || {
        implemented: false,
        configured: false,
        reason: adapterAnswersThisProvider ? "NOT_DECLARED" : "PROVIDER_NOT_REGISTERED"
      };
    const approval = approvals.get(capability) || { approved: false, approvalReference: null, approvedAt: null, revokedAt: null };

    const gates = {
      implemented: Boolean(adapter.implemented),
      configured: Boolean(adapter.configured),
      flagEnabled: flags.capabilityFlagEnabled(provider, capability, env),
      environmentPermits: environment.permitted,
      approved: Boolean(approval.approved)
    };
    const available = gates.implemented && gates.configured && gates.flagEnabled
      && gates.environmentPermits && gates.approved;

    // The first gate that is shut, in the order an operator would fix them.
    // "NOT_CONFIRMED" is used when nothing has been implemented at all, because
    // that is the accurate word for a supplier TitoPay has no documentation,
    // credentials or written agreement for.
    let reason = null;
    if (!available) {
      if (!integrationEnabled) reason = "BANKING_INTEGRATION_DISABLED";
      else if (!gates.implemented) reason = adapter.reason || "NOT_CONFIRMED";
      else if (!gates.configured) reason = "NOT_CONFIGURED";
      else if (!gates.environmentPermits) reason = environment.reason;
      else if (!gates.flagEnabled) reason = "FLAG_DISABLED";
      else reason = "NOT_APPROVED";
    }

    return {
      capability,
      available,
      reason,
      gates,
      flagVariable: flags.capabilityFlagName(provider, capability),
      approvalReference: approval.approvalReference,
      approvedAt: approval.approvedAt,
      revokedAt: approval.revokedAt
    };
  });

  return {
    provider,
    integrationEnabled,
    environment: environment.banking,
    deploymentEnvironment: environment.deployment,
    environmentPermitted: environment.permitted,
    environmentReason: environment.reason,
    // Registered means an adapter answers the capability at all. With
    // BANKING_PROVIDER unset that is the `none` adapter, which refuses
    // everything, and that is a correct and safe state rather than a fault.
    registered: bankingProvider.bankingCapabilityConfigured(),
    capabilities,
    availableCapabilities: capabilities.filter((entry) => entry.available).map((entry) => entry.capability)
  };
}

// The check every banking operation makes before it does anything at all.
// Refuses BEFORE any state is written, any provider is called or any money is
// touched, so a disabled capability leaves the database exactly as it found it.
async function assertCapability(capability, { env = process.env } = {}) {
  if (!flags.ALL_CAPABILITIES.includes(capability)) {
    throw unavailable({ capability: null });
  }
  const report = await getCapabilityReport({ env });
  const entry = report.capabilities.find((item) => item.capability === capability);
  if (!entry || !entry.available) {
    // Operator detail to the log, never to the customer.
    console.warn("[banking] capability refused", {
      capability, provider: report.provider, reason: entry?.reason || "UNKNOWN", gates: entry?.gates || null
    });
    throw unavailable({ capability, reason: entry?.reason || "UNKNOWN" });
  }
  return { provider: report.provider, environment: report.environment };
}

/* ------------------------------------------------------------- the sidecar */

function requireText(value, field, max = 200) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw new AppError(400, `${field} is required`);
  return text.slice(0, max);
}

// Open a bank conversation about a transaction that ALREADY EXISTS.
//
// The ordering is deliberate and is taken from the card top-up path: the money
// record is written first, then the provider is called. An intent can therefore
// never be the only trace of a payment somebody made.
//
// Idempotent by construction. `(provider, idempotency_key)` is unique in the
// database, so a retried request returns the original intent rather than
// starting a second conversation with the bank. That is a constraint, not a
// check in application code, so it holds under concurrency and across processes.
async function createIntent(client, {
  transactionId, userId, provider, environment, capability,
  amount, currency = "ZAR", idempotencyKey, metadata = {}
}) {
  const queryable = client || pool;
  const key = requireText(idempotencyKey, "An idempotency key", 120);
  const money = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(money) || money <= 0) throw new AppError(400, "Amount must be greater than zero");
  if (!/^[A-Z]{3}$/.test(String(currency || "").toUpperCase())) throw new AppError(400, "Currency is invalid");

  const { rows } = await queryable.query(
    `INSERT INTO banking_payment_intents
       (id, transaction_id, user_id, provider, environment, capability,
        canonical_state, amount, currency, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (provider, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      crypto.randomUUID(), transactionId, userId, provider, environment, capability,
      bankingState.STATES.CREATED, money, String(currency).toUpperCase(), key,
      JSON.stringify(metadata || {})
    ]
  );

  if (rows[0]) {
    await recordTransition(queryable, {
      intentId: rows[0].id, fromState: null, toState: bankingState.STATES.CREATED,
      source: "intent_created"
    });
    return { intent: rows[0], created: true };
  }

  // The conflict path: somebody already opened this exact conversation.
  const existing = await queryable.query(
    "SELECT * FROM banking_payment_intents WHERE provider = $1 AND idempotency_key = $2",
    [provider, key]
  );
  if (!existing.rows[0]) throw new AppError(409, "This request is already being processed. Please try again in a moment.");
  return { intent: existing.rows[0], created: false };
}

// Append to the history. Never called on its own by a caller that is not also
// changing the state, and never a substitute for changing it.
async function recordTransition(client, {
  intentId, fromState, toState, source, providerStatus = null,
  actorType = "system", actorId = null, requestId = null, metadata = {}
}) {
  const queryable = client || pool;
  await queryable.query(
    `INSERT INTO banking_state_transitions
       (intent_id, from_state, to_state, source, provider_status, actor_type, actor_id, request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [intentId, fromState, toState, requireText(source, "A transition source", 80),
     providerStatus, actorType, actorId, requestId, JSON.stringify(metadata || {})]
  );
}

// Move an intent to a new canonical state.
//
// THE ROW IS LOCKED FOR THE DURATION. A callback, a status poll and an operator
// can all arrive at once; the lock makes them serialise, and the transition
// rules then make a late or out-of-order report a no-op rather than a rewind.
//
// An illegal move is REFUSED, not corrected. In particular nothing may leave a
// terminal state except SUCCESS to REFUNDED, and nothing reaches SUCCESS except
// from a state the machine allows it from. This function does not decide
// whether the evidence justifies the state; the caller does that by asking the
// provider directly, and this enforces that the answer is a legal one.
//
// It does not credit anything. Settling money against a SUCCESS is the job of
// the transaction lifecycle, which has its own lock, its own idempotency and
// its own single credit site.
async function transitionIntent(client, intentId, toState, {
  source, providerStatus = null, providerTransactionId = null, providerReference = null,
  failureReason = null, requiresReview = null, actorType = "system", actorId = null,
  requestId = null, metadata = {}
} = {}) {
  const queryable = client || pool;
  if (!bankingState.isCanonicalState(toState)) {
    throw new AppError(400, `Unknown banking state: ${toState}`);
  }

  const locked = await queryable.query(
    "SELECT * FROM banking_payment_intents WHERE id = $1 FOR UPDATE",
    [intentId]
  );
  const intent = locked.rows[0];
  if (!intent) throw new AppError(404, "Banking payment intent not found");

  const fromState = intent.canonical_state;
  if (fromState === toState) {
    return { intent, changed: false, reason: "ALREADY_IN_STATE" };
  }
  if (!bankingState.canTransition(fromState, toState)) {
    // Loud, because a provider reporting an impossible move is a real signal:
    // either the mapping is wrong or two payments have been confused.
    console.error("[banking] illegal state transition refused", {
      intentId, fromState, toState, source, providerStatus
    });
    throw new AppError(409, "This payment cannot move to that state.", {
      code: "ILLEGAL_STATE_TRANSITION", fromState, toState
    });
  }

  const { rows } = await queryable.query(
    `UPDATE banking_payment_intents
        SET canonical_state = $2,
            provider_status = COALESCE($3, provider_status),
            provider_transaction_id = COALESCE($4, provider_transaction_id),
            provider_reference = COALESCE($5, provider_reference),
            failure_reason = COALESCE($6, failure_reason),
            requires_review = COALESCE($7, requires_review),
            provider_updated_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [intentId, toState, providerStatus, providerTransactionId, providerReference,
     failureReason, requiresReview]
  );

  await recordTransition(queryable, {
    intentId, fromState, toState, source, providerStatus, actorType, actorId, requestId, metadata
  });

  return { intent: rows[0], changed: true, fromState, toState };
}

/* -------------------------------------------------------- provider events */

// Record an inbound callback, exactly once.
//
// `(provider, event_id)` is unique in the database, so a provider that delivers
// the same event five times produces one row and four duplicates that do
// nothing. This is the whole of the duplicate-delivery defence, and it is a
// constraint rather than a lookup, so it holds under concurrent delivery.
//
// THE RETURN VALUE IS NOT PERMISSION TO SETTLE. `{ duplicate: false }` means
// "this delivery is new", not "this payment succeeded". What happened is
// established by asking the provider directly. Storing a callback and believing
// a callback are different things, and only the first one happens here.
//
// Nothing here can move money, and the row it writes is never consulted when a
// balance is computed.
async function recordProviderEvent({
  provider, environment, eventId, eventType = null, signatureVerified = false,
  payload = {}, intentId = null, requestId = null, sourceIp = null
}) {
  const key = requireText(eventId, "A provider event id", 200);
  const { rows } = await pool.query(
    `INSERT INTO banking_provider_events
       (provider, environment, event_id, event_type, signature_verified, payload,
        intent_id, request_id, source_ip)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [provider, environment, key, eventType, Boolean(signatureVerified),
     JSON.stringify(payload || {}), intentId, requestId, sourceIp]
  );
  if (rows[0]) return { eventRowId: rows[0].id, duplicate: false };
  return { eventRowId: null, duplicate: true };
}

// Close an event off. Attempts are counted so a repeatedly failing callback is
// visible as one rather than as noise.
async function markProviderEventProcessed(provider, eventId, { status = "processed", error = null, intentId = null } = {}) {
  const { rows } = await pool.query(
    `UPDATE banking_provider_events
        SET status = $3,
            attempts = attempts + 1,
            last_error = $4,
            intent_id = COALESCE($5, intent_id),
            processed_at = NOW()
      WHERE provider = $1 AND event_id = $2
      RETURNING id, status, attempts`,
    [provider, eventId, status, error ? String(error).slice(0, 500) : null, intentId]
  );
  return rows[0] || null;
}

/* --------------------------------------------------------------- read side */

async function getIntentByTransaction(transactionId) {
  const { rows } = await pool.query(
    "SELECT * FROM banking_payment_intents WHERE transaction_id = $1",
    [transactionId]
  );
  return rows[0] || null;
}

// The operator's queue: everything a person still has to resolve. IN_DOUBT
// belongs here by definition, and nothing leaves it by the passage of time.
async function listUnresolvedIntents({ limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, transaction_id, provider, environment, capability, canonical_state,
            amount, currency, provider_reference, failure_reason, requires_review,
            created_at, updated_at
       FROM banking_payment_intents
      WHERE requires_review OR canonical_state = 'IN_DOUBT'
      ORDER BY created_at ASC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return rows;
}

module.exports = {
  CAPABILITY_NOT_SUPPORTED,
  getCapabilityReport,
  assertCapability,
  environmentDecision,
  createIntent,
  transitionIntent,
  recordTransition,
  recordProviderEvent,
  markProviderEventProcessed,
  getIntentByTransaction,
  listUnresolvedIntents
};
