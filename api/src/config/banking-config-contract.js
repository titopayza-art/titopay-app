"use strict";

// THE STORED CONFIGURATION CONTRACT: A PROVIDER'S CONFIG MUST SAY WHICH WORLD IT IS FOR.
//
// THE HOLE THIS CLOSES, STATED PLAINLY.
//
// TitoPay resolves integration credentials STORED-CONFIG-FIRST. `platform_settings`
// holds `integration_*` rows an operator sets from the admin console, and when
// one exists it wins over the environment variable. That is why going live
// carries a written warning never to copy `platform_settings` from sandbox into
// production: a production database carrying sandbox rows would use sandbox
// credentials and silently ignore the environment variable saying otherwise.
//
// Every environment check written so far reads the ENVIRONMENT. None of them
// can see stored configuration, so none of them would notice. The Phase 3.5
// audit recorded this as the one architectural weakness left, and this file is
// the answer: a stored configuration must carry its own environment identity,
// that identity is checked against the running one, and anything less than an
// exact match refuses.
//
// THE RULE: ENVIRONMENT IS DECLARED, NEVER INFERRED.
//
// It would be easy to guess. A URL with "sandbox" in the hostname, a key with a
// `test_` prefix, a credential named for a playpen: every one of those looks
// like an answer and none of them is one. Providers rename hosts. Keys get
// prefixes that mean something else. A production URL can sit in a sandbox
// config because somebody pasted the wrong line, and inference would then
// CONFIRM the mistake rather than catch it, which is worse than having no check
// at all.
//
// So nothing here parses a URL, a hostname, a key format, a credential name or
// a provider name. The only thing read is an explicit `environment` field. If
// it is absent, the answer is "missing", not "probably sandbox".
//
// AND AMBIGUITY IS ITS OWN FAILURE. A configuration that declares an
// environment twice and disagrees with itself is not a configuration to pick a
// winner from. It is refused, and the operator resolves it.

const VALID_ENVIRONMENTS = Object.freeze(["development", "staging", "production"]);

// The one field that counts. The others are checked ONLY to detect a config
// that contradicts itself; none of them is ever used as the answer.
const DECLARATION_FIELD = "environment";
const CONTRADICTION_FIELDS = Object.freeze(["environment", "env", "mode", "bankingEnvironment"]);

// Result codes. Each names one specific way a stored configuration fails to
// establish which world it belongs to, so a log line says what to fix.
const REASONS = Object.freeze({
  MISSING_CONFIG: "STORED_CONFIG_MISSING",
  INVALID_CONFIG: "STORED_CONFIG_INVALID",
  MISSING_ENVIRONMENT: "STORED_ENVIRONMENT_MISSING",
  UNKNOWN_ENVIRONMENT: "STORED_ENVIRONMENT_UNKNOWN",
  AMBIGUOUS_ENVIRONMENT: "STORED_ENVIRONMENT_AMBIGUOUS",
  NOT_DECLARED: "CONFIG_ENVIRONMENT_NOT_DECLARED",
  MISMATCH: "STORED_ENVIRONMENT_MISMATCH",
  RUNTIME_UNKNOWN: "RUNTIME_ENVIRONMENT_UNKNOWN"
});

function normalise(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return ""; // an object is never an environment
  return String(value).trim().toLowerCase();
}

/**
 * Read the environment a stored configuration DECLARES for itself.
 *
 * Nothing is inferred. A configuration full of production URLs and production
 * key prefixes with no `environment` field returns MISSING, deliberately.
 *
 * @param {object|null} storedConfig the provider's stored configuration
 * @returns {{ok: boolean, environment: string|null, reason: string|null, declarations: object}}
 */
function readDeclaredEnvironment(storedConfig) {
  const empty = { ok: false, environment: null, declarations: {} };

  if (storedConfig === undefined || storedConfig === null) {
    return { ...empty, reason: REASONS.MISSING_CONFIG };
  }
  if (typeof storedConfig !== "object" || Array.isArray(storedConfig)) {
    return { ...empty, reason: REASONS.INVALID_CONFIG };
  }

  // Every field that could be read as an environment declaration, gathered so a
  // self-contradicting configuration can be spotted rather than resolved.
  const declarations = {};
  for (const field of CONTRADICTION_FIELDS) {
    const value = normalise(storedConfig[field]);
    if (value) declarations[field] = value;
  }

  const distinct = new Set(Object.values(declarations));
  if (distinct.size > 1) {
    // Two answers is no answer. Never pick one, not even the canonical field:
    // a config that disagrees with itself has been edited by somebody who
    // believed something different from somebody else.
    return { ok: false, environment: null, reason: REASONS.AMBIGUOUS_ENVIRONMENT, declarations };
  }

  const declared = normalise(storedConfig[DECLARATION_FIELD]);
  if (!declared) {
    // Present but unnamed, or named only in a field that is not the contract's.
    return { ok: false, environment: null, reason: REASONS.MISSING_ENVIRONMENT, declarations };
  }
  if (!VALID_ENVIRONMENTS.includes(declared)) {
    return { ok: false, environment: null, reason: REASONS.UNKNOWN_ENVIRONMENT, declarations };
  }
  return { ok: true, environment: declared, reason: null, declarations };
}

/**
 * Bind a stored configuration to the environment actually running.
 *
 * The stored declaration must EQUAL the resolved banking environment. Not be
 * compatible with it, not be a superset of it: equal. A staging configuration
 * on a staging deployment is the only thing that lets staging run.
 *
 * The pairing of the banking environment against TITOPAY_ENV is a separate
 * check, in `banking-service`, and both must pass. This function deliberately
 * does not repeat it: two checks that could drift apart are worse than one
 * check called from two places.
 *
 * @param {object} options
 * @param {object|null} options.storedConfig
 * @param {string|null} options.bankingEnvironment the resolved BANKING_ENVIRONMENT
 * @returns {{bound: boolean, environment: string|null, reason: string|null, declarations: object}}
 */
function bindStoredEnvironment({ storedConfig, bankingEnvironment } = {}) {
  const runtime = normalise(bankingEnvironment);
  // An unresolved runtime environment cannot be matched against anything. This
  // is checked FIRST so that a missing runtime never reads as a configuration
  // fault, which would send an operator to fix the wrong thing.
  if (!runtime || !VALID_ENVIRONMENTS.includes(runtime)) {
    return { bound: false, environment: null, reason: REASONS.RUNTIME_UNKNOWN, declarations: {} };
  }

  const declared = readDeclaredEnvironment(storedConfig);
  if (!declared.ok) {
    return { bound: false, environment: null, reason: declared.reason, declarations: declared.declarations };
  }
  if (declared.environment !== runtime) {
    return {
      bound: false,
      environment: declared.environment,
      reason: REASONS.MISMATCH,
      declarations: declared.declarations
    };
  }
  return { bound: true, environment: declared.environment, reason: null, declarations: declared.declarations };
}

/**
 * What an adapter must return from `configEnvironment()`.
 *
 * An adapter reads its OWN stored configuration, because that is the only thing
 * that knows where it lives, and runs it through `readDeclaredEnvironment`
 * above. It returns the RESULT, never the configuration: no credential crosses
 * this boundary, which is what keeps the provider layer free of secrets.
 *
 * An adapter that does not implement `configEnvironment()` at all is treated as
 * NOT_DECLARED and refused, so the check cannot be skipped by omission. That is
 * the whole reason this is a gate rather than a convention.
 */
function normaliseAdapterDeclaration(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, environment: null, reason: REASONS.NOT_DECLARED, declarations: {} };
  }
  const environment = normalise(result.environment);
  if (!result.ok || !environment) {
    return {
      ok: false,
      environment: null,
      reason: result.reason || REASONS.MISSING_ENVIRONMENT,
      declarations: result.declarations || {}
    };
  }
  if (!VALID_ENVIRONMENTS.includes(environment)) {
    return { ok: false, environment: null, reason: REASONS.UNKNOWN_ENVIRONMENT, declarations: result.declarations || {} };
  }
  return { ok: true, environment, reason: null, declarations: result.declarations || {} };
}

module.exports = {
  VALID_ENVIRONMENTS,
  DECLARATION_FIELD,
  CONTRADICTION_FIELDS,
  REASONS,
  readDeclaredEnvironment,
  bindStoredEnvironment,
  normaliseAdapterDeclaration
};
