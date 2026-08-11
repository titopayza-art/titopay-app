const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { AppError } = require("../lib/errors");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");

function platformIntegrationSettingKey(provider) {
  return `integration_${provider}`;
}

function integrationEncryptionKey() {
  return crypto
    .createHash("sha256")
    .update(config.refreshSecret || config.accessSecret)
    .digest();
}

function decryptIntegrationSecret(value) {
  const text = String(value || "");
  if (!text.startsWith("enc:")) return "";
  const [, ivText, tagText, encryptedText] = text.split(":");
  if (!ivText || !tagText || !encryptedText) return "";
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    integrationEncryptionKey(),
    Buffer.from(ivText, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function savedSecretValue(stored, field, fallback = "") {
  const candidates = [
    stored?.secrets?.[`${field}Encrypted`],
    stored?.[`${field}Encrypted`],
    stored?.secrets?.[field],
    stored?.[field]
  ].filter((value) => value !== undefined && value !== null && String(value).trim() !== "");

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text || text.startsWith("••••")) continue;
    if (!text.startsWith("enc:")) return text;
    try {
      return decryptIntegrationSecret(text);
    } catch (_error) {
      continue;
    }
  }

  return fallback || "";
}

async function loadSavedIntegrationConfig(providerKey) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1",
      [platformIntegrationSettingKey(providerKey)]
    );
    return rows[0]?.value || null;
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning(`notification.integration.${providerKey}`, error);
    return null;
  }
}

async function getEffectiveSmsProvider() {
  const stored = await loadSavedIntegrationConfig("sms");
  const envProvider = config.integrations.sms;
  const provider = {
    provider: stored?.provider || envProvider.provider || "simcloud",
    apiUrl: stored?.baseUrl || stored?.apiUrl || envProvider.apiUrl || "https://simcloud.co.za/api/sms.php",
    apiKey: savedSecretValue(stored, "apiKey", envProvider.apiKey),
    senderId: stored?.senderId || envProvider.senderId || "TitoPay",
    enabled: stored?.enabled !== false
  };
  return provider;
}

async function createNotification({
  user,
  channel,
  notificationType,
  title,
  body,
  provider,
  metadata = {}
}) {
  const notificationId = uuidv4();
  const userId = user.user_type === "customer" ? user.id : null;
  const adminUserId = user.user_type === "admin" ? user.id : null;
  try {
    await ensureNotificationRuntimeSchema();
    await pool.query(
      `INSERT INTO notifications
        (id, user_id, admin_user_id, channel, notification_type, title, body, provider, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        notificationId,
        userId,
        adminUserId,
        channel,
        notificationType,
        title,
        body,
        provider,
        JSON.stringify(metadata)
      ]
    );
    return notificationId;
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("notification.create", error);
    return null;
  }
}

async function markNotification(notificationId, status, providerMessageId = null, metadata = {}) {
  if (!notificationId) return;
  try {
    await pool.query(
      `UPDATE notifications
       SET status = $2,
           provider_message_id = COALESCE($3, provider_message_id),
           metadata = metadata || $4::jsonb,
           sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [notificationId, status, providerMessageId, JSON.stringify(metadata)]
    );
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("notification.mark", error);
  }
}

let notificationRuntimeSchemaReady = false;

async function ensureNotificationRuntimeSchema() {
  if (notificationRuntimeSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'read')),
      provider TEXT,
      provider_message_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      sent_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (user_id IS NOT NULL OR admin_user_id IS NOT NULL)
    )
  `);
  await pool.query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_notifications_admin ON notifications (admin_user_id, created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status, created_at DESC)");
  notificationRuntimeSchemaReady = true;
}

async function providerPost(url, apiKey, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}`);
  }
  return json;
}

function simcloudTokenDetails(apiToken = "") {
  const token = String(apiToken || "").trim();
  return {
    authorizationScheme: "Bearer",
    tokenLength: token.length,
    tokenLast4: token ? token.slice(-4) : ""
  };
}

async function simcloudSmsPost({ url, apiToken, recipient, message }) {
  const token = String(apiToken || "").trim();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      recipient,
      message
    })
  });
  const responseBody = await response.text().catch(() => "");
  const tokenDetails = simcloudTokenDetails(token);
  console.info("[sms-provider] SIMcloud response", {
    authorizationScheme: tokenDetails.authorizationScheme,
    tokenLength: tokenDetails.tokenLength,
    tokenLast4: tokenDetails.tokenLast4,
    contentType: "application/json",
    responseStatus: response.status,
    responseBody: responseBody.slice(0, 2000)
  });
  if (!response.ok) {
    throw new Error(`SIMcloud returned ${response.status}: ${responseBody.slice(0, 300)}`);
  }
  try {
    return JSON.parse(responseBody);
  } catch (_error) {
    return {
      statusCode: response.status,
      responseBody
    };
  }
}

function loadNodemailer() {
  try {
    return require("nodemailer");
  } catch (error) {
    throw new Error("Nodemailer is not installed. Run npm install on the API host.");
  }
}

function shouldUseSmtp(provider) {
  return String(provider.provider || "").toLowerCase() === "smtp" || Boolean(provider.smtpHost);
}

function createSmtpTransport(provider) {
  if (!provider.smtpHost || !provider.smtpPort || !provider.fromAddress) {
    throw new Error("SMTP email provider is not configured");
  }
  const nodemailer = loadNodemailer();
  const auth = provider.smtpUser || provider.smtpPassword
    ? { user: provider.smtpUser, pass: provider.smtpPassword }
    : undefined;
  return nodemailer.createTransport({
    host: provider.smtpHost,
    port: provider.smtpPort,
    secure: provider.smtpSecure,
    auth,
    tls: {
      rejectUnauthorized: provider.smtpRejectUnauthorized
    }
  });
}

async function deliverSmtpEmail({ provider, to, subject, body }) {
  const transport = createSmtpTransport(provider);
  await transport.verify();
  const result = await transport.sendMail({
    from: provider.fromAddress,
    to,
    subject,
    text: body
  });
  return {
    id: result.messageId,
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
    response: result.response
  };
}

async function deliverEmail({ to, subject, body, metadata }) {
  const provider = config.integrations.email;
  if (shouldUseSmtp(provider)) {
    return deliverSmtpEmail({ provider, to, subject, body, metadata });
  }
  if (!provider.apiUrl || !provider.apiKey || !provider.fromAddress) {
    throw new Error("Email provider is not configured");
  }
  return providerPost(provider.apiUrl, provider.apiKey, {
    from: provider.fromAddress,
    to,
    subject,
    text: body,
    metadata
  });
}

async function getEffectiveEmailProviderConfig() {
  const stored=await loadSavedIntegrationConfig("smtp"),env=config.integrations.email;
  return {
    enabled:stored?.enabled!==false,
    smtpHost:stored?.baseUrl||env.smtpHost,
    smtpPort:Number(stored?.smtpPort||env.smtpPort),
    smtpSecure:env.smtpSecure,
    smtpUser:stored?.username||env.smtpUser,
    smtpPassword:savedSecretValue(stored,"password",env.smtpPassword),
    fromAddress:stored?.senderEmail||env.fromAddress,
    smtpRejectUnauthorized:env.smtpRejectUnauthorized
  };
}

function getEmailProviderStatus() {
  const provider = config.integrations.email;
  const smtpMode = shouldUseSmtp(provider);
  return {
    provider: provider.provider,
    mode: smtpMode ? "smtp" : "api",
    configured: smtpMode
      ? Boolean(provider.smtpHost && provider.smtpPort && provider.fromAddress && provider.smtpUser && provider.smtpPassword)
      : Boolean(provider.apiUrl && provider.apiKey && provider.fromAddress),
    smtpHost: provider.smtpHost || "",
    smtpPort: provider.smtpPort || "",
    smtpSecure: Boolean(provider.smtpSecure),
    senderEmail: provider.fromAddress || "",
    usernameConfigured: Boolean(provider.smtpUser),
    passwordConfigured: Boolean(provider.smtpPassword)
  };
}

async function sendSmtpTestEmail({ to }) {
  const title = "TitoPay Admin email test";
  const body = "This confirms TitoPay Admin email delivery is configured. If you did not request this test, contact the Super Admin.";
  return deliverEmail({
    to,
    subject: title,
    body,
    metadata: { purpose: "admin_smtp_test" }
  });
}

async function deliverSms({ to, body, metadata }) {
  const provider = await getEffectiveSmsProvider();
  if (!provider.enabled) {
    throw new Error("SMS provider is disabled");
  }
  if (!provider.apiUrl || !provider.apiKey) {
    throw new Error("SMS provider is not configured");
  }
  return simcloudSmsPost({
    url: provider.apiUrl,
    apiToken: provider.apiKey,
    recipient: to,
    message: body,
    metadata
  });
}

async function sendOtpNotification({ user, code, purpose, channels }) {
  const title = "Your TitoPay verification code";
  const body = `Your TitoPay verification code is ${code}. It expires in ${Math.ceil(config.otpTtlSeconds / 60)} minutes. Never share this code.`;
  const metadata = { purpose };
  const attempts = [];
  const deliveryChannels = user.user_type === "admin" ? ["email"] : ["sms"];
  if (user.user_type !== "admin" && !user.phone) {
    throw new AppError(400, "A verified cellphone number is required for TitoPay OTP.");
  }

  for (const channel of deliveryChannels) {
    if (channel === "email" && user.email) {
      const notificationId = await createNotification({
        user,
        channel,
        notificationType: "otp",
        title,
        body,
        provider: config.integrations.email.provider,
        metadata
      });
      try {
        const result = await deliverEmail({ to: user.email, subject: title, body, metadata });
        await markNotification(notificationId, "sent", result.id || result.messageId || null, { providerResponse: result });
        attempts.push({ channel, ok: true });
      } catch (error) {
        await markNotification(notificationId, "failed", null, { error: error.message });
        attempts.push({ channel, ok: false, error: error.message });
      }
    }

    if (channel === "sms" && user.phone) {
      const notificationId = await createNotification({
        user,
        channel,
        notificationType: "otp",
        title,
        body,
        provider: config.integrations.sms.provider,
        metadata
      });
      try {
        const result = await deliverSms({ to: user.phone, body, metadata });
        await markNotification(notificationId, "sent", result.id || result.messageId || null, { providerResponse: result });
        attempts.push({ channel, ok: true });
      } catch (error) {
        await markNotification(notificationId, "failed", null, { error: error.message });
        attempts.push({ channel, ok: false, error: error.message });
      }
    }
  }

  if (!attempts.some((attempt) => attempt.ok)) {
    const channelList = attempts.map((attempt) => `${attempt.channel}:${attempt.error || "failed"}`).join(" | ");
    console.error("[otp-delivery] all OTP channels failed", {
      userType: user.user_type,
      userId: user.id,
      purpose,
      channels: deliveryChannels,
      errors: channelList
    });
    throw new AppError(503, "OTP delivery failed. Please try again.");
  }

  return attempts;
}

module.exports = {
  sendOtpNotification,
  getEmailProviderStatus,
  sendSmtpTestEmail,
  deliverSms,
  deliverEmail,
  getEffectiveEmailProviderConfig,
  createNotification,
  markNotification
};
