"use strict";

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config/env");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { applyWalletMovement } = require("../services/wallet-service");
const { writeAuditLog } = require("../services/audit-service");
const { encryptTerminalSecret, sha256 } = require("./security");

const PROVIDERS = new Set(["STANDARD_BANK", "ABSA", "NEDBANK", "CAPITEC", "OTHER"]);
const FINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED", "REVERSED", "REFUNDED"]);
const TRANSITIONS = {
  PENDING: new Set(["SCANNED", "CANCELLED", "EXPIRED"]),
  SCANNED: new Set(["AUTHORIZED", "CANCELLED", "EXPIRED"]),
  AUTHORIZED: new Set(["PROCESSING", "FAILED"]),
  PROCESSING: new Set(["COMPLETED", "FAILED"]),
  COMPLETED: new Set(["REVERSED", "REFUNDED"]),
  FAILED: new Set(),
  CANCELLED: new Set(),
  EXPIRED: new Set(),
  REVERSED: new Set(),
  REFUNDED: new Set()
};

function money(value, label = "Amount") {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new AppError(400, `${label} is invalid`);
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > Math.round(config.pos.maxAmount * 100)) {
    throw new AppError(400, `${label} is outside the supported range`);
  }
  return cents;
}

function paymentReference() {
  return `TP_POS_${crypto.randomBytes(7).toString("hex").toUpperCase()}`;
}

function safeIntent(row) {
  return {
    paymentId: row.payment_id,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    merchantName: row.business_name,
    merchantReference: row.merchant_reference,
    terminalId: row.terminal_code || row.terminal_id,
    provider: row.provider,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    transactionReference: row.transaction_reference || null
  };
}

async function addEvent(client, intent, nextStatus, actor = {}) {
  const previous = intent.status;
  if (previous !== nextStatus && !TRANSITIONS[previous]?.has(nextStatus)) {
    throw new AppError(409, `Invalid POS payment transition from ${previous} to ${nextStatus}`);
  }
  if (previous !== nextStatus) {
    await client.query(
      "UPDATE pos_payment_intents SET status = $2, updated_at = NOW() WHERE id = $1",
      [intent.id, nextStatus]
    );
    intent.status = nextStatus;
  }
  await client.query(
    `INSERT INTO pos_payment_events
       (payment_intent_id, event_type, previous_status, new_status, actor_type, actor_id, terminal_id, provider, request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB)`,
    [
      intent.id,
      actor.eventType || nextStatus.toLowerCase(),
      previous,
      nextStatus,
      actor.actorType || "system",
      actor.actorId || null,
      intent.terminal_id,
      intent.provider,
      actor.requestId || null,
      JSON.stringify(actor.metadata || {})
    ]
  );
}

async function idempotentResult(client, scope, key, requestHash) {
  if (!key) throw new AppError(400, "Idempotency-Key is required");
  const result = await client.query(
    "SELECT request_hash, response FROM pos_idempotency_keys WHERE scope = $1 AND idempotency_key = $2 LIMIT 1",
    [scope, key]
  );
  if (!result.rows[0]) return null;
  if (result.rows[0].request_hash !== requestHash) throw new AppError(409, "Idempotency-Key was already used for a different request");
  return result.rows[0].response;
}

async function saveIdempotency(client, scope, key, requestHash, response) {
  await client.query(
    `INSERT INTO pos_idempotency_keys (scope, idempotency_key, request_hash, response)
     VALUES ($1,$2,$3,$4::JSONB)`,
    [scope, key, requestHash, JSON.stringify(response)]
  );
}

async function lockIdempotency(client, scope, key) {
  if (!key) throw new AppError(400, "Idempotency-Key is required");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${scope}:${key}`]);
}

async function registerTerminal(actor, payload, meta = {}) {
  if (actor.userType !== "admin") throw new AppError(403, "Admin access required to register POS terminals");
  const merchantCode = String(payload.merchantId || "").trim();
  const terminalId = String(payload.terminalId || "").trim();
  const provider = String(payload.provider || "").trim().toUpperCase();
  const deviceIdentifier = String(payload.deviceIdentifier || "").trim();
  if (!merchantCode || !terminalId || !deviceIdentifier) throw new AppError(400, "merchantId, terminalId and deviceIdentifier are required");
  if (!PROVIDERS.has(provider)) throw new AppError(400, "POS provider is invalid");
  const merchantResult = await pool.query(
    "SELECT id, merchant_id, business_name, status FROM merchants WHERE merchant_id = $1 LIMIT 1",
    [merchantCode]
  );
  const merchant = merchantResult.rows[0];
  if (!merchant || merchant.status !== "active") throw new AppError(404, "Active merchant not found");
  const secret = crypto.randomBytes(32).toString("base64url");
  const result = await pool.query(
    `INSERT INTO pos_terminals
       (id, terminal_id, merchant_id, provider, device_identifier, status, credential_encrypted, credential_fingerprint, created_by)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)
     ON CONFLICT (terminal_id) DO UPDATE
       SET merchant_id = EXCLUDED.merchant_id,
           provider = EXCLUDED.provider,
           device_identifier = EXCLUDED.device_identifier,
           status = 'active',
           credential_encrypted = EXCLUDED.credential_encrypted,
           credential_fingerprint = EXCLUDED.credential_fingerprint,
           updated_at = NOW()
     RETURNING id, terminal_id, provider, device_identifier, status, created_at, updated_at`,
    [uuidv4(), terminalId, merchant.id, provider, deviceIdentifier, encryptTerminalSecret(secret), sha256(secret).slice(0, 16), actor.userId]
  );
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "pos_terminal_registered",
    entityType: "pos_terminal",
    entityId: result.rows[0].id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { terminalId, merchantId: merchantCode, provider }
  });
  return { terminal: result.rows[0], terminalSecret: secret };
}

async function createPaymentIntent(terminal, payload, idempotencyKey, requestId) {
  const merchantCode = String(payload.merchantId || "").trim();
  const terminalCode = String(payload.terminalId || "").trim();
  const currency = String(payload.currency || "").trim().toUpperCase();
  const merchantReference = String(payload.merchantReference || "").trim().slice(0, 160);
  const amountCents = money(payload.amount);
  if (currency !== "ZAR") throw new AppError(400, "Only ZAR is currently supported");
  if (merchantCode !== terminal.merchant_code || terminalCode !== terminal.terminal_id) {
    throw new AppError(403, "Terminal does not belong to the supplied merchant");
  }
  if (!merchantReference) throw new AppError(400, "merchantReference is required");
  const requestHash = sha256(JSON.stringify({ merchantCode, terminalCode, amountCents, currency, merchantReference }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockIdempotency(client, `intent:${terminal.id}`, idempotencyKey);
    const replay = await idempotentResult(client, `intent:${terminal.id}`, idempotencyKey, requestHash);
    if (replay) {
      await client.query("COMMIT");
      return { ...replay, idempotentReplay: true };
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const id = uuidv4();
    const paymentId = paymentReference();
    const result = await client.query(
      `INSERT INTO pos_payment_intents
         (id, payment_id, merchant_id, terminal_id, amount, currency, merchant_reference, qr_token_hash, status, expires_at, provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',NOW() + ($9 || ' seconds')::INTERVAL,$10)
       RETURNING *`,
      [id, paymentId, terminal.merchant_id_uuid, terminal.id, amountCents / 100, currency, merchantReference, sha256(token), config.pos.qrExpirySeconds, terminal.provider]
    );
    const intent = result.rows[0];
    await addEvent(client, intent, "PENDING", { eventType: "payment_intent_created", actorType: "terminal", actorId: terminal.id, requestId });
    const response = {
      paymentId,
      status: "PENDING",
      amount: amountCents / 100,
      currency,
      merchantName: terminal.business_name,
      qrPayload: `${config.pos.universalLinkBase}/${token}`,
      expiresIn: config.pos.qrExpirySeconds,
      createdAt: intent.created_at
    };
    await saveIdempotency(client, `intent:${terminal.id}`, idempotencyKey, requestHash, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadIntentForUpdate(client, paymentId) {
  const result = await client.query(
    `SELECT p.*, m.business_name, m.user_id AS merchant_user_id,
            t.terminal_id AS terminal_code, t.status AS terminal_status
       FROM pos_payment_intents p
       JOIN merchants m ON m.id = p.merchant_id
       JOIN pos_terminals t ON t.id = p.terminal_id
      WHERE p.payment_id = $1
      FOR UPDATE OF p`,
    [paymentId]
  );
  const intent = result.rows[0];
  if (!intent) throw new AppError(404, "POS payment not found");
  return intent;
}

async function expireIfNeeded(client, intent, requestId) {
  if (!FINAL_STATES.has(intent.status) && new Date(intent.expires_at).getTime() <= Date.now()) {
    await addEvent(client, intent, "EXPIRED", { eventType: "payment_expired", requestId });
  }
}

async function rejectPersistedExpiry(client, intent) {
  if (intent.status !== "EXPIRED") return;
  await client.query("COMMIT");
  const error = new AppError(410, "QR payment has expired");
  error.posTransactionCommitted = true;
  throw error;
}

async function resolvePaymentIntent(token, actor, requestId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT p.*, m.business_name, m.status AS merchant_status,
              t.terminal_id AS terminal_code, t.status AS terminal_status
         FROM pos_payment_intents p
         JOIN merchants m ON m.id = p.merchant_id
         JOIN pos_terminals t ON t.id = p.terminal_id
        WHERE p.qr_token_hash = $1
        FOR UPDATE OF p`,
      [sha256(token)]
    );
    const intent = result.rows[0];
    if (!intent) throw new AppError(404, "QR payment is invalid");
    await expireIfNeeded(client, intent, requestId);
    await rejectPersistedExpiry(client, intent);
    if (intent.merchant_status !== "active" || intent.terminal_status !== "active") throw new AppError(409, "Merchant terminal is unavailable");
    if (intent.status === "PENDING") {
      await addEvent(client, intent, "SCANNED", { eventType: "qr_scanned", actorType: "customer", actorId: actor.userId, requestId });
    }
    if (!["SCANNED", "PENDING"].includes(intent.status)) throw new AppError(409, `POS payment is ${intent.status}`);
    const response = safeIntent(intent);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    if (!error.posTransactionCommitted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function confirmPayment(paymentId, actor, idempotencyKey, requestId) {
  if (actor.userType !== "customer") throw new AppError(403, "Customer authentication required");
  if (actor.profileLocked) throw new AppError(423, "Profile is locked. Financial transactions are disabled.");
  const requestHash = sha256(`${paymentId}:${actor.userId}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockIdempotency(client, `confirm:${actor.userId}`, idempotencyKey);
    const replay = await idempotentResult(client, `confirm:${actor.userId}`, idempotencyKey, requestHash);
    if (replay) {
      await client.query("COMMIT");
      return { ...replay, idempotentReplay: true };
    }
    const intent = await loadIntentForUpdate(client, paymentId);
    await expireIfNeeded(client, intent, requestId);
    await rejectPersistedExpiry(client, intent);
    if (!["PENDING", "SCANNED"].includes(intent.status)) throw new AppError(409, `POS payment is ${intent.status}`);
    const customerResult = await client.query(
      `SELECT u.status AS account_status, u.profile_locked, u.fica_status, w.*
         FROM users u
         JOIN wallets w ON w.user_id = u.id
        WHERE u.id = $1
        ORDER BY w.created_at ASC
        LIMIT 1
        FOR UPDATE OF w`,
      [actor.userId]
    );
    const customerWallet = customerResult.rows[0];
    if (!customerWallet || customerWallet.account_status !== "active" || customerWallet.status !== "active") {
      throw new AppError(404, "Active customer wallet not found");
    }
    if (customerWallet.profile_locked) throw new AppError(423, "Profile is locked. Financial transactions are disabled.");
    const merchantWalletResult = await client.query(
      `SELECT w.*
         FROM merchants m
         LEFT JOIN merchant_wallets mw ON mw.merchant_id = m.id AND mw.status = 'active'
         JOIN wallets w ON w.id = COALESCE(mw.wallet_id, (
           SELECT id FROM wallets WHERE user_id = m.user_id AND kind IN ('merchant','business') ORDER BY created_at ASC LIMIT 1
         ))
        WHERE m.id = $1 AND m.status = 'active'
        LIMIT 1
        FOR UPDATE OF w`,
      [intent.merchant_id]
    );
    const merchantWallet = merchantWalletResult.rows[0];
    if (!merchantWallet || merchantWallet.status !== "active") throw new AppError(503, "Merchant settlement wallet is unavailable");
    if (Number(customerWallet.available_balance) < Number(intent.amount)) throw new AppError(400, "Insufficient balance");
    await addEvent(client, intent, "AUTHORIZED", { actorType: "customer", actorId: actor.userId, requestId });
    await addEvent(client, intent, "PROCESSING", { actorType: "system", requestId });
    const transactionId = uuidv4();
    const transactionReference = `POS-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await client.query(
      `INSERT INTO transactions
         (id,user_id,wallet_id,merchant_id,service_code,amount,fee,total,status,direction,reference,recipient_reference,metadata)
       VALUES ($1,$2,$3,$4,'pos_qr',$5,0,$5,'processing','debit',$6,$7,$8::JSONB)`,
      [transactionId, actor.userId, customerWallet.id, intent.merchant_id, intent.amount, transactionReference, intent.merchant_reference,
        JSON.stringify({ channel: "POS_QR", paymentId, terminalId: intent.terminal_code, provider: intent.provider, merchantReference: intent.merchant_reference, merchantWalletId: merchantWallet.id })]
    );
    await applyWalletMovement(client, {
      walletId: customerWallet.id,
      transactionId,
      entryType: "debit",
      amount: intent.amount,
      reference: transactionReference,
      metadata: { channel: "POS_QR", paymentId, terminalId: intent.terminal_code, provider: intent.provider }
    });
    await applyWalletMovement(client, {
      walletId: merchantWallet.id,
      transactionId,
      entryType: "credit",
      amount: intent.amount,
      reference: transactionReference,
      metadata: { channel: "POS_QR", paymentId, customerId: actor.userId }
    });
    await client.query("UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1", [transactionId]);
    await client.query(
      `UPDATE pos_payment_intents
          SET customer_id = $2, transaction_id = $3, transaction_reference = $4,
              completed_at = NOW(), qr_consumed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [intent.id, actor.userId, transactionId, transactionReference]
    );
    await addEvent(client, intent, "COMPLETED", { eventType: "payment_completed", actorType: "system", requestId, metadata: { transactionReference } });
    const response = { ...safeIntent({ ...intent, status: "COMPLETED", transaction_reference: transactionReference, completed_at: new Date().toISOString() }), receipt: { reference: transactionReference, channel: "POS_QR" } };
    await saveIdempotency(client, `confirm:${actor.userId}`, idempotencyKey, requestHash, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    if (!error.posTransactionCommitted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getPaymentStatus(paymentId, terminal, requestId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const intent = await loadIntentForUpdate(client, paymentId);
    if (intent.terminal_id !== terminal.id) throw new AppError(403, "Payment does not belong to this terminal");
    await expireIfNeeded(client, intent, requestId);
    await client.query("COMMIT");
    return safeIntent(intent);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cancelPayment(paymentId, terminal, payload, idempotencyKey, requestId) {
  const requestHash = sha256(`${paymentId}:${String(payload.reason || "").trim()}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockIdempotency(client, `cancel:${terminal.id}`, idempotencyKey);
    const replay = await idempotentResult(client, `cancel:${terminal.id}`, idempotencyKey, requestHash);
    if (replay) {
      await client.query("COMMIT");
      return { ...replay, idempotentReplay: true };
    }
    const intent = await loadIntentForUpdate(client, paymentId);
    if (intent.terminal_id !== terminal.id) throw new AppError(403, "Payment does not belong to this terminal");
    await expireIfNeeded(client, intent, requestId);
    if (!["PENDING", "SCANNED"].includes(intent.status)) throw new AppError(409, `POS payment cannot be cancelled from ${intent.status}`);
    await client.query("UPDATE pos_payment_intents SET cancellation_reason = $2, cancelled_at = NOW() WHERE id = $1", [intent.id, String(payload.reason || "Cancelled by terminal").slice(0, 280)]);
    await addEvent(client, intent, "CANCELLED", { eventType: "payment_cancelled", actorType: "terminal", actorId: terminal.id, requestId });
    const response = safeIntent(intent);
    await saveIdempotency(client, `cancel:${terminal.id}`, idempotencyKey, requestHash, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assertPaymentOperator(client, intent, actor) {
  if (actor.userType === "admin") return;
  const merchant = await client.query("SELECT user_id FROM merchants WHERE id = $1", [intent.merchant_id]);
  if (actor.userType !== "customer" || merchant.rows[0]?.user_id !== actor.userId) {
    throw new AppError(403, "Merchant or admin authorisation required");
  }
}

async function refundOrReverse(kind, paymentId, actor, payload, idempotencyKey, requestId) {
  const client = await pool.connect();
  const requestedCents = kind === "refund" ? money(payload.amount, "Refund amount") : null;
  const requestHash = sha256(`${kind}:${paymentId}:${requestedCents || "full"}`);
  try {
    await client.query("BEGIN");
    await lockIdempotency(client, `${kind}:${paymentId}`, idempotencyKey);
    const replay = await idempotentResult(client, `${kind}:${paymentId}`, idempotencyKey, requestHash);
    if (replay) {
      await client.query("COMMIT");
      return { ...replay, idempotentReplay: true };
    }
    const intent = await loadIntentForUpdate(client, paymentId);
    await assertPaymentOperator(client, intent, actor);
    if (!["COMPLETED", "REFUNDED"].includes(intent.status)) throw new AppError(409, `POS payment cannot be ${kind}ed from ${intent.status}`);
    const refunded = await client.query("SELECT COALESCE(SUM(amount),0)::NUMERIC total FROM pos_refunds WHERE payment_intent_id = $1 AND status = 'completed'", [intent.id]);
    const refundedCents = Math.round(Number(refunded.rows[0].total) * 100);
    const totalCents = Math.round(Number(intent.amount) * 100);
    const amountCents = kind === "reverse" ? totalCents : requestedCents;
    if (kind === "reverse" && refundedCents > 0) throw new AppError(409, "A payment with refunds cannot be reversed");
    if (refundedCents + amountCents > totalCents) throw new AppError(409, "Cumulative refunds cannot exceed the original payment");
    const wallets = await client.query(
      `SELECT
         (SELECT id FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1) customer_wallet_id,
         (SELECT w.id FROM merchants m LEFT JOIN merchant_wallets mw ON mw.merchant_id=m.id
            JOIN wallets w ON w.id=COALESCE(mw.wallet_id,(SELECT id FROM wallets WHERE user_id=m.user_id AND kind IN ('merchant','business') ORDER BY created_at LIMIT 1))
           WHERE m.id=$2 LIMIT 1) merchant_wallet_id`,
      [intent.customer_id, intent.merchant_id]
    );
    const customerWalletId = wallets.rows[0]?.customer_wallet_id;
    const merchantWalletId = wallets.rows[0]?.merchant_wallet_id;
    if (!customerWalletId || !merchantWalletId) throw new AppError(503, "Refund wallets are unavailable");
    const transactionId = uuidv4();
    const reference = `${kind === "reverse" ? "POS-REV" : "POS-REF"}-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await client.query(
      `INSERT INTO transactions
         (id,user_id,wallet_id,merchant_id,service_code,amount,fee,total,status,direction,reference,recipient_reference,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,0,$6,'processing','credit',$7,$8,$9::JSONB)`,
      [transactionId, intent.customer_id, customerWalletId, intent.merchant_id, kind === "reverse" ? "pos_qr_reversal" : "pos_qr_refund", amountCents / 100, reference, intent.merchant_reference, JSON.stringify({ channel: "POS_QR", originalPaymentId: paymentId, originalTransactionId: intent.transaction_id, operation: kind })]
    );
    await applyWalletMovement(client, { walletId: merchantWalletId, transactionId, entryType: "debit", amount: amountCents / 100, reference, metadata: { channel: "POS_QR", originalPaymentId: paymentId, operation: kind } });
    await applyWalletMovement(client, { walletId: customerWalletId, transactionId, entryType: "credit", amount: amountCents / 100, reference, metadata: { channel: "POS_QR", originalPaymentId: paymentId, operation: kind } });
    await client.query("UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1", [transactionId]);
    await client.query(
      `INSERT INTO pos_refunds (payment_intent_id, transaction_id, operation, amount, status, reason, processed_by)
       VALUES ($1,$2,$3,$4,'completed',$5,$6)`,
      [intent.id, transactionId, kind, amountCents / 100, String(payload.reason || "").slice(0, 280), actor.userId]
    );
    const newRefundedCents = refundedCents + amountCents;
    const nextStatus = kind === "reverse" ? "REVERSED" : newRefundedCents === totalCents ? "REFUNDED" : intent.status;
    await addEvent(client, intent, nextStatus, { eventType: `payment_${kind}ed`, actorType: actor.userType, actorId: actor.userId, requestId, metadata: { amount: amountCents / 100, reference } });
    const response = { paymentId, status: nextStatus, operation: kind, amount: amountCents / 100, cumulativeRefunded: newRefundedCents / 100, reference };
    await saveIdempotency(client, `${kind}:${paymentId}`, idempotencyKey, requestHash, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processProviderWebhook(event, requestId) {
  const eventId = String(event.id || event.eventId || "").trim();
  if (!eventId) throw new AppError(400, "Provider event ID is required");
  const result = await pool.query(
    `INSERT INTO pos_provider_events (event_id, provider, event_type, payload, request_id)
     VALUES ($1,$2,$3,$4::JSONB,$5)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [eventId, String(event.provider || "OTHER").toUpperCase(), String(event.type || "provider_event"), JSON.stringify(event), requestId || null]
  );
  return { duplicate: result.rowCount === 0, eventId };
}

module.exports = {
  TRANSITIONS,
  money,
  registerTerminal,
  createPaymentIntent,
  resolvePaymentIntent,
  confirmPayment,
  getPaymentStatus,
  cancelPayment,
  refundOrReverse,
  processProviderWebhook
};
