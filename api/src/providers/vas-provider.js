"use strict";

// VALUE ADDED SERVICES: airtime, data, electricity, vouchers.
//
// THIS CAPABILITY IS NOT WIRED, AND THIS FILE SAYS SO RATHER THAN COVERING IT.
//
// The audit behind this layer found the honest position: the VAS integration
// authenticates, lists the products the account may sell and reports its own
// health to the console, and that is all. No purchase has ever been sent to
// it. The console's routing page nevertheless shows airtime, data, electricity
// and bill payments as supplied, which reads as a live rail.
//
// The correct thing to build here is the SEAM, not the rail. `purchaseAirtime`
// exists as a TitoPay operation with a TitoPay signature, so the day a VAS
// contract is live it is one adapter away. Until then it refuses with the same
// wording any unavailable service uses. It does NOT return a fabricated token,
// a stubbed reference or a mocked success, because a VAS purchase debits a
// wallet and a fake success debits it for nothing.
//
// MONEY SAFETY, when this is wired: a VAS purchase is a debit against a
// prepaid float and a delivery of a redeemable token. It needs an idempotency
// key on the request, the token stored against the transaction before the
// customer is shown it, and a timeout treated as UNKNOWN rather than failed,
// because a token issued by the provider and lost by TitoPay is money gone. It
// must be reconciled, never blindly re-purchased.
//
// ---------------------------------------------------------------------------
// ALL OF THAT IS NOW BUILT. See services/vas-purchase-service.js: the debit,
// the idempotency key with its advisory lock and unique index, the token
// encrypted and persisted before it is returned, timeout-as-unknown with a
// review queue, and a single guarded release. It is tested against a real
// database in api/test/vas-purchase.test.js with a fake adapter.
//
// WHAT IS LEFT IS THIS FILE. To make airtime, data, electricity, vouchers and
// bill payments live, an adapter has to:
//
//   1. implement purchaseAirtime / purchaseData / purchaseElectricity with the
//      signature (actor, request) where request is
//        { serviceCode, amount, recipient, productCode, reference }
//      `reference` is TitoPay's and is STABLE ACROSS RETRIES — send it as the
//      supplier's idempotency key, so a retried request returns the original
//      purchase instead of issuing a second token. flashTransactionReference()
//      in flash-service.js exists for exactly this.
//
//   2. return { token } — or { pin } / { voucherCode } — carrying the
//      redeemable value, plus an optional `receipt` object kept for audit.
//
//   3. raise a 4xx (AppError or any error with a status) ONLY when the
//      supplier actually refused. Anything else — a timeout, a socket error,
//      a 5xx, a 408, a 429 — must propagate as-is so the rail records it as
//      unknown. An adapter that converts a timeout into a 400 would cause a
//      refund for a token the customer is holding.
//
//   4. declare canPurchase: true. That one line opens the fee preview, the
//      purchase route and the app tiles together, because all three read this
//      same declaration rather than keeping their own lists.
//
// Nothing else in the platform needs to change.
// ---------------------------------------------------------------------------

const { registerProvider, operation, CAPABILITIES, capabilityConfigured, providerAttribute } = require("./index");
const { AppError } = require("../lib/errors");

function notAvailable() {
  throw new AppError(503, "This service is not available right now. Please try again later.");
}

// ---------------------------------------------------------------------------
// Adapter: none. The shipped default, and an explicit refusal.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.VAS,
  key: "none",
  isDefault: true,
  // WHETHER A PURCHASE CAN ACTUALLY BE MADE, declared rather than inferred.
  // `purchaseAirtime` exists on every adapter — that is the seam — so its
  // presence proves nothing, and anything checking for the function would
  // conclude the rail is live. This is the fact the catalogue reads before it
  // publishes a service as active.
  canPurchase: false,
  purchaseAirtime: notAvailable,
  purchaseData: notAvailable,
  purchaseElectricity: notAvailable,
  async listProducts() { return { products: [] }; }
});

// ---------------------------------------------------------------------------
// Adapter: Flash Partner API. Selected with VAS_PROVIDER=flash. It can
// authenticate and list products; it cannot yet buy, and it refuses to pretend
// otherwise.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.VAS,
  key: "flash",
  // Authenticating and listing a catalogue is not selling from it. Until a
  // purchase can be sent and settled, this stays false, and the services it
  // would supply stay off the shelf.
  canPurchase: false,
  purchaseAirtime: notAvailable,
  purchaseData: notAvailable,
  purchaseElectricity: notAvailable,
  async listProducts() {
    const flash = require("../services/flash-service");
    return { products: await flash.listAccountProducts() };
  }
});

// ---------------------------------------------------------------------------
// The interface core would use.
// ---------------------------------------------------------------------------
module.exports = {
  purchaseAirtime: (actor, request) => operation(CAPABILITIES.VAS, "purchaseAirtime")(actor, request),
  purchaseData: (actor, request) => operation(CAPABILITIES.VAS, "purchaseData")(actor, request),
  purchaseElectricity: (actor, request) => operation(CAPABILITIES.VAS, "purchaseElectricity")(actor, request),
  listVasProducts: () => operation(CAPABILITIES.VAS, "listProducts")(),
  vasCapabilityConfigured: () => capabilityConfigured(CAPABILITIES.VAS),
  // Can TitoPay actually sell any of this today? Read by the service catalogue
  // so a rail that cannot transact is never published to a customer as one
  // that can. Defaults to false for an unwired capability, so the failure mode
  // is a service that is not offered rather than one that is offered and then
  // refuses at the till.
  vasCanPurchase: () => Boolean(providerAttribute(CAPABILITIES.VAS, "canPurchase", false))
};
