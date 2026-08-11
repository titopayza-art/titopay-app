"use strict";

const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { sha256 } = require("../lib/crypto");
const { AppError } = require("../lib/errors");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");
const { createOtpChallenge } = require("./auth-service");
const emailOtp = require("./email-otp-service");

const AUTHENTICATION_METHODS = Object.freeze(["PUSH", "EMAIL", "SMS"]);
const FALLBACK_ORDER = Object.freeze(["PUSH", "EMAIL", "SMS"]);
const WALLET_PURPOSE = "wallet_unlock";
const PREFERENCE_PURPOSE = "authentication_preference_change";

let schemaReady = false;

async function ensureAuthenticationPreferenceSchema(db = pool) {
  if (schemaReady && db === pool) return;
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_authentication_method TEXT NOT NULL DEFAULT 'PUSH'");
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS authentication_method_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_successful_authentication_at TIMESTAMPTZ");
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_authentication_at TIMESTAMPTZ");
  if (db === pool) schemaReady = true;
}

function normalizeAuthenticationMethod(value, label = "Authentication method") {
  const method = String(value || "").trim().toUpperCase();
  if (!AUTHENTICATION_METHODS.includes(method)) {
    throw new AppError(400, `${label} must be PUSH, EMAIL or SMS`);
  }
  return method;
}

function maskPhone(value = "") {
  const phone = String(value || "");
  return phone ? `${phone.slice(0, 3)}***${phone.slice(-2)}` : null;
}

function maskEmail(value = "") {
  const [local, domain] = String(value || "").split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : null;
}

async function loadCustomer(userId, db = pool) {
  await ensureAuthenticationPreferenceSchema(db);
  const { rows } = await db.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]);
  if (!rows[0]) throw new AppError(404, "User not found");
  return { ...rows[0], user_type: "customer", role: "customer" };
}

async function methodAvailability(user, purpose = WALLET_PURPOSE) {
  const emailEvent = purpose === WALLET_PURPOSE ? "wallet_unlock" : "optional_mfa";
  const emailConfigured = await emailOtp.shouldRequireEmailOtp(emailEvent);
  const emailEnabled = Boolean(user.email) && emailConfigured;
  return {
    PUSH: {
      available: false,
      reason: "push_authentication_not_registered",
      maskedDestination: null
    },
    EMAIL: {
      available: emailEnabled,
      configured: emailConfigured,
      reason: !user.email ? "email_not_registered" : emailEnabled ? null : "email_otp_not_enabled",
      maskedDestination: maskEmail(user.email)
    },
    SMS: {
      available: Boolean(user.phone),
      reason: user.phone ? null : "cellphone_not_registered",
      maskedDestination: maskPhone(user.phone)
    }
  };
}

function orderedCandidates(preferredMethod) {
  return [preferredMethod, ...FALLBACK_ORDER.filter((method) => method !== preferredMethod)];
}

async function safeAudit(entry) {
  try {
    await writeAuditLog(entry);
  } catch (error) {
    console.error("[authentication-preference-audit-failed]", {
      action: entry.action,
      actorId: entry.actorId,
      message: error.message
    });
  }
}

async function invalidateChallenges(userId, purposes = [WALLET_PURPOSE, `email_otp:${WALLET_PURPOSE}`]) {
  await pool.query(
    `UPDATE otp_codes
        SET expires_at = NOW()
      WHERE user_type = 'customer'
        AND user_id = $1
        AND purpose = ANY($2::TEXT[])
        AND used_at IS NULL
        AND expires_at > NOW()`,
    [userId, purposes]
  );
}

async function createMethodChallenge({ user, method, purpose, meta, desiredMethod = null }) {
  const auditPurpose = purpose === WALLET_PURPOSE ? WALLET_PURPOSE : PREFERENCE_PURPOSE;
  if (method === "EMAIL") {
    const event = purpose === WALLET_PURPOSE ? "wallet_unlock" : "optional_mfa";
    const challenge = await emailOtp.createChallenge(
      user,
      event,
      meta,
      {
        requireEventEnabled: true,
        metadata: {
          authenticationPurpose: auditPurpose,
          desiredAuthenticationMethod: desiredMethod,
          channel: "email"
        }
      }
    );
    return { ...challenge, channel: "email", authenticationMethod: "EMAIL", fee: 0, currency: "ZAR" };
  }
  if (method === "SMS") {
    const challenge = await createOtpChallenge({
      user,
      purpose,
      channels: ["sms"],
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        authenticationPurpose: auditPurpose,
        desiredAuthenticationMethod: desiredMethod,
        channel: "sms"
      }
    });
    await safeAudit({
      actorType: "customer",
      actorId: user.id,
      action: "sms_otp_sent",
      entityType: "otp_challenge",
      entityId: challenge.challengeId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { purpose: auditPurpose }
    });
    return { ...challenge, channel: "sms", authenticationMethod: "SMS", fee: 0, currency: "ZAR" };
  }
  throw new AppError(503, "Push Authentication is not available on this account");
}

async function requestChallenge({ userId, requestedMethod, desiredMethod = null, purpose, meta = {} }) {
  const user = await loadCustomer(userId);
  if (purpose === WALLET_PURPOSE && !user.profile_locked) {
    throw new AppError(409, "Wallet is not locked");
  }
  const preferredMethod = requestedMethod
    ? normalizeAuthenticationMethod(requestedMethod)
    : normalizeAuthenticationMethod(user.preferred_authentication_method || "PUSH");
  const availability = await methodAvailability(user, purpose);
  const lockClient = await pool.connect();
  let locked = false;
  const failures = [];
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`authentication:${purpose}:${userId}`]);
    locked = true;
    const invalidPurposes = purpose === WALLET_PURPOSE
      ? [WALLET_PURPOSE, `email_otp:${WALLET_PURPOSE}`]
      : [PREFERENCE_PURPOSE, "email_otp:optional_mfa"];
    await invalidateChallenges(userId, invalidPurposes);
    for (const method of orderedCandidates(preferredMethod)) {
      if (!availability[method].available) {
        failures.push({ method, reason: availability[method].reason });
        continue;
      }
      try {
        const challenge = await createMethodChallenge({
          user,
          method,
          purpose,
          meta,
          desiredMethod: purpose === PREFERENCE_PURPOSE ? desiredMethod : null
        });
        const fallbackUsed = method !== preferredMethod;
        if (fallbackUsed) {
          await safeAudit({
            actorType: "customer",
            actorId: userId,
            action: "authentication_fallback_used",
            entityType: "authentication_challenge",
            entityId: challenge.challengeId,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            metadata: { purpose, preferredMethod, selectedMethod: method, unavailable: failures }
          });
        }
        await safeAudit({
          actorType: "customer",
          actorId: userId,
          action: purpose === WALLET_PURPOSE ? "wallet_unlock_requested" : "authentication_method_change_requested",
          entityType: "otp_challenge",
          entityId: challenge.challengeId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          metadata: { preferredMethod, selectedMethod: method, fallbackUsed }
        });
        return {
          ...challenge,
          preferredAuthenticationMethod: user.preferred_authentication_method || "PUSH",
          requestedAuthenticationMethod: preferredMethod,
          selectedAuthenticationMethod: method,
          fallbackUsed,
          message: purpose === WALLET_PURPOSE ? "For your security, please verify your identity." : undefined
        };
      } catch (error) {
        failures.push({ method, reason: "delivery_failed" });
        await invalidateChallenges(userId, invalidPurposes);
      }
    }
  } finally {
    if (locked) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`authentication:${purpose}:${userId}`]).catch(() => {});
    lockClient.release();
  }
  await safeAudit({
    actorType: "customer",
    actorId: userId,
    action: purpose === WALLET_PURPOSE ? "wallet_unlock_failed" : "authentication_method_change_failed",
    entityType: "authentication_challenge",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { preferredMethod, reason: "no_available_authentication_method", unavailable: failures }
  });
  throw new AppError(503, "No authentication method is currently available. Please contact TitoPay Support.");
}

async function getAuthenticationPreference(userId) {
  const user = await loadCustomer(userId);
  const availability = await methodAvailability(user, PREFERENCE_PURPOSE);
  return {
    method: user.preferred_authentication_method || "PUSH",
    updatedAt: user.authentication_method_updated_at,
    lastSuccessfulAuthenticationAt: user.last_successful_authentication_at || user.last_login_at || null,
    lastFailedAuthenticationAt: user.last_failed_authentication_at || user.last_failed_login_at || null,
    availability
  };
}

async function requestAuthenticationPreferenceChange(userId, desiredMethod, meta = {}) {
  const method = normalizeAuthenticationMethod(desiredMethod, "Preferred authentication method");
  const current = await loadCustomer(userId);
  if ((current.preferred_authentication_method || "PUSH") === method) {
    throw new AppError(409, "This authentication method is already selected");
  }
  return requestChallenge({
    userId,
    requestedMethod: current.preferred_authentication_method || "PUSH",
    desiredMethod: method,
    purpose: PREFERENCE_PURPOSE,
    meta
  });
}

async function loadOwnedChallenge(userId, challengeId, purposes, db = pool, forUpdate = false) {
  const { rows } = await db.query(
    `SELECT * FROM otp_codes
      WHERE id = $1
        AND user_type = 'customer'
        AND user_id = $2
        AND purpose = ANY($3::TEXT[])
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [challengeId, userId, purposes]
  );
  if (!rows[0]) throw new AppError(404, "Authentication challenge not found");
  return rows[0];
}

async function verifySmsChallenge({ userId, challengeId, otp, purpose, client }) {
  const row = await loadOwnedChallenge(userId, challengeId, [purpose], client, true);
  if (row.used_at) throw new AppError(409, "OTP already used");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new AppError(410, "OTP expired");
  if (Number(row.attempts) >= config.maxOtpAttempts) throw new AppError(423, "OTP attempts exceeded");
  if (!/^\d{6}$/.test(String(otp || "")) || sha256(String(otp)) !== row.code_hash) {
    const attempts = Number(row.attempts) + 1;
    await client.query("UPDATE otp_codes SET attempts = $2 WHERE id = $1", [challengeId, attempts]);
    return {
      row,
      error: new AppError(attempts >= config.maxOtpAttempts ? 423 : 401, attempts >= config.maxOtpAttempts ? "OTP attempts exceeded" : "Invalid OTP", {
        remainingAttempts: Math.max(0, config.maxOtpAttempts - attempts)
      })
    };
  }
  await client.query("UPDATE otp_codes SET used_at = NOW() WHERE id = $1", [challengeId]);
  return { row, error: null };
}

async function verifyEmailChallenge({ userId, challengeId, otp, purposes, meta }) {
  const row = await loadOwnedChallenge(userId, challengeId, purposes);
  await emailOtp.verifyChallenge(challengeId, otp, meta);
  return row;
}

async function recordAuthenticationFailure(userId, action, challengeId, meta, error) {
  await ensureAuthenticationPreferenceSchema();
  await pool.query("UPDATE users SET last_failed_authentication_at = NOW() WHERE id = $1", [userId]).catch(() => {});
  await safeAudit({
    actorType: "customer",
    actorId: userId,
    action,
    entityType: "authentication_challenge",
    entityId: challengeId || null,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { reason: error.statusCode ? "verification_rejected" : "verification_error" }
  });
  await writeSecurityLog({
    actorType: "customer",
    actorId: userId,
    eventType: action,
    severity: "warning",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: false,
    metadata: {}
  }).catch(() => {});
}

async function verifyWalletUnlock({ userId, challengeId, otp, meta = {} }) {
  let method;
  try {
    const challenge = await loadOwnedChallenge(userId, challengeId, [WALLET_PURPOSE, `email_otp:${WALLET_PURPOSE}`]);
    method = challenge.purpose.startsWith("email_otp:") ? "EMAIL" : "SMS";
    if (method === "EMAIL") {
      await verifyEmailChallenge({ userId, challengeId, otp, purposes: [`email_otp:${WALLET_PURPOSE}`], meta });
      const { rowCount } = await pool.query(
        "UPDATE users SET profile_locked = FALSE, last_successful_authentication_at = NOW(), updated_at = NOW() WHERE id = $1 AND profile_locked = TRUE",
        [userId]
      );
      if (!rowCount) throw new AppError(409, "Wallet is already unlocked");
    } else {
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const verification = await verifySmsChallenge({ userId, challengeId, otp, purpose: WALLET_PURPOSE, client });
        if (verification.error) {
          await client.query("COMMIT");
          transactionOpen = false;
          throw verification.error;
        }
        const { rowCount } = await client.query(
          "UPDATE users SET profile_locked = FALSE, last_successful_authentication_at = NOW(), updated_at = NOW() WHERE id = $1 AND profile_locked = TRUE",
          [userId]
        );
        if (!rowCount) throw new AppError(409, "Wallet is already unlocked");
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await safeAudit({
      actorType: "customer",
      actorId: userId,
      action: "wallet_unlocked",
      entityType: "wallet_security",
      entityId: userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { challengeId, authenticationMethod: method }
    });
    await writeSecurityLog({
      actorType: "customer",
      actorId: userId,
      eventType: "wallet_unlocked",
      severity: "info",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: true,
      metadata: { authenticationMethod: method }
    }).catch(() => {});
    return { authenticationMethod: method };
  } catch (error) {
    await recordAuthenticationFailure(userId, "wallet_unlock_failed", challengeId, meta, error);
    throw error;
  }
}

async function confirmAuthenticationPreferenceChange({ userId, desiredMethod, challengeId, otp, meta = {} }) {
  const method = normalizeAuthenticationMethod(desiredMethod, "Preferred authentication method");
  try {
    const challenge = await loadOwnedChallenge(userId, challengeId, [PREFERENCE_PURPOSE, "email_otp:optional_mfa"]);
    const boundMethod = String(challenge.metadata?.desiredAuthenticationMethod || "").toUpperCase();
    if (!boundMethod || boundMethod !== method) throw new AppError(409, "Authentication challenge does not match the requested method");
    const verificationMethod = challenge.purpose.startsWith("email_otp:") ? "EMAIL" : "SMS";
    let updatedPreference;
    if (verificationMethod === "EMAIL") {
      await verifyEmailChallenge({ userId, challengeId, otp, purposes: ["email_otp:optional_mfa"], meta });
      const { rows } = await pool.query(
        `UPDATE users
            SET preferred_authentication_method = $2,
                authentication_method_updated_at = NOW(),
                last_successful_authentication_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
          RETURNING preferred_authentication_method, authentication_method_updated_at`,
        [userId, method]
      );
      updatedPreference = rows[0];
    } else {
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const verification = await verifySmsChallenge({ userId, challengeId, otp, purpose: PREFERENCE_PURPOSE, client });
        if (verification.error) {
          await client.query("COMMIT");
          transactionOpen = false;
          throw verification.error;
        }
        const { rows } = await client.query(
          `UPDATE users
              SET preferred_authentication_method = $2,
                  authentication_method_updated_at = NOW(),
                  last_successful_authentication_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING preferred_authentication_method, authentication_method_updated_at`,
          [userId, method]
        );
        updatedPreference = rows[0];
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await safeAudit({
      actorType: "customer",
      actorId: userId,
      action: "authentication_method_changed",
      entityType: "user",
      entityId: userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { method, verificationMethod }
    });
    return {
      method: updatedPreference.preferred_authentication_method,
      updatedAt: updatedPreference.authentication_method_updated_at,
      verificationMethod
    };
  } catch (error) {
    await recordAuthenticationFailure(userId, "authentication_method_change_failed", challengeId, meta, error);
    throw error;
  }
}

module.exports = {
  AUTHENTICATION_METHODS,
  FALLBACK_ORDER,
  WALLET_PURPOSE,
  PREFERENCE_PURPOSE,
  ensureAuthenticationPreferenceSchema,
  normalizeAuthenticationMethod,
  methodAvailability,
  getAuthenticationPreference,
  requestAuthenticationPreferenceChange,
  confirmAuthenticationPreferenceChange,
  requestChallenge,
  verifyWalletUnlock
};
