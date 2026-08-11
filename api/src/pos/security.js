"use strict";

const crypto = require("crypto");
const { config } = require("../config/env");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encryptionKey() {
  return crypto.createHash("sha256")
    .update(config.pos.terminalEncryptionKey || config.refreshSecret || config.accessSecret)
    .digest();
}

function integrationEncryptionKey() {
  return crypto.createHash("sha256")
    .update(config.refreshSecret || config.accessSecret)
    .digest();
}

function decryptIntegrationSecret(value) {
  const text = String(value || "");
  if (!text.startsWith("enc:")) return "";
  const [, iv, tag, encrypted] = text.split(":");
  if (!iv || !tag || !encrypted) return "";
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      integrationEncryptionKey(),
      Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (_error) {
    return "";
  }
}

async function loadProviderWebhookSecret() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1",
      ["integration_pos_provider"]
    );
    const stored = rows[0]?.value || {};
    if (stored.enabled === false) throw new AppError(503, "POS provider webhook is disabled");
    return decryptIntegrationSecret(stored.secrets?.webhookSecretEncrypted)
      || config.pos.providerWebhookSecret
      || "";
  } catch (error) {
    // Preserve the server-side environment fallback during database recovery.
    // An explicit Admin disable remains authoritative and is never bypassed.
    if (error instanceof AppError) throw error;
    if (config.pos.providerWebhookSecret) return config.pos.providerWebhookSecret;
    throw error;
  }
}

function encryptTerminalSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptTerminalSecret(value) {
  const [, iv, tag, encrypted] = String(value || "").split(":");
  if (!iv || !tag || !encrypted) throw new AppError(500, "Terminal credential is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function canonicalRequest(req, timestamp, nonce) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  const body = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from("");
  return [timestamp, nonce, req.method.toUpperCase(), path, sha256(body)].join("\n");
}

async function requireTerminalAuth(req, _res, next) {
  try {
    const terminalId = String(req.get("x-titopay-terminal-id") || "").trim();
    const timestamp = String(req.get("x-titopay-timestamp") || "").trim();
    const nonce = String(req.get("x-titopay-nonce") || "").trim();
    const signature = String(req.get("x-titopay-signature") || "").trim().replace(/^sha256=/i, "");
    if (!terminalId || !timestamp || !nonce || !signature) throw new AppError(401, "Terminal authentication required");
    if (!/^[A-Za-z0-9._:-]{12,160}$/.test(nonce)) throw new AppError(401, "Terminal nonce is invalid");
    const requestTime = Number(timestamp);
    const tolerance = config.pos.signatureToleranceSeconds * 1000;
    if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > tolerance) {
      throw new AppError(401, "Terminal request timestamp is invalid");
    }
    const result = await pool.query(
      `SELECT t.*, t.merchant_id AS merchant_id_uuid,
              m.merchant_id AS merchant_code, m.business_name,
              m.status AS merchant_status, m.verification_status
         FROM pos_terminals t
         JOIN merchants m ON m.id = t.merchant_id
        WHERE t.terminal_id = $1
        LIMIT 1`,
      [terminalId]
    );
    const terminal = result.rows[0];
    if (!terminal || terminal.status !== "active" || terminal.merchant_status !== "active") {
      throw new AppError(401, "Terminal is not authorised");
    }
    const secret = decryptTerminalSecret(terminal.credential_encrypted);
    const expected = crypto.createHmac("sha256", secret).update(canonicalRequest(req, timestamp, nonce)).digest("hex");
    if (!safeEqual(expected, signature)) throw new AppError(401, "Terminal signature is invalid");
    try {
      await pool.query(
        `INSERT INTO pos_request_nonces (terminal_id, nonce_hash, expires_at)
         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
        [terminal.id, sha256(nonce), config.pos.signatureToleranceSeconds * 2]
      );
    } catch (error) {
      if (error.code === "23505") throw new AppError(409, "Terminal request replay detected");
      throw error;
    }
    await pool.query("UPDATE pos_terminals SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1", [terminal.id]);
    req.posTerminal = terminal;
    next();
  } catch (error) {
    next(error);
  }
}

async function verifyProviderWebhook(req) {
  const timestamp = String(req.get("x-titopay-timestamp") || "").trim();
  const nonce = String(req.get("x-titopay-nonce") || "").trim();
  const signature = String(req.get("x-titopay-signature") || "").trim().replace(/^sha256=/i, "");
  if (!timestamp || !nonce || !signature) throw new AppError(401, "Provider signature required");
  const secret = await loadProviderWebhookSecret();
  if (!secret) throw new AppError(503, "POS provider webhook is not configured");
  if (Math.abs(Date.now() - Number(timestamp)) > config.pos.signatureToleranceSeconds * 1000) {
    throw new AppError(401, "Provider timestamp is invalid");
  }
  const expected = crypto.createHmac("sha256", secret).update(canonicalRequest(req, timestamp, nonce)).digest("hex");
  if (!safeEqual(expected, signature)) throw new AppError(401, "Provider signature is invalid");
  return { nonceHash: sha256(nonce) };
}

module.exports = {
  sha256,
  safeEqual,
  encryptTerminalSecret,
  decryptTerminalSecret,
  canonicalRequest,
  requireTerminalAuth,
  verifyProviderWebhook
};
