"use strict";

// TITOPAY OWNS THE CAPABILITY. A PROVIDER ONLY SUPPLIES IT.
//
// Every external company TitoPay buys a capability from is temporary. A card
// acquirer is renegotiated, a payout rail is added, a VAS aggregator is
// replaced, an identity verification vendor is chosen for the first time. None
// of that is allowed to be a rewrite, and none of it is allowed to reach the
// customer as a change in what the app says or does.
//
// So the platform is layered:
//
//     TitoPay core
//        -> an internal capability, named for what TitoPay needs
//           -> an adapter, named for the company that supplies it
//              -> that company's API
//
// The rule that makes it hold is one sentence: NO PROVIDER NAME MAY APPEAR IN
// CORE BUSINESS LOGIC. Core asks for `payment` and calls `processPayment()`.
// It never asks for Peach and never calls `processWithPeach()`. An adapter, by
// contrast, is ALLOWED to know its provider intimately — that is its entire
// job, and pretending otherwise would just move the coupling somewhere less
// honest. The line is: provider-specific code may know the provider, TitoPay
// core must not.
//
// WHICH PROVIDER IS LIVE IS CONFIGURATION, NOT CODE. Each capability reads one
// environment variable, server side:
//
//     PAYMENT_PROVIDER=peach_checkout
//     PAYOUT_PROVIDER=peach_payouts
//     KYC_PROVIDER=internal
//     VAS_PROVIDER=none
//
// Unset means whichever adapter declares itself the shipped default for that
// capability, which is the adapter's own business. No credential of any kind lives here
// or in any adapter's export: adapters read secrets from the API's own server
// side configuration when they make a call, and nothing in this tree is
// reachable from the browser.
//
// NOTHING HERE INVENTS A CAPABILITY THE PLATFORM DOES NOT HAVE. Where TitoPay
// has no provider contracted for an operation, the adapter refuses with a
// plain "not available" and says so in the diagnosis. It never returns a
// fabricated success, a mocked verification or a stubbed reference. A refusal
// is recoverable; a fake result is a lie that reaches a ledger.

const { AppError } = require("../lib/errors");

// The capabilities TitoPay names for itself. A new provider category is added
// here first, as a TitoPay concept, and only then given an adapter.
const CAPABILITIES = {
  KYC: "kyc",                 // identity and business verification
  AML: "aml",                 // sanctions, PEP and adverse media screening
  PAYMENT: "payment",         // money in: card, EFT, collection rails
  PAYOUT: "payout",           // money out: bank payouts and withdrawals
  BANKING: "banking",         // account verification, statements, balances
  VAS: "vas",                 // airtime, data, electricity, vouchers
  CARD: "card",               // issued virtual and physical cards
  NOTIFICATION: "notification" // email and push delivery
};

const CAPABILITY_KEYS = new Set(Object.values(CAPABILITIES));

// NOT ONE PROVIDER NAME APPEARS IN THIS FILE, and that is the point. The
// registry knows capabilities, environment variables and adapters. WHICH
// adapter answers a capability by default is declared by the adapter itself
// (`isDefault: true`), so adding, replacing or retiring a provider never edits
// the resolver.
//
// Capabilities with no adapter at all today — banking, card issuing, and the
// notification capability, which is still served directly by TitoPay's own
// email centre and in-app notification service — are named above so the work
// has somewhere to land. They report as unregistered rather than being
// pretended into existence.

// capability -> Map(providerKey -> adapter)
const registry = new Map();
// capability -> providerKey declared as the shipped default
const declaredDefaults = new Map();

// The env var name for a capability: kyc -> KYC_PROVIDER.
function environmentVariableFor(capability) {
  return `${String(capability).toUpperCase()}_PROVIDER`;
}

// An adapter declares which capability it supplies, the key that selects it,
// and the operations it implements. Anything it does not implement is simply
// absent, and asking for it fails loudly rather than silently doing nothing.
function registerProvider(adapter) {
  if (!adapter || !CAPABILITY_KEYS.has(adapter.capability)) {
    throw new Error(`Unknown provider capability: ${adapter && adapter.capability}`);
  }
  if (!adapter.key) throw new Error(`Provider for ${adapter.capability} has no key`);
  if (!registry.has(adapter.capability)) registry.set(adapter.capability, new Map());
  registry.get(adapter.capability).set(adapter.key, Object.freeze(adapter));
  if (adapter.isDefault) {
    const existing = declaredDefaults.get(adapter.capability);
    if (existing && existing !== adapter.key) {
      throw new Error(`Two providers claim to be the default for ${adapter.capability}: ${existing} and ${adapter.key}`);
    }
    declaredDefaults.set(adapter.capability, adapter.key);
  }
  return adapter;
}

function configuredKey(capability) {
  const fromEnvironment = String(process.env[environmentVariableFor(capability)] || "").trim();
  return fromEnvironment || declaredDefaults.get(capability) || "none";
}

// The one way core reaches a provider. It never takes a provider name: the
// caller says what it needs, configuration says who supplies it.
function providerFor(capability) {
  if (!CAPABILITY_KEYS.has(capability)) throw new Error(`Unknown capability: ${capability}`);
  const key = configuredKey(capability);
  const adapter = registry.get(capability)?.get(key);
  if (adapter) return adapter;
  // A misconfigured capability must be obvious to an operator and invisible to
  // a customer, so the operator detail goes to the log and the customer gets
  // the same wording any unavailable service uses. It names no company.
  console.error("[providers] no adapter registered", {
    capability, configured: key, variable: environmentVariableFor(capability)
  });
  throw new AppError(503, "This service is not available right now. Please try again later.");
}

// Whether a capability has a usable adapter at all, without throwing. Used by
// availability checks and by the admin diagnosis, never to decide silently.
function capabilityConfigured(capability) {
  return Boolean(registry.get(capability)?.get(configuredKey(capability)));
}

// Ask an adapter for one operation. Keeping this in one place means an
// operation a provider does not support fails the same way everywhere, and
// core never has to branch on which provider is live.
function operation(capability, name) {
  const adapter = providerFor(capability);
  const fn = adapter[name];
  if (typeof fn !== "function") {
    console.error("[providers] operation not supported", { capability, provider: adapter.key, operation: name });
    throw new AppError(503, "This service is not available right now. Please try again later.");
  }
  return fn.bind(adapter);
}

// What the console and the diagnosis script may show an operator: which
// capability resolves to which adapter, and whether it is wired. No secret and
// no endpoint is included.
function describeProviders() {
  return Object.values(CAPABILITIES).map((capability) => {
    const key = configuredKey(capability);
    const adapter = registry.get(capability)?.get(key) || null;
    return {
      capability,
      variable: environmentVariableFor(capability),
      configured: key,
      registered: Boolean(adapter),
      source: process.env[environmentVariableFor(capability)] ? "environment" : "default",
      operations: adapter ? Object.keys(adapter).filter((k) => typeof adapter[k] === "function").sort() : []
    };
  });
}

module.exports = {
  CAPABILITIES,
  registerProvider,
  providerFor,
  capabilityConfigured,
  configuredKey,
  environmentVariableFor,
  operation,
  describeProviders
};
