"use strict";

// Single source of truth for the Peach Payments provider configuration.
//
// The Admin Portal stores the live credentials in `platform_settings` under
// `integration_peach_payments`, with secrets encrypted at rest (AES-256-GCM).
// Environment variables remain a fallback for installations that never used the
// portal. Everything that talks to Peach — authentication, Checkout and the
// webhook — resolves its configuration here so the three can never drift apart.
//
// Decrypted secrets are returned to server-side callers only. Nothing in this
// module is safe to serialise into an API response.

const crypto = require("crypto");
const { config } = require("../config/env");
const { pool } = require("../db/pool");

const SETTING_KEY = "integration_peach_payments";
const SECRET_FIELDS = ["apiKey", "apiSecret", "clientSecret", "password", "webhookSecret"];
const PLAIN_FIELDS = [
  "baseUrl", "sandboxBaseUrl", "productionBaseUrl", "clientId", "username",
  "merchantId", "entityId", "callbackUrl"
];

// Short cache so a burst of status polls does not hammer the settings table.
// Deliberately small: a credential change in the portal takes effect within it.
const CACHE_TTL_MS = 15000;
let cache = null;

function integrationEncryptionKey() {
  return crypto.createHash("sha256").update(config.refreshSecret || config.accessSecret).digest();
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text.startsWith("enc:")) return "";
  const [, ivText, tagText, encryptedText] = text.split(":");
  if (!ivText || !tagText || !encryptedText) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", integrationEncryptionKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
  } catch (_error) {
    // A key rotation invalidates old ciphertext; treat it as unconfigured
    // rather than crashing a payment request.
    return "";
  }
}

function storedSecret(stored, field) {
  const candidates = [
    stored?.secrets?.[`${field}Encrypted`],
    stored?.[`${field}Encrypted`],
    stored?.secrets?.[field],
    stored?.[field]
  ];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (!text || text.startsWith("••••")) continue;
    if (!text.startsWith("enc:")) return text;
    const decrypted = decryptSecret(text);
    if (decrypted) return decrypted;
  }
  return "";
}

function normalizeEnvironment(value) {
  const environment = String(value || "").trim().toLowerCase();
  if (["sandbox", "test", "testing", "staging"].includes(environment)) return "sandbox";
  if (["production", "live", "prod"].includes(environment)) return "production";
  return "";
}

function buildEffectiveConfig(stored) {
  const env = config.integrations.peachPayments || {};
  const effective = {
    enabled: stored ? stored.enabled !== false : true,
    environment: normalizeEnvironment(stored?.environment || stored?.mode) || normalizeEnvironment(env.mode) || "production",
    source: stored ? "database" : "environment"
  };
  for (const field of PLAIN_FIELDS) {
    effective[field] = String(stored?.[field] ?? env[field] ?? "").trim();
  }
  for (const field of SECRET_FIELDS) {
    effective[field] = storedSecret(stored, field) || String(env[field] ?? "").trim();
  }
  return effective;
}

async function loadPeachConfig({ refresh = false } = {}) {
  if (!refresh && cache && cache.expiresAt > Date.now()) return cache.value;
  let stored = null;
  try {
    const { rows } = await pool.query("SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [SETTING_KEY]);
    stored = rows[0]?.value || null;
  } catch (_error) {
    // A settings read failure must not take payments down harder than it has
    // to; fall back to the process environment.
    stored = null;
  }
  const value = buildEffectiveConfig(stored);
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

function clearPeachConfigCache() {
  cache = null;
}

// Presence-only view, safe to log or return to an admin caller.
function describePeachConfig(effective = {}) {
  return {
    enabled: Boolean(effective.enabled),
    environment: effective.environment || "",
    source: effective.source || "",
    clientId: Boolean(effective.clientId),
    clientSecret: Boolean(effective.clientSecret),
    merchantId: Boolean(effective.merchantId),
    entityId: Boolean(effective.entityId),
    webhookSecret: Boolean(effective.webhookSecret)
  };
}

module.exports = {
  SETTING_KEY,
  loadPeachConfig,
  clearPeachConfigCache,
  describePeachConfig,
  normalizeEnvironment
};
