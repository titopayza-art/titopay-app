"use strict";

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config/env");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { testCheckoutAuthentication } = require("./peach-checkout-auth-service");
const walletService = require("./wallet-service");

const DEFAULT_TIMEOUT_MS = 10000;
const SUCCESS_STATES = new Set(["succeeded", "successful", "paid", "captured", "completed"]);
const FAILURE_STATES = new Set(["failed", "failure", "declined", "cancelled", "canceled", "expired"]);
const REFUND_STATES = new Set(["refunded", "partially_refunded", "refund_succeeded", "refund_completed"]);

function assertEnabled() {
  if (!config.integrations.peachPayments.v2Enabled) {
    throw new AppError(503, "Peach Payments v2 is not enabled");
  }
}

function normalizeEnvironment(value) {
  const environment = String(value || config.integrations.peachPayments.mode || "production").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new AppError(400, "Peach Payments environment must be sandbox or production");
  }
  return environment;
}

function baseUrlFor(effective = {}) {
  const environment = normalizeEnvironment(effective.environment || effective.mode);
  const configured = environment === "sandbox"
    ? effective.sandboxBaseUrl || config.integrations.peachPayments.sandboxBaseUrl
    : effective.productionBaseUrl || config.integrations.peachPayments.productionBaseUrl;
  const legacy = effective.baseUrl || config.integrations.peachPayments.baseUrl;
  const value = String(effective.baseUrl || configured || legacy || "").trim();
  if (!value) throw new AppError(400, "Peach Payments API URL is not configured");
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return { environment, url: parsed.toString().replace(/\/+$/, "") };
  } catch (_error) {
    throw new AppError(400, "Peach Payments API URL is invalid");
  }
}

function peachHeaders(effective = {}) {
  const apiKey = String(effective.apiKey || "").trim();
  if (!apiKey) throw new AppError(400, "Peach Payments API key is not configured", { code: "INVALID_CREDENTIALS" });
  return {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "TitoPay-PeachPayments/2.0",
    "api-key": apiKey
  };
}

function errorFromResponse(status, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  const lower = text.toLowerCase();
  if (status === 401 || status === 403) {
    return new AppError(502, "Peach Payments authentication failed: invalid credentials", { code: "AUTHENTICATION_FAILED", providerStatus: status });
  }
  if (status === 404 && /(entity|merchant|payment|resource)/.test(lower)) {
    return new AppError(502, "Peach Payments entity ID or resource is invalid", { code: "ENTITY_ID_INVALID", providerStatus: status });
  }
  return new AppError(502, `Peach Payments request failed (${status})`, { code: "PROVIDER_REQUEST_FAILED", providerStatus: status, providerMessage: text.slice(0, 500) });
}

async function requestPeach(effective, method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  assertEnabled();
  const { url, environment } = baseUrlFor(effective);
  const headers = peachHeaders(effective);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${url}/${String(path || "").replace(/^\/+/, "")}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(504, "Peach Payments network timeout", { code: "NETWORK_TIMEOUT" });
    }
    throw new AppError(502, "Peach Payments could not be reached", { code: "NETWORK_ERROR" });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = raw; }
  if (!response.ok) throw errorFromResponse(response.status, payload);
  return { payload, statusCode: response.status, environment, endpoint: url };
}

// Provider health is measured against Peach Checkout (V2) authentication, which
// is the integration the Admin Portal configures. It deliberately does not use
// the `api-key` header of the Peach Payments API used by the top-up calls below
// — the two products must never share an authentication method.
function testPeachConnection(effective = {}) {
  return testCheckoutAuthentication(effective);
}

function providerPaymentId() {
  return `pay_${crypto.randomBytes(13).toString("hex")}`.slice(0, 30);
}

function localReference() {
  return `TP-PEACH-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function amountMinor(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) throw new AppError(400, "Top-up amount is invalid");
  return Math.round(amount * 100);
}

function providerStatus(payload = {}) {
  const code = payload["result.code"] || payload.result_code || payload.result?.code;
  const paymentType = String(payload.paymentType || payload.payment_type || "").toUpperCase();
  if (paymentType === "RF" && code && /^000\./.test(String(code))) return "refunded";
  if (code) {
    if (/^000\.000\.|^000\.100\./.test(String(code))) return "successful";
    if (/^000\.200\./.test(String(code))) return "pending";
    if (/100\.396\.101/.test(String(code))) return "cancelled";
    if (/100\.396\.104/.test(String(code))) return "uncertain";
    if (/^[1-9]/.test(String(code))) return "failed";
  }
  return String(
    payload.status || payload.state || payload.payment_status || payload.result?.status || payload.payment?.status || "pending"
  ).trim().toLowerCase();
}

function normalizedStatus(status) {
  const value = String(status || "pending").toLowerCase();
  if (SUCCESS_STATES.has(value)) return "completed";
  if (FAILURE_STATES.has(value)) return value === "canceled" ? "cancelled" : value;
  if (value === "uncertain") return "pending";
  if (REFUND_STATES.has(value)) return value === "partially_refunded" ? value : "refunded";
  return "pending";
}

function paymentIdFrom(payload = {}) {
  return String(payload.id || payload.payment_id || payload.paymentId || payload.result?.id || payload.payment?.id || "").trim();
}

function refundAmountFromPayload(payload = {}, transaction) {
  const decimalAmount = payload.amount?.value;
  if (decimalAmount !== undefined && Number.isFinite(Number(decimalAmount)) && Number(decimalAmount) > 0) return Number(decimalAmount);
  const raw = payload.refund_amount ?? payload.refunded_amount ?? payload.amount;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return Number(transaction.amount);
  // Peach responses use minor units for integer amounts; decimal amounts are
  // preserved as-is so a R100.00 refund is never interpreted as R1.00.
  return Number.isInteger(value) && value >= 100 ? value / 100 : value;
}

function paymentPayload(payload = {}, reference, paymentId, effective) {
  const token = payload.paymentToken || payload.payment_token || payload.token;
  const methodData = payload.paymentMethodData || payload.payment_method_data;
  if (!token && !methodData) throw new AppError(400, "A Peach payment token or tokenized payment method is required");
  const body = {
    amount: amountMinor(payload.amount),
    currency: String(payload.currency || "ZAR").trim().toUpperCase(),
    payment_id: paymentId,
    capture_method: payload.captureMethod || payload.capture_method || "automatic",
    authentication_type: payload.authenticationType || payload.authentication_type || "three_ds",
    confirm: Boolean(payload.confirm),
    return_url: payload.returnUrl || payload.return_url || effective.callbackUrl || undefined,
    metadata: { titoPayReference: reference, titoPayUserId: payload.userId }
  };
  if (token) body.payment_token = token;
  if (methodData) body.payment_method_data = methodData;
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined && value !== ""));
}

async function findTransaction(paymentId, userId, client = pool) {
  const params = [paymentId];
  let condition = "metadata->>'peachPaymentId' = $1 OR recipient_reference = $1";
  if (userId) { params.push(userId); condition = `(${condition}) AND user_id = $2`; }
  const result = await client.query(`SELECT * FROM transactions WHERE ${condition} ORDER BY created_at DESC LIMIT 1`, params);
  if (!result.rows[0]) throw new AppError(404, "Peach payment transaction not found");
  return result.rows[0];
}

async function settleTransaction(client, transaction, status, providerPayload = {}) {
  const metadata = typeof transaction.metadata === "string" ? JSON.parse(transaction.metadata) : (transaction.metadata || {});
  const nextMetadata = {
    ...metadata,
    providerStatus: providerStatus(providerPayload),
    providerUpdatedAt: new Date().toISOString()
  };
  if (status === "completed") {
    const existing = await client.query(
      "SELECT id FROM wallet_ledger WHERE transaction_id = $1 AND entry_type = 'credit' AND metadata->>'provider' = 'peach_payments' LIMIT 1",
      [transaction.id]
    );
    if (!existing.rows[0]) {
      await walletService.applyWalletMovement(client, {
        walletId: transaction.wallet_id,
        transactionId: transaction.id,
        entryType: "credit",
        amount: transaction.amount,
        reference: transaction.reference,
        metadata: { provider: "peach_payments", peachPaymentId: metadata.peachPaymentId || transaction.recipient_reference }
      });
    }
    if (metadata.merchantWalletId && metadata.merchantWalletId !== transaction.wallet_id) {
      const merchantCredit = await client.query(
        "SELECT id FROM wallet_ledger WHERE transaction_id = $1 AND wallet_id = $2 AND entry_type = 'credit' AND metadata->>'provider' = 'peach_payments' LIMIT 1",
        [transaction.id, metadata.merchantWalletId]
      );
      if (!merchantCredit.rows[0]) {
        await walletService.applyWalletMovement(client, {
          walletId: metadata.merchantWalletId,
          transactionId: transaction.id,
          entryType: "credit",
          amount: metadata.merchantNetAmount || transaction.amount,
          reference: transaction.reference,
          metadata: { provider: "peach_payments", settlement: "merchant" }
        });
      }
    }
    nextMetadata.settledAt = metadata.settledAt || new Date().toISOString();
  }
  if (status === "refunded" || status === "partially_refunded") {
    const refundAmount = Math.min(Number(transaction.amount), refundAmountFromPayload(providerPayload, transaction));
    const existingRefund = await client.query(
      "SELECT id FROM wallet_ledger WHERE transaction_id = $1 AND entry_type = 'debit' AND metadata->>'provider' = 'peach_payments_refund' LIMIT 1",
      [transaction.id]
    );
    if (!existingRefund.rows[0]) {
      await walletService.applyWalletMovement(client, {
        walletId: transaction.wallet_id,
        transactionId: transaction.id,
        entryType: "debit",
        amount: refundAmount,
        reference: `${transaction.reference}-REFUND`,
        metadata: { provider: "peach_payments_refund", amount: refundAmount }
      });
    }
    nextMetadata.refundedAmount = refundAmount;
  }
  await client.query("UPDATE transactions SET status = $2, metadata = $3::jsonb, updated_at = NOW() WHERE id = $1", [transaction.id, status, JSON.stringify(nextMetadata)]);
  return { status, transactionId: transaction.id, reference: transaction.reference };
}

async function createCardTopup(actor, payload = {}) {
  assertEnabled();
  const effective = { ...config.integrations.peachPayments, ...payload.peachConfig };
  const clientIdempotencyKey = String(payload.idempotencyKey || payload.clientIdempotencyKey || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,200}$/.test(clientIdempotencyKey)) throw new AppError(400, "A valid idempotency key is required");
  if (clientIdempotencyKey) {
    const existing = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND metadata->>'clientIdempotencyKey' = $2 ORDER BY created_at DESC LIMIT 1", [actor.userId, clientIdempotencyKey]);
    if (existing.rows[0]) return { transactionId: existing.rows[0].id, reference: existing.rows[0].reference, status: existing.rows[0].status, idempotentReplay: true };
  }
  const paymentId = providerPaymentId();
  const reference = localReference();
  const body = paymentPayload({ ...payload, userId: actor.userId }, reference, paymentId, effective);
  const wallet = await walletService.getPrimaryWalletForUser(actor.userId);
  const transactionId = uuidv4();
  const amount = Number(body.amount) / 100;
  await pool.query(
    `INSERT INTO transactions (id,user_id,wallet_id,service_code,amount,fee,total,status,direction,reference,recipient_reference,metadata)
     VALUES ($1,$2,$3,'wallet_top_up',$4,0,$4,'pending','credit',$5,$6,$7::jsonb)`,
    [transactionId, actor.userId, wallet.id, amount, reference, paymentId, JSON.stringify({ provider: "peach_payments", peachPaymentId: paymentId, clientIdempotencyKey, environment: body.environment || effective.environment || effective.mode || "production", currency: body.currency })]
  );
  let response;
  try {
    response = await requestPeach(effective, "POST", "payments", body);
  } catch (error) {
    await pool.query(
      "UPDATE transactions SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW() WHERE id = $1",
      [transactionId, error.details?.code === "NETWORK_TIMEOUT" ? "pending" : "failed", JSON.stringify({ providerError: error.message, providerErrorCode: error.details?.code || "PROVIDER_REQUEST_FAILED" })]
    ).catch(() => {});
    throw error;
  }
  const providerPayload = response.payload || {};
  const status = normalizedStatus(providerStatus(providerPayload));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE transactions SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW() WHERE id = $1",
      [transactionId, status, JSON.stringify({ providerStatus: providerStatus(providerPayload), environment: response.environment })]
    );
    const transaction = { id: transactionId, wallet_id: wallet.id, amount, reference, recipient_reference: paymentId, metadata: { peachPaymentId: paymentId, providerStatus: providerStatus(providerPayload) } };
    if (status === "completed") await settleTransaction(client, transaction, status, providerPayload);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  return { transactionId, reference, peachPaymentId: paymentId, status, amount, currency: body.currency, providerResponse: providerPayload };
}

async function paymentAction(actor, paymentId, action, payload = {}) {
  assertEnabled();
  const effective = { ...config.integrations.peachPayments, ...payload.peachConfig };
  const path = `/payments/${encodeURIComponent(paymentId)}${action ? `/${action}` : ""}`;
  const response = await requestPeach(effective, action ? "POST" : "GET", path, action ? payload : undefined);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transaction = await findTransaction(paymentId, actor.userId, client);
    const status = normalizedStatus(providerStatus(response.payload));
    await settleTransaction(client, transaction, status, response.payload);
    await client.query("COMMIT");
    return { transactionId: transaction.id, reference: transaction.reference, peachPaymentId: paymentId, status, providerResponse: response.payload };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

async function refundCardTopup(actor, paymentId, payload = {}) {
  assertEnabled();
  const transaction = await findTransaction(paymentId, actor.userId);
  if (!["completed", "partially_refunded"].includes(transaction.status)) throw new AppError(409, "Only a completed Peach payment can be refunded");
  const refundId = `ref_${crypto.randomBytes(13).toString("hex")}`.slice(0, 30);
  const body = { payment_id: paymentId, refund_id: refundId, reason: payload.reason || "requested_by_customer" };
  if (payload.amount !== undefined) body.amount = amountMinor(payload.amount);
  const response = await requestPeach({ ...config.integrations.peachPayments, ...payload.peachConfig }, "POST", "refunds", body);
  return { transactionId: transaction.id, reference: transaction.reference, peachPaymentId: paymentId, refundId, status: normalizedStatus(providerStatus(response.payload)), providerResponse: response.payload };
}

async function processPeachPaymentWebhook(event = {}) {
  const payload = event.payload || event;
  const paymentId = paymentIdFrom(payload);
  const status = normalizedStatus(providerStatus(payload));
  if (!paymentId) return { matched: false, status };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transaction = await findTransaction(paymentId, null, client);
    const result = await settleTransaction(client, transaction, status, payload);
    await client.query("COMMIT");
    return { matched: true, ...result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.statusCode === 404) return { matched: false, status };
    throw error;
  } finally { client.release(); }
}

module.exports = {
  testPeachConnection,
  createCardTopup,
  getCardTopupStatus: (actor, paymentId) => paymentAction(actor, paymentId, ""),
  confirmCardTopup: (actor, paymentId, payload) => paymentAction(actor, paymentId, "confirm", payload),
  captureCardTopup: (actor, paymentId, payload) => paymentAction(actor, paymentId, "capture", payload),
  cancelCardTopup: (actor, paymentId, payload) => paymentAction(actor, paymentId, "cancel", payload),
  refundCardTopup,
  processPeachPaymentWebhook,
  normalizedStatus,
  providerStatus,
  requestPeach
};
