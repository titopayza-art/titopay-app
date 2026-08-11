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
  // The refusal must live on the wallet-debit path only. assertServiceLaunched
  // also serves the fee preview, and blocking it there stopped the customer
  // before they could ever be shown the top-up fee.
  const launched = source.slice(
    source.indexOf("async function assertServiceLaunched"),
    source.indexOf("async function assertLiveTransactionSupported")
  );
  assert.ok(launched.length > 200, "assertServiceLaunched must still exist");
  assert.doesNotMatch(launched, /CARD_TOPUP_SERVICES\.has/);
  const live = source.slice(source.indexOf("async function assertLiveTransactionSupported"));
  assert.match(live.slice(0, 800), /CARD_TOPUP_SERVICES\.has\(normalizedServiceCode\)[\s\S]{0,240}USE_CARD_TOPUP_FLOW/);
});

test("The fee preview quotes a card top-up instead of refusing it", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  const preview = source.slice(source.indexOf("async function feePreview"), source.indexOf("async function resolveRecipientWallet"));
  // The preview is a read-only price calculation; it must not carry the
  // wallet-debit refusal, or the top-up form cannot reach the review screen.
  assert.doesNotMatch(preview, /USE_CARD_TOPUP_FLOW/);
});

test("A card top-up charges the card the total the customer confirmed", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  const create = source.slice(source.indexOf("async function createTopupCheckout"), source.indexOf("async function settleTopupTransaction"));
  // Fee comes from the same approved pricing rule the preview quoted.
  assert.match(create, /calculateFee\(SERVICE_CODE, amount\)/);
  assert.match(create, /chargeTotal = roundMoney\(amount \+ fee\)/);
  // Peach is charged the total, not the bare amount.
  assert.match(create, /amount: Number\(chargeTotal\.toFixed\(2\)\)/);
  // The transaction row records amount / fee / total separately.
  assert.match(create, /amount, fee, total, status/);
  // The wallet is still credited only the amount, never the fee.
  const settle = source.slice(source.indexOf("async function settleTopupTransaction"));
  assert.match(settle.slice(0, 3000), /amount: Number\(row\.amount\)/);
  assert.match(settle.slice(0, 3000), /expectedCharge = Number\(row\.total \?\? row\.amount\)/);
});

test("A stale review screen cannot send a customer to Peach for the wrong total", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "peach-checkout-service.js"), "utf8");
  const create = source.slice(source.indexOf("async function createTopupCheckout"), source.indexOf("async function settleTopupTransaction"));
  assert.match(create, /TOPUP_QUOTE_STALE/);
  // The quote can only refuse. It is never used to set the amount charged, so a
  // tampered client cannot raise or lower what Peach is asked for.
  assert.doesNotMatch(create, /chargeTotal\s*=\s*[^;]*quotedTotal/);
  // And it is checked before anything is written or Peach is called.
  assert.ok(create.indexOf("TOPUP_QUOTE_STALE") < create.indexOf("INSERT INTO transactions"));
});

test("Withdraw and payout are gated by the Peach payout capability", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  // They belong to the payout capability, never to Collection/Checkout.
  for (const code of ["withdraw", "withdraw_money_to_bank", "withdraw_cash", "bank_withdrawal",
    "cash_withdrawal", "payouts", "business_payout", "merchant_payout", "merchant_payouts", "seller_payout"]) {
    assert.ok(
      new RegExp(`PEACH_PAYOUT_SERVICES = new Set\\(\\[[\\s\\S]{0,600}"${code}"`).test(source),
      `${code} must be routed to the Peach payout capability`
    );
  }
  // The gate consults the payout capability at the fee preview, so an
  // unconfigured, disabled or unverified payout provider is reported as itself
  // before the customer is shown a fee.
  assert.match(source, /PEACH_PAYOUT_SERVICES\.has\(normalizedServiceCode\)[\s\S]{0,400}payoutAvailability\(\)/);
  assert.match(source, /assertPayoutAvailable/);
});

test("A withdrawal cannot be created through the wallet-debit endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  // The fee preview must succeed — the customer has to see the withdrawal fee.
  const launched = source.slice(
    source.indexOf("async function assertServiceLaunched"),
    source.indexOf("async function assertLiveTransactionSupported")
  );
  assert.doesNotMatch(launched, /USE_WITHDRAWAL_FLOW/);
  // createTransaction only debits; a withdrawal also has to submit a payout and
  // be reversible, so it is refused here and runs its own lifecycle instead.
  const live = source.slice(source.indexOf("async function assertLiveTransactionSupported"));
  assert.match(live.slice(0, 1400), /PEACH_PAYOUT_SERVICES\.has\(normalizedServiceCode\)[\s\S]{0,240}USE_WITHDRAWAL_FLOW/);
  assert.match(live.slice(0, 1400), /No wallet debit was made/);
  assert.match(live.slice(0, 1400), /\/v1\/payouts\/withdrawals/);
});

test("The fee preview blocks unlaunched services before a customer sees a fee", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
  const preview = source.slice(source.indexOf("async function feePreview"));
  assert.match(preview.slice(0, 700), /assertServiceLaunched\(normalizedServiceCode\)/);
});

/* --------------------------------------------------- deliberate 5xx messages */

test("A deliberate 503 reaches the customer instead of the generic error", () => {
  const { AppError } = require("../src/lib/errors");
  const { errorHandler } = require("../src/middleware/error-handler");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "error-handler.js"), "utf8");
  assert.match(source, /clientSafe/);
  assert.match(source, /status >= 500 && !clientSafe/);
  // The machine-readable code is still restricted to provider-state errors.
  assert.match(source, /\[502, 503, 504\]\.includes\(error\.statusCode\)/);
  assert.ok(new AppError(503, "x") instanceof Error);

  // Asserted as behaviour rather than source shape. 502/503/504 keep their
  // sentence — a provider being unreachable is a state the customer is really
  // in. A 500 does not: it briefly did, and that is how TitoPay's internal
  // wallet configuration ended up on the Email Statement screen.
  const say = (error) => {
    const sent = {};
    const res = { status(code) { sent.status = code; return this; }, json(body) { sent.body = body; return this; } };
    const originalError = console.error;
    console.error = () => {};
    try { errorHandler(error, { requestId: "r" }, res); } finally { console.error = originalError; }
    return sent.body.error;
  };
  assert.equal(say(new AppError(503, "Card top-up is not configured yet")), "Card top-up is not configured yet");
  assert.equal(say(new AppError(500, "TitoPay revenue wallet is not configured")),
    "Unable to complete the request. Please try again.");
  assert.equal(say(new AppError(500, "TitoPay revenue wallet is not configured",
    { publicMessage: "Statement request unavailable. Please try again later." })),
    "Statement request unavailable. Please try again later.");
  assert.equal(say(new AppError(500, "relation \"x\" does not exist — sql")),
    "Unable to complete the request. Please try again.");
  assert.equal(say(new Error("ECONNREFUSED password=hunter2")),
    "Unable to complete the request. Please try again.");
});

test("A 5xx returns a safe code at most, never the provider's details", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "middleware", "error-handler.js"), "utf8");
  // A deliberate 502/503/504 needs a machine-readable code so the app can tell
  // "rejected, money returned" from "unconfirmed, money held". Only that one
  // token survives — the details object itself never does.
  assert.match(source, /status < 500 && details[\s\S]{0,20}\?\s*\{ details \}/);
  // codeSafe, not clientSafe: the sentence and the machine-readable code are
  // now separate decisions. The code is still provider-state only.
  assert.match(source, /codeSafe && safeErrorCode\(details\)/);
  assert.match(source, /details: \{ code: safeErrorCode\(details\) \}/);

  // And the token is constrained to something this codebase authored.
  const { errorHandler } = require("../src/middleware/error-handler");
  const { AppError } = require("../src/lib/errors");
  const capture = () => {
    const sent = {};
    const res = { status(code) { sent.status = code; return this; }, json(body) { sent.body = body; return this; } };
    return { res, sent };
  };

  const safe = capture();
  errorHandler(new AppError(502, "held", { code: "PAYOUT_SUBMISSION_UNCERTAIN", providerBody: "<html>secret</html>" }), { requestId: "r" }, safe.res);
  assert.deepEqual(safe.sent.body.details, { code: "PAYOUT_SUBMISSION_UNCERTAIN" });
  assert.ok(!JSON.stringify(safe.sent.body).includes("secret"), "provider text must never ride out on a 5xx");

  // Provider prose in the code position is dropped rather than forwarded.
  const unsafe = capture();
  errorHandler(new AppError(502, "held", { code: "Invalid client ID or secret." }), { requestId: "r" }, unsafe.res);
  assert.equal(unsafe.sent.body.details, undefined);

  // A 500 carries no code — that signal is only meaningful for provider state —
  // and no sentence of its own either, unless the throw site wrote one for the
  // customer. Both are withheld by default; the requestId is what carries the
  // cause to whoever can act on it.
  const generic = capture();
  errorHandler(new AppError(500, "boom", { code: "SOMETHING" }), { requestId: "r" }, generic.res);
  assert.equal(generic.sent.body.details, undefined, "no machine-readable code on a plain 500");
  assert.equal(generic.sent.body.error, "Unable to complete the request. Please try again.");
  assert.equal(generic.sent.body.requestId, "r");

  // And a 500 whose text is technical is still replaced.
  const technical = capture();
  errorHandler(new AppError(500, "pricing rule not found"), { requestId: "r" }, technical.res);
  assert.equal(technical.sent.body.error, "Unable to complete the request. Please try again.");
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
