"use strict";

// Flash Partner API v4 — VAS provider (airtime, data, prepaid utilities,
// vouchers, Flash Token, Flash Pay).
//
//   Sandbox     https://api-flashswitch-sandbox.flash-group.com
//   Production  https://api.flashswitch.flash-group.com
//
//   POST {base}/token                                        OAuth 2.0 client credentials
//        Authorization: Basic <Flash API key>
//        Content-Type:  application/x-www-form-urlencoded
//        body:          grant_type=client_credentials
//        -> { access_token, token_type, expires_in }   (Flash documents 3600s)
//
//   GET  {base}/aggregation/4.0/accounts/{accountNumber}/products
//        Accept:        application/json
//        Authorization: Bearer <access_token>
//
// Two rules govern every call here:
//
//   1. Flash can fail with an HTTP error OR with HTTP 200 carrying a non-zero
//      responseCode. A response is only successful when the HTTP status is a
//      success AND responseCode is 0 wherever Flash supplies one.
//   2. The API key and the access token are secrets. They are never returned to
//      a caller, never written to a log line, and are scrubbed out of any
//      provider message before it is recorded.
//
// The connection test authenticates and then reads the account's product list.
// It never initiates a purchase.

const crypto = require("crypto");
const { AppError } = require("../lib/errors");

const DEFAULT_TIMEOUT_MS = 15000;
const TOKEN_PATH = "/token";
// Flash documents a 3600s token. Re-authenticate a minute early so a token can
// never expire in flight between our check and Flash receiving the request.
const TOKEN_EXPIRY_SKEW_MS = 60000;
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const TOKEN_CACHE_LIMIT = 8;
const PRODUCTS_PATH_PREFIX = "/aggregation/4.0/accounts";

// Documented defaults. A base URL saved in Admin always wins, so the endpoint
// stays configurable and is never silently assumed when an operator set one.
const FLASH_SERVICE_URLS = {
  sandbox: "https://api-flashswitch-sandbox.flash-group.com",
  production: "https://api.flashswitch.flash-group.com"
};

// Product groups the Partner API v4 exposes. Used only to summarise what the
// account discovery call returned — never to decide what TitoPay may sell.
const FLASH_PRODUCT_GROUPS = [
  "Cellular",
  "Prepaid Utilities",
  "Gift Vouchers",
  "1Voucher",
  "Cash Out PIN",
  "Eezi Vouchers",
  "Flash Token",
  "Flash Pay"
];

// Access tokens are held in memory only, keyed by the credentials that issued
// them, so changing the API key or the environment can never reuse the old one.
const flashTokenCache = new Map();

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function normalizeEnvironment(value) {
  const environment = trimmed(value).toLowerCase();
  if (["sandbox", "test", "testing", "staging"].includes(environment)) return "sandbox";
  if (["production", "live", "prod"].includes(environment)) return "production";
  return "sandbox";
}

function defaultFlashBaseUrl(environment) {
  return FLASH_SERVICE_URLS[normalizeEnvironment(environment)];
}

function flashBaseUrl(effective = {}) {
  const environment = normalizeEnvironment(effective.environment);
  const configured = trimmed(effective.baseUrl);
  const value = configured || FLASH_SERVICE_URLS[environment];
  let url;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch (_error) {
    throw new AppError(400, "Flash base URL is invalid", { code: "FLASH_CONFIGURATION_INVALID" });
  }
  return url.toString().replace(/\/+$/, "");
}

function missingFlashFields(effective = {}) {
  return ["apiKey", "accountNumber"].filter((field) => !trimmed(effective[field]));
}

// Removes the API key and any issued access token from provider text before it
// reaches a log line or an Admin diagnostic.
function scrub(text, credentials = {}) {
  let value = String(text || "");
  for (const secret of [credentials.apiKey, credentials.accessToken]) {
    if (secret && String(secret).length >= 4) value = value.split(String(secret)).join("[redacted]");
  }
  // A bearer or basic credential echoed back inside a message body.
  value = value.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  return value.slice(0, 300);
}

function cacheKey(effective, tokenEndpoint) {
  return crypto.createHash("sha256")
    .update(`flash|${tokenEndpoint}|${trimmed(effective.apiKey)}`)
    .digest("hex");
}

function cachedToken(key) {
  const entry = flashTokenCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now()) {
    flashTokenCache.delete(key);
    return null;
  }
  return entry.accessToken;
}

function storeToken(key, accessToken, expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  const ttlSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOKEN_TTL_SECONDS;
  if (flashTokenCache.size >= TOKEN_CACHE_LIMIT) flashTokenCache.delete(flashTokenCache.keys().next().value);
  flashTokenCache.set(key, { accessToken, expiresAt: Date.now() + ttlSeconds * 1000 });
  return ttlSeconds;
}

function forgetToken(key) {
  flashTokenCache.delete(key);
}

function clearFlashTokenCache() {
  flashTokenCache.clear();
}

/* --------------------------------------------------------------- responses */

// Flash supplies responseCode on most operations; a few endpoints omit it.
// Absent is not the same as zero, so return null rather than defaulting.
function flashResponseCode(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload.responseCode ?? payload.response_code ?? payload.responseCd;
  if (raw === undefined || raw === null || raw === "") return null;
  const code = Number(raw);
  return Number.isFinite(code) ? code : null;
}

function flashResponseMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  return trimmed(payload.responseMessage || payload.response_message || payload.message || payload.error || "");
}

// HTTP 200 with a non-zero responseCode is a failure. Refusing to treat it as
// success is the whole point: a "connected" Flash that answers 200/-1 to every
// call is worse than one that is plainly disconnected.
function assertFlashResponseCode(payload, { operation, credentials = {} } = {}) {
  const code = flashResponseCode(payload);
  if (code === null || code === 0) return code;
  const message = scrub(flashResponseMessage(payload), credentials);
  throw new AppError(502, `Flash rejected the ${operation || "request"} (responseCode ${code})${message ? `: ${message}` : ""}`, {
    code: "FLASH_RESPONSE_CODE_ERROR",
    providerResponseCode: code
  });
}

// Flash's HTTP status separates a rejected credential from a wrong account or a
// wrong endpoint, which is the first thing an operator needs to know.
function flashErrorFor(status, message, credentials = {}, { operation } = {}) {
  const raw = scrub(message, credentials);
  const said = raw && raw.length <= 160 ? ` Flash said: "${raw.replace(/"/g, "'")}"` : "";
  const because = `${Number.isFinite(status) ? ` [HTTP ${status}]` : ""}${said}`;
  if (status === 401 || status === 403) {
    return new AppError(502, `Authentication rejected by Flash (invalid API key).${because}`, {
      code: "FLASH_AUTHENTICATION_REJECTED", providerStatus: status
    });
  }
  if (status === 400) {
    return new AppError(502, `Flash rejected the request as invalid.${because}`, {
      code: "FLASH_CONFIGURATION_INVALID", providerStatus: status
    });
  }
  if (status === 404) {
    return new AppError(502, operation === "account product list"
      ? `Flash does not recognise this account number.${because}`
      : `The Flash endpoint was not found. Check the base URL.${because}`, {
      code: operation === "account product list" ? "FLASH_ACCOUNT_NOT_FOUND" : "FLASH_ENDPOINT_NOT_FOUND",
      providerStatus: status
    });
  }
  if (status === 429) {
    return new AppError(502, "Flash rate limited the request", { code: "FLASH_RATE_LIMITED", providerStatus: status });
  }
  if (status >= 500) {
    return new AppError(502, "Flash is unavailable", { code: "FLASH_PROVIDER_UNAVAILABLE", providerStatus: status });
  }
  return new AppError(502, `Flash request failed (HTTP ${status})`, { code: "FLASH_REQUEST_FAILED", providerStatus: status });
}

/* ---------------------------------------------------------- authentication */

async function requestAccessToken(effective, { timeoutMs = DEFAULT_TIMEOUT_MS, skipCache = false } = {}) {
  const environment = normalizeEnvironment(effective.environment);
  const apiKey = trimmed(effective.apiKey);
  if (!apiKey) {
    throw new AppError(503, "Flash is not configured", { code: "FLASH_NOT_CONFIGURED", missingFields: ["apiKey"] });
  }

  const tokenEndpoint = `${flashBaseUrl(effective)}${TOKEN_PATH}`;
  const key = cacheKey({ apiKey }, tokenEndpoint);
  if (!skipCache) {
    const cached = cachedToken(key);
    if (cached) return { accessToken: cached, environment, tokenEndpoint, cacheKey: key, cached: true, statusCode: 200 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${apiKey}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": "TitoPay-Flash/1.0"
      },
      body: "grant_type=client_credentials",
      signal: controller.signal
    });
  } catch (error) {
    console.error("[flash-auth] network failure", {
      environment,
      tokenEndpoint,
      durationMs: Date.now() - startedAt,
      reason: error?.name === "AbortError" ? "timeout" : scrub(error?.message, { apiKey })
    });
    if (error?.name === "AbortError") throw new AppError(504, "Flash authentication timed out", { code: "FLASH_NETWORK_TIMEOUT" });
    throw new AppError(502, "Flash could not be reached", { code: "FLASH_NETWORK_ERROR" });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text().catch(() => "");
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }

  console.info("[flash-auth] token request", {
    environment,
    tokenEndpoint,
    httpStatus: response.status,
    durationMs: Date.now() - startedAt,
    // Presence and shape only. Never the key itself, never the token.
    apiKeyConfigured: true,
    apiKeyLength: apiKey.length,
    providerMessage: response.ok ? "" : scrub(payload?.error_description || payload?.message || payload?.error || raw, { apiKey })
  });

  if (!response.ok) {
    throw flashErrorFor(response.status, payload?.error_description || payload?.message || payload?.error || raw, { apiKey }, { operation: "token request" });
  }
  assertFlashResponseCode(payload, { operation: "token request", credentials: { apiKey } });

  const accessToken = trimmed(payload.access_token || payload.accessToken);
  if (!accessToken) {
    throw new AppError(502, "Flash did not return an access token", {
      code: "FLASH_AUTHENTICATION_FAILED", providerStatus: response.status
    });
  }

  const expiresIn = storeToken(key, accessToken, payload.expires_in ?? payload.expiresIn);
  return {
    accessToken,
    environment,
    tokenEndpoint,
    cacheKey: key,
    cached: false,
    statusCode: response.status,
    expiresIn,
    tokenType: trimmed(payload.token_type || payload.tokenType) || "Bearer"
  };
}

/* --------------------------------------------------------------- requests */

async function flashRequest(effective, method, path, { timeoutMs = DEFAULT_TIMEOUT_MS, skipCache = false, operation, retryOnExpiredToken = true, token: issuedToken } = {}) {
  const apiKey = trimmed(effective.apiKey);
  // A caller that has just authenticated passes its token in rather than
  // authenticating a second time — the connection test does exactly that.
  const token = issuedToken || await requestAccessToken(effective, { timeoutMs, skipCache });
  const url = `${flashBaseUrl(effective)}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        "user-agent": "TitoPay-Flash/1.0"
      },
      signal: controller.signal
    });
  } catch (error) {
    console.error("[flash] network failure", {
      method, endpoint: url, durationMs: Date.now() - startedAt,
      reason: error?.name === "AbortError" ? "timeout" : scrub(error?.message, { apiKey, accessToken: token.accessToken })
    });
    if (error?.name === "AbortError") throw new AppError(504, "Flash timed out", { code: "FLASH_NETWORK_TIMEOUT" });
    throw new AppError(502, "Flash could not be reached", { code: "FLASH_NETWORK_ERROR" });
  } finally {
    clearTimeout(timer);
  }

  // A cached token Flash has already expired or revoked comes back as a 401.
  // Discard it and authenticate once more before giving up, so a token that
  // aged out between calls never surfaces as an authentication failure.
  if (response.status === 401 && token.cached && retryOnExpiredToken) {
    forgetToken(token.cacheKey);
    console.info("[flash] cached token rejected — re-authenticating", { method, endpoint: url });
    return flashRequest(effective, method, path, { timeoutMs, skipCache: true, operation, retryOnExpiredToken: false });
  }

  const raw = await response.text().catch(() => "");
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }

  console.info("[flash] request", {
    method,
    endpoint: url,
    httpStatus: response.status,
    durationMs: Date.now() - startedAt,
    usedCachedToken: token.cached,
    responseCode: flashResponseCode(payload),
    providerMessage: response.ok ? "" : scrub(flashResponseMessage(payload) || raw, { apiKey, accessToken: token.accessToken })
  });

  if (!response.ok) {
    throw flashErrorFor(response.status, flashResponseMessage(payload) || raw, { apiKey, accessToken: token.accessToken }, { operation });
  }
  const responseCode = assertFlashResponseCode(payload, { operation, credentials: { apiKey, accessToken: token.accessToken } });

  return { payload, statusCode: response.status, responseCode, usedCachedToken: token.cached, endpoint: url };
}

/* ------------------------------------------------------ product discovery */

function productEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["products", "productList", "data", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function productGroupNames(products) {
  const groups = new Set();
  for (const product of products) {
    if (!product || typeof product !== "object") continue;
    const group = trimmed(product.productGroup || product.group || product.category || product.productGroupName);
    if (group) groups.add(group);
  }
  return [...groups].slice(0, 25);
}

// Account/product discovery. Read-only: it validates that the account number is
// real and that the token is accepted, without moving any money.
async function listAccountProducts(effective, { timeoutMs = DEFAULT_TIMEOUT_MS, skipCache = false, token } = {}) {
  const accountNumber = trimmed(effective.accountNumber);
  if (!accountNumber) {
    throw new AppError(503, "Flash account number is not configured", {
      code: "FLASH_NOT_CONFIGURED", missingFields: ["accountNumber"]
    });
  }
  const path = `${PRODUCTS_PATH_PREFIX}/${encodeURIComponent(accountNumber)}/products`;
  const result = await flashRequest(effective, "GET", path, { timeoutMs, skipCache, token, operation: "account product list" });
  const products = productEntries(result.payload);
  return {
    ...result,
    products,
    productCount: products.length,
    productGroups: productGroupNames(products)
  };
}

/* -------------------------------------------------------- connection test */

// A real two-step authentication test. Nothing here can report "connected"
// without Flash having issued an access token AND accepted it on a live call
// against the configured account number.
async function testFlashConnection(effective = {}) {
  const environment = normalizeEnvironment(effective.environment);
  const baseUrl = trimmed(effective.baseUrl) || FLASH_SERVICE_URLS[environment];
  const tokenEndpoint = `${String(baseUrl).replace(/\/+$/, "")}${TOKEN_PATH}`;
  const accountNumber = trimmed(effective.accountNumber);
  const productsEndpoint = accountNumber
    ? `${String(baseUrl).replace(/\/+$/, "")}${PRODUCTS_PATH_PREFIX}/${encodeURIComponent(accountNumber)}/products`
    : null;

  const missing = missingFlashFields(effective);
  if (missing.length) {
    return {
      ok: false,
      status: "not_configured",
      error: `Flash configuration is incomplete: ${missing.join(", ")}`,
      errorCode: "FLASH_NOT_CONFIGURED",
      environment,
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        environment,
        baseUrl,
        tokenEndpoint,
        productsEndpoint,
        missingFields: missing,
        accessTokenIssued: false
      }
    };
  }

  // Step 1 — POST /token. Never answered from the cache: a test that could be
  // served from a cached token would keep reporting the previous outcome after
  // an operator corrected the key.
  let token;
  try {
    token = await requestAccessToken(effective, { skipCache: true });
  } catch (error) {
    const code = error?.details?.code || "FLASH_AUTHENTICATION_FAILED";
    const networkFailure = code === "FLASH_NETWORK_ERROR" || code === "FLASH_NETWORK_TIMEOUT" || code === "FLASH_PROVIDER_UNAVAILABLE";
    return {
      ok: false,
      status: networkFailure ? "connection_failed" : "authentication_failed",
      error: error?.message || "Flash authentication failed",
      errorCode: code,
      environment,
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        environment,
        baseUrl,
        tokenEndpoint,
        productsEndpoint,
        step: "token",
        statusCode: error?.details?.providerStatus ?? null,
        responseCode: error?.details?.providerResponseCode ?? null,
        accessTokenIssued: false,
        // Presence and shape only — never a value.
        credentials: {
          apiKeyConfigured: Boolean(trimmed(effective.apiKey)),
          apiKeyLength: trimmed(effective.apiKey).length,
          accountNumber
        }
      }
    };
  }

  // Step 2 — GET the account's product list with the issued Bearer token.
  try {
    // Step 2 reuses the token step 1 just issued: the point is to prove that
    // token is accepted, not to authenticate twice.
    const products = await listAccountProducts(effective, { token });
    return {
      ok: true,
      status: "connected",
      environment,
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        environment,
        baseUrl,
        tokenEndpoint,
        productsEndpoint,
        accessTokenIssued: true,
        tokenExpiresInSeconds: token.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS,
        tokenStatusCode: token.statusCode,
        accountNumber,
        productsStatusCode: products.statusCode,
        responseCode: products.responseCode,
        productCount: products.productCount,
        productGroups: products.productGroups
      }
    };
  } catch (error) {
    const code = error?.details?.code || "FLASH_ACCOUNT_VALIDATION_FAILED";
    const networkFailure = code === "FLASH_NETWORK_ERROR" || code === "FLASH_NETWORK_TIMEOUT" || code === "FLASH_PROVIDER_UNAVAILABLE";
    const authFailure = code === "FLASH_AUTHENTICATION_REJECTED" || code === "FLASH_AUTHENTICATION_FAILED";
    return {
      ok: false,
      status: networkFailure ? "connection_failed" : authFailure ? "authentication_failed" : "account_validation_failed",
      error: error?.message || "Flash account validation failed",
      errorCode: code,
      environment,
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        environment,
        baseUrl,
        tokenEndpoint,
        productsEndpoint,
        step: "products",
        accessTokenIssued: true,
        tokenExpiresInSeconds: token.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS,
        tokenStatusCode: token.statusCode,
        accountNumber,
        statusCode: error?.details?.providerStatus ?? null,
        responseCode: error?.details?.providerResponseCode ?? null
      }
    };
  }
}

/* ------------------------------------------------------------ idempotency */

// Flash transaction references are idempotent: retrying a timed-out purchase
// with the SAME reference is how a double-spend is avoided, and a fresh
// reference on retry is how one is caused. This derives the Flash reference
// deterministically from TitoPay's own transaction reference, so a retry of the
// same transaction can only ever produce the same value.
function flashTransactionReference(sourceReference) {
  const source = trimmed(sourceReference);
  if (!source) throw new AppError(400, "A transaction reference is required", { code: "FLASH_REFERENCE_REQUIRED" });
  const normalized = source.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length >= 12 && normalized.length <= 32) return normalized;
  if (normalized.length > 32) return normalized.slice(0, 32);
  const suffix = crypto.createHash("sha256").update(source).digest("hex").toUpperCase();
  return `${normalized}${suffix}`.slice(0, 20);
}

module.exports = {
  FLASH_SERVICE_URLS,
  FLASH_PRODUCT_GROUPS,
  DEFAULT_TOKEN_TTL_SECONDS,
  normalizeEnvironment,
  defaultFlashBaseUrl,
  flashBaseUrl,
  missingFlashFields,
  flashResponseCode,
  assertFlashResponseCode,
  requestAccessToken,
  flashRequest,
  listAccountProducts,
  testFlashConnection,
  flashTransactionReference,
  clearFlashTokenCache,
  scrub
};
