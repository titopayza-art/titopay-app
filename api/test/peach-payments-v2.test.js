"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "peach-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "peach-test-refresh-secret";
process.env.PEACH_PAYMENTS_V2_ENABLED = "true";
process.env.PEACH_PAYMENTS_API_KEY = "test-api-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("../src/config/env");
const peach = require("../src/services/peach-payments-service");

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

test("Peach connection test authenticates against the Checkout sandbox auth service", async () => {
  let request;
  const restore = mockFetch(async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify({ access_token: "sandbox-access-token", expires_in: "3600", token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox",
      clientId: "sandbox-client-id",
      clientSecret: "sandbox-client-secret",
      merchantId: "sandbox-merchant-id"
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "connected");
    assert.equal(result.environment, "sandbox");
    assert.equal(result.integration, "checkout_v2");
    assert.equal(result.authenticationType, "oauth_client_credentials");
    assert.equal(result.providerResponse.accessTokenIssued, true);
    assert.equal(result.providerResponse.expiresInSeconds, 3600);

    assert.equal(request.url, "https://sandbox-dashboard.peachpayments.com/api/oauth/token");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(request.options.body), {
      clientId: "sandbox-client-id",
      clientSecret: "sandbox-client-secret",
      merchantId: "sandbox-merchant-id"
    });
  } finally { restore(); }
});

test("Peach connection test uses the live auth service for production", async () => {
  let request;
  const restore = mockFetch(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ access_token: "live-token", expires_in: 600 }), { status: 200 });
  });
  try {
    const result = await peach.testPeachConnection({
      environment: "production",
      clientId: "live-client-id",
      clientSecret: "live-client-secret",
      merchantId: "live-merchant-id"
    });
    assert.equal(result.ok, true);
    assert.equal(request.url, "https://dashboard.peachpayments.com/api/oauth/token");
  } finally { restore(); }
});

test("Peach rejects the HTTP 400 invalid-credential response as an authentication failure", async () => {
  const restore = mockFetch(async () => new Response(
    JSON.stringify({ message: "Invalid client ID or secret." }),
    { status: 400, headers: { "content-type": "application/json" } }
  ));
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox",
      clientId: "wrong",
      clientSecret: "wrong",
      merchantId: "wrong"
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "AUTHENTICATION_REJECTED");
    assert.equal(result.providerResponse.statusCode, 400);
  } finally { restore(); }
});

test("Peach reports a 403 as an authentication rejection, never as connected", async () => {
  const restore = mockFetch(async () => new Response("Forbidden", { status: 403 }));
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox",
      clientId: "client",
      clientSecret: "secret",
      merchantId: "merchant"
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "AUTHENTICATION_REJECTED");
  } finally { restore(); }
});

test("Peach reports a 5xx as provider unavailable", async () => {
  const restore = mockFetch(async () => new Response("", { status: 503 }));
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox", clientId: "a", clientSecret: "b", merchantId: "c"
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "PROVIDER_UNAVAILABLE");
  } finally { restore(); }
});

test("Peach connection test distinguishes network timeout", async () => {
  const restore = mockFetch(async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox", clientId: "a", clientSecret: "b", merchantId: "c"
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "NETWORK_TIMEOUT");
  } finally { restore(); }
});

test("Peach reports missing configuration without calling the provider", async () => {
  let called = false;
  const restore = mockFetch(async () => { called = true; return new Response("{}", { status: 200 }); });
  try {
    const result = await peach.testPeachConnection({ environment: "sandbox", clientId: "only-client-id" });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "INVALID_CONFIGURATION");
    assert.deepEqual(result.providerResponse.missingFields, ["clientSecret", "merchantId"]);
  } finally { restore(); }
});

test("A 200 response without an access token is not reported as connected", async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox", clientId: "a", clientSecret: "b", merchantId: "c"
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "AUTHENTICATION_FAILED");
  } finally { restore(); }
});

test("No credential or token value is ever returned to the caller", async () => {
  const restore = mockFetch(async () => new Response(
    JSON.stringify({ message: "Invalid client ID or secret. supplied super-secret-value" }),
    { status: 400 }
  ));
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox",
      clientId: "client-id-value",
      clientSecret: "super-secret-value",
      merchantId: "merchant-id-value"
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /super-secret-value/);
    assert.doesNotMatch(serialized, /client-id-value/);
    assert.doesNotMatch(serialized, /merchant-id-value/);
  } finally { restore(); }
});

test("Snake_case saved credentials resolve to the documented request body", async () => {
  let request;
  const restore = mockFetch(async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
  });
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox",
      client_id: "snake-client",
      client_secret: "snake-secret",
      merchant_id: "snake-merchant"
    });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(request.options.body), {
      clientId: "snake-client",
      clientSecret: "snake-secret",
      merchantId: "snake-merchant"
    });
  } finally { restore(); }
});

test("Test Connection always calls Peach and never serves a cached token", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
  });
  try {
    const credentials = { environment: "sandbox", clientId: "a", clientSecret: "b", merchantId: "c" };
    await peach.testPeachConnection(credentials);
    await peach.testPeachConnection(credentials);
    assert.equal(calls, 2);
  } finally { restore(); }
});

test("Peach status normalization covers the payment lifecycle", () => {
  assert.equal(peach.normalizedStatus("pending"), "pending");
  assert.equal(peach.normalizedStatus("succeeded"), "completed");
  assert.equal(peach.normalizedStatus("cancelled"), "cancelled");
  assert.equal(peach.normalizedStatus("expired"), "expired");
  assert.equal(peach.normalizedStatus("refunded"), "refunded");
});

test("A failed test reports the endpoint that was actually called", async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ message: "Invalid client ID or secret." }), { status: 400 }));
  try {
    const result = await peach.testPeachConnection({
      environment: "sandbox",
      sandboxAuthUrl: "https://auth-override.example.test",
      clientId: "a",
      clientSecret: "b",
      merchantId: "c"
    });
    assert.equal(result.ok, false);
    assert.equal(result.providerResponse.endpoint, "https://auth-override.example.test/api/oauth/token");
  } finally { restore(); }
});
