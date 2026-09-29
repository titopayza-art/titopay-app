"use strict";

// Flash Partner API v4 — sandbox authentication, account validation and the
// rules that decide whether Flash may ever be reported as Connected.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "flash-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "flash-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const flash = require("../src/services/flash-service");

const API_KEY = "Zmxhc2gtc2FuZGJveC1hcGkta2V5LXNlY3JldA==";
const ACCESS_TOKEN = "flash-access-token-8f3a91c0d4e5";
const ACCOUNT_NUMBER = "9876543210";

const SANDBOX = {
  environment: "sandbox",
  enabled: true,
  baseUrl: "",
  apiKey: API_KEY,
  accountNumber: ACCOUNT_NUMBER
};

function readSource(...parts) {
  return fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");
}

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function jsonResponse(status, body, { ok } = {}) {
  return {
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

// A Flash sandbox that behaves the way the Partner API v4 documents: Basic on
// /token, Bearer everywhere else, and a product list behind the account number.
function flashSandbox(options = {}) {
  const calls = [];
  const handler = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({ url: String(url), method: init.method || "GET", headers, body: init.body });

    if (String(url).endsWith("/token")) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return jsonResponse(options.tokenStatus, options.tokenBody || { error: "invalid_client", error_description: "Invalid credentials" });
      }
      if (headers.authorization !== `Basic ${options.expectedApiKey || API_KEY}`) {
        return jsonResponse(401, { error: "invalid_client", error_description: "Invalid credentials" });
      }
      if (headers["content-type"] !== "application/x-www-form-urlencoded") {
        return jsonResponse(400, { error: "invalid_request", error_description: "Unsupported content type" });
      }
      if (init.body !== "grant_type=client_credentials") {
        return jsonResponse(400, { error: "unsupported_grant_type" });
      }
      return jsonResponse(200, {
        access_token: options.accessToken || ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: options.expiresIn === undefined ? 3600 : options.expiresIn
      });
    }

    if (String(url).includes("/aggregation/4.0/accounts/")) {
      if (headers.authorization !== `Bearer ${options.acceptToken || options.accessToken || ACCESS_TOKEN}`) {
        return jsonResponse(401, { responseMessage: "Token expired" });
      }
      if (options.productsStatus && options.productsStatus !== 200) {
        return jsonResponse(options.productsStatus, options.productsBody || { responseMessage: "Account not found" });
      }
      if (options.productsBody) return jsonResponse(200, options.productsBody);
      return jsonResponse(200, {
        responseCode: 0,
        products: [
          { productId: 101, productGroup: "Cellular", name: "Airtime" },
          { productId: 202, productGroup: "Prepaid Utilities", name: "Electricity" },
          { productId: 303, productGroup: "1Voucher", name: "1Voucher" }
        ]
      });
    }

    return jsonResponse(404, { responseMessage: "Not found" });
  };
  return { handler, calls };
}

function captureConsole() {
  const lines = [];
  const originalInfo = console.info;
  const originalError = console.error;
  const record = (...args) => lines.push(args.map((value) => {
    try { return typeof value === "string" ? value : JSON.stringify(value); } catch (_error) { return String(value); }
  }).join(" "));
  console.info = record;
  console.error = record;
  return {
    lines,
    restore() { console.info = originalInfo; console.error = originalError; }
  };
}

test.beforeEach(() => flash.clearFlashTokenCache());

/* ------------------------------------------------ 1. sandbox token generation */

test("sandbox token request matches the documented Flash contract", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const token = await flash.requestAccessToken(SANDBOX);
    assert.equal(token.accessToken, ACCESS_TOKEN);
    assert.equal(token.environment, "sandbox");
    assert.equal(token.expiresIn, 3600);
    assert.equal(token.tokenType, "Bearer");

    const call = sandbox.calls[0];
    assert.equal(call.url, "https://api-flashswitch-sandbox.flash-group.com/token");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, `Basic ${API_KEY}`);
    assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(call.body, "grant_type=client_credentials");
  } finally {
    silence.restore();
    restore();
  }
});

test("a blank base URL falls back to the documented sandbox endpoint", () => {
  assert.equal(flash.flashBaseUrl({ environment: "sandbox" }), "https://api-flashswitch-sandbox.flash-group.com");
  assert.equal(flash.flashBaseUrl({ environment: "production" }), "https://api.flashswitch.flash-group.com");
});

test("a configured base URL always wins over the documented default", () => {
  assert.equal(
    flash.flashBaseUrl({ environment: "sandbox", baseUrl: "https://flash-proxy.titopay.co.za/" }),
    "https://flash-proxy.titopay.co.za"
  );
});

test("a valid token is reused from the cache until it is close to expiry", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const first = await flash.requestAccessToken(SANDBOX);
    const second = await flash.requestAccessToken(SANDBOX);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(sandbox.calls.filter((call) => call.url.endsWith("/token")).length, 1);
  } finally {
    silence.restore();
    restore();
  }
});

test("a connection test never answers from the token cache", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    await flash.requestAccessToken(SANDBOX);
    await flash.testFlashConnection(SANDBOX);
    assert.equal(sandbox.calls.filter((call) => call.url.endsWith("/token")).length, 2);
  } finally {
    silence.restore();
    restore();
  }
});

/* ------------------------------------------------- 2. invalid Flash credential */

test("an invalid API key is reported as an authentication failure, never as connected", async () => {
  const sandbox = flashSandbox({ expectedApiKey: "a-different-key" });
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.ok, false);
    assert.equal(result.status, "authentication_failed");
    assert.equal(result.errorCode, "FLASH_AUTHENTICATION_REJECTED");
    assert.equal(result.providerResponse.accessTokenIssued, false);
    assert.equal(result.providerResponse.step, "token");
    // The account read must never be attempted without a token.
    assert.equal(sandbox.calls.filter((call) => call.url.includes("/products")).length, 0);
  } finally {
    silence.restore();
    restore();
  }
});

test("missing credentials report not_configured rather than a failed test", async () => {
  const result = await flash.testFlashConnection({ environment: "sandbox", apiKey: "", accountNumber: "" });
  assert.equal(result.status, "not_configured");
  assert.equal(result.errorCode, "FLASH_NOT_CONFIGURED");
  assert.deepEqual(result.providerResponse.missingFields, ["apiKey", "accountNumber"]);
});

test("an API key without an account number is still not_configured", async () => {
  const result = await flash.testFlashConnection({ environment: "sandbox", apiKey: API_KEY, accountNumber: "" });
  assert.equal(result.status, "not_configured");
  assert.deepEqual(result.providerResponse.missingFields, ["accountNumber"]);
});

test("a token response with no access_token is a failure, not a success", async () => {
  const restore = mockFetch(async () => jsonResponse(200, { token_type: "Bearer", expires_in: 3600 }));
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.ok, false);
    assert.equal(result.status, "authentication_failed");
    assert.equal(result.errorCode, "FLASH_AUTHENTICATION_FAILED");
  } finally {
    silence.restore();
    restore();
  }
});

/* -------------------------------------------------- 3. expired token handling */

test("a cached token expires and is re-requested once its lifetime has passed", async () => {
  const sandbox = flashSandbox({ expiresIn: 1 });
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    await flash.requestAccessToken(SANDBOX);
    // Flash documents 3600s; a 1s token is already inside the refresh skew, so
    // the cache must refuse to serve it.
    const second = await flash.requestAccessToken(SANDBOX);
    assert.equal(second.cached, false);
    assert.equal(sandbox.calls.filter((call) => call.url.endsWith("/token")).length, 2);
  } finally {
    silence.restore();
    restore();
  }
});

test("a cached token Flash has already revoked is discarded and re-issued once", async () => {
  // Flash still holds the second token, so the cached first one gets a 401.
  const sandbox = flashSandbox({ accessToken: ACCESS_TOKEN, acceptToken: "second-token" });
  let issued = 0;
  const restore = mockFetch(async (url, init) => {
    if (String(url).endsWith("/token")) {
      issued += 1;
      return jsonResponse(200, { access_token: issued === 1 ? ACCESS_TOKEN : "second-token", token_type: "Bearer", expires_in: 3600 });
    }
    return sandbox.handler(url, init);
  });
  const silence = captureConsole();
  try {
    await flash.requestAccessToken(SANDBOX);            // caches the stale token
    const products = await flash.listAccountProducts(SANDBOX);
    assert.equal(products.statusCode, 200);
    assert.equal(issued, 2, "the rejected cached token must trigger exactly one re-authentication");
  } finally {
    silence.restore();
    restore();
  }
});

test("a token rejected twice fails rather than retrying forever", async () => {
  let issued = 0;
  const restore = mockFetch(async (url) => {
    if (String(url).endsWith("/token")) {
      issued += 1;
      return jsonResponse(200, { access_token: `token-${issued}`, token_type: "Bearer", expires_in: 3600 });
    }
    return jsonResponse(401, { responseMessage: "Token expired" });
  });
  const silence = captureConsole();
  try {
    await flash.requestAccessToken(SANDBOX);
    await assert.rejects(() => flash.listAccountProducts(SANDBOX), (error) => {
      assert.equal(error.details.code, "FLASH_AUTHENTICATION_REJECTED");
      return true;
    });
    assert.equal(issued, 2, "one retry, not a loop");
  } finally {
    silence.restore();
    restore();
  }
});

test("changing the API key invalidates the cached token", async () => {
  const sandbox = flashSandbox({ expectedApiKey: API_KEY });
  const restore = mockFetch(async (url, init) => {
    if (String(url).endsWith("/token")) {
      return jsonResponse(200, { access_token: `token-for-${(init.headers || {}).authorization}`, token_type: "Bearer", expires_in: 3600 });
    }
    return sandbox.handler(url, init);
  });
  const silence = captureConsole();
  try {
    const first = await flash.requestAccessToken(SANDBOX);
    const second = await flash.requestAccessToken({ ...SANDBOX, apiKey: "a-rotated-key" });
    assert.equal(second.cached, false);
    assert.notEqual(first.accessToken, second.accessToken);
  } finally {
    silence.restore();
    restore();
  }
});

/* --------------------------------------- 4. product list / account validation */

test("a successful test authenticates and then reads the account product list", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.ok, true);
    assert.equal(result.status, "connected");
    assert.equal(result.providerResponse.accessTokenIssued, true);
    assert.equal(result.providerResponse.tokenExpiresInSeconds, 3600);
    assert.equal(result.providerResponse.productCount, 3);
    assert.deepEqual(result.providerResponse.productGroups, ["Cellular", "Prepaid Utilities", "1Voucher"]);

    const productCall = sandbox.calls.find((call) => call.url.includes("/products"));
    assert.equal(productCall.url, `https://api-flashswitch-sandbox.flash-group.com/aggregation/4.0/accounts/${ACCOUNT_NUMBER}/products`);
    assert.equal(productCall.method, "GET");
    assert.equal(productCall.headers.accept, "application/json");
    assert.equal(productCall.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  } finally {
    silence.restore();
    restore();
  }
});

test("an unknown account number is an account validation failure, not an auth failure", async () => {
  const sandbox = flashSandbox({ productsStatus: 404 });
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.ok, false);
    assert.equal(result.status, "account_validation_failed");
    assert.equal(result.errorCode, "FLASH_ACCOUNT_NOT_FOUND");
    // The token step did succeed, and the diagnostic says so.
    assert.equal(result.providerResponse.accessTokenIssued, true);
    assert.equal(result.providerResponse.step, "products");
  } finally {
    silence.restore();
    restore();
  }
});

test("the connection test never initiates a purchase", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    await flash.testFlashConnection(SANDBOX);
    for (const call of sandbox.calls) {
      if (call.url.endsWith("/token")) continue;
      assert.equal(call.method, "GET", `${call.url} must be a read`);
      assert.match(call.url, /\/products$/);
    }
  } finally {
    silence.restore();
    restore();
  }
});

test("an empty product list is still a real answer from Flash", async () => {
  const sandbox = flashSandbox({ productsBody: { responseCode: 0, products: [] } });
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.status, "connected");
    assert.equal(result.providerResponse.productCount, 0);
  } finally {
    silence.restore();
    restore();
  }
});

/* --------------------------------------------- 5. Flash responseCode handling */

test("HTTP 200 with a non-zero responseCode is a failure, never connected", async () => {
  const sandbox = flashSandbox({ productsBody: { responseCode: 7, responseMessage: "Account suspended" } });
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.ok, false);
    assert.equal(result.status, "account_validation_failed");
    assert.equal(result.errorCode, "FLASH_RESPONSE_CODE_ERROR");
    assert.equal(result.providerResponse.responseCode, 7);
    assert.match(result.error, /responseCode 7/);
  } finally {
    silence.restore();
    restore();
  }
});

test("responseCode 0 is a success and an absent responseCode is not treated as failure", () => {
  assert.equal(flash.assertFlashResponseCode({ responseCode: 0 }, { operation: "test" }), 0);
  assert.equal(flash.assertFlashResponseCode({ products: [] }, { operation: "test" }), null);
  assert.equal(flash.flashResponseCode({ responseCode: "0" }), 0);
  assert.equal(flash.flashResponseCode({}), null);
  assert.throws(() => flash.assertFlashResponseCode({ responseCode: -1 }, { operation: "test" }), /responseCode -1/);
});

test("a non-zero responseCode on the token call blocks the account read", async () => {
  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/token")) {
      return jsonResponse(200, { responseCode: 12, responseMessage: "Client disabled", access_token: ACCESS_TOKEN });
    }
    return jsonResponse(200, { responseCode: 0, products: [] });
  });
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.status, "authentication_failed");
    assert.equal(result.errorCode, "FLASH_RESPONSE_CODE_ERROR");
    assert.equal(calls.filter((url) => url.includes("/products")).length, 0);
  } finally {
    silence.restore();
    restore();
  }
});

/* ---------------------------------------------------------- 6. network timeout */

test("a network timeout is a connection failure, distinct from an auth failure", async () => {
  const restore = mockFetch(async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  });
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.ok, false);
    assert.equal(result.status, "connection_failed");
    assert.equal(result.errorCode, "FLASH_NETWORK_TIMEOUT");
  } finally {
    silence.restore();
    restore();
  }
});

test("an unreachable host is a connection failure", async () => {
  const restore = mockFetch(async () => { throw new Error("getaddrinfo ENOTFOUND api-flashswitch-sandbox.flash-group.com"); });
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.status, "connection_failed");
    assert.equal(result.errorCode, "FLASH_NETWORK_ERROR");
  } finally {
    silence.restore();
    restore();
  }
});

test("Flash returning a 5xx is a connection failure, not a credential problem", async () => {
  const sandbox = flashSandbox({ tokenStatus: 503, tokenBody: { message: "Service unavailable" } });
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.status, "connection_failed");
    assert.equal(result.errorCode, "FLASH_PROVIDER_UNAVAILABLE");
  } finally {
    silence.restore();
    restore();
  }
});

test("a timeout during account validation is a connection failure, not an account problem", async () => {
  let call = 0;
  const restore = mockFetch(async (url) => {
    call += 1;
    if (String(url).endsWith("/token")) return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection(SANDBOX);
    assert.equal(result.status, "connection_failed");
    assert.equal(result.errorCode, "FLASH_NETWORK_TIMEOUT");
    assert.equal(result.providerResponse.accessTokenIssued, true);
    assert.ok(call >= 2);
  } finally {
    silence.restore();
    restore();
  }
});

/* -------------------------------------------------------- 7. credential masking */

test("the API key is a secret field and is masked, and the account number is not", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /SECRET_FIELD_NAMES = new Set\(\[[^\]]*"apiKey"/);
  assert.match(source, /accountNumber: "Flash Account Number"/);
  // Flash asks for the credential and the account number, and nothing else.
  const definition = source.slice(source.indexOf("  flash: {"), source.indexOf("  smtp: {"));
  assert.match(definition, /fields: \["enabled", "environment", "baseUrl", "apiKey", "accountNumber"\]/);
  assert.match(definition, /secretKeys: \["apiKey"\]/);
  for (const dropped of ["apiSecret", "username", "password", "webhookSecret", "merchantId"]) {
    assert.ok(!definition.includes(`"${dropped}"`), `Flash must not ask for ${dropped}`);
  }
});

test("stored secrets are encrypted at rest through the existing mechanism", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /value\.secrets\[`\$\{field\}Encrypted`\] = encryptSecret\(submittedValue\)/);
  assert.match(source, /value\.secrets\[`\$\{field\}Masked`\] = maskSecret\(submittedValue\)/);
  assert.match(source, /aes-256-gcm/);
});

test("scrub removes the API key and the access token from provider text", () => {
  const text = `Rejected key ${API_KEY} using Bearer ${ACCESS_TOKEN}`;
  const scrubbed = flash.scrub(text, { apiKey: API_KEY, accessToken: ACCESS_TOKEN });
  assert.ok(!scrubbed.includes(API_KEY));
  assert.ok(!scrubbed.includes(ACCESS_TOKEN));
  assert.match(scrubbed, /\[redacted\]/);
});

/* ------------------------------------------------------ 8. environment switching */

test("production uses the production endpoint with the same contract", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    const result = await flash.testFlashConnection({ ...SANDBOX, environment: "production" });
    assert.equal(result.ok, true);
    assert.equal(result.environment, "production");
    assert.equal(sandbox.calls[0].url, "https://api.flashswitch.flash-group.com/token");
    assert.match(result.providerResponse.productsEndpoint, /^https:\/\/api\.flashswitch\.flash-group\.com\/aggregation\/4\.0\/accounts\//);
  } finally {
    silence.restore();
    restore();
  }
});

test("the documented endpoints are exactly the two Flash publishes", () => {
  assert.deepEqual(flash.FLASH_SERVICE_URLS, {
    sandbox: "https://api-flashswitch-sandbox.flash-group.com",
    production: "https://api.flashswitch.flash-group.com"
  });
  assert.equal(flash.defaultFlashBaseUrl("sandbox"), "https://api-flashswitch-sandbox.flash-group.com");
  assert.equal(flash.defaultFlashBaseUrl("production"), "https://api.flashswitch.flash-group.com");
  // An unrecognised environment falls back to sandbox, never to production.
  assert.equal(flash.defaultFlashBaseUrl(""), "https://api-flashswitch-sandbox.flash-group.com");
  assert.equal(flash.normalizeEnvironment("live"), "production");
});

test("the Admin provider carries both environment defaults so the form can follow the dropdown", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /defaultBaseUrls: FLASH_SERVICE_URLS/);
  assert.match(source, /defaultBaseUrl: provider\.defaultBaseUrls\?\.\[environment\] \|\| provider\.defaultBaseUrl/);
});

/* --------------------------------------- 9. no secrets in logs or API responses */

test("no log line written during a successful test contains the key or the token", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const capture = captureConsole();
  let result;
  try {
    result = await flash.testFlashConnection(SANDBOX);
  } finally {
    capture.restore();
    restore();
  }
  assert.equal(result.status, "connected");
  assert.ok(capture.lines.length > 0, "the test must still be logged for diagnostics");
  const logged = capture.lines.join("\n");
  assert.ok(!logged.includes(API_KEY), "the API key must never be logged");
  assert.ok(!logged.includes(ACCESS_TOKEN), "the access token must never be logged");
  // Diagnostics stay useful: the endpoint and status are logged.
  assert.match(logged, /api-flashswitch-sandbox\.flash-group\.com/);
  assert.match(logged, /httpStatus/);
});

test("no log line written during a failed test contains the key, even when Flash echoes it", async () => {
  const sandbox = flashSandbox({
    tokenStatus: 401,
    tokenBody: { error: "invalid_client", error_description: `Unknown client ${API_KEY}` }
  });
  const restore = mockFetch(sandbox.handler);
  const capture = captureConsole();
  let result;
  try {
    result = await flash.testFlashConnection(SANDBOX);
  } finally {
    capture.restore();
    restore();
  }
  assert.equal(result.status, "authentication_failed");
  const logged = capture.lines.join("\n");
  assert.ok(!logged.includes(API_KEY), "an echoed key must be scrubbed before it is logged");
  assert.ok(!result.error.includes(API_KEY), "an echoed key must be scrubbed out of the Admin message");
});

test("the connection result carries no credential value anywhere in it", async () => {
  const sandbox = flashSandbox();
  const restore = mockFetch(sandbox.handler);
  const silence = captureConsole();
  try {
    for (const effective of [SANDBOX, { ...SANDBOX, apiKey: "wrong-key" }]) {
      const result = await flash.testFlashConnection(effective);
      const serialised = JSON.stringify(result);
      assert.ok(!serialised.includes(API_KEY));
      assert.ok(!serialised.includes("wrong-key"));
      assert.ok(!serialised.includes(ACCESS_TOKEN));
    }
  } finally {
    silence.restore();
    restore();
  }
});

test("the API never returns the Flash credential to the Admin Portal", () => {
  const source = readSource("routes", "admin.routes.js");
  // The test result reports presence only for credentials, and the account
  // number — an identifier, not a secret — by value.
  assert.match(source, /apiKey: Boolean\(effective\.apiKey\)/);
  assert.match(source, /accountNumber: providerKey === "flash" \? effective\.accountNumber \|\| "" : undefined/);
});

test("the Flash service never sends a credential to any endpoint but Flash's own", async () => {
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ url: String(url), authorization: (init.headers || {}).authorization });
    return jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3600, responseCode: 0, products: [] });
  });
  const silence = captureConsole();
  try {
    await flash.testFlashConnection(SANDBOX);
    for (const call of seen) {
      assert.match(call.url, /^https:\/\/api-flashswitch-sandbox\.flash-group\.com\//);
    }
  } finally {
    silence.restore();
    restore();
  }
});

/* ---------------------------------------------------------------- idempotency */

test("the same TitoPay reference always produces the same Flash reference", () => {
  const first = flash.flashTransactionReference("TP-TXN-000123456");
  const second = flash.flashTransactionReference("TP-TXN-000123456");
  assert.equal(first, second);
  assert.notEqual(first, flash.flashTransactionReference("TP-TXN-000123457"));
  assert.match(first, /^[A-Z0-9]+$/);
  assert.ok(first.length >= 12 && first.length <= 32);
  assert.throws(() => flash.flashTransactionReference(""), /reference is required/);
});

test("a short reference is padded deterministically rather than randomly", () => {
  const first = flash.flashTransactionReference("TP-1");
  const second = flash.flashTransactionReference("TP-1");
  assert.equal(first, second);
  assert.ok(first.startsWith("TP1"));
});

/* ------------------------------------------- 10. existing provider regressions */

test("the Flash test is dispatched to the Flash service and nothing else changed hands", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /} else if \(providerKey === "flash"\) \{\n(?:.*\n)*?\s+connection = await testFlashConnection\(effective\);/);
  // Peach keeps its own two independent tests.
  assert.match(source, /providerKey === "peach_payments"[\s\S]{0,400}testCheckoutAuthentication\(effective\)/);
  assert.match(source, /providerKey === "peach_payouts"[\s\S]{0,400}testPayoutConnection\(effective\)/);
});

test("every other provider keeps the fields it had", () => {
  const source = readSource("routes", "admin.routes.js");
  const definition = (key, next) => source.slice(source.indexOf(`  ${key}: {`), source.indexOf(`  ${next}: {`));
  assert.match(definition("ott", "flash"), /fields: \["enabled", "environment", "baseUrl", "apiKey", "apiSecret", "username", "password", "merchantId", "webhookSecret", "callbackUrl"\]/);
  assert.match(definition("docfox", "ott"), /secretKeys: \["apiKey", "apiSecret", "clientSecret", "webhookSecret"\]/);
  assert.match(definition("smtp", "sms"), /requiredFields: \["baseUrl", "smtpPort", "senderEmail", "username", "password"\]/);
  assert.match(definition("peach_payouts", "pos_provider"), /requiredFields: \["baseUrl", "clientId", "clientSecret", "merchantId"\]/);
});

test("OTT keeps its Basic username/password authentication", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /providerKey === "ott" && effective\.username && effective\.password\) return "basic_username_password"/);
  assert.match(source, /providerKey === "ott" && effective\.username && effective\.password\) \{\n\s+headers\.authorization = `Basic/);
  // Flash no longer claims Basic username/password; it is OAuth now.
  assert.match(source, /providerKey === "flash"\) return "oauth_client_credentials"/);
});

test("a provider that classifies its own failure keeps that classification", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /status: connection\.ok\n\s+\? \(connection\.status \|\| \(providerKey === "pos_provider" \? "ready" : "connected"\)\)\n\s+: \(connection\.status \|\| "failed"\)/);
});

test("the Flash webhook event endpoint still reads its secret from the environment", () => {
  const source = readSource("routes", "integrations.routes.js");
  // Dropping webhookSecret from the Flash provider form must not disturb the
  // existing webhook-event registry, which never read the stored value.
  assert.match(source, /flash: process\.env\.FLASH_WEBHOOK_SECRET \|\| ""/);
  assert.match(source, /WEBHOOK_PROVIDERS = \["peach_payments", "docfox", "ott", "flash", "smtp", "sms"\]/);
});

test("no other provider was pointed at the Flash service", () => {
  const source = readSource("routes", "admin.routes.js");
  const matches = source.match(/testFlashConnection\(/g) || [];
  assert.equal(matches.length, 1, "exactly one call site");
});
