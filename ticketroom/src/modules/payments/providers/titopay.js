// TitoPay wallet as a payment method. TicketRoom is independent infrastructure:
// it reaches TitoPay only through the TitoPay Partner API described in
// docs/TITOPAY-PARTNER-API.md. Until TitoPay publishes that API, development
// and tests run against the mock (scripts/mock-services.js, TITOPAY_ENV=mock).
const crypto = require("crypto");
const config = require("../../../config");
const client = require("../../titopay/client");
const { AppError } = require("../../../lib/errors");

const name = "titopay";
const capabilities = { refunds: true, statusQuery: true, redirect: false };
const c = () => config.integrations.titopay;

const STATUS = { completed: "paid", pending_approval: "pending", declined: "failed", expired: "cancelled", cancelled: "cancelled" };

async function createCheckout({ payment, description, notifyUrl, walletToken }) {
  if (!walletToken) throw new AppError(409, "wallet_not_linked", "Link your TitoPay wallet first.");
  const r = await client.request("create_payment", "POST", "/v1/partner/payments", {
    walletToken, amountCents: payment.amount_cents, currency: "ZAR", merchantReference: payment.id, description, callbackUrl: notifyUrl,
  }, { idempotencyKey: payment.id });
  return { providerReference: r.paymentId, redirectUrl: null, immediateOutcome: STATUS[r.status] };
}

async function fetchStatus(ref) {
  try {
    const r = await client.request("get_payment", "GET", `/v1/partner/payments/${encodeURIComponent(ref)}`);
    return { status: STATUS[r.status] || "unknown", amountCents: r.amountCents };
  } catch { return { status: "unknown" }; }
}

const TYPES = { "payment.completed": "payment.succeeded", "payment.declined": "payment.failed", "payment.expired": "payment.cancelled", "payment.cancelled": "payment.cancelled" };
function verifyWebhook(raw, headers) {
  const header = String(headers["x-titopay-signature"] || "");
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new AppError(400, "bad_signature", "Missing signature.");
  if (Math.abs(Date.now() / 1000 - t) > config.payments.webhookToleranceSeconds) throw new AppError(400, "stale_signature", "Signature timestamp outside tolerance.");
  const expected = crypto.createHmac("sha256", c().webhookSecret).update(`${t}.${raw}`).digest("hex");
  if (expected.length !== parts.v1.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) throw new AppError(400, "bad_signature", "Signature mismatch.");
  const body = JSON.parse(raw);
  return { id: body.id, type: TYPES[body.type] || body.type, reference: body.data?.paymentId, amountCents: body.data?.amountCents };
}

async function refund({ providerReference, amountCents, idempotencyKey }) {
  const r = await client.request("refund", "POST", `/v1/partner/payments/${encodeURIComponent(providerReference)}/refunds`, { amountCents }, { idempotencyKey });
  return { refundReference: r.refundId };
}

async function settlementReport({ from, to }) {
  const r = await client.request("settlements", "GET", `/v1/partner/settlements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  return (r.transactions || []).map((t) => ({ reference: t.paymentId, amountCents: t.amountCents, refundedCents: t.refundedCents || 0, feeCents: t.feeCents || 0, status: STATUS[t.status] === "paid" ? "paid" : STATUS[t.status] || t.status }));
}

const health = () => client.health();

module.exports = { name, get environment() { return c().env; }, capabilities, createCheckout, fetchStatus, verifyWebhook, refund, settlementReport, health };
