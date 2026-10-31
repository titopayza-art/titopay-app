// Client for the TitoPay Partner API (wallet linking and wallet payments).
// Auth: HTTP Basic with the partner client id/secret issued by TitoPay.
// Writes carry an Idempotency-Key. Contract: docs/TITOPAY-PARTNER-API.md.
const config = require("../../config");
const http = require("../../lib/http");
const { AppError } = require("../../lib/errors");

const c = () => config.integrations.titopay;

async function request(operation, method, path, json, { idempotencyKey } = {}) {
  if (!c().enabled) throw new AppError(503, "titopay_disabled", "TitoPay wallet is not available right now.");
  const headers = { authorization: `Basic ${Buffer.from(`${c().clientId}:${c().clientSecret}`).toString("base64")}` };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const r = await http.call({ integration: "titopay", environment: c().env, operation, url: `${c().baseUrl}${path}`, method, headers, json, timeoutMs: c().timeoutMs });
  if (!r.ok) {
    const code = r.body?.error?.code || `titopay_${r.status}`;
    const message = r.body?.error?.message || `TitoPay could not complete the request (${r.status}).`;
    throw new AppError(r.status >= 500 ? 502 : 409, code, message);
  }
  return r.body;
}

// Start linking: TitoPay sends a one-time code to the wallet holder.
const startLink = (msisdn, partnerUserRef) => request("link_start", "POST", "/v1/partner/wallet-links/requests", { msisdn, partnerUserRef });
const confirmLink = (requestId, otp) => request("link_confirm", "POST", `/v1/partner/wallet-links/requests/${encodeURIComponent(requestId)}/confirm`, { otp });
const revokeLink = (walletToken) => request("link_revoke", "POST", "/v1/partner/wallet-links/revoke", { walletToken });

async function health() {
  if (!c().enabled) return { ok: false, detail: "disabled (TITOPAY_WALLET_ENABLED=false)" };
  try { const r = await request("health", "GET", "/v1/partner/health"); return { ok: true, detail: `${r.status || "ok"} (${c().env} at ${c().baseUrl})` }; }
  catch (err) { return { ok: false, detail: err.message }; }
}

module.exports = { request, startLink, confirmLink, revokeLink, health };
