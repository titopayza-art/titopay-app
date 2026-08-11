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

/* ------------------------------------------------ documented payout schema */

// createPayoutRequest, exactly as published. Every constraint below is quoted
// from the reference; nothing here is inferred.
// https://developer.peachpayments.com/reference/createpayoutrequest
//
//   amount        number, MINOR units (cents), 1000 .. 500000000
//   accountNumber string, max 50
//   branchCode    string, ^[0-9]{6}$
//   reference     string, ^(?! )[A-Za-z0-9 ]{1,20}(?<! )$
//   bankName      enum, see SUPPORTED_BANKS
//   accountHolder string, 2..50, ^[a-zA-Z0-9]([ .-](?![ .-])|[a-zA-Z0-9]){0,48}[a-zA-Z0-9]$
//   payoutMethod  enum, "realtime-eft"
//   currency      enum, "ZAR"
//   payoutId      optional lowercase UUIDv4 — supplied by TitoPay so a payout
//                 always carries our own identifier
const SUPPORTED_BANKS = [
  "STANDARD BANK", "NEDBANK", "FNB", "OLD MUTUAL BANK", "ACCESS BANK", "AFRICAN BANK",
  "UBANK LTD", "BIDVEST BANK", "BIDVEST BANK ALLIANCES", "CAPITEC BANK", "ABSA",
  "HBZ BANK LIMITED", "FINBOND MUTUAL BANK", "INVESTEC BANK LIMITED", "FINBOND EPE",
  "DISCOVERY BANK", "TYMEBANK", "SASFIN BANK", "STANDARD CHARTERED BANK SA",
  "ALBARAKA BANK", "CAPITEC BUSINESS", "AFRICAN BANK BUSINESS", "BANK ZERO MUTUAL BANK",
  "YWBN MUTUAL BANK"
];

const PAYOUT_METHODS = ["realtime-eft"];
const MIN_PAYOUT_CENTS = 1000;
const MAX_PAYOUT_CENTS = 500000000;
const PAYOUT_REFERENCE_PATTERN = /^(?! )[A-Za-z0-9 ]{1,20}(?<! )$/;
const ACCOUNT_HOLDER_PATTERN = /^[a-zA-Z0-9]([ .-](?![ .-])|[a-zA-Z0-9]){0,48}[a-zA-Z0-9]$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Peach statuses, verbatim. `pending` and `processing` are not outcomes.
const PAYOUT_TERMINAL_STATUSES = new Set(["successful", "failed", "cancelled", "reversed"]);
const PAYOUT_STATUSES = new Set(["pending", "processing", ...PAYOUT_TERMINAL_STATUSES]);

function normalizeBankName(value) {
  const text = trimmed(value).toUpperCase().replace(/\s+/g, " ");
  return SUPPORTED_BANKS.includes(text) ? text : "";
}

// Peach's reference alphabet is [A-Za-z0-9 ] only, so a TitoPay reference such
// as "TP-WD-MSJ0-1A2B" cannot be sent as-is. Strip to the allowed alphabet
// rather than dropping the reference, so the payout still carries something an
// operator can match back to the transaction.
function toPayoutReference(value, fallback = "TitoPay") {
  const cleaned = trimmed(value).replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 20).trim();
  return cleaned || fallback;
}

function toAccountHolder(value) {
  const cleaned = trimmed(value)
    .replace(/[^a-zA-Z0-9 .-]+/g, " ")
    .replace(/([ .-])(?=[ .-])/g, "")
    .replace(/^[ .-]+|[ .-]+$/g, "")
    .slice(0, 50)
    .replace(/^[ .-]+|[ .-]+$/g, "");
  return ACCOUNT_HOLDER_PATTERN.test(cleaned) ? cleaned : "";
}

// Rands in, cents out. Peach rejects fractional cents, and a rounding slip here
// is a real over- or under-payment, so this is deliberately explicit.
function toMinorUnits(amountInRands) {
  const rands = Number(amountInRands);
  if (!Number.isFinite(rands)) return NaN;
  return Math.round(rands * 100);
}

function fromMinorUnits(cents) {
  const value = Number(cents);
  return Number.isFinite(value) ? Math.round(value) / 100 : NaN;
}

// Documented request shape only — no invented fields.
// POST {payouts}/merchants/{merchantId}/payouts
//   { payouts: [{ payoutId, currency, amount, accountNumber, branchCode,
//                 reference, bankName, accountHolder, merchantReference, payoutMethod }] }
//
// `amount` is given to this function in RANDS, the unit TitoPay stores, and is
// converted to the cents Peach documents. Callers never do the conversion.
function buildPayoutEntry(request = {}) {
  const problems = [];

  const payoutId = trimmed(request.payoutId).toLowerCase();
  if (payoutId && !UUID_V4_PATTERN.test(payoutId)) problems.push("payoutId must be a lowercase v4 UUID");

  const currency = (trimmed(request.currency).toUpperCase() || "ZAR");
  if (currency !== "ZAR") problems.push("currency must be ZAR");

  const amount = toMinorUnits(request.amount);
  if (!Number.isFinite(amount) || amount <= 0) problems.push("amount must be greater than zero");
  else if (amount < MIN_PAYOUT_CENTS) problems.push(`the smallest payout is R${(MIN_PAYOUT_CENTS / 100).toFixed(2)}`);
  else if (amount > MAX_PAYOUT_CENTS) problems.push(`the largest payout is R${(MAX_PAYOUT_CENTS / 100).toFixed(2)}`);

  const accountNumber = trimmed(request.accountNumber).replace(/\s+/g, "");
  if (!accountNumber) problems.push("accountNumber is required");
  else if (accountNumber.length > 50) problems.push("accountNumber is too long");

  const branchCode = trimmed(request.branchCode).replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(branchCode)) problems.push("branchCode must be exactly 6 digits");

  const reference = toPayoutReference(request.reference);
  if (!PAYOUT_REFERENCE_PATTERN.test(reference)) problems.push("reference must be 1-20 letters, digits or spaces");

  const bankName = normalizeBankName(request.bankName);
  if (!bankName) problems.push("bankName must be one of the banks Peach supports");

  const accountHolder = toAccountHolder(request.accountHolder);
  if (!accountHolder || accountHolder.length < 2) problems.push("accountHolder must be 2-50 letters, digits, spaces, dots or hyphens");

  const payoutMethod = trimmed(request.payoutMethod) || PAYOUT_METHODS[0];
  if (!PAYOUT_METHODS.includes(payoutMethod)) problems.push(`payoutMethod must be one of ${PAYOUT_METHODS.join(", ")}`);

  const merchantReference = request.merchantReference === undefined || request.merchantReference === null
    ? undefined
    : toPayoutReference(request.merchantReference, "");

  if (problems.length) {
    // Bank details are never echoed back — only which field is wrong.
    throw new AppError(400, `Payout details are incomplete: ${problems.join("; ")}`, {
      code: "PAYOUT_DETAILS_INCOMPLETE",
      problems
    });
  }

  const entry = {
    payoutId: payoutId || undefined,
    currency,
    amount,
    accountNumber,
    branchCode,
    reference,
    bankName,
    accountHolder,
    merchantReference: merchantReference || undefined,
    payoutMethod
  };
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

// Pull our payout out of a Peach create/status response by the payoutId TitoPay
// generated. Peach echoes the whole request back, so the entry is always there.
function findPayoutInResponse(payload = {}, payoutId) {
  const list = Array.isArray(payload.payouts) ? payload.payouts : [];
  const wanted = trimmed(payoutId).toLowerCase();
  const match = list.find((item) => trimmed(item?.payoutId).toLowerCase() === wanted);
  return match || (list.length === 1 ? list[0] : null);
}

// Peach's own vocabulary, normalised but never reinterpreted. An unrecognised
// status is treated as still-in-flight, never as an outcome.
function normalizePayoutStatus(value) {
  const status = trimmed(value).toLowerCase();
  return PAYOUT_STATUSES.has(status) ? status : "";
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
  SUPPORTED_BANKS,
  PAYOUT_METHODS,
  PAYOUT_TERMINAL_STATUSES,
  MIN_PAYOUT_CENTS,
  MAX_PAYOUT_CENTS,
  assertPayoutAvailable,
  buildPayoutEntry,
  clearPayoutTokenCache,
  createPayoutRequest,
  findPayoutInResponse,
  fromMinorUnits,
  missingPayoutFields,
  normalizeBankName,
  normalizeEnvironment,
  normalizePayoutStatus,
  payoutAvailability,
  storedPayoutHealthStatus,
  payoutBaseUrl,
  queryPayoutRequest,
  requestPayoutAccessToken,
  testPayoutConnection,
  toAccountHolder,
  toMinorUnits,
  toPayoutReference
};
