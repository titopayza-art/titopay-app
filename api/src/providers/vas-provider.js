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
