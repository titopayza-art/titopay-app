// PayFast adapter (card / EFT / SnapScan etc. via PayFast's hosted page).
// Implemented from PayFast's documented redirect + ITN flow:
//   - The buyer's browser POSTs a signed form to {sandbox|www}.payfast.co.za/eng/process
//   - signature = md5 of the non-empty fields, in form order, "key=urlencode(value)"
//     joined by "&", plus "&passphrase=…"; urlencode is PHP-style (spaces as "+")
//   - ITN (form-encoded POST to notify_url): verify signature, compare amount,
//     then post the fields back to /eng/query/validate and expect "VALID".
// Refunds are NOT automated in this adapter: finance completes them in the
// PayFast dashboard and records the reference (refund status manual_pending).
// STATUS: tested against the local mock only — verify in the PayFast sandbox.
const crypto = require("crypto");
const config = require("../../../config");
const http = require("../../../lib/http");
const { AppError } = require("../../../lib/errors");

const c = () => config.integrations.payfast;
const name = "payfast";
const capabilities = { refunds: false, statusQuery: false, redirect: true };

// PHP urlencode(): RFC 3986 encoding, but spaces as "+" and !'()*~ escaped.
const phpEncode = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+").replace(/[!'()*~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

function paramString(entries, withPassphrase = true) {
  const parts = entries.filter(([k, v]) => k !== "signature" && v !== undefined && v !== null && String(v) !== "").map(([k, v]) => `${k}=${phpEncode(v)}`);
  if (withPassphrase && c().passphrase) parts.push(`passphrase=${phpEncode(c().passphrase)}`);
  return parts.join("&");
}
const sign = (entries) => crypto.createHash("md5").update(paramString(entries)).digest("hex");

// Fields in PayFast's documented order.
function formFields(payment, ctx, buyer) {
  const [first, ...rest] = String(buyer.full_name || "").split(" ");
  const entries = [
    ["merchant_id", c().merchantId], ["merchant_key", c().merchantKey],
    ["return_url", ctx.returnUrl], ["cancel_url", ctx.cancelUrl], ["notify_url", ctx.notifyUrl],
    ["name_first", first], ["name_last", rest.join(" ")], ["email_address", buyer.email],
    ["m_payment_id", payment.id], ["amount", (payment.amount_cents / 100).toFixed(2)], ["item_name", String(ctx.description || "TicketRoom").slice(0, 100)],
  ];
  return [...entries.filter(([, v]) => v !== undefined && v !== null && String(v) !== ""), ["signature", sign(entries)]];
}

// The redirect goes to TicketRoom's own page, which renders the signed form.
async function createCheckout({ payment }) {
  if (!c().merchantId || !c().merchantKey) throw new AppError(502, "provider_not_configured", "PayFast is not configured.");
  return { providerReference: payment.id, redirectUrl: `${config.publicBaseUrl}/pay/payfast/${payment.id}` };
}

const fetchStatus = async () => ({ status: "unknown" });

const STATUS = { COMPLETE: "payment.succeeded", FAILED: "payment.failed", CANCELLED: "payment.cancelled" };
async function verifyWebhook(raw) {
  const entries = [...new URLSearchParams(raw).entries()];
  const fields = Object.fromEntries(entries);
  if (!fields.signature || !fields.m_payment_id) throw new AppError(400, "bad_signature", "Missing ITN fields.");
  const expected = sign(entries);
  if (expected.length !== fields.signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(fields.signature))) throw new AppError(400, "bad_signature", "ITN signature mismatch.");
  if (fields.merchant_id !== c().merchantId) throw new AppError(400, "bad_merchant", "ITN for another merchant.");
  // Server-to-server confirmation that PayFast really sent this ITN.
  const v = await http.call({ integration: "payfast", environment: c().env, operation: "itn_validate", url: c().validateUrl, method: "POST", form: paramString(entries, false), headers: { accept: "text/plain" } });
  if (!v.ok || v.text.trim() !== "VALID") throw new AppError(400, "itn_not_valid", "PayFast did not confirm this ITN.");
  return { id: `${fields.pf_payment_id}:${fields.payment_status}`, type: STATUS[fields.payment_status] || `payfast.${fields.payment_status}`, reference: fields.m_payment_id, amountCents: Math.round(Number(fields.amount_gross) * 100) };
}

async function health() {
  const missing = ["merchantId", "merchantKey", "passphrase"].filter((k) => !c()[k]);
  if (missing.length) return { ok: false, detail: `not set: ${missing.join(", ")}` };
  return { ok: true, detail: `configured for ${c().env} (${c().processUrl}). Refunds are manual.` };
}

module.exports = { name, get environment() { return c().env; }, capabilities, createCheckout, fetchStatus, verifyWebhook, health, formFields, sign, paramString, phpEncode };
