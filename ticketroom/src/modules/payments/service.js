const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { getProvider } = require("./providers");
const { AppError, notFound } = require("../../lib/errors");

// Opens a hosted checkout for an initiated payment.
async function start(payment, { description, returnPath }) {
  const provider = getProvider(payment.provider);
  try {
    const { providerReference, redirectUrl } = await provider.createCheckout({
      payment, description,
      returnUrl: `${config.publicBaseUrl}${returnPath}`,
      cancelUrl: `${config.publicBaseUrl}${returnPath}`,
      notifyUrl: `${config.publicBaseUrl}/api/webhooks/${payment.provider}`,
    });
    const { rows } = await db.query(
      "UPDATE payments SET provider_reference = $2, status = 'pending', updated_at = now() WHERE id = $1 AND status = 'initiated' RETURNING *",
      [payment.id, providerReference]);
    return { ...(rows[0] || payment), redirectUrl };
  } catch (err) {
    await db.query("UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'initiated'", [payment.id, `checkout: ${String(err.message).slice(0, 200)}`]);
    throw new AppError(502, "provider_unavailable", "We could not reach the payment provider. Nothing was charged. Please try again.");
  }
}

// Applies a provider outcome. Idempotent: a duplicate "succeeded" is a no-op.
// Returns 'confirmed' | 'duplicate' | 'failed' | 'cancelled' | 'mismatch' | 'ignored'.
async function apply(providerName, reference, outcome, amountCents) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM payments WHERE provider = $1 AND provider_reference = $2 FOR UPDATE", [providerName, reference]);
    const p = rows[0];
    if (!p) throw new AppError(404, "unknown_reference", "Unknown payment reference.");
    if (outcome === "paid") {
      if (["confirmed", "refunded", "partially_refunded"].includes(p.status)) return "duplicate";
      if (amountCents !== p.amount_cents) {
        await c.query("UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1", [p.id, `amount mismatch: provider ${amountCents}, expected ${p.amount_cents}`]);
        await audit.record(c, { action: "payment.amount_mismatch", entityType: "payment", entityId: p.id, details: { reference, providerAmount: amountCents, expected: p.amount_cents } });
        return "mismatch";
      }
      await c.query("UPDATE payments SET status = 'confirmed', confirmed_at = now(), failure_reason = NULL, updated_at = now() WHERE id = $1", [p.id]);
      if (p.purpose === "order") await require("../orders/service").fulfil(c, p.order_id, p);
      else await require("../cashless/service").confirmTopup(c, p);
      await audit.record(c, { action: "payment.confirmed", entityType: "payment", entityId: p.id, details: { reference, amount: p.amount_cents } });
      return "confirmed";
    }
    if (outcome === "failed" || outcome === "cancelled") {
      if (["confirmed", "refunded", "partially_refunded"].includes(p.status)) {
        await audit.record(c, { action: "payment.conflicting_outcome", entityType: "payment", entityId: p.id, details: { reference, outcome } });
        return "ignored";
      }
      await c.query("UPDATE payments SET status = $2, updated_at = now() WHERE id = $1", [p.id, outcome]);
      if (p.purpose === "topup") await c.query("UPDATE wallet_topups SET status = $2 WHERE id = $1 AND status = 'pending'", [p.topup_id, outcome === "failed" ? "failed" : "cancelled"]);
      return outcome;
    }
    return "ignored";
  });
}

// Webhook entry point: verify, store, de-duplicate, apply.
async function handleWebhook(providerName, rawBody, headers) {
  const provider = getProvider(providerName);
  let evt;
  try {
    evt = provider.verifyWebhook(rawBody, headers);
  } catch (err) {
    await db.query(
      `INSERT INTO webhook_events (provider, provider_event_id, signature_valid, payload, status, error)
       VALUES ($1, 'rejected:' || gen_random_uuid(), false, $2, 'rejected', $3)`,
      [providerName, { size: rawBody.length }, String(err.message).slice(0, 200)]);
    throw err instanceof AppError ? err : new AppError(400, "bad_webhook", "Invalid webhook.");
  }
  const ins = await db.query(
    `INSERT INTO webhook_events (provider, provider_event_id, signature_valid, payload) VALUES ($1,$2,true,$3)
     ON CONFLICT (provider, provider_event_id) DO UPDATE SET attempts = webhook_events.attempts + 1
     RETURNING id, status, (xmax <> 0) AS existed`, [providerName, evt.id, JSON.parse(rawBody)]);
  const row = ins.rows[0];
  if (row.existed && ["processed", "ignored"].includes(row.status)) return { duplicate: true };

  const outcome = { "payment.succeeded": "paid", "payment.failed": "failed", "payment.cancelled": "cancelled" }[evt.type];
  try {
    const result = outcome ? await apply(providerName, evt.reference, outcome, evt.amountCents) : "ignored";
    await db.query("UPDATE webhook_events SET status = $2, processed_at = now(), error = NULL WHERE id = $1", [row.id, result === "ignored" ? "ignored" : "processed"]);
    return { result };
  } catch (err) {
    await db.query("UPDATE webhook_events SET status = 'failed', error = $2 WHERE id = $1", [row.id, String(err.message).slice(0, 300)]);
    throw err;
  }
}

// Asks the provider directly. Used before expiring an order, by the admin
// "re-check" action, and by reconciliation — never trusts the browser.
async function syncStatus(paymentId) {
  const { rows } = await db.query("SELECT * FROM payments WHERE id = $1", [paymentId]);
  const p = rows[0];
  if (!p) throw notFound("Payment not found.");
  if (!p.provider_reference) return p.status;
  const status = await getProvider(p.provider).fetchStatus(p.provider_reference);
  if (status.status === "paid") return apply(p.provider, p.provider_reference, "paid", status.amountCents);
  if (status.status === "failed" || status.status === "cancelled") return apply(p.provider, p.provider_reference, status.status);
  return p.status;
}

module.exports = { start, apply, handleWebhook, syncStatus };
