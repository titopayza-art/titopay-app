// TicketRoom SANDBOX: TicketRoom's own practice payment page (/pay?m=sandbox).
// No provider account and nothing real: the buyer chooses what the "bank"
// answers (approve, decline or cancel) and the answer goes through exactly the
// same path as a real provider's notification. Always test mode, never live:
// its orders are test orders, their tickets never open a gate and their money
// is booked to "test:" ledger accounts.
const { signLink } = require("../../../lib/crypto");
const { AppError } = require("../../../lib/errors");

const name = "sandbox";
const environment = "test";
const capabilities = { refunds: true, statusQuery: false, redirect: true };

// The redirect is relative: TicketRoom's own page, on whatever host the buyer
// is using. The short-lived key lets a guest (no session) open it too.
async function createCheckout({ payment }) {
  const key = signLink({ p: payment.id }, 3600);
  return { providerReference: payment.id, redirectUrl: `/pay?p=${payment.id}&m=sandbox&k=${encodeURIComponent(key)}` };
}

const fetchStatus = async () => ({ status: "unknown" });

// Nobody outside TicketRoom ever notifies about a sandbox payment.
function verifyWebhook() { throw new AppError(400, "bad_webhook", "The sandbox has no webhooks."); }

// Sandbox money goes back at once: there is nobody to ask.
async function refund({ reference, idempotencyKey }) {
  return { refundReference: `SANDBOX-${reference || String(idempotencyKey || "").replace(/^refund:/, "")}` };
}

const health = async () => ({ ok: true, detail: "The sandbox is ready. Buyers see a practice payment page and choose the outcome. No money moves and every ticket is marked TEST, which the gate refuses." });

module.exports = { name, environment, capabilities, createCheckout, fetchStatus, verifyWebhook, refund, health };
