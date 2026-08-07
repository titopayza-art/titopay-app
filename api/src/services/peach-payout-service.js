"use strict";

// Peach Payments — PAYOUT / WITHDRAWAL (money OUT).
//
// A separate Peach capability from Collection/Checkout, with its own base URL,
// its own credentials and its own connection test. It shares nothing with the
// Collection module except the documented OAuth request shape, and it reads its
// configuration from a different platform_settings row so the two sets of
// credentials can never overwrite or borrow from each other.
//
// Reference: https://developer.peachpayments.com/docs/payouts-api-1
//
//   Authentication  live https://dashboard.peachpayments.com
//                sandbox https://sandbox-dashboard.peachpayments.com
//   Payouts         live https://payouts.peachpayments.com/api
//                sandbox https://sandbox-payouts.peachpayments.com/api
//
//   POST {auth}/api/oauth/token                                {clientId, clientSecret, merchantId}
//   GET  {payouts}/merchants/{merchantId}/balance              connection test (read-only)
//   POST {payouts}/merchants/{merchantId}/payouts              create payout request
//   GET  {payouts}/merchants/{merchantId}/payouts/{id}/status  query payout request
//
// Nothing here is enabled by the presence of the Admin form. A payout can only
// be submitted once the capability is configured, enabled and its connection
// test has actually succeeded.

const crypto = require("crypto");
const { AppError } = require("../lib/errors");
const { pool } = require("../db/pool");
const { loadPeachPayoutConfig, PAYOUT_SETTING_KEY } = require("./peach-config-service");

const DEFAULT_TIMEOUT_MS = 15000;
const OAUTH_TOKEN_PATH = "/api/oauth/token";
const TOKEN_EXPIRY_SKEW_MS = 30000;
const TOKEN_CACHE_LIMIT = 8;

const AUTH_SERVICE_URLS = {
  sandbox: "https://sandbox-dashboard.peachpayments.com",
  production: "https://dashboard.peachpayments.com"
};

// Documented defaults. The Admin field still wins, so the endpoint stays
// configurable and is never silently assumed when an operator set one.
const PAYOUT_SERVICE_URLS = {
  sandbox: "https://sandbox-payouts.peachpayments.com/api",
  production: "https://payouts.peachpayments.com/api"
};

// Payout access tokens live in their own cache, keyed by the payout credentials.
// A Collection token can never satisfy a payout call and vice versa.
const payoutTokenCache = new Map();

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function normalizeEnvironment(value) {
  const environment = trimmed(value).toLowerCase();
  if (["sandbox", "test", "testing", "staging"].includes(environment)) return "sandbox";
  if (["production", "live", "prod"].includes(environment)) return "production";
  return "sandbox";
}

function authServiceBaseUrl(environment, effective = {}) {
  const configured = trimmed(
    environment === "sandbox"
      ? effective.sandboxAuthUrl || process.env.PEACH_PAYOUTS_SANDBOX_AUTH_URL
      : effective.productionAuthUrl || process.env.PEACH_PAYOUTS_PRODUCTION_AUTH_URL
  );
  return (configured || AUTH_SERVICE_URLS[environment]).replace(/\/+$/, "");
}

function payoutBaseUrl(effective = {}) {
  const environment = normalizeEnvironment(effective.environment);
  const configured = trimmed(effective.baseUrl);
  const value = configured || PAYOUT_SERVICE_URLS[environment];
  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch (_error) {
    throw new AppError(400, "Peach payout base URL is invalid", { code: "PAYOUT_CONFIGURATION_INVALID" });
  }
  // The documented Payouts server is https://[sandbox-]payouts.peachpayments.com/api,
  // but the Dashboard shows the bare host, so that is what an operator pastes.
  // Add the path for a Peach host that has none; an explicit path is always
  // left exactly as entered.
  if (!url.pathname.replace(/\/+$/, "") && /(^|[.-])payouts\.peachpayments\.com$/i.test(url.hostname)) {
    url.pathname = "/api";
  }
  return url.toString().replace(/\/+$/, "");
}

function missingPayoutFields(effective = {}) {
  return ["baseUrl", "clientId", "clientSecret", "merchantId"].filter((field) => !trimmed(effective[field]));
}

function scrub(text, credentials = {}) {
  let value = String(text || "");
  for (const secret of [credentials.clientSecret, credentials.clientId, credentials.merchantId]) {
    if (secret && String(secret).length >= 4) value = value.split(secret).join("[redacted]");
  }
  return value.slice(0, 300);
}

function lastFour(value) {
  const text = trimmed(value);
  return text.length > 4 ? text.slice(-4) : "";
}

function cacheKey(effective, authEndpoint) {
  return crypto.createHash("sha256")
    .update(`payout|${authEndpoint}|${effective.clientId}|${effective.merchantId}|${effective.clientSecret}`)
    .digest("hex");
}

function cachedToken(key) {
  const entry = payoutTokenCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now()) {
    payoutTokenCache.delete(key);
    return null;
  }
  return entry.accessToken;
}

function storeToken(key, accessToken, expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  const ttlMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5 * 60 * 1000;
  if (payoutTokenCache.size >= TOKEN_CACHE_LIMIT) payoutTokenCache.delete(payoutTokenCache.keys().next().value);
  payoutTokenCache.set(key, { accessToken, expiresAt: Date.now() + ttlMs });
}

function clearPayoutTokenCache() {
  payoutTokenCache.clear();
}

// Peach's own wording distinguishes a bad Client ID/Secret from a bad Merchant
// ID, which the previous single message hid. It contains no credential, and it
// is passed through the scrubber before it is used, so quoting it is safe and
// is the difference between a debuggable failure and a dead end.
function payoutErrorFor(status, message, credentials = {}) {
  const raw = scrub(message, credentials);
  const lower = String(message || "").toLowerCase();
  const said = raw && raw.length <= 160 ? ` Peach said: "${raw.replace(/"/g, "'")}"` : "";
  // The status alone separates a rejected credential (400/401/403) from a wrong
  // endpoint (404), which is the first thing to check when a test fails.
  const because = `${Number.isFinite(status) ? ` [HTTP ${status}]` : ""}${said}`;
  if (status === 401 || status === 403) {
    return new AppError(502, `Authentication rejected by Peach Payouts (invalid Client ID, Client Secret or Merchant ID).${because}`, {
      code: "PAYOUT_AUTHENTICATION_REJECTED", providerStatus: status
    });
  }
  if (status === 400) {
    if (/client|secret|merchant|credential|unauthor/.test(lower)) {
      return new AppError(502, `Authentication rejected by Peach Payouts (invalid Client ID, Client Secret or Merchant ID).${because}`, {
        code: "PAYOUT_AUTHENTICATION_REJECTED", providerStatus: status
      });
    }
    return new AppError(502, `Peach Payouts rejected the request as invalid.${because}`, { code: "PAYOUT_CONFIGURATION_INVALID", providerStatus: status });
  }
  if (status === 404) {
    return new AppError(502, "The Peach payout endpoint was not found. Check the payout base URL and merchant ID.", {
      code: "PAYOUT_ENDPOINT_NOT_FOUND", providerStatus: status
    });
  }
  if (status === 429) return new AppError(502, "Peach Payouts rate limited the request", { code: "PAYOUT_RATE_LIMITED", providerStatus: status });
  if (status >= 500) return new AppError(502, "Peach Payouts is unavailable", { code: "PAYOUT_PROVIDER_UNAVAILABLE", providerStatus: status });
  return new AppError(502, `Peach Payouts request failed (HTTP ${status})`, { code: "PAYOUT_REQUEST_FAILED", providerStatus: status });
}

/* ----------------------------------------------------------- authentication */

async function requestPayoutAccessToken(effective, { timeoutMs = DEFAULT_TIMEOUT_MS, skipCache = false } = {}) {
  const environment = normalizeEnvironment(effective.environment);
  const missing = missingPayoutFields(effective);
  if (missing.length) {
    throw new AppError(503, "Peach payout is not configured", { code: "PAYOUT_NOT_CONFIGURED", missingFields: missing });
  }

  const authEndpoint = `${authServiceBaseUrl(environment, effective)}${OAUTH_TOKEN_PATH}`;
  const key = cacheKey(effective, authEndpoint);
  if (!skipCache) {
    const cached = cachedToken(key);
    if (cached) return { accessToken: cached, environment, authEndpoint, cached: true, statusCode: 200 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(authEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "TitoPay-PeachPayouts/1.0" },
      body: JSON.stringify({
        clientId: effective.clientId,
        clientSecret: effective.clientSecret,
        merchantId: effective.merchantId
      }),
      signal: controller.signal
    });
  } catch (error) {
    console.error("[peach-payout-auth] network failure", {
      environment, authEndpoint, durationMs: Date.now() - startedAt,
      reason: error?.name === "AbortError" ? "timeout" : scrub(error?.message, effective)
    });
    if (error?.name === "AbortError") throw new AppError(504, "Peach Payouts authentication timed out", { code: "PAYOUT_NETWORK_TIMEOUT" });
    throw new AppError(502, "Peach Payouts could not be reached", { code: "PAYOUT_NETWORK_ERROR" });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text().catch(() => "");
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }

  console.info("[peach-payout-auth] token request", {
    environment, authEndpoint, httpStatus: response.status, durationMs: Date.now() - startedAt,
    clientIdLast4: lastFour(effective.clientId), merchantIdLast4: lastFour(effective.merchantId),
    clientSecretConfigured: Boolean(effective.clientSecret),
    providerMessage: response.ok ? "" : scrub(payload?.message || payload?.error || raw, effective)
  });

  if (!response.ok) throw payoutErrorFor(response.status, payload?.message || payload?.error || raw, effective);

  const accessToken = trimmed(payload.access_token || payload.accessToken);
  if (!accessToken) throw new AppError(502, "Peach Payouts did not return an access token", { code: "PAYOUT_AUTHENTICATION_FAILED", providerStatus: response.status });

  storeToken(key, accessToken, payload.expires_in ?? payload.expiresIn);
  return {
    accessToken, environment, authEndpoint, cached: false, statusCode: response.status,
    expiresIn: Number(payload.expires_in ?? payload.expiresIn) || null,
    tokenType: trimmed(payload.token_type || payload.tokenType) || "Bearer"
  };
}

async function payoutRequest(effective, method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, skipCache = false } = {}) {
  const { accessToken } = await requestPayoutAccessToken(effective, { skipCache });
  const url = `${payoutBaseUrl(effective)}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "TitoPay-PeachPayouts/1.0",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new AppError(504, "Peach Payouts timed out", { code: "PAYOUT_NETWORK_TIMEOUT" });
    throw new AppError(502, "Peach Payouts could not be reached", { code: "PAYOUT_NETWORK_ERROR" });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text().catch(() => "");
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }

  if (!response.ok) {
    console.error("[peach-payout] request failed", {
      method, path, httpStatus: response.status,
      providerMessage: scrub(payload?.message || payload?.error || raw, effective)
    });
    throw payoutErrorFor(response.status, payload?.message || payload?.error || raw);
  }
  return { payload, statusCode: response.status };
}

/* -------------------------------------------------------- connection test */

// A real authenticated call against the PAYOUT endpoint with the PAYOUT
// credentials. It never falls back to Checkout authentication, and it reads a
// balance rather than moving money.
async function testPayoutConnection(effectiveOverride) {
  const effective = effectiveOverride || await loadPeachPayoutConfig({ refresh: true });
  const environment = normalizeEnvironment(effective.environment);

  const missing = missingPayoutFields(effective);
  if (missing.length) {
    return {
      ok: false,
      status: "not_configured",
      error: missing.includes("baseUrl")
        ? "Payout endpoint not configured"
        : `Peach payout configuration is incomplete: ${missing.join(", ")}`,
      errorCode: "PAYOUT_NOT_CONFIGURED",
      environment,
      capability: "payout",
      authenticationType: "oauth_client_credentials",
      providerResponse: { method: "GET", endpoint: trimmed(effective.baseUrl) || null, statusCode: null, missingFields: missing }
    };
  }

  let endpoint = null;
  try {
    endpoint = `${payoutBaseUrl(effective)}/merchants/${encodeURIComponent(effective.merchantId)}/balance`;
    // Always a live authentication: a test that could be answered from the
    // token cache would keep reporting the last outcome after a credential fix.
    const result = await payoutRequest(effective, "GET", `/merchants/${encodeURIComponent(effective.merchantId)}/balance`, undefined, { skipCache: true });
    return {
      ok: true,
      status: "connected",
      environment,
      capability: "payout",
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        method: "GET",
        endpoint,
        statusCode: result.statusCode,
        accessTokenIssued: true,
        balanceAvailable: result.payload?.balance !== undefined || result.payload?.availableBalance !== undefined
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      error: error?.message || "Peach payout connection failed",
      errorCode: error?.details?.code || "PAYOUT_CONNECTION_FAILED",
      environment,
      capability: "payout",
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        method: "GET",
        endpoint,
        authEndpoint: `${authServiceBaseUrl(environment, effective)}${OAUTH_TOKEN_PATH}`,
        statusCode: error?.details?.providerStatus ?? null,
        accessTokenIssued: false,
        // Presence and shape only — never a value. Lets an operator check what
        // was actually stored against the Peach Dashboard without exposing it.
        credentials: {
          clientIdLength: trimmed(effective.clientId).length,
          clientIdLast4: lastFour(effective.clientId),
          clientSecretLength: trimmed(effective.clientSecret).length,
          merchantIdLength: trimmed(effective.merchantId).length,
          merchantIdLast4: lastFour(effective.merchantId)
        }
      }
    };
  }
}

/* ------------------------------------------------------------ availability */

// Payouts stay switched off until the capability is configured, enabled, and a
// connection test has actually succeeded. The presence of the Admin form is
// never sufficient.
// The last recorded outcome of the payout capability's own connection test.
async function storedPayoutHealthStatus() {
  try {
    const { rows } = await pool.query("SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [PAYOUT_SETTING_KEY]);
    return String(rows[0]?.value?.health?.status || "").toLowerCase();
  } catch (_error) {
    return "";
  }
}

async function payoutAvailability(storedHealthStatus) {
  const effective = await loadPeachPayoutConfig();
  const missing = missingPayoutFields(effective);
  if (missing.length) {
    return { available: false, reason: "PAYOUT_NOT_CONFIGURED", missingFields: missing, environment: effective.environment };
  }
  if (effective.enabled === false) {
    return { available: false, reason: "PAYOUT_DISABLED", environment: effective.environment };
  }
  const health = storedHealthStatus === undefined ? await storedPayoutHealthStatus() : storedHealthStatus;
  if (health !== "connected") {
    return { available: false, reason: "PAYOUT_NOT_VERIFIED", environment: effective.environment };
  }
  return { available: true, environment: effective.environment };
}

function assertPayoutAvailable(availability) {
  if (availability.available) return;
  const message = {
    PAYOUT_NOT_CONFIGURED: "Payout endpoint not configured",
    PAYOUT_DISABLED: "Withdrawals are currently disabled. No wallet debit was made.",
    PAYOUT_NOT_VERIFIED: "Withdrawals are unavailable until the payout provider connection has been verified. No wallet debit was made."
  }[availability.reason] || "Withdrawals are unavailable. No wallet debit was made.";
  throw new AppError(503, message, { code: availability.reason });
}

/* -------------------------------------------------------------- payout API */

// Documented request shape only — no invented fields.
// POST {payouts}/merchants/{merchantId}/payouts
//   { payouts: [{ payoutId, currency, amount, accountNumber, branchCode,
//                 reference, bankName, accountHolder, merchantReference, payoutMethod }] }
function buildPayoutEntry(request = {}) {
  const required = ["currency", "amount", "accountNumber", "branchCode", "reference", "bankName", "accountHolder", "payoutMethod"];
  const entry = {
    payoutId: trimmed(request.payoutId) || undefined,
    currency: trimmed(request.currency).toUpperCase() || "ZAR",
    amount: Number(request.amount),
    accountNumber: trimmed(request.accountNumber),
    branchCode: trimmed(request.branchCode),
    reference: trimmed(request.reference),
    bankName: trimmed(request.bankName),
    accountHolder: trimmed(request.accountHolder),
    merchantReference: trimmed(request.merchantReference) || undefined,
    payoutMethod: trimmed(request.payoutMethod)
  };
  const missing = required.filter((field) => entry[field] === undefined || entry[field] === "" || (field === "amount" && !(Number.isFinite(entry.amount) && entry.amount > 0)));
  if (missing.length) throw new AppError(400, `Payout details are incomplete: ${missing.join(", ")}`, { code: "PAYOUT_DETAILS_INCOMPLETE", missingFields: missing });
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

async function createPayoutRequest(requests, { storedHealthStatus } = {}) {
  const availability = await payoutAvailability(storedHealthStatus);
  assertPayoutAvailable(availability);
  const effective = await loadPeachPayoutConfig();
  const payouts = (Array.isArray(requests) ? requests : [requests]).map(buildPayoutEntry);
  const result = await payoutRequest(effective, "POST", `/merchants/${encodeURIComponent(effective.merchantId)}/payouts`, { payouts });
  return result.payload;
}

async function queryPayoutRequest(payoutRequestId) {
  const effective = await loadPeachPayoutConfig();
  const missing = missingPayoutFields(effective);
  if (missing.length) throw new AppError(503, "Payout endpoint not configured", { code: "PAYOUT_NOT_CONFIGURED", missingFields: missing });
  const result = await payoutRequest(
    effective, "GET",
    `/merchants/${encodeURIComponent(effective.merchantId)}/payouts/${encodeURIComponent(payoutRequestId)}/status`
  );
  return result.payload;
}

module.exports = {
  AUTH_SERVICE_URLS,
  PAYOUT_SERVICE_URLS,
  OAUTH_TOKEN_PATH,
  assertPayoutAvailable,
  buildPayoutEntry,
  clearPayoutTokenCache,
  createPayoutRequest,
  missingPayoutFields,
  normalizeEnvironment,
  payoutAvailability,
  storedPayoutHealthStatus,
  payoutBaseUrl,
  queryPayoutRequest,
  requestPayoutAccessToken,
  testPayoutConnection
};
