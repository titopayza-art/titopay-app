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

// Collection/Top-up and Payout/Withdrawal are stored in two separate
// platform_settings rows, so saving one can never overwrite the other's
// credentials.
const SETTING_KEY = "integration_peach_payments";
const PAYOUT_SETTING_KEY = "integration_peach_payouts";
const SECRET_FIELDS = ["apiKey", "apiSecret", "clientSecret", "password", "webhookSecret"];
const PLAIN_FIELDS = [
  "baseUrl", "sandboxBaseUrl", "productionBaseUrl", "clientId", "username",
  "merchantId", "entityId", "callbackUrl"
];

// Short cache so a burst of status polls does not hammer the settings table.
// Deliberately small: a credential change in the portal takes effect within it.
const CACHE_TTL_MS = 15000;
const caches = new Map();

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

// A masked display value is never a credential. A configuration poisoned by an
// earlier save reads as unconfigured, so the operator is told to re-enter the
// secret instead of the provider rejecting the mask forever.
function isMaskedSecretPlaceholder(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("••••") || /^[•*]{3,}/.test(text);
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
    if (!text || isMaskedSecretPlaceholder(text)) continue;
    if (!text.startsWith("enc:")) return text;
    const decrypted = decryptSecret(text);
    if (decrypted && !isMaskedSecretPlaceholder(decrypted)) return decrypted;
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

async function readStored(settingKey) {
  try {
    const { rows } = await pool.query("SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [settingKey]);
    return rows[0]?.value || null;
  } catch (_error) {
    // A settings read failure must not take payments down harder than it has
    // to; fall back to the process environment.
    return null;
  }
}

async function loadPeachConfig({ refresh = false } = {}) {
  const cached = caches.get(SETTING_KEY);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const value = buildEffectiveConfig(await readStored(SETTING_KEY));
  caches.set(SETTING_KEY, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// Payout credentials are deliberately NOT merged with the Collection ones and
// have no environment-variable fallback that could silently borrow them.
async function loadPeachPayoutConfig({ refresh = false } = {}) {
  const cached = caches.get(PAYOUT_SETTING_KEY);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const stored = await readStored(PAYOUT_SETTING_KEY);
  const value = {
    enabled: stored ? stored.enabled !== false : false,
    environment: normalizeEnvironment(stored?.environment || stored?.mode) || "sandbox",
    source: stored ? "database" : "unconfigured",
    baseUrl: String(stored?.baseUrl ?? process.env.PEACH_PAYOUTS_BASE_URL ?? "").trim(),
    clientId: String(stored?.clientId ?? "").trim(),
    merchantId: String(stored?.merchantId ?? "").trim(),
    clientSecret: storedSecret(stored, "clientSecret"),
    webhookSecret: storedSecret(stored, "webhookSecret"),
    callbackUrl: String(stored?.callbackUrl ?? "").trim()
  };
  caches.set(PAYOUT_SETTING_KEY, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function clearPeachConfigCache() {
  caches.clear();
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

function describePeachPayoutConfig(effective = {}) {
  return {
    enabled: Boolean(effective.enabled),
    environment: effective.environment || "",
    baseUrlConfigured: Boolean(effective.baseUrl),
    clientId: Boolean(effective.clientId),
    clientSecret: Boolean(effective.clientSecret),
    merchantId: Boolean(effective.merchantId)
  };
}

module.exports = {
  SETTING_KEY,
  PAYOUT_SETTING_KEY,
  loadPeachConfig,
  loadPeachPayoutConfig,
  describePeachPayoutConfig,
  clearPeachConfigCache,
  describePeachConfig,
  normalizeEnvironment
};
