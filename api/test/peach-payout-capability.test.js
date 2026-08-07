"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "payout-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "payout-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const payout = require("../src/services/peach-payout-service");

function readSource(...parts) {
  return fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");
}

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

const CREDENTIALS = {
  environment: "sandbox",
  baseUrl: "https://sandbox-payouts.peachpayments.com/api",
  clientId: "payout-client",
  clientSecret: "payout-secret",
  merchantId: "payout-merchant"
};

/* ------------------------------------------------- documented endpoints */

test("Payout uses the documented Peach Payouts hosts", () => {
  assert.equal(payout.PAYOUT_SERVICE_URLS.sandbox, "https://sandbox-payouts.peachpayments.com/api");
  assert.equal(payout.PAYOUT_SERVICE_URLS.production, "https://payouts.peachpayments.com/api");
  assert.equal(payout.AUTH_SERVICE_URLS.sandbox, "https://sandbox-dashboard.peachpayments.com");
  assert.equal(payout.AUTH_SERVICE_URLS.production, "https://dashboard.peachpayments.com");
  assert.equal(payout.OAUTH_TOKEN_PATH, "/api/oauth/token");
});

test("A configured payout base URL always wins over the default", () => {
  assert.equal(payout.payoutBaseUrl({ environment: "sandbox", baseUrl: "https://payouts.example.test/api" }), "https://payouts.example.test/api");
  assert.equal(payout.payoutBaseUrl({ environment: "sandbox" }), "https://sandbox-payouts.peachpayments.com/api");
});

/* ----------------------------------------------------- not configured */

test("Payout reports PAYOUT_NOT_CONFIGURED without calling anything", async () => {
  let called = false;
  const restore = mockFetch(async () => { called = true; return new Response("{}", { status: 200 }); });
  try {
    const result = await payout.testPayoutConnection({ environment: "sandbox" });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.status, "not_configured");
    assert.equal(result.errorCode, "PAYOUT_NOT_CONFIGURED");
    assert.equal(result.error, "Payout endpoint not configured");
  } finally { restore(); }
});

test("Missing credentials are listed without exposing any value", async () => {
  const restore = mockFetch(async () => new Response("{}", { status: 200 }));
  try {
    const result = await payout.testPayoutConnection({ environment: "sandbox", baseUrl: "https://payouts.example.test/api" });
    assert.deepEqual(result.providerResponse.missingFields, ["clientId", "clientSecret", "merchantId"]);
    assert.doesNotMatch(JSON.stringify(result), /payout-secret/);
  } finally { restore(); }
});

/* --------------------------------------------- real authenticated test */

test("Payout Test Connection authenticates and reads the balance", async () => {
  const calls = [];
  const restore = mockFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/api/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "payout-token", expires_in: 1800 }), { status: 200 });
    }
    return new Response(JSON.stringify({ balance: 1500, currency: "ZAR" }), { status: 200 });
  });
  try {
    payout.clearPayoutTokenCache();
    const result = await payout.testPayoutConnection(CREDENTIALS);
    assert.equal(result.ok, true);
    assert.equal(result.status, "connected");
    assert.equal(result.capability, "payout");
    assert.equal(result.providerResponse.accessTokenIssued, true);

    // The credentials sent are the PAYOUT ones, in the documented body.
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      clientId: "payout-client", clientSecret: "payout-secret", merchantId: "payout-merchant"
    });
    // The balance call goes to the payout host with a bearer token.
    assert.equal(calls[1].url, "https://sandbox-payouts.peachpayments.com/api/merchants/payout-merchant/balance");
    assert.equal(calls[1].options.headers.authorization, "Bearer payout-token");
  } finally { restore(); payout.clearPayoutTokenCache(); }
});

test("Payout never falls back to the Checkout endpoint", async () => {
  const urls = [];
  const restore = mockFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes("/api/oauth/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 60 }), { status: 200 });
    return new Response(JSON.stringify({ balance: 0 }), { status: 200 });
  });
  try {
    payout.clearPayoutTokenCache();
    await payout.testPayoutConnection(CREDENTIALS);
    assert.ok(!urls.some((url) => /testsecure\.peachpayments\.com|secure\.peachpayments\.com|\/v2\/checkout/.test(url)),
      `payout must never touch a Checkout host: ${urls.join(", ")}`);
  } finally { restore(); payout.clearPayoutTokenCache(); }
});

test("A rejected payout credential is an authentication failure, not a config error", async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ message: "Invalid client ID or secret." }), { status: 400 }));
  try {
    payout.clearPayoutTokenCache();
    const result = await payout.testPayoutConnection(CREDENTIALS);
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "PAYOUT_AUTHENTICATION_REJECTED");
  } finally { restore(); payout.clearPayoutTokenCache(); }
});

test("No payout credential or token is ever returned to the caller", async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ message: "rejected payout-secret" }), { status: 401 }));
  try {
    payout.clearPayoutTokenCache();
    const result = await payout.testPayoutConnection(CREDENTIALS);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /payout-secret/);
    assert.doesNotMatch(serialized, /payout-client/);
  } finally { restore(); payout.clearPayoutTokenCache(); }
});

/* ------------------------------------------------------ withdrawal safety */

test("Payouts stay unavailable until configured, enabled and verified", async () => {
  assert.equal(payout.payoutAvailability.constructor.name, "AsyncFunction");
  // A connection test that has not succeeded blocks submission.
  assert.throws(() => payout.assertPayoutAvailable({ available: false, reason: "PAYOUT_NOT_VERIFIED" }), /verified/i);
  assert.throws(() => payout.assertPayoutAvailable({ available: false, reason: "PAYOUT_NOT_CONFIGURED" }), /not configured/i);
  assert.throws(() => payout.assertPayoutAvailable({ available: false, reason: "PAYOUT_DISABLED" }), /disabled/i);
  assert.doesNotThrow(() => payout.assertPayoutAvailable({ available: true }));
});

test("Every blocked-payout message states that no wallet debit was made", () => {
  for (const reason of ["PAYOUT_DISABLED", "PAYOUT_NOT_VERIFIED"]) {
    assert.throws(
      () => payout.assertPayoutAvailable({ available: false, reason }),
      /No wallet debit was made/,
      `${reason} must reassure the customer`
    );
  }
});

test("A payout entry is built from the documented fields only", () => {
  const entry = payout.buildPayoutEntry({
    currency: "ZAR", amount: 100, accountNumber: "1234567890", branchCode: "250655",
    reference: "TP-WD-1", bankName: "FNB", accountHolder: "A Customer", payoutMethod: "EFT",
    merchantReference: "TP-WD-1", payoutId: "po_1"
  });
  assert.deepEqual(Object.keys(entry).sort(), [
    "accountHolder", "accountNumber", "amount", "bankName", "branchCode", "currency",
    "merchantReference", "payoutId", "payoutMethod", "reference"
  ].sort());
});

test("An incomplete payout is refused before it reaches Peach", () => {
  assert.throws(() => payout.buildPayoutEntry({ currency: "ZAR", amount: 100 }), /incomplete/i);
  assert.throws(() => payout.buildPayoutEntry({
    currency: "ZAR", amount: 0, accountNumber: "1", branchCode: "2",
    reference: "r", bankName: "b", accountHolder: "h", payoutMethod: "EFT"
  }), /incomplete/i);
});

/* ------------------------------------------- separation from Collection */

test("Collection and payout are stored in separate settings rows", () => {
  const source = readSource("services", "peach-config-service.js");
  assert.match(source, /const SETTING_KEY = "integration_peach_payments"/);
  assert.match(source, /const PAYOUT_SETTING_KEY = "integration_peach_payouts"/);
  // The payout loader must not read the Collection row or its env fallbacks.
  const loader = source.slice(source.indexOf("async function loadPeachPayoutConfig"));
  const body = loader.slice(0, loader.indexOf("\n}"));
  // The Collection row key must not appear on its own (PAYOUT_SETTING_KEY may).
  assert.doesNotMatch(body, /(?<!PAYOUT_)\bSETTING_KEY\b/);
  assert.doesNotMatch(body, /peachPayments/);
});

test("The payout provider is registered with its own credentials and is not routable", () => {
  const source = readSource("routes", "admin.routes.js");
  const entry = source.slice(source.indexOf("  peach_payouts: {"));
  const block = entry.slice(0, entry.indexOf("\n  },"));
  assert.match(block, /capability: "payout"/);
  assert.match(block, /routingEligible: false/);
  assert.match(block, /requiredFields: \["baseUrl", "clientId", "clientSecret", "merchantId"\]/);
  assert.match(block, /secretKeys: \["clientSecret", "webhookSecret"\]/);
  // Payout must never inherit a Collection environment variable.
  assert.doesNotMatch(block, /PEACH_PAYMENTS_/);
});

test("The payout connection test is routed to the payout service only", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /providerKey === "peach_payouts"[\s\S]{0,400}testPayoutConnection\(effective\)/);
  // Collection keeps its own, unchanged test.
  assert.match(source, /providerKey === "peach_payments"[\s\S]{0,400}testCheckoutAuthentication\(effective\)/);
});

test("Collection top-up still runs on Checkout, never on the payout host", () => {
  const source = readSource("services", "peach-checkout-service.js");
  assert.doesNotMatch(source, /payouts\.peachpayments\.com/);
  assert.match(source, /CHECKOUT_SERVICE_URLS/);
  const payoutSource = readSource("services", "peach-payout-service.js");
  assert.doesNotMatch(payoutSource, /v2\/checkout/);
});

/* ------------------------------------- masked placeholder must never store */

test("A masked display value is never stored as a secret", () => {
  const source = readSource("routes", "admin.routes.js");
  assert.match(source, /function isMaskedSecretPlaceholder/);
  // Both write paths guard: the config save and the credential rotation.
  assert.match(source, /submittedValue && !isMaskedSecretPlaceholder\(submittedValue\)/);
  assert.match(source, /submitted && !isMaskedSecretPlaceholder\(submitted\)/);
});

test("A secret poisoned by an earlier save reads as unconfigured, not as a credential", () => {
  for (const file of [["routes", "admin.routes.js"], ["services", "peach-config-service.js"]]) {
    const source = readSource(...file);
    assert.match(source, /isMaskedSecretPlaceholder\(decrypted\)/, `${file.join("/")} must discard a decrypted mask`);
  }
});

test("The placeholder test catches the shapes the portal can render", () => {
  // Mirrors admin.routes.js / peach-config-service.js.
  const isMasked = (value) => {
    const text = String(value ?? "").trim();
    return text.startsWith("••••") || /^[•*]{3,}/.test(text);
  };
  for (const masked of ["••••1234", "••••CRET", "••••", "****1234", "•••••••"]) {
    assert.equal(isMasked(masked), true, `${masked} must be treated as a placeholder`);
  }
  for (const real of ["PayoutSecret123", "abc", "sk_live_1234", "a•b"]) {
    assert.equal(isMasked(real), false, `${real} is a real credential and must be stored`);
  }
});

/* --------------------------------------------- the test is always a live call */

test("Payout Test Connection never answers from the token cache", () => {
  const source = readSource("services", "peach-payout-service.js");
  const fn = source.slice(source.indexOf("async function testPayoutConnection"));
  assert.match(fn.slice(0, fn.indexOf("} catch")), /skipCache: true/);
});

test("A payout failure reports Peach's own reason and a credential fingerprint", async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ message: "Invalid client ID or secret." }), { status: 400 }));
  try {
    payout.clearPayoutTokenCache();
    const result = await payout.testPayoutConnection(CREDENTIALS);
    assert.match(result.error, /Peach said/i);
    assert.match(result.error, /Invalid client ID or secret/i);
    const fingerprint = result.providerResponse.credentials;
    assert.equal(fingerprint.clientIdLength, CREDENTIALS.clientId.length);
    assert.equal(fingerprint.clientSecretLength, CREDENTIALS.clientSecret.length);
    assert.equal(fingerprint.merchantIdLength, CREDENTIALS.merchantId.length);
    // A fingerprint, never a value.
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /payout-secret/);
    assert.doesNotMatch(serialized, /payout-client\b/);
    assert.equal(fingerprint.clientSecret, undefined);
  } finally { restore(); payout.clearPayoutTokenCache(); }
});

test("The failure names the auth endpoint that was actually called", async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ message: "nope" }), { status: 401 }));
  try {
    payout.clearPayoutTokenCache();
    const result = await payout.testPayoutConnection(CREDENTIALS);
    assert.equal(result.providerResponse.authEndpoint, "https://sandbox-dashboard.peachpayments.com/api/oauth/token");
  } finally { restore(); payout.clearPayoutTokenCache(); }
});
