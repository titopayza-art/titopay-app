"use strict";

// THE BANKING CAPABILITY, FROM TITOPAY'S SIDE.
//
// The adapter in `src/providers/banking-provider.js` answers "can this supplier
// do it?". This file answers the question that actually decides whether a rail
// runs, which is a different and stricter one: "is TitoPay willing, configured,
// permitted AND approved to do it, with this supplier, in this environment?"
//
// SIX GATES. ALL SIX, EVERY TIME.
//
//   1. implemented           the adapter exports the operation
//   2. configured            that adapter's own configuration resolves
//   3. flagEnabled           a server side flag says so (NOT the admin console)
//   4. environmentPermits    the banking environment is declared and paired with
//                            the deployment's own declared environment
//   5. configEnvironmentBound the adapter's STORED configuration declares an
//                            environment, and it equals the running one
//   6. approved              an ATTRIBUTABLE, SIGNED approval record names this
//                            capability, provider and environment, has not been
//                            revoked, and for production carries a second,
//                            different approver's countersignature
//
// (The count has been corrected twice, in the same direction both times: gates
// 1 and 2 were once described as one, and gate 5 was added when the Phase 3.5
// audit found that every environment check read the ENVIRONMENT and none could
// see stored configuration. TitoPay resolves credentials stored-config-first,
// so a stored row beats the variable, and until gate 5 existed a sandbox
// configuration sitting in a production database would have passed every check
// in this file. See `banking-config-contract.js`.)
//
// Any one of them false means unavailable. There is no combination that adds up
// to "probably fine", no override flag, and no ordering in which a missing gate
// is skipped. Default closed: a server with nothing configured reports every
// capability unavailable, which is exactly what TitoPay is today.
//
// WHY SIX RATHER THAN ONE. Each gate fails a different way in real life. Code
// can exist for a rail nobody bought. Credentials can be absent for code that
// is finished. A flag can be set on the wrong deployment. An environment can be
// mismatched. A configuration can be restored from the wrong database. And an
// operator can be certain a thing is agreed when the agreement is for something
// else. Requiring all six means no single mistake, and no single compromised
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
const configContract = require("../config/banking-config-contract");
const approvalContract = require("../config/banking-approval-contract");
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

/* ------------------------------------------------------------ gate 4: env */

// A banking rail may only run when the banking environment is DECLARED and
// PAIRED, by this table, with the deployment's own declared environment.
//
// AN ALLOW LIST, NOT A LIST OF OBJECTIONS. The first version of this was two
// rules describing which pairs were WRONG, with everything else falling
// through to permitted. That is fail-open in shape even when it is correct in
// content: adding a fourth banking environment later, or a third TITOPAY_ENV,
// would have been silently permitted against anything the two rules did not
// happen to mention. Here the pair must appear below or it is refused, so a new
// value is closed until somebody deliberately opens it.
//
// THE TWO VOCABULARIES ARE DIFFERENT, and pretending otherwise would hide the
// mapping. TITOPAY_ENV has exactly two values, `sandbox` and `production`,
// because that is what the deployment layer has always used. BANKING_ENVIRONMENT
// has three, because a bank distinguishes a developer's machine from a shared
// staging deployment pointed at a bank's sandbox. So `sandbox` admits both of
// the non-production banking worlds, and `production` admits exactly one thing.
//
// What each pair prevents, in plain terms: production banking on a sandbox
// deployment would take real customers to a test bank; anything less than
// production banking on a production deployment would take test credentials,
// or a developer's laptop configuration, to a real one.
const ENVIRONMENT_PAIRS = Object.freeze({
  production: Object.freeze(["production"]),
  sandbox: Object.freeze(["development", "staging"])
});

function environmentDecision(env = process.env) {
  const banking = flags.bankingEnvironment(env);
  const deployment = String(env.TITOPAY_ENV || "").trim().toLowerCase();

  if (!banking) {
    return { permitted: false, reason: "BANKING_ENVIRONMENT_NOT_DECLARED", banking: null, deployment: deployment || null };
  }
  if (!deployment) {
    return { permitted: false, reason: "TITOPAY_ENV_NOT_DECLARED", banking, deployment: null };
  }

  const permittedForDeployment = ENVIRONMENT_PAIRS[deployment];
  // A deployment environment this table has never heard of. Refused rather than
  // guessed, because the guess would be about where real money goes.
  if (!permittedForDeployment) {
    return { permitted: false, reason: "UNKNOWN_DEPLOYMENT_ENVIRONMENT", banking, deployment };
  }
  if (!permittedForDeployment.includes(banking)) {
    return {
      permitted: false,
      reason: deployment === "production"
        ? "NON_PRODUCTION_BANKING_ON_PRODUCTION_DEPLOYMENT"
        : "PRODUCTION_BANKING_ON_NON_PRODUCTION_DEPLOYMENT",
      banking,
      deployment
    };
  }
  return { permitted: true, reason: null, banking, deployment };
}

/* --------------------------------------- gate 5: stored config environment */

// Ask the adapter what environment its stored configuration declares, and bind
// it to the one actually running.
//
// FAIL CLOSED IN FOUR DIRECTIONS, all of which are real:
//   - the adapter does not implement `configEnvironment()`      NOT_DECLARED
//   - it throws while reading its own configuration             NOT_DECLARED
//   - its configuration declares nothing, something unknown,
//     or two things that disagree                               (contract reasons)
//   - it declares an environment that is not the running one    MISMATCH
//
// The last of those is the one this gate was built for: a `platform_settings`
// row restored or copied from the wrong database. Nothing else in the platform
// can see that, because everything else reads the environment variables, and a
// stored row beats an environment variable in this codebase.
function evaluateStoredBinding({ adapterRegistered, provider, bankingEnvironment }) {
  if (!adapterRegistered) {
    return { bound: false, environment: null, reason: "PROVIDER_NOT_REGISTERED", declarations: {} };
  }

  // ONE PATH, AND IT IS THE THROWING ONE.
  //
  // There was a `typeof bankingProvider.configEnvironment === "function"` guard
  // here, and it was dead code: the module export always exists, because it is
  // a wrapper that asks the registry for the operation. An adapter that omits
  // `configEnvironment` makes the REGISTRY throw, which lands in the catch
  // below. Mutation testing found the guard by proving that changing it changed
  // nothing, and dead code around a safety check is worse than no code, because
  // it reads like a second defence that is not there.
  //
  // So: call it, and treat every failure the same way. An adapter that omits
  // the method, one that throws while reading its own configuration, and one
  // that returns nonsense are all "has not declared an environment". None of
  // them is ever "probably fine".
  let declaration;
  try {
    declaration = bankingProvider.configEnvironment();
  } catch (error) {
    console.error("[banking] adapter could not declare its stored configuration environment", {
      provider, reason: error?.message || "unknown"
    });
    declaration = null;
  }

  const normalised = configContract.normaliseAdapterDeclaration(declaration);
  if (!normalised.ok) {
    return { bound: false, environment: null, reason: normalised.reason, declarations: normalised.declarations };
  }

  // The declaration is well formed. Now it has to match.
  const runtime = String(bankingEnvironment || "").trim().toLowerCase();
  if (!configContract.VALID_ENVIRONMENTS.includes(runtime)) {
    return { bound: false, environment: normalised.environment, reason: configContract.REASONS.RUNTIME_UNKNOWN, declarations: normalised.declarations };
  }
  if (normalised.environment !== runtime) {
    console.error("[banking] STORED CONFIGURATION IS FOR THE WRONG ENVIRONMENT", {
      provider, storedEnvironment: normalised.environment, runningEnvironment: runtime,
      action: "This configuration was written for a different environment. Do not copy platform_settings between deployments."
    });
    return { bound: false, environment: normalised.environment, reason: configContract.REASONS.MISMATCH, declarations: normalised.declarations };
  }
  return { bound: true, environment: normalised.environment, reason: null, declarations: normalised.declarations };
}

/* ------------------------------------------------------ gate 6: approval */

// KNOWN LIMITATION, RECORDED DELIBERATELY: THIS GATE TRUSTS THE DATABASE.
//
// An approval is a row. Anyone who can write to `banking_capability_approvals`
// can create one, and nothing here can tell an approval a compliance officer
// signed off from an approval somebody inserted with a psql prompt. The row
// carries `approved_by`, `approved_at`, `approval_reference`, `reason` and the
// matching revocation columns, so an approval CAN be attributed and audited;
// what it cannot yet do is PROVE it was not forged, because none of those
// fields is verified against anything.
//
// Why that is acceptable today, and only today: this is one gate of six, and
// the other five live outside the database. Database write access alone still
// cannot open a rail, because it cannot set a server environment variable, it
// cannot make an adapter exist, and it cannot make a stored configuration
// declare the environment that is running. It is the weakest of the six and it
// is not a single point of failure.
//
// ARCHITECTURAL TODO, before any capability is production-enabled:
//
//   1. Attributable approval. `approved_by` must be a real admin identity
//      captured at the moment of approval, not a column somebody can fill in.
//   2. `approval_reference` must point at a document that exists outside this
//      system: a signed agreement, a board minute, a regulator's letter.
//   3. Tamper evidence. Sign the approval row, or mirror it into the existing
//      append-only audit log and compare, so an inserted row is detectable.
//   4. Revocation must be as attributable as approval, using the
//      `revoked_by` / `revoked_at` / `revocation_reason` columns already there.
//   5. Two-person rule for production approvals, so no single account can open
//      a real-money rail.
//
// NOT DONE NOW, deliberately: redesigning approval while no provider exists
// would be designing against an imagined workflow. It is recorded here and in
// BANKING_SAFETY_AUDIT.md so it is a decision rather than an oversight.
//
// Approvals are read fresh rather than cached. They change rarely, they are
// read on a path that is already talking to a bank, and a revocation that takes
// effect on the next call is worth more than the query it costs.
async function loadApprovals(provider, environment, { env = process.env } = {}) {
  if (!provider || !environment) return new Map();
  // Every column the contract needs, and nothing else. No secret is stored in
  // this table, so this SELECT cannot pull one out of it.
  const { rows } = await pool.query(
    `SELECT provider, capability, environment, approved,
            approved_by, approval_reference, approved_at,
            approval_signature, signature_algorithm,
            countersigned_by, countersigned_at, countersignature,
            audit_event_id, revoked_at, revoked_by, revocation_reason
       FROM banking_capability_approvals
      WHERE provider = $1 AND environment = $2`,
    [provider, environment]
  ).catch((error) => {
    // A missing table, a missing column or an unreachable database must not
    // read as "approved". It reads as what it is: unknown, and therefore
    // refused. This is also the path taken on a deployment that has not applied
    // the attribution migration, which is correct: unverifiable is not approved.
    console.error("[banking] approvals could not be read; treating every capability as unapproved", {
      provider, environment, reason: error?.message || "unknown"
    });
    return { rows: [] };
  });

  const map = new Map();
  for (const row of rows) {
    // THE ROW IS EVIDENCE, NOT THE VERDICT. `verifyApproval` requires
    // attribution, a signature keyed by a server-side secret that is not in this
    // database, and for production a second, different approver. A row that
    // satisfies none of that is recorded here as unapproved, with the reason.
    const verdict = approvalContract.verifyApproval(row, { env });
    if (!verdict.approved) {
      console.warn("[banking] approval present but not valid", {
        provider, environment, capability: row.capability, reason: verdict.reason
      });
    }
    map.set(row.capability, {
      approved: verdict.approved,
      reason: verdict.reason,
      // Attribution only: who, when, and against which external document.
      // No signature and no key is ever carried out of this function.
      approvalReference: verdict.attribution?.approvalReference || null,
      approvedAt: verdict.attribution?.approvedAt || null,
      approvedBy: verdict.attribution?.approvedBy || null,
      countersignedBy: verdict.attribution?.countersignedBy || null,
      revokedAt: row.revoked_at || null
    });
  }
  return map;
}

/* ------------------------------------------------------- the report itself */

// What every capability's five gates currently say. This is what the admin
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
  // Two different absences, and conflating them sent operators to the wrong
  // place. "The registry resolves a DIFFERENT provider" and "the registry
  // resolves THIS provider but no adapter is registered under that key" both
  // mean no adapter answers, and only the second is a missing registration.
  const adapterRegistered = adapterAnswersThisProvider
    && bankingProvider.bankingCapabilityConfigured();

  let declared = [];
  if (adapterRegistered) {
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

  // GATE 5: the adapter's STORED configuration must declare its own environment
  // and it must equal the running one.
  //
  // The adapter reads its own stored configuration and returns only the
  // DECISION, never the configuration, so no credential crosses this boundary.
  // An adapter with no `configEnvironment()` at all is refused rather than
  // waved through: the check must not be skippable by omission, which is the
  // whole reason it is a gate and not a convention.
  const storedBinding = evaluateStoredBinding({
    adapterRegistered, provider, bankingEnvironment: environment.banking
  });

  const approvals = environment.banking ? await loadApprovals(provider, environment.banking, { env }) : new Map();

  const capabilities = flags.ALL_CAPABILITIES.map((capability) => {
    const adapter = declaredByName.get(capability)
      || {
        implemented: false,
        configured: false,
        reason: adapterRegistered ? "NOT_DECLARED" : "PROVIDER_NOT_REGISTERED"
      };
    const approval = approvals.get(capability)
      || { approved: false, reason: approvalContract.REASONS.MISSING, approvalReference: null,
           approvedAt: null, approvedBy: null, countersignedBy: null, revokedAt: null };

    const gates = {
      implemented: Boolean(adapter.implemented),
      configured: Boolean(adapter.configured),
      flagEnabled: flags.capabilityFlagEnabled(provider, capability, env),
      environmentPermits: environment.permitted,
      configEnvironmentBound: storedBinding.bound,
      approved: Boolean(approval.approved)
    };
    const available = gates.implemented && gates.configured && gates.flagEnabled
      && gates.environmentPermits && gates.configEnvironmentBound && gates.approved;

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
      else if (!gates.configEnvironmentBound) reason = storedBinding.reason;
      else if (!gates.flagEnabled) reason = "FLAG_DISABLED";
      // The approval gate now says WHY: unsigned, unattributed, not
      // countersigned, revoked, or simply absent. An operator reading
      // "NOT_APPROVED" learned nothing they could act on.
      else reason = approval.reason || "NOT_APPROVED";
    }

    return {
      capability,
      available,
      reason,
      gates,
      flagVariable: flags.capabilityFlagName(provider, capability),
      // Attribution, for the operator and the audit trail. Names and a
      // reference: no signature, no key, no credential.
      approvalReference: approval.approvalReference,
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
      countersignedBy: approval.countersignedBy,
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
    // What the adapter's stored configuration says about itself. The declared
    // environment is a name, never a credential, so it is safe to show an
    // operator, and it is the single most useful line when a rail refuses.
    storedConfigEnvironment: storedBinding.environment,
    storedConfigBound: storedBinding.bound,
    storedConfigReason: storedBinding.reason,
    // Registered means an adapter answers the capability at all. With
    // BANKING_PROVIDER unset that is the `none` adapter, which refuses
    // everything, and that is a correct and safe state rather than a fault.
    registered: adapterRegistered,
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

  // Decide-once, in the WHERE clause. `canonical_state = $8` makes the update
  // conditional on the state we read still holding, so two callers that both read
  // `fromState` (possible when this runs without a held transaction — the
  // client === null / pool path drops the FOR UPDATE lock the instant that SELECT
  // returns) cannot both apply the same transition: the first update wins and the
  // second matches zero rows. Without this the second caller would write a second
  // transition row and re-fire any settlement hung off the destination state.
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
      WHERE id = $1 AND canonical_state = $8
      RETURNING *`,
    [intentId, toState, providerStatus, providerTransactionId, providerReference,
     failureReason, requiresReview, fromState]
  );

  // Zero rows means another caller transitioned this intent between our read and
  // our write. Do not record a second transition; report the no-op.
  if (!rows[0]) {
    const { rows: current } = await queryable.query(
      "SELECT * FROM banking_payment_intents WHERE id = $1", [intentId]
    );
    return { intent: current[0] || intent, changed: false, reason: "ALREADY_TRANSITIONED" };
  }

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
