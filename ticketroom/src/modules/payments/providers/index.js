// Payment provider adapter registry.
//
// An adapter implements only the operations its provider documents:
//   createCheckout({ payment, description, returnUrl, cancelUrl, notifyUrl }) -> { providerReference, redirectUrl }
//   fetchStatus(providerReference) -> { status: 'paid'|'pending'|'failed'|'cancelled', amountCents }
//   verifyWebhook(rawBody, headers) -> { id, type, reference, amountCents } | throws
//   refund({ providerReference, amountCents, idempotencyKey }) -> { refundReference }
//   settlementReport({ from, to }) -> [{ reference, amountCents, refundedCents, feeCents, status }]
//
// Only the SIMULATED provider is installed. TitoPay's live provider
// integration lives in the TitoPay API, which is not in this repository; it
// must be wired in as a new adapter once its documentation and sandbox
// credentials are available (docs/INTEGRATIONS.md).
const config = require("../../../config");

const registry = {
  simulated: () => require("./simulated"),
};

function getProvider(name = config.payments.provider) {
  const factory = registry[name];
  if (!factory) throw new Error(`payment provider "${name}" is not installed`);
  if (name === "simulated" && !config.payments.allowSimulated) throw new Error("simulated provider is disabled in this environment");
  return factory();
}

module.exports = { getProvider };
