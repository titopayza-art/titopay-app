"use strict";

// SERVER ENFORCED BANKING FLAGS. OFF UNLESS SOMEBODY WITH SERVER ACCESS SAYS OTHERWISE.
//
// WHY THIS FILE EXISTS RATHER THAN REUSING THE FLAGS THAT ARE ALREADY THERE.
//
// TitoPay has a feature flag mechanism: `platform_settings.feature_flags`, with
// twenty-odd flags an operator toggles in the admin console. It is read and
// written by `admin.routes.js` and consumed by NOTHING. A search of the whole
// API for that key outside the console's own routes returns no results. Every
// one of those switches is a label; not one of them gates a line of behaviour.
//
// That is survivable for a display toggle. It is not survivable for a bank
// rail, where "off" has to mean a payment instruction is never sent. So banking
// gets its own flags, and they are enforced at the point of use rather than
// described in a console.
//
// THE FLAGS LIVE IN THE ENVIRONMENT, DELIBERATELY, AND THE ADMIN CONSOLE CANNOT
// WRITE THEM. Turning on a rail that moves real money should require access to
// the server, not a session in a web app. A stolen admin session, a confused
// operator or a bug in a save handler must not be able to activate a bank. The
// console can READ this and show an operator what is on; it has no path to
// change it.
//
// A FLAG IS NEVER SUFFICIENT ON ITS OWN. It is one of five gates in
// `banking-service.js`, and the other four are: the adapter implements the
// operation, its configuration resolves, the banking environment is paired with
// the deployment's own, and an approval record exists naming the capability. A
// flag says "TitoPay is willing"; it does not say a bank has agreed, a contract
// exists or a regulator is satisfied.
//
// DEFAULT OFF, AND FAIL CLOSED. An unset variable is off. An unreadable value
// is off. A typo is off. There is no value that means "work it out": the only
// string that enables a flag is a deliberate one, and everything else, silence
// included, leaves the rail shut.

// The capabilities TitoPay names for a bank rail. Provider-neutral: not one of
// these words belongs to a company.
const CAPABILITIES = Object.freeze({
  CUSTOMER_PAYMENT_INITIATION: "CUSTOMER_PAYMENT_INITIATION",
  ACCOUNT_INFORMATION: "ACCOUNT_INFORMATION",
  ACCOUNT_VERIFICATION: "ACCOUNT_VERIFICATION",
  TRANSACTION_HISTORY: "TRANSACTION_HISTORY",
  PAYMENT_STATUS: "PAYMENT_STATUS",
  WITHDRAWAL: "WITHDRAWAL",
  PAYOUT: "PAYOUT",
  REFUND: "REFUND",
  RECONCILIATION: "RECONCILIATION",
  SETTLEMENT: "SETTLEMENT",
  CONSENT_MANAGEMENT: "CONSENT_MANAGEMENT"
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

const VALID_ENVIRONMENTS = Object.freeze(["development", "staging", "production"]);

// ONE string is true. Everything else, including "1", "yes", "on", "TRUE " with
// a trailing space, an empty value and an absent variable, is false.
//
// This is stricter than the `booleanFromEnv` helper the rest of the config
// uses, and that is the point: for a switch that can start sending payment
// instructions to a bank, "close enough" is not a standard worth having. An
// operator who means it types the word exactly.
function enabledFlag(env, name) {
  return String(env[name] === undefined || env[name] === null ? "" : env[name]) === "true";
}

// The environment a banking rail is allowed to run in. No default: an
// undeclared banking environment is not "development", it is undeclared, and
// nothing runs until somebody states it.
function bankingEnvironment(env = process.env) {
  const value = String(env.BANKING_ENVIRONMENT || "").trim().toLowerCase();
  return VALID_ENVIRONMENTS.includes(value) ? value : null;
}

// Which adapter answers the banking capability. `none` is the shipped default
// and refuses everything, so an unset variable is a working, safe server.
function bankingProviderKey(env = process.env) {
  return String(env.BANKING_PROVIDER || "").trim() || "none";
}

// The master switch. Off means the banking layer is inert: `banking-service`
// reports every capability unavailable and no adapter operation is reachable.
function bankingIntegrationEnabled(env = process.env) {
  return enabledFlag(env, "BANKING_INTEGRATION_ENABLED");
}

// Per provider, per capability: BANKING_<PROVIDER>_<CAPABILITY>_ENABLED.
//
// Derived rather than listed, so registering a provider never edits this file
// and no provider name appears in it, not even as an example. A provider key of
// `example_bank` plus WITHDRAWAL becomes BANKING_EXAMPLE_BANK_WITHDRAWAL_ENABLED,
// which is off until somebody sets it, and which being on still proves nothing
// about what that bank has agreed to.
function capabilityFlagName(providerKey, capability) {
  const provider = String(providerKey || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const name = String(capability || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `BANKING_${provider}_${name}_ENABLED`;
}

function capabilityFlagEnabled(providerKey, capability, env = process.env) {
  if (!ALL_CAPABILITIES.includes(capability)) return false;
  if (!bankingIntegrationEnabled(env)) return false; // the master switch wins
  return enabledFlag(env, capabilityFlagName(providerKey, capability));
}

// The whole flag picture, for the boot log, /health and the admin console.
// Names and booleans only: this reads no credential and returns none.
function describeBankingFlags(env = process.env) {
  const provider = bankingProviderKey(env);
  const integrationEnabled = bankingIntegrationEnabled(env);
  return {
    integrationEnabled,
    provider,
    environment: bankingEnvironment(env),
    capabilities: ALL_CAPABILITIES.map((capability) => ({
      capability,
      variable: capabilityFlagName(provider, capability),
      enabled: capabilityFlagEnabled(provider, capability, env)
    }))
  };
}

module.exports = {
  CAPABILITIES,
  ALL_CAPABILITIES,
  VALID_ENVIRONMENTS,
  bankingEnvironment,
  bankingProviderKey,
  bankingIntegrationEnabled,
  capabilityFlagName,
  capabilityFlagEnabled,
  describeBankingFlags
};
