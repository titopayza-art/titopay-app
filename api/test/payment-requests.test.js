"use strict";

// REQUEST FUNDS AND BILL SPLIT ARE REAL DOORS NOW.
//
// Both forms used to submit into the generic transaction flow, where the fee
// preview refused them with a 409 - a form that could only ever end in an
// error banner. The behaviour is proven end to end by
// verification/payment-requests-live.js; these tests pin the contract so it
// cannot quietly rot:
//
//   - the six request endpoints exist and money moves ONLY through the pay
//     endpoint, on the wallet_transfer rails, idempotently;
//   - the payer is notified through the same feed the app already reads;
//   - the PWA forms submit to the new endpoints, never the dead door;
//   - the old transaction path still refuses request services, so an old
//     client gets a clear refusal instead of a silent nothing.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVICE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "payment-request-service.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "payments.routes.js"), "utf8");
const CHAT_ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "chat.routes.js"), "utf8");
const TX_SERVICE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("all six request endpoints exist behind authentication", () => {
  for (const route of [
    'router.post("/requests"',
    'router.post("/requests/split"',
    'router.get("/requests"',
    'router.post("/requests/:id/pay"',
    'router.post("/requests/:id/decline"',
    'router.post("/requests/:id/cancel"'
  ]) {
    assert.ok(ROUTES.includes(route), `${route} must exist in payments.routes.js`);
  }
  assert.ok(ROUTES.indexOf("router.use(requireAuth)") < ROUTES.indexOf('router.post("/requests"'),
    "the request endpoints must sit behind requireAuth");
});

test("money moves only through the transfer rails, exactly once", () => {
  // The pay leg is a wallet_transfer through createTransaction - the same
  // locks, ledger writes and receipts as Send Money.
  assert.match(SERVICE, /serviceCode: "wallet_transfer"/);
  assert.match(SERVICE, /createTransaction\(actor, \{/);
  // Idempotency derived from the request id: however many times Pay is
  // pressed, one transfer.
  assert.match(SERVICE, /idempotencyKey: `payment-request:\$\{request\.id\}`/);
  // Creating a request must never touch a wallet: the only wallet write in
  // this service is the transfer above.
  assert.doesNotMatch(SERVICE, /applyWalletMovement/,
    "the request service must not move wallet money itself");
  assert.doesNotMatch(SERVICE, /UPDATE wallets/i,
    "the request service must not edit wallet balances directly");
});

test("a request can only be answered by its payer and cancelled by its requester", () => {
  assert.match(SERVICE, /payer_user_id = \$2 AND status IN \('pending', 'paying'\)/,
    "pay claims the row atomically, payer-scoped");
  assert.match(SERVICE, /payer_user_id = \$2 AND status = 'pending'[\s\S]{0,200}RETURNING/,
    "decline is payer-scoped and pending-only");
  assert.match(SERVICE, /requester_user_id = \$2 AND status = 'pending'/,
    "cancel is requester-scoped and pending-only");
});

test("receiving is open unless TitoPay has blocked the account", () => {
  // Policy: FICA status does not gate receiving money. The only accounts
  // that cannot receive or request are blocked, suspended or closed ones,
  // and both the request service and the transfer rails use the same
  // BLOCKED_ACCOUNT_STATUSES set to decide it.
  assert.match(SERVICE, /assertRequesterCanReceive/);
  assert.match(SERVICE, /BLOCKED_ACCOUNT_STATUSES/);
  assert.match(TX_SERVICE, /assertRecipientCanReceive/);
  assert.match(TX_SERVICE, /BLOCKED_ACCOUNT_STATUSES/);
  assert.doesNotMatch(TX_SERVICE, /Recipient must be a verified TitoPay user/,
    "the old FICA wall must stay gone");
  assert.doesNotMatch(TX_SERVICE, /UNVERIFIED_MONTHLY_RECEIVE_LIMIT/,
    "the R200 000 limit was removed by policy decision");
  assert.doesNotMatch(SERVICE, /UNVERIFIED_MONTHLY_RECEIVE_LIMIT/);
});

test("every sent transfer records WHO was paid, for receipts and notices", () => {
  assert.match(TX_SERVICE, /recipientName: recipientWallet\.full_name/);
  assert.match(TX_SERVICE, /recipientContact: recipientWallet\.phone \|\| recipientWallet\.email/);
  assert.match(TX_SERVICE, /recipientLine/);
  const EMAIL = fs.readFileSync(path.join(__dirname, "..", "src", "services", "email-centre-service.js"), "utf8");
  assert.match(EMAIL, /"recipientLine"/, "the receipt template variable must be whitelisted");
  assert.match(EMAIL, /to \{\{recipientLine\}\}/, "the transfer receipt must name the recipient");
  // And the app shows it: detail sheet and the sent notification.
  assert.match(APP, /txMeta\.recipientName/);
  assert.match(APP, /Sent to \$\{sentToName\}/);
});

test("payment request notices travel the feed the app already reads", () => {
  const occurrences = CHAT_ROUTES.match(/notification_type LIKE 'payment_request%'/g) || [];
  assert.ok(occurrences.length >= 2,
    "both the feed SELECT and the read UPDATE must include payment_request notices");
  assert.match(SERVICE, /notificationType: "payment_request"/);
  assert.match(SERVICE, /notificationType: "payment_request_update"/);
});

test("a recurring request spawns its next occurrence only when paid", () => {
  const payBlock = SERVICE.slice(SERVICE.indexOf("async function payRequest"));
  assert.match(payBlock.slice(0, payBlock.indexOf("async function declineRequest")), /spawnNextOccurrence/);
  const declineBlock = SERVICE.slice(SERVICE.indexOf("async function declineRequest"));
  assert.doesNotMatch(declineBlock, /spawnNextOccurrence\(/,
    "decline and cancel must end a series, not continue it");
});

test("the PWA forms submit to the request endpoints, not the dead transaction door", () => {
  const requestModal = APP.slice(APP.indexOf("function openPaymentRequestModal("), APP.indexOf("function loadPaymentRequestInbox("));
  assert.match(requestModal, /data-form="payment-request"/);
  assert.doesNotMatch(requestModal, /data-form="transaction"/,
    "Request funds must never submit into the generic transaction flow again");
  const splitModal = APP.slice(APP.indexOf("function openBillSplitModal("));
  const splitForm = splitModal.slice(0, splitModal.indexOf("</form>"));
  assert.match(splitForm, /data-form="bill-split"/);
  assert.doesNotMatch(splitForm, /data-form="transaction"/);
  assert.match(APP, /await submitPaymentRequestForm\(form, data\)/);
  assert.match(APP, /await submitBillSplitForm\(form, data\)/);
  assert.match(APP, /api\("\/v1\/payments\/requests", \{\s*method: "POST"/);
  assert.match(APP, /api\("\/v1\/payments\/requests\/split", \{/);
});

test("the payer can find, pay and decline requests in the app", () => {
  assert.match(APP, /function openPaymentRequestsModal/);
  assert.match(APP, /payreq-pay:/);
  assert.match(APP, /payreq-decline:/);
  assert.match(APP, /payreq-cancel:/);
  // Paying is a confirmed money action.
  const answer = APP.slice(APP.indexOf("async function answerPaymentRequest"));
  assert.match(answer.slice(0, 2200), /askToConfirm/);
  // A payment request notice files under Payments in the notification centre.
  const classifier = APP.slice(APP.indexOf("function notificationCategory("));
  assert.match(classifier.slice(0, classifier.indexOf("\n}") + 2), /payment_request/);
});

test("old clients still get a clear refusal from the old path", () => {
  assert.match(TX_SERVICE, /REQUEST_ONLY_SERVICES/);
  assert.match(TX_SERVICE, /Payment requests create a request only\. No wallet debit was made\./);
});
