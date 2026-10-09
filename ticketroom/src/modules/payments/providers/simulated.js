// SIMULATED payment provider. Behaves like a hosted-checkout provider: it owns
// its own transaction records (schema sim_provider), redirects the buyer to a
// hosted page, and notifies TicketRoom by a signed webhook. No money moves.
const crypto = require("crypto");
const config = require("../../../config");
const db = require("../../../lib/db");
const { randomCode, safeEqual } = require("../../../lib/crypto");
const { AppError } = require("../../../lib/errors");

const NAME = "simulated";

function sign(raw, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", Buffer.from(config.payments.simWebhookSecret, "hex")).update(`${t}.${raw}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function createCheckout({ payment, description, returnUrl, notifyUrl }) {
  const reference = `SIM-${randomCode(12)}`;
  await db.query(
    `INSERT INTO sim_provider.transactions (reference, merchant_ref, amount_cents, notify_url, return_url, description)
     VALUES ($1,$2,$3,$4,$5,$6)`, [reference, payment.id, payment.amount_cents, notifyUrl, returnUrl, description || null]);
  return { providerReference: reference, redirectUrl: `${config.publicBaseUrl}/sim/pay/${reference}` };
}

async function fetchStatus(reference) {
  const { rows } = await db.query("SELECT status, amount_cents FROM sim_provider.transactions WHERE reference = $1", [reference]);
  if (!rows[0]) return { status: "unknown" };
  return { status: rows[0].status, amountCents: rows[0].amount_cents };
}

function verifyWebhook(raw, headers) {
  const header = String(headers["x-sim-signature"] || "");
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new AppError(400, "bad_signature", "Missing signature.");
  if (Math.abs(Date.now() / 1000 - t) > config.payments.webhookToleranceSeconds) throw new AppError(400, "stale_signature", "Signature timestamp outside tolerance.");
  const expected = sign(raw, t).split("v1=")[1];
  if (!safeEqual(expected, parts.v1)) throw new AppError(400, "bad_signature", "Signature mismatch.");
  const body = JSON.parse(raw);
  return { id: body.id, type: body.type, reference: body.data?.reference, amountCents: body.data?.amount_cents };
}

async function refund({ providerReference, amountCents, idempotencyKey }) {
  return db.withTx(async (c) => {
    const prior = await c.query("SELECT reference FROM sim_provider.refunds WHERE idempotency_key = $1", [idempotencyKey]);
    if (prior.rows[0]) return { refundReference: prior.rows[0].reference };
    const { rows } = await c.query("SELECT * FROM sim_provider.transactions WHERE reference = $1 FOR UPDATE", [providerReference]);
    const tx = rows[0];
    if (!tx || tx.status !== "paid") throw new AppError(502, "provider_refused", "Provider: transaction is not refundable.");
    if (tx.refunded_cents + amountCents > tx.amount_cents) throw new AppError(502, "provider_refused", "Provider: refund exceeds the captured amount.");
    const ref = `SIMR-${randomCode(10)}`;
    await c.query("INSERT INTO sim_provider.refunds (reference, transaction_ref, amount_cents, idempotency_key) VALUES ($1,$2,$3,$4)", [ref, providerReference, amountCents, idempotencyKey]);
    await c.query("UPDATE sim_provider.transactions SET refunded_cents = refunded_cents + $2 WHERE reference = $1", [providerReference, amountCents]);
    return { refundReference: ref };
  });
}

async function settlementReport({ from, to }) {
  const { rows } = await db.query(
    `SELECT reference, amount_cents, refunded_cents, status FROM sim_provider.transactions
      WHERE created_at >= $1 AND created_at < $2 AND status IN ('paid','failed','cancelled')`, [from, to]);
  return rows.map((r) => ({ reference: r.reference, amountCents: r.amount_cents, refundedCents: r.refunded_cents, feeCents: 0, status: r.status }));
}

// --- simulator-only operations used by the hosted test page and tests ---
async function complete(reference, outcome, { sendWebhook = true } = {}) {
  const status = outcome === "approve" ? "paid" : outcome === "cancel" ? "cancelled" : "failed";
  const { rows } = await db.query(
    `UPDATE sim_provider.transactions SET status = $2, completed_at = now()
      WHERE reference = $1 AND status = 'pending' RETURNING *`, [reference, status]);
  const tx = rows[0];
  if (!tx) return null;
  if (sendWebhook) await deliverWebhook(tx).catch((e) => console.warn("[sim] webhook delivery failed:", e.message));
  return tx;
}

function webhookBody(tx, id = `evt_${randomCode(14)}`) {
  const type = tx.status === "paid" ? "payment.succeeded" : tx.status === "cancelled" ? "payment.cancelled" : "payment.failed";
  return JSON.stringify({ id, type, data: { reference: tx.reference, amount_cents: tx.amount_cents, merchant_ref: tx.merchant_ref } });
}

async function deliverWebhook(tx, id) {
  const raw = webhookBody(tx, id);
  const res = await fetch(tx.notify_url, { method: "POST", headers: { "content-type": "application/json", "x-sim-signature": sign(raw) }, body: raw });
  return res.status;
}

module.exports = { name: NAME, createCheckout, fetchStatus, verifyWebhook, refund, settlementReport, complete, sign, webhookBody, deliverWebhook };
