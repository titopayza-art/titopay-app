"use strict";

// PAYOUT: money leaving a TitoPay wallet for a bank account.
//
// Core asks whether the payout capability is available, and asks it to
// `processPayout()`. It never asks whether a particular company's payout
// service is reachable, which is what `transaction-service` and the payouts
// route used to do by name.
//
// The withdrawal lifecycle this wraps already carries the money-safety
// controls, and they stay where they are: an idempotency key is REQUIRED on
// every withdrawal, the request is taken under an advisory lock keyed on that
// key, funds are reserved before the provider is called, and a provider
// timeout leaves the withdrawal pending for reconciliation instead of being
// resubmitted. None of that is the adapter's to relax.

const { registerProvider, operation, CAPABILITIES, capabilityConfigured } = require("./index");
const payouts = require("../services/peach-payout-service");
const withdrawals = require("../services/peach-withdrawal-service");

// ---------------------------------------------------------------------------
// Adapter: Peach Payments Payouts.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.PAYOUT,
  key: "peach_payouts",
  isDefault: true,
  disclosureName: "Peach Payments",

  async payoutAvailability(storedHealthStatus) {
    return payouts.payoutAvailability(storedHealthStatus);
  },
  assertPayoutAvailable(availability) {
    return payouts.assertPayoutAvailable(availability);
  },
  async processPayout(actor, request) {
    return withdrawals.createWithdrawal(actor, request);
  },
  async getPayoutStatus(actor, reference) {
    return withdrawals.getWithdrawalStatus(actor, reference);
  },
  async listRecentPayouts(actor, limit) {
    return withdrawals.listRecentWithdrawals(actor, limit);
  },
  // The banks and account types a payout can be made to. Provider-shaped
  // reference data, so it belongs behind the adapter rather than in a route.
  supportedBanks() {
    return payouts.SUPPORTED_BANKS;
  }
});

// ---------------------------------------------------------------------------
// The interface core uses.
// ---------------------------------------------------------------------------
module.exports = {
  payoutAvailability: (storedHealthStatus) =>
    operation(CAPABILITIES.PAYOUT, "payoutAvailability")(storedHealthStatus),
  assertPayoutAvailable: (availability) =>
    operation(CAPABILITIES.PAYOUT, "assertPayoutAvailable")(availability),
  processPayout: (actor, request) => operation(CAPABILITIES.PAYOUT, "processPayout")(actor, request),
  getPayoutStatus: (actor, reference) => operation(CAPABILITIES.PAYOUT, "getPayoutStatus")(actor, reference),
  listRecentPayouts: (actor, limit) => operation(CAPABILITIES.PAYOUT, "listRecentPayouts")(actor, limit),
  payoutCapabilityConfigured: () => capabilityConfigured(CAPABILITIES.PAYOUT)
};
