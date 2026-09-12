"use strict";

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

const REQUIRED_EMAIL_CATEGORIES = new Set([
  "password_reset",
  "password_changed",
  "account_security",
  "email_verification",
  "welcome",
  "kyc",
  "business_approval"
]);

let schemaReady;

async function ensureCustomerNotificationPreferenceSchema(db = pool) {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS customer_notification_preferences (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        email_transaction_receipts BOOLEAN NOT NULL DEFAULT TRUE,
        email_support_updates BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_customer_notification_preferences_updated
        ON customer_notification_preferences (updated_at DESC);
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function publicPreferences(row = {}) {
  const enabled = row.email_notifications_enabled !== false;
  return {
    email: {
      enabled,
      transactionReceipts: row.email_transaction_receipts !== false,
      supportUpdates: row.email_support_updates !== false,
      passwordResets: true,
      criticalSecurity: true,
      kycAndBusinessUpdates: true,
      price: 0
    }
  };
}

async function getCustomerNotificationPreferences(userId, db = pool) {
  await ensureCustomerNotificationPreferenceSchema(db);
  const { rows } = await db.query(
    `INSERT INTO customer_notification_preferences (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id
     RETURNING *`,
    [userId]
  );
  return publicPreferences(rows[0]);
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new AppError(400, `${label} must be true or false`);
  return value;
}

async function updateCustomerNotificationPreferences(userId, values = {}, actor = {}) {
  const enabled = optionalBoolean(values.emailNotificationsEnabled ?? values.email?.enabled, "Email notifications");
  const transactions = optionalBoolean(values.transactionReceipts ?? values.email?.transactionReceipts, "Transaction receipts");
  const support = optionalBoolean(values.supportUpdates ?? values.email?.supportUpdates, "Support updates");
  if (enabled === undefined && transactions === undefined && support === undefined) {
    throw new AppError(400, "Choose at least one email notification preference");
  }
  await ensureCustomerNotificationPreferenceSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO customer_notification_preferences
         (user_id,email_notifications_enabled,email_transaction_receipts,email_support_updates)
       VALUES ($1,COALESCE($2,TRUE),COALESCE($3,TRUE),COALESCE($4,TRUE))
       ON CONFLICT (user_id) DO UPDATE SET
         email_notifications_enabled=COALESCE($2,customer_notification_preferences.email_notifications_enabled),
         email_transaction_receipts=COALESCE($3,customer_notification_preferences.email_transaction_receipts),
         email_support_updates=COALESCE($4,customer_notification_preferences.email_support_updates),
         updated_at=NOW()
       RETURNING *`,
      [userId, enabled, transactions, support]
    );
    const preferences = publicPreferences(rows[0]);
    await writeAuditLog({
      actorType: "customer",
      actorId: userId,
      action: "email_notification_preferences_updated",
      entityType: "customer_notification_preferences",
      entityId: userId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: {
        emailNotificationsEnabled: preferences.email.enabled,
        transactionReceipts: preferences.email.transactionReceipts,
        supportUpdates: preferences.email.supportUpdates,
        protectedCriticalEmails: true
      },
      db: client
    });
    await client.query("COMMIT");
    return preferences;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

async function shouldSendCustomerEmail(userId, category) {
  if (!userId || REQUIRED_EMAIL_CATEGORIES.has(String(category || ""))) return true;
  try {
    const preferences = await getCustomerNotificationPreferences(userId);
    if (!preferences.email.enabled) return false;
    if (category === "transaction") return preferences.email.transactionReceipts;
    if (category === "support") return preferences.email.supportUpdates;
    return true;
  } catch (error) {
    console.error("[notification-preferences] preference lookup failed open", {
      userId,
      category,
      message: error.message
    });
    return true;
  }
}

module.exports = {
  REQUIRED_EMAIL_CATEGORIES,
  publicPreferences,
  ensureCustomerNotificationPreferenceSchema,
  getCustomerNotificationPreferences,
  updateCustomerNotificationPreferences,
  shouldSendCustomerEmail
};
