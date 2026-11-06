// Yoco Checkout API adapter (card payments).
// Implemented from Yoco's public Checkout API conventions:
//   POST {base}/api/checkouts  (Bearer secret key, Idempotency-Key)  -> { id, redirectUrl }
//   webhooks signed Standard-Webhooks style: headers webhook-id, webhook-timestamp,
//   webhook-signature "v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>", secret "whsec_<base64>"
//   POST {base}/api/checkouts/{id}/refund (Idempotency-Key)
// STATUS: tested against the local mock only. Verify every call against Yoco's
// sandbox (sk_test_ keys) before going live — see docs/INTEGRATIONS.md.
const crypto = require("crypto");
const config = require("../../../config");
const http = require("../../../lib/http");
const { AppError } = require("../../../lib/errors");

const c = () => config.integrations.yoco;
const capabilities = { refunds: true, statusQuery: true, redirect: true };
const name = "yoco";
const environmentOf = () => c().env;

const auth = () => ({ authorization: `Bearer ${c().secretKey}` });
const call = (operation, opts) => http.call({ integration: "yoco", environment: c().env, operation, ...opts });

async function createCheckout({ payment, returnUrl, cancelUrl }) {
  const r = await call("create_checkout", {
    url: `${c().baseUrl}/api/checkouts`, method: "POST", headers: { ...auth(), "idempotency-key": payment.id },
    json: { amount: payment.amount_cents, currency: "ZAR", successUrl: returnUrl, cancelUrl, failureUrl: returnUrl, metadata: { ticketroomPaymentId: payment.id } },
  });
  if (!r.ok || !r.body?.id || !r.body?.redirectUrl) throw new AppError(502, "provider_refused", `Yoco: checkout not created (${r.status})`);
  return { providerReference: r.body.id, redirectUrl: r.body.redirectUrl };
}

const STATUS = { completed: "paid", succeeded: "paid", failed: "failed", cancelled: "cancelled", expired: "cancelled", created: "pending", started: "pending", processing: "pending" };
async function fetchStatus(ref) {
  try {
    const r = await call("get_checkout", { url: `${c().baseUrl}/api/checkouts/${encodeURIComponent(ref)}`, headers: auth() });
    if (!r.ok) return { status: "unknown" };
    return { status: STATUS[r.body?.status] || "unknown", amountCents: r.body?.amount };
  } catch { return { status: "unknown" }; }
}

function verifyWebhook(raw, headers) {
  const id = headers["webhook-id"], ts = Number(headers["webhook-timestamp"]), sigs = String(headers["webhook-signature"] || "");
  if (!id || !ts || !sigs) throw new AppError(400, "bad_signature", "Missing webhook signature headers.");
  if (Math.abs(Date.now() / 1000 - ts) > config.payments.webhookToleranceSeconds) throw new AppError(400, "stale_signature", "Signature timestamp outside tolerance.");
  const secret = Buffer.from(String(c().webhookSecret).replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", secret).update(`${id}.${ts}.${raw}`).digest("base64");
  const ok = sigs.split(" ").some((part) => {
    const [, sig] = part.split(",");
    return sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!ok) throw new AppError(400, "bad_signature", "Signature mismatch.");
  const body = JSON.parse(raw);
  const p = body.payload || {};
  return { id: body.id || id, type: body.type, reference: p.metadata?.checkoutId, amountCents: p.amount };
}

async function refund({ providerReference, amountCents, idempotencyKey }) {
  const r = await call("refund", {
    url: `${c().baseUrl}/api/checkouts/${encodeURIComponent(providerReference)}/refund`, method: "POST",
    headers: { ...auth(), "idempotency-key": idempotencyKey }, json: { amount: amountCents },
  });
  if (!r.ok) throw new AppError(502, "provider_refused", `Yoco: refund refused (${r.status})`);
  return { refundReference: r.body?.refundId || r.body?.id || idempotencyKey };
}

async function health() {
  const k = c().secretKey;
  if (!k) return { ok: false, detail: "YOCO_SECRET_KEY not set" };
  if (c().env === "live" && !k.startsWith("sk_live_")) return { ok: false, detail: "env is live but the key is not a live key" };
  if (c().env === "sandbox" && !k.startsWith("sk_test_")) return { ok: false, detail: "env is sandbox but the key is not a test key" };
  if (!c().webhookSecret) return { ok: false, detail: "YOCO_WEBHOOK_SECRET not set" };
  try {
    const r = await call("health", { url: `${c().baseUrl}/api/checkouts/ch_ticketroom_healthcheck`, headers: auth(), timeoutMs: 5000 });
    if (r.status === 401 || r.status === 403) return { ok: false, detail: "credentials rejected" };
    return { ok: true, detail: `reachable (HTTP ${r.status})` };
  } catch (err) { return { ok: false, detail: err.message }; }
}

module.exports = { name, get environment() { return environmentOf(); }, capabilities, createCheckout, fetchStatus, verifyWebhook, refund, health };
