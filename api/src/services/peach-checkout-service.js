"use strict";

// Peach Payments Checkout V2 wallet top-up lifecycle.
//
//   PWA  -> POST /v1/payments/topup            create a Checkout, return redirectUrl
//   user -> pays on Peach
//   Peach-> POST /v1/payments/topup/return     browser redirect (POST), 303 back to the PWA
//   Peach-> POST /v1/webhooks/provider         server-to-server notification
//   PWA  -> GET  /v1/payments/topup/:id        poll until a terminal state
//
// The wallet is credited in exactly one place, `settleTopupTransaction`, and only
// after this server has independently asked Peach for the checkout status. A
// browser redirect, a success URL, a webhook body, or anything the frontend
// claims is never sufficient on its own.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config/env");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { loadPeachConfig } = require("./peach-config-service");
const { getAccessToken, CHECKOUT_SERVICE_URLS } = require("./peach-checkout-auth-service");
const { calculateFee } = require("./pricing-service");
const walletService = require("./wallet-service");

const SERVICE_CODE = "wallet_top_up";
const PROVIDER = "peach_checkout";
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_AMOUNT = Number(process.env.PEACH_TOPUP_MIN_AMOUNT || 5);
const MAX_AMOUNT = Number(process.env.PEACH_TOPUP_MAX_AMOUNT || 50000);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function checkoutBaseUrl(environment) {
  const override = environment === "sandbox"
    ? process.env.PEACH_PAYMENTS_SANDBOX_CHECKOUT_URL
    : process.env.PEACH_PAYMENTS_PRODUCTION_CHECKOUT_URL;
  const value = String(override || "").trim();
  if (value) return value.replace(/\/+$/, "");
  return CHECKOUT_SERVICE_URLS[environment] || CHECKOUT_SERVICE_URLS.production;
}

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || "https://app.titopay.co.za").replace(/\/+$/, "");
}

function apiBaseUrl() {
  return String(config.apiBaseUrl || "https://api.titopay.co.za").replace(/\/+$/, "");
}

function topupReturnUrl() {
  return `${apiBaseUrl()}/v1/payments/topup/return`;
}

// Peach's own wording when the Referer is not a domain allowlisted for the
// merchant. Matched on the distinctive parts rather than the whole sentence so
// a rephrasing on their side does not send it back to the generic bucket.
function isMerchantDomainRejection(providerMessage) {
  const text = String(providerMessage || "").toLowerCase();
  return /domain/.test(text) && /(allow ?list|white ?list|not permitted|not registered)/.test(text);
}

// Preserve the existing TitoPay provider webhook endpoint.
function topupNotificationUrl(effective = {}) {
  return String(effective.callbackUrl || config.integrations.peachPayments.webhookUrl || `${apiBaseUrl()}/v1/webhooks/provider`).trim();
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function assertAmount(value) {
  const amount = roundMoney(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "Top-up amount must be greater than zero");
  if (amount < MIN_AMOUNT) throw new AppError(400, `The smallest top-up is R${MIN_AMOUNT.toFixed(2)}`);
  if (amount > MAX_AMOUNT) throw new AppError(400, `The largest top-up is R${MAX_AMOUNT.toFixed(2)}`);
  return amount;
}

function topupReference() {
  return `TP-TOPUP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function nonce() {
  return crypto.randomBytes(16).toString("hex");
}

// Peach result codes. Reference:
// https://developer.peachpayments.com/docs/dashboard-response-codes#result-codes
function statusFromResultCode(rawCode) {
  const code = String(rawCode || "").trim();
  if (!code) return "pending";
  if (/^(000\.000\.|000\.100\.1|000\.[36]00\.)/.test(code)) return "successful";
  // 000.400.0xx / 000.400.100 are successful but flagged for manual review.
  // They are never auto-credited; an operator settles them deliberately.
  if (/^000\.400\.(0[0-9]{2}|100)/.test(code)) return "review";
  if (/^000\.200\./.test(code)) return "pending";
  if (/^100\.396\.101$/.test(code)) return "cancelled";
  // "Uncertain" can still turn into successful later, so it must not fail.
  if (/^100\.396\.(104|103|106)$/.test(code)) return "pending";
  if (/^(800\.400\.5|100\.400\.500)/.test(code)) return "review";
  return "failed";
}

function transactionStatusFor(providerState) {
  switch (providerState) {
    case "successful": return "completed";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    case "review": return "processing";
    default: return "pending";
  }
}

function readField(payload, names) {
  for (const name of names) {
    const direct = payload?.[name];
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") return String(direct).trim();
    const nested = String(name).split(".").reduce((current, key) => (current == null ? current : current[key]), payload);
    if (nested !== undefined && nested !== null && String(nested).trim() !== "") return String(nested).trim();
  }
  return "";
}

function resultCodeFrom(payload = {}) {
  return readField(payload, ["result.code", "resultCode", "result_code"]) || readField(payload?.result || {}, ["code"]);
}

async function peachRequest(effective, method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // Anything that was not exactly "sandbox" used to mean production, so an
  // empty, misspelled or missing environment sent a real customer's card to
  // the live acquirer. Both values are now stated, and anything else refuses.
  const declared = String(effective.environment || config.integrations.peachPayments.mode || "").trim().toLowerCase();
  if (!["sandbox", "production"].includes(declared)) {
    throw new AppError(400, "Peach Checkout environment must be sandbox or production. Set PEACH_PAYMENTS_MODE.");
  }
  const environment = declared;
  const accessToken = await getAccessToken(effective);
  const url = `${checkoutBaseUrl(environment)}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "TitoPay-PeachCheckout/1.0",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // Checkout requires the calling domain to be allowlisted in the Dashboard.
        origin: appBaseUrl(),
        referer: `${appBaseUrl()}/`
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new AppError(504, "Peach Payments timed out", { code: "NETWORK_TIMEOUT" });
    throw new AppError(502, "Peach Payments could not be reached", { code: "NETWORK_ERROR" });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text().catch(() => "");
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }

  if (!response.ok) {
    const providerMessage = String(payload?.result?.description || payload?.message || "").slice(0, 200);
    console.error("[peach-checkout] request failed", {
      method,
      path,
      environment,
      httpStatus: response.status,
      providerMessage,
      // The domain TitoPay presented. Peach requires the Referer to be a
      // domain allowlisted for the merchant, so when it rejects one this is
      // the single value an operator needs to compare against the Dashboard.
      sentReferer: `${appBaseUrl()}/`,
      sentOrigin: appBaseUrl()
    });
    if (response.status === 401 || response.status === 403) {
      throw new AppError(502, "Peach Payments rejected the request", { code: "AUTHENTICATION_REJECTED", providerStatus: response.status });
    }
    if (response.status === 404) throw new AppError(404, "Peach Payments checkout was not found", { code: "CHECKOUT_NOT_FOUND", providerStatus: response.status });
    if (response.status >= 500) throw new AppError(502, "Peach Payments is unavailable", { code: "PROVIDER_UNAVAILABLE", providerStatus: response.status });
    // Peach rejects the checkout when the Referer is not a domain allowlisted
    // for this merchant. It is a configuration problem on the Peach side, not
    // a fault the customer can retry away, so it is reported as unavailable
    // with its own code — and the customer is never shown the provider's text.
    if (isMerchantDomainRejection(providerMessage)) {
      console.error("[peach-checkout] PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED — Peach must allowlist this domain for the merchant", {
        domainSent: appBaseUrl(),
        environment,
        action: "Add this exact domain under the Peach Dashboard for this merchant, or correct APP_BASE_URL if it is wrong."
      });
      throw new AppError(
        503,
        "Card top-ups are temporarily unavailable. Please try again later.",
        { code: "PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED", providerStatus: response.status }
      );
    }
    throw new AppError(502, "Peach Payments could not process the request", { code: "PROVIDER_REQUEST_FAILED", providerStatus: response.status });
  }
  return payload;
}

async function requireCheckoutConfig() {
  const effective = await loadPeachConfig();
  if (effective.enabled === false) throw new AppError(503, "Card top-up is currently disabled", { code: "PROVIDER_DISABLED" });
  const missing = ["clientId", "clientSecret", "merchantId", "entityId"].filter((field) => !effective[field]);
  if (missing.length) {
    console.error("[peach-checkout] configuration incomplete", { missing });
    throw new AppError(503, "Card top-up is not configured yet", { code: "INVALID_CONFIGURATION" });
  }
  return effective;
}

function metadataOf(row = {}) {
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {});
  return metadata || {};
}

function topupResponse(row, extra = {}) {
  const metadata = metadataOf(row);
  return {
    transactionId: row.id,
    reference: row.reference,
    // `amount` is what lands in the wallet; `total` is what the card is charged.
    amount: Number(row.amount),
    fee: Number(row.fee || 0),
    total: Number(row.total ?? row.amount),
    currency: metadata.currency || "ZAR",
    status: row.status,
    providerState: metadata.providerState || null,
    checkoutId: metadata.checkoutId || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra
  };
}

/* ------------------------------------------------------------------ create */

async function createTopupCheckout(actor, payload = {}) {
  const effective = await requireCheckoutConfig();
  const amount = assertAmount(payload.amount);
  const currency = String(payload.currency || "ZAR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(400, "Currency is invalid");

  const idempotencyKey = String(payload.idempotencyKey || payload.metadata?.clientIdempotencyKey || "").trim().slice(0, 120);
  if (!idempotencyKey) throw new AppError(400, "An idempotency key is required");

  // The wallet balance cap for the customer's verification tier, checked
  // BEFORE they are sent to the card page: a top up that could not be
  // credited must never be charged.
  await require("./compliance-service").assertBalanceHeadroom(actor.userId, amount);

  // A repeated submit returns the original checkout instead of charging twice.
  const existing = await pool.query(
    `SELECT * FROM transactions
      WHERE user_id = $1 AND service_code = $2
        AND metadata->>'clientIdempotencyKey' = $3
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [actor.userId, SERVICE_CODE, idempotencyKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    const metadata = metadataOf(row);
    return topupResponse(row, { redirectUrl: metadata.redirectUrl || null, idempotentReplay: true });
  }

  // The top-up fee comes from the same approved pricing rule the fee preview
  // quoted, so the card is charged exactly the total the customer confirmed.
  // The fee is collected at the card and never enters the wallet: the wallet is
  // credited `amount`, the card is charged `amount + fee`.
  const pricing = await calculateFee(SERVICE_CODE, amount);
  const fee = roundMoney(pricing.fee || 0);
  const chargeTotal = roundMoney(amount + fee);
  if (chargeTotal <= 0) throw new AppError(400, "Top-up amount must be greater than zero");

  // If the client tells us what the review screen quoted, refuse to charge
  // anything different. This can only ever REFUSE a payment, never authorise a
  // larger one, so it adds a safety net without trusting the browser: a review
  // screen left open across a pricing change cannot send the customer to Peach
  // for a total they never agreed to.
  const quotedTotal = payload.quotedTotal === undefined || payload.quotedTotal === null || payload.quotedTotal === ""
    ? null
    : Number(payload.quotedTotal);
  if (quotedTotal !== null && Number.isFinite(quotedTotal) && Math.abs(quotedTotal - chargeTotal) > 0.005) {
    throw new AppError(
      409,
      "The top-up fee changed since this screen was opened. Nothing was charged. Please start the top up again to see the current total.",
      { code: "TOPUP_QUOTE_STALE" }
    );
  }

  const wallet = await walletService.getPrimaryWalletForUser(actor.userId);
  const transactionId = uuidv4();
  const reference = topupReference();

  await pool.query(
    `INSERT INTO transactions
      (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
     VALUES ($1,$2,$3,$4,$5,$8,$9,'pending','credit',$6,$6,$7::jsonb)`,
    [
      transactionId, actor.userId, wallet.id, SERVICE_CODE, amount, reference,
      JSON.stringify({
        provider: PROVIDER,
        integration: "checkout_v2",
        environment: effective.environment,
        currency,
        clientIdempotencyKey: idempotencyKey,
        merchantTransactionId: reference,
        providerState: "created",
        feeAmount: fee,
        chargeTotal,
        note: String(payload.note || payload.reference || "").slice(0, 200) || undefined
      }),
      fee,
      chargeTotal
    ]
  );

  let checkout;
  try {
    checkout = await peachRequest(effective, "POST", "/v2/checkout", {
      authentication: { entityId: effective.entityId },
      merchantTransactionId: reference,
      amount: Number(chargeTotal.toFixed(2)),
      currency,
      paymentType: "DB",
      nonce: nonce(),
      shopperResultUrl: topupReturnUrl(),
      cancelUrl: topupReturnUrl(),
      notificationUrl: topupNotificationUrl(effective),
      defaultPaymentMethod: payload.defaultPaymentMethod || undefined
    });
  } catch (error) {
    await pool.query(
      "UPDATE transactions SET status='failed', metadata = metadata || $2::jsonb, updated_at=NOW() WHERE id=$1",
      [transactionId, JSON.stringify({ providerState: "failed", failureReason: error?.details?.code || "PROVIDER_REQUEST_FAILED" })]
    ).catch(() => {});
    throw error;
  }

  const checkoutId = String(checkout.checkoutId || "").trim();
  const redirectUrl = String(checkout.redirectUrl || "").trim();
  if (!checkoutId || !redirectUrl) {
    await pool.query("UPDATE transactions SET status='failed', updated_at=NOW() WHERE id=$1", [transactionId]).catch(() => {});
    throw new AppError(502, "Peach Payments did not return a checkout", { code: "PROVIDER_REQUEST_FAILED" });
  }

  const { rows } = await pool.query(
    `UPDATE transactions
        SET metadata = metadata || $2::jsonb, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [transactionId, JSON.stringify({ checkoutId, redirectUrl, providerState: "pending" })]
  );

  console.info("[peach-checkout] checkout created", {
    transactionId, reference, checkoutId, environment: effective.environment, amount, fee, chargeTotal, currency
  });

  return topupResponse(rows[0], { redirectUrl, idempotentReplay: false });
}

/* ----------------------------------------------------------------- settle */

// The one and only place a Peach top-up credits a wallet.
//
// Concurrency: the transaction row is locked FOR UPDATE, so a webhook, a status
// poll and a browser return racing each other serialise here. The first one to
// win the lock credits; the rest observe a terminal status and no-op.
async function settleTopupTransaction(client, transactionId, verified) {
  const locked = await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId]);
  const row = locked.rows[0];
  if (!row) throw new AppError(404, "Top-up transaction not found");

  const metadata = metadataOf(row);
  const nextStatus = transactionStatusFor(verified.providerState);

  if (TERMINAL_STATUSES.has(row.status)) {
    return { row, credited: false, alreadySettled: true };
  }

  if (verified.providerState !== "successful") {
    const { rows } = await client.query(
      `UPDATE transactions SET status=$2, metadata = metadata || $3::jsonb, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [transactionId, nextStatus, JSON.stringify({
        providerState: verified.providerState,
        resultCode: verified.resultCode || null,
        providerUpdatedAt: new Date().toISOString()
      })]
    );
    return { row: rows[0], credited: false, alreadySettled: false };
  }

  // Peach reported success. Confirm the amount and currency still match what
  // TitoPay created, so a tampered or mismatched notification cannot change
  // what gets credited. Peach was asked to charge the TOTAL (amount + top-up
  // fee), so that is what its answer must equal; the wallet is still credited
  // only `amount`. Rows written before the fee existed carry total = amount, so
  // this stays correct for them too.
  const expectedCharge = Number(row.total ?? row.amount);
  if (verified.amount !== null && Math.abs(Number(verified.amount) - expectedCharge) > 0.005) {
    console.error("[peach-checkout] amount mismatch; refusing to credit", {
      transactionId, expected: expectedCharge, reported: Number(verified.amount)
    });
    const { rows } = await client.query(
      `UPDATE transactions SET status='processing', metadata = metadata || $2::jsonb, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [transactionId, JSON.stringify({ providerState: "amount_mismatch", requiresReview: true })]
    );
    return { row: rows[0], credited: false, alreadySettled: false };
  }

  // Belt and braces alongside the row lock: never add a second credit for this
  // transaction even if a status row were somehow rewound.
  //
  // Scoped to the CUSTOMER's wallet. The fee posting below writes a second
  // credit against the same transaction on the revenue wallet, and without this
  // scope that row would satisfy this check and silently skip crediting the
  // customer on any re-run.
  const existingCredit = await client.query(
    `SELECT id FROM wallet_ledger
      WHERE transaction_id = $1 AND wallet_id = $2 AND entry_type = 'credit' AND metadata->>'provider' = $3 LIMIT 1`,
    [transactionId, row.wallet_id, PROVIDER]
  );

  let credited = false;
  if (!existingCredit.rows[0]) {
    await walletService.applyWalletMovement(client, {
      walletId: row.wallet_id,
      transactionId,
      entryType: "credit",
      amount: Number(row.amount),
      reference: row.reference,
      metadata: { provider: PROVIDER, checkoutId: metadata.checkoutId || verified.checkoutId || null, serviceCode: SERVICE_CODE }
    });
    credited = true;
  }

  const feeRecorded = await recordTopupFeeRevenue(client, row);

  const { rows } = await client.query(
    `UPDATE transactions SET status='completed', metadata = metadata || $2::jsonb, updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [transactionId, JSON.stringify({
      providerState: "successful",
      resultCode: verified.resultCode || null,
      paymentBrand: verified.paymentBrand || null,
      peachPaymentId: verified.peachPaymentId || null,
      settledAt: metadata.settledAt || new Date().toISOString(),
      providerUpdatedAt: new Date().toISOString()
    })]
  );
  return { row: rows[0], credited, feeRecorded, alreadySettled: false };
}

// The top-up fee is real money. Peach charges the customer amount + fee on the
// card and settles the whole R506 to TitoPay, but only the R500 was ever posted
// to the customer's wallet — the R6 reached TitoPay and was recorded nowhere, so
// Revenue Recorded read R0.00 against a fee that had genuinely been collected
// and every settled top-up sat flagged for reconciliation.
//
// This posts it the way every other fee in the platform is posted: a credit to
// the revenue wallet plus a revenue_ledger row. There is deliberately NO debit
// against the customer — they paid the fee to Peach on the card, and debiting
// the wallet as well would charge them twice.
//
// Two rules govern it. It must never post twice, so revenue_ledger is the
// idempotency key. And it must never cost a customer their credit: the whole
// posting runs inside a SAVEPOINT, so if the revenue wallet is missing or the
// insert fails, that part rolls back alone and the wallet credit above still
// commits. A fee TitoPay failed to record is an accounting problem; a top-up
// the customer paid for and did not receive is a much worse one.
async function recordTopupFeeRevenue(client, row) {
  const fee = roundMoney(Number(row.fee || 0));
  if (!(fee > 0)) return false;

  const already = await client.query("SELECT id FROM revenue_ledger WHERE transaction_id = $1 LIMIT 1", [row.id]);
  if (already.rows[0]) return false;

  await client.query("SAVEPOINT topup_fee_revenue");
  try {
    const revenueWallet = await walletService.getRevenueWallet();
    await walletService.applyWalletMovement(client, {
      walletId: revenueWallet.id,
      transactionId: row.id,
      entryType: "credit",
      amount: fee,
      reference: row.reference,
      metadata: { serviceCode: SERVICE_CODE, source: "fee", collectedBy: PROVIDER }
    });
    await client.query(
      `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuidv4(), row.id, SERVICE_CODE, fee, revenueWallet.id]
    );
    await client.query("RELEASE SAVEPOINT topup_fee_revenue");
    return true;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT topup_fee_revenue").catch(() => {});
    await client.query("RELEASE SAVEPOINT topup_fee_revenue").catch(() => {});
    console.error("[peach-checkout] top-up fee revenue not recorded; the wallet credit still stands", {
      transactionId: row.id,
      reference: row.reference,
      fee,
      reason: error?.message || "unknown"
    });
    return false;
  }
}

// Ask Peach directly what happened. This is the only trusted source.
async function verifyWithPeach(effective, checkoutId) {
  const payload = await peachRequest(effective, "GET", `/v2/checkout/${encodeURIComponent(checkoutId)}/status`);
  const resultCode = resultCodeFrom(payload);
  const amountText = readField(payload, ["amount"]);
  return {
    providerState: statusFromResultCode(resultCode),
    resultCode,
    amount: amountText === "" ? null : Number(amountText),
    currency: readField(payload, ["currency"]) || null,
    checkoutId,
    paymentBrand: readField(payload, ["paymentBrand"]) || null,
    peachPaymentId: readField(payload, ["id"]) || null,
    merchantTransactionId: readField(payload, ["merchantTransactionId"]) || null
  };
}

async function verifyAndSettle(transactionRow) {
  const metadata = metadataOf(transactionRow);
  const checkoutId = String(metadata.checkoutId || "").trim();
  if (!checkoutId) return { row: transactionRow, credited: false, alreadySettled: false };

  const effective = await requireCheckoutConfig();
  const verified = await verifyWithPeach(effective, checkoutId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await settleTopupTransaction(client, transactionRow.id, verified);
    await client.query("COMMIT");
    if (result.credited) {
      console.info("[peach-checkout] wallet credited", {
        transactionId: transactionRow.id, reference: transactionRow.reference, amount: Number(transactionRow.amount)
      });
    }
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ----------------------------------------------------------------- status */

async function findTopupForActor(actor, transactionIdOrReference) {
  const value = String(transactionIdOrReference || "").trim();
  if (!value) throw new AppError(400, "A top-up reference is required");
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const { rows } = await pool.query(
    `SELECT * FROM transactions
      WHERE user_id = $1 AND service_code = $2
        AND (${isUuid ? "id = $3::uuid OR " : ""}reference = $3 OR metadata->>'checkoutId' = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [actor.userId, SERVICE_CODE, value]
  );
  if (!rows[0]) throw new AppError(404, "Top-up not found");
  return rows[0];
}

async function getTopupStatus(actor, transactionIdOrReference) {
  const row = await findTopupForActor(actor, transactionIdOrReference);
  if (TERMINAL_STATUSES.has(row.status)) return topupResponse(row, { verified: true });
  try {
    const result = await verifyAndSettle(row);
    return topupResponse(result.row, { verified: true, credited: result.credited });
  } catch (error) {
    // A provider hiccup during polling must never present as a failed payment.
    console.error("[peach-checkout] status verification failed", {
      transactionId: row.id, code: error?.details?.code || "UNKNOWN"
    });
    return topupResponse(row, { verified: false, verificationError: error?.details?.code || "VERIFICATION_UNAVAILABLE" });
  }
}

async function listRecentTopups(actor, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM transactions WHERE user_id=$1 AND service_code=$2 ORDER BY created_at DESC LIMIT $3`,
    [actor.userId, SERVICE_CODE, Math.min(Math.max(Number(limit) || 10, 1), 50)]
  );
  return rows.map((row) => topupResponse(row));
}

/* ---------------------------------------------------------------- webhook */

// A webhook is only a hint that something changed. The status is re-read from
// Peach before any money moves.
async function settleTopupFromWebhook(webhookPayload = {}) {
  const merchantTransactionId = readField(webhookPayload, ["merchantTransactionId", "merchant_transaction_id"]);
  const checkoutId = readField(webhookPayload, ["checkoutId", "checkout_id"]);
  if (!merchantTransactionId && !checkoutId) return { matched: false, reason: "no_reference" };

  const { rows } = await pool.query(
    `SELECT * FROM transactions
      WHERE service_code = $1 AND (reference = $2 OR metadata->>'checkoutId' = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [SERVICE_CODE, merchantTransactionId || "", checkoutId || ""]
  );
  const row = rows[0];
  if (!row) return { matched: false, reason: "unknown_transaction" };
  if (TERMINAL_STATUSES.has(row.status)) {
    return { matched: true, transactionId: row.id, status: row.status, credited: false, alreadySettled: true };
  }

  const result = await verifyAndSettle(row);
  return {
    matched: true,
    transactionId: result.row.id,
    reference: result.row.reference,
    status: result.row.status,
    credited: result.credited,
    alreadySettled: result.alreadySettled
  };
}

/* ----------------------------------------------------------------- return */

// Peach POSTs the customer's browser back here. Resolve the transaction, kick
// off verification, then 303 the browser to the PWA. The redirect itself never
// decides the outcome.
async function resolveReturn(body = {}, query = {}) {
  const merchantTransactionId = readField({ ...query, ...body }, ["merchantTransactionId", "merchant_transaction_id"]);
  const checkoutId = readField({ ...query, ...body }, ["checkoutId", "checkout_id", "id"]);
  if (!merchantTransactionId && !checkoutId) return { redirectTo: `${appBaseUrl()}/?topup=unknown` };

  const { rows } = await pool.query(
    `SELECT * FROM transactions
      WHERE service_code = $1 AND (reference = $2 OR metadata->>'checkoutId' = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [SERVICE_CODE, merchantTransactionId || "", checkoutId || ""]
  );
  const row = rows[0];
  if (!row) return { redirectTo: `${appBaseUrl()}/?topup=unknown` };

  let status = row.status;
  if (!TERMINAL_STATUSES.has(status)) {
    try {
      const result = await verifyAndSettle(row);
      status = result.row.status;
    } catch (_error) {
      status = row.status;
    }
  }
  return {
    transactionId: row.id,
    reference: row.reference,
    status,
    redirectTo: `${appBaseUrl()}/?topup=${encodeURIComponent(status)}&ref=${encodeURIComponent(row.reference)}`
  };
}

module.exports = {
  SERVICE_CODE,
  PROVIDER,
  createTopupCheckout,
  getTopupStatus,
  listRecentTopups,
  settleTopupFromWebhook,
  settleTopupTransaction,
  resolveReturn,
  statusFromResultCode,
  transactionStatusFor,
  verifyWithPeach
};
