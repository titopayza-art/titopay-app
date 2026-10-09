// "No payment gateway configured yet." Paid checkouts are refused up front
// (before any stock is reserved); free tickets and the rest of the platform work.
const { AppError } = require("../../../lib/errors");

const refuse = () => { throw new AppError(503, "payments_not_configured", "Card payments are not switched on yet. Free tickets are available; paid tickets go on sale soon."); };
module.exports = {
  name: "none", environment: "off", capabilities: { refunds: false, statusQuery: false, redirect: false },
  createCheckout: refuse, verifyWebhook: refuse, refund: refuse,
  fetchStatus: async () => ({ status: "unknown" }),
  health: async () => ({ ok: false, detail: "No card payment gateway configured (PAYMENT_PROVIDER=none). Set up Yoco or PayFast to sell paid tickets." }),
};
