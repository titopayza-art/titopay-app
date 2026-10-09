// Payment provider adapter registry.
//
// Adapter contract (implement only what the provider documents):
//   name, environment, capabilities: { refunds, statusQuery, redirect }
//   createCheckout({ payment, description, returnUrl, cancelUrl, notifyUrl, walletToken })
//       -> { providerReference, redirectUrl | null, immediateOutcome? }
//   fetchStatus(ref)          -> { status: 'paid'|'pending'|'failed'|'cancelled'|'unknown', amountCents }
//   verifyWebhook(raw, headers) (may be async)
//       -> { id, type: 'payment.succeeded'|'payment.failed'|'payment.cancelled'|other, reference, amountCents }
//   refund({ providerReference, amountCents, idempotencyKey }) -> { refundReference }   (if capabilities.refunds)
//   settlementReport({ from, to }) -> [{ reference, amountCents, refundedCents, feeCents, status }]   (optional)
//   health() -> { ok, detail }
//
// Card gateways: simulated | yoco | payfast   (PAYMENT_PROVIDER)
// Wallet:        titopay                       (TITOPAY_WALLET_ENABLED)
const config = require("../../../config");

const registry = {
  none: () => require("./none"),
  simulated: () => require("./simulated"),
  yoco: () => require("./yoco"),
  payfast: () => require("./payfast"),
  titopay: () => require("./titopay"),
};

function getProvider(name = config.payments.provider) {
  const factory = registry[name];
  if (!factory) throw new Error(`payment provider "${name}" is not installed`);
  if (name === "simulated" && !config.payments.allowSimulated) throw new Error("simulated provider is disabled in this environment");
  if (name === "titopay" && !config.integrations.titopay.enabled) throw new Error("TitoPay wallet payments are not enabled");
  return factory();
}

// Which provider handles a payment method.
const providerForMethod = (method) => (method === "titopay_wallet" ? "titopay" : config.payments.provider);

const installed = () => Object.keys(registry);

const cardPaymentsEnabled = () => config.payments.provider !== "none";

module.exports = { getProvider, providerForMethod, installed, cardPaymentsEnabled };
