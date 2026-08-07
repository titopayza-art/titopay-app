const express = require("express");
const crypto = require("crypto");
const { config } = require("../config/env");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum } = require("../lib/validation");
const { processPeachPaymentWebhook } = require("../services/peach-payments-service");

const router = express.Router();

const WEBHOOK_PROVIDERS = ["peach_payments", "docfox", "ott", "flash", "smtp", "sms"];

function webhookSettingKey() {
  return "integration_webhook_events";
}

function providerWebhookSecret(provider) {
  const envMap = {
    peach_payments: config.integrations.peachPayments.webhookSecret,
    docfox: config.integrations.docfox.webhookSecret,
    ott: config.integrations.ott.webhookSecret,
    flash: process.env.FLASH_WEBHOOK_SECRET || "",
    smtp: "",
    sms: config.integrations.sms.webhookSecret
  };
  return envMap[provider] || "";
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function integrationEncryptionKey() {
  return crypto
    .createHash("sha256")
    .update(config.refreshSecret || config.accessSecret)
    .digest();
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text.startsWith("enc:")) return "";
  const [, ivText, tagText, encryptedText] = text.split(":");
  if (!ivText || !tagText || !encryptedText) return "";
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    integrationEncryptionKey(),
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function loadPeachWebhookConfig() {
  const result = await pool.query(
    "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1",
    ["integration_peach_payments"],
  );
  const saved = result.rows[0]?.value || {};
  return {
    secret: decryptSecret(saved?.secrets?.webhookSecretEncrypted)
      || config.integrations?.peachPayments?.webhookSecret
      || "",
    merchantId: String(saved.merchantId || config.integrations?.peachPayments?.merchantId || "").trim(),
    entityId: String(saved.entityId || config.integrations?.peachPayments?.entityId || "").trim(),
  };
}

function suppliedPeachSignature(req) {
  return String(req.get("x-webhook-signature") || "").trim();
}

function normalizeSignature(signature) {
  const value = String(signature || "").trim();
  const versioned = value.match(/(?:^|,)\s*v1=([^,\s]+)/i);
  return (versioned?.[1] || value.replace(/^sha256=/i, "")).trim();
}

function peachWebhookUrl(req) {
  const configured = String(config.integrations?.peachPayments?.webhookUrl || "").trim();
  if (configured) return configured;
  const apiBase = String(config.apiBaseUrl || "").replace(/\/+$/, "");
  const requestPath = String(req.originalUrl || req.url || "").split("?")[0];
  return `${apiBase}${requestPath}`;
}

function validWebhookTimestamp(timestamp, now = Date.now()) {
  if (!/^\d{10,13}$/.test(String(timestamp || ""))) return false;
  const numeric = Number(timestamp);
  const timestampMs = String(timestamp).length === 13 ? numeric : numeric * 1000;
  return Number.isFinite(timestampMs) && Math.abs(now - timestampMs) <= 5 * 60 * 1000;
}

function hasPeachVerificationEnvelope(req) {
  const algorithm = String(req.get("x-webhook-signature-algorithm") || "hmac-sha256")
    .trim()
    .toLowerCase();
  return Boolean(
    Buffer.isBuffer(req.rawBody)
    && suppliedPeachSignature(req)
    && validWebhookTimestamp(String(req.get("x-webhook-timestamp") || "").trim())
    && /^[A-Za-z0-9._:-]{1,200}$/.test(String(req.get("x-webhook-id") || "").trim())
    && ["hmac-sha256", "sha256"].includes(algorithm)
  );
}

function verifyPeachSignature(req, secret) {
  const rawBody = req.rawBody;
  const signature = suppliedPeachSignature(req);
  const timestamp = String(req.get("x-webhook-timestamp") || "").trim();
  const webhookId = String(req.get("x-webhook-id") || "").trim();
  const algorithm = String(req.get("x-webhook-signature-algorithm") || "hmac-sha256")
    .trim()
    .toLowerCase();

  if (
    !Buffer.isBuffer(rawBody)
    || !secret
    || !signature
    || !validWebhookTimestamp(timestamp)
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(webhookId)
    || !["hmac-sha256", "sha256"].includes(algorithm)
  ) return false;

  const message = `${timestamp}.${webhookId}.${peachWebhookUrl(req)}.${rawBody.toString("utf8")}`;
  const digest = crypto.createHmac("sha256", secret).update(message).digest();
  const candidates = [digest.toString("hex"), digest.toString("base64")];
  const supplied = normalizeSignature(signature);
  return candidates.some((candidate) => timingSafeEqualText(candidate, supplied));
}

function firstValue(body, paths) {
  for (const path of paths) {
    const value = Object.prototype.hasOwnProperty.call(body, path)
      ? body[path]
      : path.split(".").reduce((current, key) => current?.[key], body);
    if (
      value !== undefined
      && value !== null
      && (typeof value === "string" || typeof value === "number")
      && String(value).trim() !== ""
    ) return String(value).trim();
  }
  return "";
}

function validatePeachPayload(body, expected) {
  const merchantId = firstValue(body, ["merchantId", "merchant_id", "merchant.id", "merchant"]);
  const entityId = firstValue(body, [
    "entityId", "entity_id", "entity.id", "authentication.entityId", "payload.entityId",
  ]);
  const amountText = firstValue(body, ["amount", "amount.value", "payment.amount"]);
  const currency = firstValue(body, ["currency", "amount.currency", "payment.currency"]).toUpperCase();
  const transactionId = firstValue(body, [
    "transactionId", "transaction_id", "merchantTransactionId", "paymentId", "payment_id", "id",
    "result.id", "payment.id", "payload.id", "payload.payment.id",
  ]);

  if (!merchantId) throw new AppError(400, "Merchant ID is required");
  if (!entityId) throw new AppError(400, "Entity ID is required");
  if (expected.merchantId && !timingSafeEqualText(merchantId, expected.merchantId)) {
    throw new AppError(400, "Merchant ID is invalid");
  }
  if (expected.entityId && !timingSafeEqualText(entityId, expected.entityId)) {
    throw new AppError(400, "Entity ID is invalid");
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0) {
    throw new AppError(400, "Amount is invalid");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(400, "Currency is invalid");
  if (!transactionId || transactionId.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(transactionId)) {
    throw new AppError(400, "Transaction ID is invalid");
  }

  return { merchantId, entityId, amount: amountText, currency, transactionId };
}

// Peach Checkout sends the production webhook fields (merchant.name,
// merchantTransactionId, result.code, paymentType) and does not include an
// entity ID in every event. Keep this additive so the existing webhook contract
// remains unchanged when PEACH_PAYMENTS_V2_ENABLED is false.
function validatePeachV2Payload(body, expected) {
  const merchantId = firstValue(body, ["merchantId", "merchant_id", "merchant.name", "merchant"]);
  const amountText = firstValue(body, ["amount", "amount.value", "payment.amount"]);
  const currency = firstValue(body, ["currency", "amount.currency", "payment.currency"]).toUpperCase();
  const transactionId = firstValue(body, [
    "paymentId", "payment_id", "id", "transactionId", "transaction_id", "merchantTransactionId", "merchant_transaction_id",
    "result.id", "payment.id", "payload.id", "payload.payment.id"
  ]);
  if (!amountText || !/^\d+(?:\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0) throw new AppError(400, "Amount is invalid");
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(400, "Currency is invalid");
  if (!transactionId || transactionId.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(transactionId)) throw new AppError(400, "Transaction ID is invalid");
  if (expected.merchantId && merchantId && !timingSafeEqualText(merchantId, expected.merchantId)) throw new AppError(400, "Merchant ID is invalid");
  return { merchantId, entityId: "", amount: amountText, currency, transactionId };
}

function webhookIdempotencyKey(transactionId) {
  return `peach_webhook_${crypto
    .createHash("sha256")
    .update(transactionId)
    .digest("hex")}`;
}

function peachV2WebhookIdempotencyKey(event) {
  return `peach_webhook_v2_${crypto
    .createHash("sha256")
    .update(`${event.webhookId}:${event.id}:${event.eventType}`)
    .digest("hex")}`;
}

async function reservePeachWebhookEvent(key, event) {
  const result = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2::JSONB, NOW())
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, JSON.stringify(event)],
  );
  return result.rowCount === 1 || result.rows.length === 1;
}

async function processPeachWebhookEvent(key, event) {
  await pool.query(
    `UPDATE platform_settings
        SET value = $2::JSONB, updated_at = NOW()
      WHERE key = $1`,
    [key, JSON.stringify({
      ...event,
      status: "processed",
      processedAt: new Date().toISOString(),
    })],
  );
}

async function processPeachWebhookEventV2(key, event) {
  const result = await processPeachPaymentWebhook(event);
  await pool.query(
    `UPDATE platform_settings
        SET value = $2::JSONB, updated_at = NOW()
      WHERE key = $1`,
    [key, JSON.stringify({
      ...event,
      status: "processed",
      processing: result,
      processedAt: new Date().toISOString(),
    })],
  );
  return result;
}

async function handlePeachProviderWebhook(req, res, next) {
  try {
    // Reject malformed or unsigned deliveries before touching configuration or
    // the database. Invalid webhooks must always fail closed with HTTP 401.
    if (!hasPeachVerificationEnvelope(req)) {
      throw new AppError(401, "Webhook signature is invalid");
    }
    const webhookConfig = await loadPeachWebhookConfig();
    if (!webhookConfig.secret) {
      throw new AppError(503, "Peach Payments webhook is not configured");
    }
    if (!verifyPeachSignature(req, webhookConfig.secret)) {
      throw new AppError(401, "Webhook signature is invalid");
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const useV2 = Boolean(config.integrations.peachPayments.v2Enabled);
    const validated = useV2 ? validatePeachV2Payload(body, webhookConfig) : validatePeachPayload(body, webhookConfig);
    const event = {
      id: validated.transactionId,
      webhookId: String(req.get("x-webhook-id") || ""),
      provider: "peach_payments",
      eventType: String(body.type || body.eventType || body.status || body.result?.status || body.result?.code || body["result.code"] || body.result_code || "payment_event"),
      receivedAt: new Date().toISOString(),
      status: "received",
      payload: body,
    };
    const idempotencyKey = useV2
      ? peachV2WebhookIdempotencyKey(event)
      : webhookIdempotencyKey(validated.transactionId);
    const reserved = await reservePeachWebhookEvent(idempotencyKey, event);

    res.status(200).json({
      ok: true,
      received: true,
      eventId: event.id,
      duplicate: !reserved,
    });
    if (reserved) setImmediate(() => {
      const processor = useV2 ? processPeachWebhookEventV2 : processPeachWebhookEvent;
      processor(idempotencyKey, event).catch((error) => {
        console.error("[peach-webhook-processing-failed]", {
          eventId: event.id,
          message: error?.message || "Unknown processing error",
        });
      });
    });
  } catch (error) {
    next(error);
  }
}

router.use(requireAuth);

router.post("/webhooks/:provider", async (req, res, next) => {
  try {
    const provider = requireEnum(req.params.provider, WEBHOOK_PROVIDERS, "Webhook provider");
    const secret = providerWebhookSecret(provider);
    const signature = req.get("x-titopay-webhook-secret") || req.get("x-webhook-secret") || req.get("x-signature") || "";
    if (secret && !timingSafeEqualText(signature, secret)) {
      throw new AppError(401, "Webhook signature is invalid");
    }
    const eventType = boundedText(req.body?.event || req.body?.type || "provider_webhook", "Webhook event", { min: 2, max: 120 });
    const events = await listWebhookEvents();
    const event = {
      id: crypto.randomUUID(),
      provider,
      eventType,
      status: "received",
      retryCount: 0,
      errorMessage: "",
      createdAt: new Date().toISOString(),
      payloadSummary: {
        keys: req.body && typeof req.body === "object" ? Object.keys(req.body).slice(0, 20) : [],
        hasPayload: Boolean(req.body)
      }
    };
    await saveWebhookEvents([event, ...events]);
    res.status(202).json({ ok: true, received: true, eventId: event.id });
  } catch (error) {
    next(error);
  }
});

router.get("/", requireAdminPermission("engineering"), (_req, res) => {
  res.json({
    peachPayments: {
      provider: config.integrations.peachPayments.mode,
      configured: Boolean(
        config.integrations.peachPayments.clientId
        && config.integrations.peachPayments.clientSecret
        && config.integrations.peachPayments.merchantId
      ),
      supports: ["card_top_up", "card_verification", "payment_status", "refunds", "webhooks"]
    },
    docfox: {
      provider: config.integrations.docfox.mode,
      configured: Boolean(config.integrations.docfox.baseUrl && config.integrations.docfox.apiKey),
      supports: ["kyc_onboarding", "fica_verification", "aml_screening", "identity_verification"]
    },
    ott: {
      provider: config.integrations.ott.mode,
      configured: Boolean(config.integrations.ott.baseUrl && config.integrations.ott.apiKey),
      supports: ["airtime", "data", "electricity", "vouchers"]
    },
    email: {
      provider: config.integrations.email.provider,
      configured: Boolean(config.integrations.email.apiKey),
      supports: ["otp", "password_reset", "security_alerts", "transaction_alerts"]
    },
    sms: {
      provider: config.integrations.sms.provider,
      configured: Boolean(config.integrations.sms.apiKey),
      supports: ["otp", "verification", "security_alerts"]
    }
  });
});

router.handlePeachProviderWebhook = handlePeachProviderWebhook;

module.exports = router;
