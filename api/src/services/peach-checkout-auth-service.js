"use strict";

// Peach Payments Checkout (Embedded Checkout / Hosted Checkout V2) authentication.
//
// This is the ONLY Peach product TitoPay authenticates against for provider
// health checks. It must not be mixed with the Peach Payments API (`api-key`
// header) or with OPPWA (`Authorization: Bearer <entity secret token>`).
//
// Documented flow (https://developer.peachpayments.com/docs/checkout-embedded-authentication):
//   POST {peach-auth-service}/api/oauth/token
//   content-type: application/json
//   { "clientId": "...", "clientSecret": "...", "merchantId": "..." }
//   -> 200 { "access_token": "...", "expires_in": "...", "token_type": "Bearer" }
//
// Service URLs (https://developer.peachpayments.com/docs/checkout-embedded#api-endpoints):
//   Authentication  live https://dashboard.peachpayments.com
//                sandbox https://sandbox-dashboard.peachpayments.com
//   Checkout        live https://secure.peachpayments.com
//                sandbox https://testsecure.peachpayments.com

const crypto = require("crypto");
const { AppError } = require("../lib/errors");

const DEFAULT_TIMEOUT_MS = 12000;
const OAUTH_TOKEN_PATH = "/api/oauth/token";
const TOKEN_EXPIRY_SKEW_MS = 30000;
const TOKEN_CACHE_LIMIT = 32;

const AUTH_SERVICE_URLS = {
  sandbox: "https://sandbox-dashboard.peachpayments.com",
  production: "https://dashboard.peachpayments.com"
};

const CHECKOUT_SERVICE_URLS = {
  sandbox: "https://testsecure.peachpayments.com",
  production: "https://secure.peachpayments.com"
};

// access tokens are held in memory only and never persisted or logged
const tokenCache = new Map();

function normalizeEnvironment(value) {
  const environment = String(value || "").trim().toLowerCase();
  if (["sandbox", "test", "testing", "staging"].includes(environment)) return "sandbox";
  if (["production", "live", "prod"].includes(environment)) return "production";
  return "production";
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

// The Admin Portal stores camelCase keys. Accept the snake_case spellings too so
// a configuration saved through any other path still resolves to the same
// credential rather than silently reading as empty.
function firstConfigured(effective, names) {
  for (const name of names) {
    const value = trimmed(effective?.[name]);
    if (value) return value;
  }
  return "";
}

function checkoutCredentials(effective = {}) {
  return {
    clientId: firstConfigured(effective, ["clientId", "client_id", "clientID"]),
    clientSecret: firstConfigured(effective, ["clientSecret", "client_secret"]),
    merchantId: firstConfigured(effective, ["merchantId", "merchant_id", "merchantID"])
  };
}

function missingCredentialFields(credentials) {
  return ["clientId", "clientSecret", "merchantId"].filter((field) => !credentials[field]);
}

function authServiceBaseUrl(environment, effective = {}) {
  const configured = trimmed(
    environment === "sandbox"
      ? effective.sandboxAuthUrl || process.env.PEACH_PAYMENTS_SANDBOX_AUTH_URL
      : effective.productionAuthUrl || process.env.PEACH_PAYMENTS_PRODUCTION_AUTH_URL
  );
  const value = configured || AUTH_SERVICE_URLS[environment];
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).toString().replace(/\/+$/, "");
  } catch (_error) {
    throw new AppError(400, "Peach Payments authentication URL is invalid", { code: "INVALID_CONFIGURATION" });
  }
}

function checkoutServiceBaseUrl(environment) {
  return CHECKOUT_SERVICE_URLS[environment];
}

// Guarantees that no credential value can reach a log line, even if Peach ever
// echoes one back inside an error body.
function scrub(text, credentials) {
  let value = String(text || "");
  for (const secret of [credentials.clientSecret, credentials.clientId, credentials.merchantId]) {
    if (secret && secret.length >= 4) value = value.split(secret).join("[redacted]");
  }
  return value.slice(0, 300);
}

function lastFour(value) {
  const text = trimmed(value);
  return text.length > 4 ? text.slice(-4) : "";
}

function cacheKey(credentials, environment, authEndpoint) {
  return crypto
    .createHash("sha256")
    .update(`${environment}|${authEndpoint}|${credentials.clientId}|${credentials.merchantId}|${credentials.clientSecret}`)
    .digest("hex");
}

function cachedToken(key) {
  const entry = tokenCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now()) {
    tokenCache.delete(key);
    return null;
  }
  return entry;
}

function storeToken(key, accessToken, expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  const ttlMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5 * 60 * 1000;
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value);
  tokenCache.set(key, { accessToken, expiresAt: Date.now() + ttlMs });
}

function clearTokenCache() {
  tokenCache.clear();
}

// Peach answers an invalid clientId/clientSecret/merchantId with HTTP 400 and
// `{"message":"Invalid client ID or secret."}`, not 401. Treat that as an
// authentication rejection so a bad credential is never reported as a
// configuration or provider problem.
function authenticationErrorFor(status, message) {
  const lower = String(message || "").toLowerCase();
  if (status === 401 || status === 403) {
    return new AppError(502, "Authentication rejected by Peach Payments (invalid Client ID, Client Secret or Merchant ID)", {
      code: "AUTHENTICATION_REJECTED",
      providerStatus: status
    });
  }
  if (status === 400) {
    if (/client|secret|merchant|credential|unauthor/.test(lower)) {
      return new AppError(502, "Authentication rejected by Peach Payments (invalid Client ID, Client Secret or Merchant ID)", {
        code: "AUTHENTICATION_REJECTED",
        providerStatus: status
      });
    }
    return new AppError(502, "Peach Payments rejected the authentication request as invalid", {
      code: "INVALID_CONFIGURATION",
      providerStatus: status
    });
  }
  if (status === 404) {
    return new AppError(502, "Peach Payments authentication endpoint was not found for this environment", {
      code: "INVALID_CONFIGURATION",
      providerStatus: status
    });
  }
  if (status === 429) {
    return new AppError(502, "Peach Payments rate limited the authentication request", {
      code: "PROVIDER_RATE_LIMITED",
      providerStatus: status
    });
  }
  if (status >= 500) {
    return new AppError(502, "Peach Payments is unavailable", { code: "PROVIDER_UNAVAILABLE", providerStatus: status });
  }
  return new AppError(502, `Peach Payments authentication failed (HTTP ${status})`, {
    code: "PROVIDER_REQUEST_FAILED",
    providerStatus: status
  });
}

async function requestAccessToken(effective = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, skipCache = false } = {}) {
  const environment = normalizeEnvironment(effective.environment || effective.mode);
  const credentials = checkoutCredentials(effective);
  const missing = missingCredentialFields(credentials);
  if (missing.length) {
    throw new AppError(400, `Peach Payments Checkout configuration is incomplete: ${missing.join(", ")}`, {
      code: "INVALID_CONFIGURATION",
      missingFields: missing
    });
  }

  const authEndpoint = `${authServiceBaseUrl(environment, effective)}${OAUTH_TOKEN_PATH}`;
  const key = cacheKey(credentials, environment, authEndpoint);
  // Test Connection always calls Peach for real; only payment traffic reuses a token.
  const cached = skipCache ? null : cachedToken(key);
  if (cached) {
    return { accessToken: cached.accessToken, environment, authEndpoint, cached: true, statusCode: 200 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(authEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "TitoPay-PeachCheckout/1.0"
      },
      body: JSON.stringify({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        merchantId: credentials.merchantId
      }),
      signal: controller.signal
    });
  } catch (error) {
    console.error("[peach-checkout-auth] network failure", {
      environment,
      authEndpoint,
      durationMs: Date.now() - startedAt,
      reason: error?.name === "AbortError" ? "timeout" : scrub(error?.message, credentials)
    });
    if (error?.name === "AbortError") {
      throw new AppError(504, "Peach Payments authentication timed out", { code: "NETWORK_TIMEOUT" });
    }
    throw new AppError(502, "Peach Payments could not be reached", { code: "NETWORK_ERROR" });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text().catch(() => "");
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }

  console.info("[peach-checkout-auth] token request", {
    environment,
    authEndpoint,
    httpStatus: response.status,
    durationMs: Date.now() - startedAt,
    clientIdLast4: lastFour(credentials.clientId),
    merchantIdLast4: lastFour(credentials.merchantId),
    clientSecretConfigured: Boolean(credentials.clientSecret),
    providerMessage: response.ok ? "" : scrub(payload?.message || payload?.error || raw, credentials)
  });

  if (!response.ok) throw authenticationErrorFor(response.status, payload?.message || payload?.error || raw);

  const accessToken = trimmed(payload.access_token || payload.accessToken);
  if (!accessToken) {
    throw new AppError(502, "Peach Payments did not return an access token", { code: "AUTHENTICATION_FAILED", providerStatus: response.status });
  }

  storeToken(key, accessToken, payload.expires_in ?? payload.expiresIn);
  return {
    accessToken,
    environment,
    authEndpoint,
    cached: false,
    statusCode: response.status,
    tokenType: trimmed(payload.token_type || payload.tokenType) || "Bearer",
    expiresIn: Number(payload.expires_in ?? payload.expiresIn) || null
  };
}

async function getAccessToken(effective = {}, options = {}) {
  const result = await requestAccessToken(effective, options);
  return result.accessToken;
}

// A real authenticated call: Peach only issues an access token when the Client
// ID, Client Secret and Merchant ID are all valid for the environment. No
// checkout, payment or ledger entry is created.
async function testCheckoutAuthentication(effective = {}) {
  const environment = normalizeEnvironment(effective.environment || effective.mode);
  try {
    const result = await requestAccessToken(effective, { skipCache: true });
    return {
      ok: true,
      status: "connected",
      environment: result.environment,
      integration: "checkout_v2",
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        method: "POST",
        endpoint: result.authEndpoint,
        checkoutEndpoint: checkoutServiceBaseUrl(result.environment),
        statusCode: result.statusCode,
        accessTokenIssued: true,
        expiresInSeconds: result.expiresIn ?? null,
        tokenType: result.tokenType || "Bearer"
      }
    };
  } catch (error) {
    const code = error?.details?.code || "CONNECTION_FAILED";
    return {
      ok: false,
      status: "failed",
      // Sanitized: never carries a credential, a token, or a raw provider body.
      error: error?.message || "Peach Payments authentication failed",
      errorCode: code,
      environment,
      integration: "checkout_v2",
      authenticationType: "oauth_client_credentials",
      providerResponse: {
        method: "POST",
        endpoint: `${AUTH_SERVICE_URLS[environment]}${OAUTH_TOKEN_PATH}`,
        statusCode: error?.details?.providerStatus ?? null,
        accessTokenIssued: false,
        missingFields: error?.details?.missingFields || undefined
      }
    };
  }
}

module.exports = {
  AUTH_SERVICE_URLS,
  CHECKOUT_SERVICE_URLS,
  OAUTH_TOKEN_PATH,
  authServiceBaseUrl,
  checkoutServiceBaseUrl,
  checkoutCredentials,
  clearTokenCache,
  getAccessToken,
  normalizeEnvironment,
  requestAccessToken,
  testCheckoutAuthentication
};
