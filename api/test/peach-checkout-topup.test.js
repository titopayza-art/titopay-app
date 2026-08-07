"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "checkout-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "checkout-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const checkout = require("../src/services/peach-checkout-service");

/* ------------------------------------------------ Peach result-code mapping */

test("Peach success codes credit, and nothing else does", () => {
  assert.equal(checkout.statusFromResultCode("000.000.000"), "successful");
  assert.equal(checkout.statusFromResultCode("000.100.110"), "successful");
  assert.equal(checkout.statusFromResultCode("000.300.000"), "successful");
  assert.equal(checkout.statusFromResultCode("000.600.000"), "successful");

  assert.equal(checkout.transactionStatusFor(checkout.statusFromResultCode("000.100.110")), "completed");
});

test("A pending Peach code never becomes a failure", () => {
  assert.equal(checkout.statusFromResultCode("000.200.000"), "pending");
  assert.equal(checkout.statusFromResultCode("000.200.100"), "pending");
  assert.equal(checkout.transactionStatusFor("pending"), "pending");
});

test("An uncertain payment stays open because Peach may still complete it", () => {
  // 100.396.104 can still turn into a successful payment later. Failing it here
  // would tell a customer to retry a payment that is about to succeed.
  assert.equal(checkout.statusFromResultCode("100.396.104"), "pending");
  assert.equal(checkout.transactionStatusFor(checkout.statusFromResultCode("100.396.104")), "pending");
});

test("A customer cancellation is cancelled, not failed", () => {
  assert.equal(checkout.statusFromResultCode("100.396.101"), "cancelled");
  assert.equal(checkout.transactionStatusFor("cancelled"), "cancelled");
});

test("Declines and errors fail", () => {
  assert.equal(checkout.statusFromResultCode("800.100.152"), "failed");
  assert.equal(checkout.statusFromResultCode("100.100.101"), "failed");
  assert.equal(checkout.transactionStatusFor("failed"), "failed");
});

test("Manual-review codes are never auto-credited", () => {
  // Peach treats 000.400.0xx as successful-but-review. A wallet credit is a
  // one-way door, so these are held as processing for an operator instead.
  assert.equal(checkout.statusFromResultCode("000.400.000"), "review");
  assert.equal(checkout.statusFromResultCode("000.400.100"), "review");
  assert.equal(checkout.statusFromResultCode("800.400.500"), "review");
  assert.equal(checkout.transactionStatusFor("review"), "processing");
  assert.notEqual(checkout.transactionStatusFor("review"), "completed");
});

test("An empty or unknown result code does not credit", () => {
  assert.equal(checkout.statusFromResultCode(""), "pending");
  assert.equal(checkout.statusFromResultCode(null), "pending");
  assert.notEqual(checkout.transactionStatusFor(checkout.statusFromResultCode("")), "completed");
});

/* ----------------------------------------------- verification uses Peach */

test("Checkout status is read from Peach with a bearer token, never from the caller", async () => {
  const original = global.fetch;
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      "result.code": "000.100.110",
      amount: "250.50",
      currency: "ZAR",
      merchantTransactionId: "TP-TOPUP-TEST",
      id: "peach-payment-id",
      paymentBrand: "VISA"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  // getAccessToken is exercised through the auth service; stub its token call.
  const authService = require("../src/services/peach-checkout-auth-service");
  authService.clearTokenCache();
  const realFetch = global.fetch;
  let call = 0;
  global.fetch = async (url, options) => {
    call += 1;
    if (String(url).includes("/api/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "verify-token", expires_in: 1800 }), { status: 200 });
    }
    return realFetch(url, options);
  };
  try {
    const verified = await checkout.verifyWithPeach(
      { environment: "sandbox", clientId: "a", clientSecret: "b", merchantId: "c", entityId: "e" },
      "checkout-123"
    );
    assert.equal(verified.providerState, "successful");
    assert.equal(verified.amount, 250.5);
    assert.equal(verified.currency, "ZAR");
    assert.equal(verified.resultCode, "000.100.110");
    assert.match(request.url, /\/v2\/checkout\/checkout-123\/status$/);
    assert.equal(request.options.headers.authorization, "Bearer verify-token");
  } finally {
    global.fetch = original;
    authService.clearTokenCache();
  }
});

/* --------------------------------------- the wallet-debit path is not used */

test("Card top-up service codes are refused by the wallet-debit transaction path", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  assert.match(source, /CARD_TOPUP_SERVICES/);
  assert.match(source, /USE_CARD_TOPUP_FLOW/);
  for (const code of ["wallet_top_up", "top_up", "card_topups", "card_payments"]) {
    assert.ok(
      new RegExp(`CARD_TOPUP_SERVICES[\\s\\S]{0,240}"${code}"`).test(source),
      `${code} must be routed to the card top-up flow`
    );
  }
});

test("Withdraw and payout stay blocked — there is no payout provider", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  for (const code of ["withdraw", "bank_withdrawal", "cash_withdrawal", "business_payout", "merchant_payout", "payouts"]) {
    assert.ok(
      new RegExp(`PROVIDER_DEPENDENT_SERVICES[\\s\\S]{0,900}"${code}"`).test(source),
      `${code} must remain blocked until a payout provider exists`
    );
  }
});

test("The fee preview blocks unlaunched services before a customer sees a fee", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  const preview = source.slice(source.indexOf("async function feePreview"));
  assert.match(preview.slice(0, 700), /assertServiceLaunched\(normalizedServiceCode\)/);
});

/* --------------------------------------------------- deliberate 5xx messages */

test("A deliberate 503 reaches the customer instead of the generic error", () => {
  const { AppError } = require("../src/lib/errors");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "error-handler.js"), "utf8");
  assert.match(source, /clientSafe/);
  assert.match(source, /status >= 500 && !clientSafe/);
  // Provider-state codes are the ones allowed through.
  assert.match(source, /\[502, 503, 504\]\.includes\(error\.statusCode\)/);
  assert.ok(new AppError(503, "x") instanceof Error);
});

test("Error details are never returned for a 5xx", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "error-handler.js"), "utf8");
  assert.match(source, /status < 500 && details \? \{ details \} : \{\}/);
});

/* ------------------------------------------------------------- webhook shape */

test("The webhook accepts a Checkout V2 payload that carries no entity ID", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "integrations.routes.js"), "utf8");
  // merchant.name is the merchant's display name, not the Merchant ID; comparing
  // them rejected every genuine Checkout webhook with HTTP 400.
  const validator = source.slice(source.indexOf("function validatePeachV2Payload"));
  const merchantIdLine = validator.slice(0, validator.indexOf("\n}"));
  assert.doesNotMatch(merchantIdLine.split("\n")[1], /merchant\.name/);
  assert.match(validator, /firstValue\(body, \["merchantId", "merchant_id"\]\)/);
  assert.match(source, /hasLegacyEntityId/);
  assert.match(source, /settleTopupFromWebhook/);
});

test("Form-urlencoded is accepted on the webhook and the Peach return", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "security.js"), "utf8");
  assert.match(source, /\/v1\/webhooks\/provider/);
  assert.match(source, /\/v1\/payments\/topup\/return/);
});

/* -------------------------------------------------------------- credit safety */

test("Settlement locks the transaction row before crediting", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  const settle = source.slice(source.indexOf("async function settleTopupTransaction"));
  assert.match(settle, /SELECT \* FROM transactions WHERE id = \$1 FOR UPDATE/);
  assert.match(settle, /TERMINAL_STATUSES\.has\(row\.status\)/);
  assert.match(settle, /entry_type = 'credit'/);
  // A credit only happens on a verified success.
  assert.match(settle, /verified\.providerState !== "successful"/);
});

test("A reported amount that differs from the created amount is not credited", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  assert.match(source, /amount mismatch; refusing to credit/);
});

test("The webhook re-verifies with Peach rather than trusting its body", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  const fromWebhook = source.slice(source.indexOf("async function settleTopupFromWebhook"));
  assert.match(fromWebhook, /verifyAndSettle\(row\)/);
  assert.doesNotMatch(fromWebhook, /applyWalletMovement/);
});

test("The public return endpoint cannot decide a payment outcome", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "payment-return.routes.js"), "utf8");
  // Strip comments: the file explains in prose that it cannot credit anything,
  // and that prose must not be mistaken for the behaviour under test.
  const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /applyWalletMovement|wallet_ledger|UPDATE transactions|credit/);
  assert.match(code, /resolveReturn/);
  const service = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  const resolve = service.slice(service.indexOf("async function resolveReturn"));
  assert.match(resolve, /verifyAndSettle\(row\)/);
});

/* --------------------------------------------------------------- no secrets */

test("Nothing in the top-up path returns a credential to the caller", () => {
  const service = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  const response = service.slice(service.indexOf("function topupResponse"), service.indexOf("/* ------------------------------------------------------------------ create */"));
  for (const secret of ["clientSecret", "accessToken", "apiKey", "webhookSecret", "entityId"]) {
    assert.doesNotMatch(response, new RegExp(secret), `${secret} must never be in a top-up response`);
  }
});
