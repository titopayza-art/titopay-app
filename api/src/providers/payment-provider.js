"use strict";

// PAYMENT: money coming IN to a TitoPay wallet.
//
// Core asks for `processPayment()`. It does not ask for a card page, a
// checkout id, an acquirer or a company. Everything below the interface is one
// adapter's business.
//
// MONEY SAFETY IS NOT THE ADAPTER'S TO INVENT. Two rules hold whoever supplies
// the capability, and both are enforced in the lifecycle this wraps rather
// than here:
//
//   1. A wallet is credited in exactly ONE place, and only after this server
//      has independently asked the provider what happened. A browser redirect,
//      a success URL, a webhook body or anything the app claims is never
//      enough on its own.
//   2. A TIMEOUT IS NOT A FAILURE. If a provider does not answer, the payment
//      may still have been taken. The transaction stays in its pending state
//      and is resolved by asking the provider again. It is never retried as a
//      fresh payment, because that is how a customer gets charged twice.

const { registerProvider, operation, CAPABILITIES, capabilityConfigured } = require("./index");
const checkout = require("../services/peach-checkout-service");

// ---------------------------------------------------------------------------
// Adapter: Peach Payments Checkout V2. This file is allowed to know the name;
// nothing that calls the interface below is.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.PAYMENT,
  key: "peach_checkout",
  isDefault: true,
  // The one place the provider's name is allowed to travel towards a screen,
  // and only because a payment page the customer is redirected to has to be
  // identified to them before they are sent there. It is a disclosure, not a
  // label the rest of the app is built on.
  disclosureName: "Peach Payments",
  supports: ["card", "eft_reference"],

  async processPayment(actor, request) {
    return checkout.createTopupCheckout(actor, request);
  },
  async getPaymentStatus(actor, reference) {
    return checkout.getTopupStatus(actor, reference);
  },
  async listRecentPayments(actor, limit) {
    return checkout.listRecentTopups(actor, limit);
  }
});

// ---------------------------------------------------------------------------
// The interface core uses.
// ---------------------------------------------------------------------------
module.exports = {
  processPayment: (actor, request) => operation(CAPABILITIES.PAYMENT, "processPayment")(actor, request),
  getPaymentStatus: (actor, reference) => operation(CAPABILITIES.PAYMENT, "getPaymentStatus")(actor, reference),
  listRecentPayments: (actor, limit) => operation(CAPABILITIES.PAYMENT, "listRecentPayments")(actor, limit),
  paymentCapabilityConfigured: () => capabilityConfigured(CAPABILITIES.PAYMENT)
};
