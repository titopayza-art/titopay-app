"use strict";

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { ensureEmailSchema } = require("./email-centre-service");
const emailOtp = require("./email-otp-service");

function maskEmail(value = "") {
  const [local, domain] = String(value).split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
}

function maskPhone(value = "") {
  const phone = String(value || "");
  return phone ? `${phone.slice(0, 3)}***${phone.slice(-2)}` : null;
}

function requireIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9:_-]{8,200}$/.test(key)) {
    throw new AppError(400, "A valid idempotency key is required for Email OTP");
  }
  return key;
}

async function loadCustomer(userId, db = pool) {
  const { rows } = await db.query(
    "SELECT *, 'customer'::text AS user_type FROM users WHERE id = $1 LIMIT 1",
    [userId]
  );
  if (!rows[0]) throw new AppError(404, "User not found");
  return rows[0];
}

async function passwordChangeOptions(userId) {
  const [user, emailEnabled] = await Promise.all([
    loadCustomer(userId),
    emailOtp.shouldRequireEmailOtp("change_password")
  ]);
  return {
    sms: {
      available: Boolean(user.phone),
      fee: 0,
      maskedDestination: maskPhone(user.phone)
    },
    email: {
      available: Boolean(user.email && emailEnabled),
      configured: Boolean(emailEnabled),
      fee: 0,
      currency: "ZAR",
      maskedDestination: user.email ? maskEmail(user.email) : null
    }
  };
}

async function requestEmailPasswordChangeOtp(userId, payload = {}, meta = {}) {
  const idempotencyKey = requireIdempotencyKey(payload.idempotencyKey);
  if (!await emailOtp.shouldRequireEmailOtp("change_password")) {
    throw new AppError(409, "Email OTP is not enabled for password changes");
  }
  await ensureEmailSchema();
  const queueIdempotencyKey = `email-otp-password-change:${userId}:${idempotencyKey}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [queueIdempotencyKey]);
    const user = await loadCustomer(userId, client);
    if (!user.email) throw new AppError(400, "Add a registered email address before requesting Email OTP");

    const existing = await client.query(
      "SELECT id, metadata FROM email_queue WHERE idempotency_key = $1 LIMIT 1",
      [queueIdempotencyKey]
    );
    if (existing.rows[0]) {
      const metadata = existing.rows[0].metadata || {};
      await client.query("COMMIT");
      return {
        challengeId: metadata.otpChallengeId,
        accountId: user.id,
        userId: user.id,
        otpRequired: true,
        authenticationMode: "email_otp",
        purpose: "change_password",
        channel: "email",
        fee: 0,
        currency: "ZAR",
        maskedDestination: maskEmail(user.email),
        queued: true,
        deduplicated: true
      };
    }

    const challenge = await emailOtp.createChallenge(user, "change_password", meta, {
      db: client,
      queueIdempotencyKey,
      requireEventEnabled: true,
      metadata: {
        serviceCode: "email_otp",
        clientIdempotencyKey: idempotencyKey,
        fee: 0
      }
    });
    await client.query("COMMIT");
    return {
      ...challenge,
      accountId: user.id,
      userId: user.id,
      channel: "email",
      fee: 0,
      currency: "ZAR",
      queued: true,
      deduplicated: false
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  passwordChangeOptions,
  requestEmailPasswordChangeOtp
};
