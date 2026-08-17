"use strict";

// BANKING: the rails a bank itself supplies.
//
// Account verification, account information, transaction history, payment
// initiation from a customer's own bank account, and the outbound side of
// that relationship. Distinct from PAYMENT (money in through an acquirer) and
// PAYOUT (money out through a payout rail), both of which are already bought
// from a supplier and already have adapters.
//
// THIS CAPABILITY HAS NO PROVIDER. THIS FILE SAYS SO INSTEAD OF COVERING IT.
//
// `src/providers/index.js` has named `banking` as a capability since the
// provider layer was written, and deliberately left it unregistered, on the
// principle that a capability with no adapter should "report as unregistered
// rather than being pretended into existence". That is still the honest
// position. What this file adds is the SEAM: the operations TitoPay would ask
// for, with TitoPay's own signatures, so that the day a bank is contracted it
// is one adapter away and no core module changes.
//
// It does NOT add a bank. There is no adapter here for any named institution,
// because none has been confirmed: no documentation, no credentials, no
// sandbox access, no written statement of which capabilities TitoPay is
// approved to use. A technically reachable API is not a commercial agreement,
// and neither is a bank appearing in somebody else's supported list.
//
// SO EVERY OPERATION BELOW REFUSES, and refuses with a state rather than an
// excuse: CAPABILITY_NOT_SUPPORTED. It never returns a fabricated reference, a
// stubbed consent, a mocked verification or a synthetic success. A refusal is
// recoverable. A fake result is a lie that reaches a ledger.
//
// MONEY SAFETY IS NOT THIS LAYER'S TO INVENT, and nothing here is a new set of
// rules. When a bank is wired, its payments settle through the controls the
// platform already has: the amount is the server's, an idempotency key is
// required, the transaction row is locked, the provider is asked directly what
// happened before anything is credited, a mismatch refuses, and a timeout stays
// pending rather than being resubmitted. This file is a seam, not a second
// financial system.

const { registerProvider, operation, CAPABILITIES, capabilityConfigured } = require("./index");
const { AppError } = require("../lib/errors");
const { ALL_CAPABILITIES } = require("../config/banking-flags");

// The one refusal. A distinct code so a caller can tell "TitoPay has not bought
// this" apart from "the supplier is down", while the customer sees the same
// wording every unavailable service uses and no company is ever named to them.
function notSupported() {
  throw new AppError(
    503,
    "This service is not available right now. Please try again later.",
    { code: "CAPABILITY_NOT_SUPPORTED" }
  );
}

// ---------------------------------------------------------------------------
// Adapter: none. The shipped default, and an explicit refusal.
//
// An unset BANKING_PROVIDER resolves here, so a server that has never heard of
// this capability is a working server with every bank rail shut.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.BANKING,
  key: "none",
  isDefault: true,

  // What this adapter implements, before any question of configuration,
  // approval or flags. Synchronous and database free: it is a statement about
  // code, which the five gate check in `banking-service` then combines with
  // everything else. `none` implements nothing, and says so.
  declaredCapabilities() {
    return ALL_CAPABILITIES.map((capability) => ({
      capability,
      implemented: false,
      configured: false,
      reason: "NO_PROVIDER_CONFIGURED"
    }));
  },

  initiateCustomerPayment: notSupported,
  getPaymentStatus: notSupported,
  handleProviderCallback: notSupported,
  verifyAccount: notSupported,
  getAccountInformation: notSupported,
  getTransactionHistory: notSupported,
  initiatePayout: notSupported,
  initiateWithdrawal: notSupported,
  reconcile: notSupported
});

// ---------------------------------------------------------------------------
// The interface core would use.
//
// Nine operations, named for what TitoPay needs. Not one of them names a
// company, a product or a bank's own object; an adapter translates its
// supplier's vocabulary on the way in and on the way out, and that translation
// is the adapter's entire job.
//
// `verifyAccount` is a contract, not an implementation. There is no bank
// account verification anywhere in TitoPay today, and this does not add one: it
// refuses until a real adapter and an approved integration exist. An account
// number that parses is not an account that was checked.
// ---------------------------------------------------------------------------
module.exports = {
  // Money in, initiated from the customer's own bank.
  initiateCustomerPayment: (actor, request) =>
    operation(CAPABILITIES.BANKING, "initiateCustomerPayment")(actor, request),
  getPaymentStatus: (actor, reference) =>
    operation(CAPABILITIES.BANKING, "getPaymentStatus")(actor, reference),

  // Inbound provider events. The adapter authenticates and normalises; it never
  // settles. What a callback is worth is decided by the lifecycle above it.
  handleProviderCallback: (envelope) =>
    operation(CAPABILITIES.BANKING, "handleProviderCallback")(envelope),

  // The account itself.
  verifyAccount: (actor, request) =>
    operation(CAPABILITIES.BANKING, "verifyAccount")(actor, request),
  getAccountInformation: (actor, request) =>
    operation(CAPABILITIES.BANKING, "getAccountInformation")(actor, request),
  getTransactionHistory: (actor, request) =>
    operation(CAPABILITIES.BANKING, "getTransactionHistory")(actor, request),

  // Money out. Named as TitoPay's two distinct products, because a customer
  // withdrawing their own balance and a business being paid out are different
  // approvals, different limits and different risk, whoever carries them.
  initiatePayout: (actor, request) =>
    operation(CAPABILITIES.BANKING, "initiatePayout")(actor, request),
  initiateWithdrawal: (actor, request) =>
    operation(CAPABILITIES.BANKING, "initiateWithdrawal")(actor, request),

  // Statement retrieval for reconciliation. The comparison itself stays in
  // `money-integrity-service`, which is provider neutral and already exists.
  reconcile: (request) =>
    operation(CAPABILITIES.BANKING, "reconcile")(request),

  // What the adapter says it implements, for the capability report.
  declaredCapabilities: () =>
    operation(CAPABILITIES.BANKING, "declaredCapabilities")(),

  bankingCapabilityConfigured: () => capabilityConfigured(CAPABILITIES.BANKING)
};
