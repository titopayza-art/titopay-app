const express = require("express");
const crypto = require("crypto");
const net = require("net");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireSuperAdmin } = require("../middleware/super-admin");
const { authLimiter } = require("../middleware/rate-limits");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum, requireUuid } = require("../lib/validation");
const { hashPassword } = require("../lib/passwords");
const { isMissingDbObjectError, logDbCompatibilityWarning, safeQuery } = require("../lib/db-safe");
const {
  ADMIN_ROLE_PERMISSIONS,
  getAdminRolePermissions,
  getEffectiveAdminRolePermissions,
  normalizeAdminRole,
  login,
  logout,
  logoutAll
} = require("../services/auth-service");
const { ensureWalletNumbersForAllWallets, listAllWallets } = require("../services/wallet-service");
const { listAllTransactions, revenueSummary } = require("../services/transaction-service");
const { listMerchants } = require("../services/merchant-service");
const { listAuditLogs, writeAuditLog } = require("../services/audit-service");
const { API_BUILD } = require("../build-info");
const { adminDisableBeneficiary, adminListBeneficiaries } = require("../services/beneficiary-service");
const { getEmailProviderStatus, sendSmtpTestEmail, deliverSms } = require("../services/notification-service");
const { queueEmail, queueRawEmail } = require("../services/email-centre-service");
const { testCheckoutAuthentication } = require("../services/peach-checkout-auth-service");
const { testPayoutConnection } = require("../services/peach-payout-service");
const { testFlashConnection, FLASH_SERVICE_URLS } = require("../services/flash-service");
const { shouldSendCustomerEmail } = require("../services/customer-notification-preference-service");
const {
  listTicketsForAdmin: listSupportTicketsForAdmin,
  addAdminReply: addSupportTicketAdminReply
} = require("../services/support-ticket-reply-service");
const { ensureAuthenticationPreferenceSchema } = require("../services/authentication-preference-service");
const { getChatPresenceSnapshot } = require("../realtime/chat-hub");
const {
  getAdminAuthenticationPolicy,
  setAdminAuthenticationPolicy,
  getPlatformSetting,
  setPlatformSetting
} = require("../services/platform-settings-service");
const {
  SECURITY_CONTENT_KEY,
  getSecurityContentRecord,
  saveSecurityContent
} = require("../services/security-content-service");
const {
  listProfileChangeRequests,
  approveProfileChangeRequest,
  rejectProfileChangeRequest
} = require("../services/profile-change-service");
const {
  listAdminEvents,
  getAdminEvent,
  adminTransitionEvent,
  listTicketRefunds,
  processTicketRefund,
  listEventChangeRequests,
  processEventChangeRequest,
  eventSalesReport,
  createTicketSettlement,
  adminTicketingAnalytics
} = require("../services/ticketing-service");
const campaigns = require("../services/event-campaign-service");
const {
  listDefinitions: listServiceBuilderDefinitions,
  saveDefinition: saveServiceBuilderDefinition,
  deleteDefinition: deleteServiceBuilderDefinition
} = require("../services/service-builder-service");
const {
  listEventTags,
  eventTagAnalytics,
  listEventVendors,
  setTagStatus,
  PLATFORM_SCOPE,
  tagAuditTrail
} = require("../services/event-tag-service");
const {
  adminOverview: enterpriseDistributionOverview,
  listApplications: listEnterpriseDistributionApplications,
  listOrganisations: listEnterpriseDistributionOrganisations,
  transitionApplication: transitionEnterpriseDistributionApplication,
  listAllBatches: listEnterpriseDistributionBatches,
  releaseBatch: releaseEnterpriseDistributionBatch,
  listPayouts: listEnterpriseDistributionPayouts,
  listAuditLogs: listEnterpriseDistributionAuditLogs,
  adminReport: enterpriseDistributionReport
} = require("../services/enterprise-distribution-service");

const router = express.Router();

async function createUserInAppNotification({ userId, type, title, body, metadata = {}, db = pool }) {
  if (!userId) return null;
  const notificationId = crypto.randomUUID();
  await db.query(
    `INSERT INTO notifications (
       id, user_id, channel, notification_type, title, body, status, provider, metadata, sent_at
     )
     VALUES ($1, $2, 'in_app', $3, $4, $5, 'sent', 'titopay', $6::JSONB, NOW())
     RETURNING id`,
    [
      notificationId,
      userId,
      type,
      title,
      body,
      JSON.stringify({ ...metadata, clientNotificationId: metadata.clientNotificationId || notificationId })
    ]
  );
  return notificationId;
}

function adminRequestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.info("[admin-api]", {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      requestId: req.requestId,
      adminId: req.auth?.userId || null,
      role: req.auth?.role || null
    });
  });
  next();
}

function meta(req) {
  return { ipAddress: req.ip, userAgent: req.get("user-agent") };
}

const INTEGRATION_PROVIDERS = {
  peach_payments: {
    label: "Peach Payments",
    description: "Card, wallet top-up and payment processing.",
    category: "payments",
    env: config.integrations.peachPayments,
    fields: ["enabled", "environment", "baseUrl", "sandboxBaseUrl", "productionBaseUrl", "apiKey", "apiSecret", "clientId", "clientSecret", "username", "password", "merchantId", "entityId", "webhookSecret", "callbackUrl"],
    secretKeys: ["apiKey", "apiSecret", "clientSecret", "password", "webhookSecret"],
    // Peach Checkout (Embedded / Hosted Checkout V2) authenticates with the
    // Client ID, Client Secret and Merchant ID. The authentication and checkout
    // service URLs are fixed per environment, so no base URL is required.
    requiredFields: ["clientId", "clientSecret", "merchantId"],
    capability: "collection",
    capabilityLabel: "Collection / Top-up",
    peachGroup: "peach_payments",
    defaultBaseUrl: "https://testsecure.peachpayments.com/v2/checkout"
  },
  // Peach Payments — Payout / Withdrawal. A separate Peach capability with its
  // own base URL and its own credentials, stored in its own platform_settings
  // row so saving it can never touch the working Collection configuration.
  // Reference: https://developer.peachpayments.com/docs/payouts-api-1
  peach_payouts: {
    label: "Peach Payments Payout / Withdrawal",
    description: "Bank withdrawals and payouts (money out).",
    category: "payments",
    routingEligible: false,
    env: {
      mode: process.env.PEACH_PAYOUTS_MODE || "sandbox",
      baseUrl: process.env.PEACH_PAYOUTS_BASE_URL || "",
      clientId: process.env.PEACH_PAYOUTS_CLIENT_ID || "",
      clientSecret: process.env.PEACH_PAYOUTS_CLIENT_SECRET || "",
      merchantId: process.env.PEACH_PAYOUTS_MERCHANT_ID || "",
      webhookSecret: process.env.PEACH_PAYOUTS_WEBHOOK_SECRET || "",
      callbackUrl: process.env.PEACH_PAYOUTS_CALLBACK_URL || ""
    },
    fields: ["enabled", "environment", "baseUrl", "clientId", "clientSecret", "merchantId", "webhookSecret", "callbackUrl"],
    secretKeys: ["clientSecret", "webhookSecret"],
    requiredFields: ["baseUrl", "clientId", "clientSecret", "merchantId"],
    capability: "payout",
    capabilityLabel: "Payout / Withdrawal",
    peachGroup: "peach_payments",
    defaultBaseUrl: "https://sandbox-payouts.peachpayments.com/api"
  },
  pos_provider: {
    label: "Speedpoint / POS Provider",
    description: "Signed POS provider callbacks, terminal payment status and reconciliation.",
    category: "payments",
    routingEligible: false,
    env: {
      mode: process.env.POS_PROVIDER_MODE || "production",
      baseUrl: process.env.POS_PROVIDER_BASE_URL || "",
      providerName: process.env.POS_PROVIDER_NAME || "",
      merchantId: process.env.POS_PROVIDER_MERCHANT_ID || "",
      entityId: process.env.POS_PROVIDER_ENTITY_ID || "",
      webhookSecret: config.pos.providerWebhookSecret,
      callbackUrl: `${String(config.apiBaseUrl || "").replace(/\/+$/, "")}/v1/webhooks/pos-provider`
    },
    fields: ["enabled", "environment", "providerName", "baseUrl", "merchantId", "entityId", "webhookSecret", "callbackUrl"],
    readOnlyFields: ["callbackUrl"],
    secretKeys: ["webhookSecret"],
    requiredFields: ["webhookSecret"]
  },
  docfox: {
    label: "DocFox / FICA",
    description: "KYC, FICA and verification provider.",
    category: "compliance",
    env: config.integrations.docfox,
    fields: ["enabled", "environment", "baseUrl", "apiKey", "apiSecret", "clientId", "clientSecret", "webhookSecret", "callbackUrl"],
    secretKeys: ["apiKey", "apiSecret", "clientSecret", "webhookSecret"],
    requiredFields: ["baseUrl", "apiKey"]
  },
  ott: {
    label: "OTT",
    description: "Voucher and VAS provider connectivity.",
    category: "vas",
    env: config.integrations.ott,
    fields: ["enabled", "environment", "baseUrl", "apiKey", "apiSecret", "username", "password", "merchantId", "webhookSecret", "callbackUrl"],
    secretKeys: ["apiKey", "apiSecret", "password", "webhookSecret"],
    requiredFields: ["baseUrl", "apiKey"]
  },
  // Flash — Partner API v4. OAuth 2.0 client credentials against a single API
  // key, then an account/product read to prove the account number is real.
  // The generic API Secret / Username / Password / Merchant ID / Webhook Secret
  // fields are deliberately absent: Flash authenticates with the one Basic
  // credential, and TitoPay has no Flash callback consumer, so asking for them
  // only invites an operator to paste a credential somewhere it is never read.
  flash: {
    label: "Flash",
    description: "Airtime, electricity, data, prepaid utilities and voucher VAS provider (Partner API v4).",
    category: "vas",
    env: {
      mode: process.env.FLASH_MODE || "sandbox",
      baseUrl: process.env.FLASH_BASE_URL || "",
      apiKey: process.env.FLASH_API_KEY || "",
      accountNumber: process.env.FLASH_ACCOUNT_NUMBER || ""
    },
    fields: ["enabled", "environment", "baseUrl", "apiKey", "accountNumber"],
    secretKeys: ["apiKey"],
    // The base URL defaults to the documented endpoint for the selected
    // environment, so only the credential and the account number are required.
    requiredFields: ["apiKey", "accountNumber"],
    defaultBaseUrl: FLASH_SERVICE_URLS.sandbox,
    defaultBaseUrls: FLASH_SERVICE_URLS
  },
  smtp: {
    label: "Email / SMTP",
    description: "Email delivery for OTP, reset and security notices.",
    category: "notifications",
    env: {
      mode: config.integrations.email.provider,
      baseUrl: config.integrations.email.smtpHost,
      smtpPort: config.integrations.email.smtpPort,
      port: config.integrations.email.smtpPort,
      senderEmail: config.integrations.email.fromAddress,
      username: config.integrations.email.smtpUser,
      password: config.integrations.email.smtpPassword
    },
    fields: ["enabled", "environment", "baseUrl", "smtpPort", "username", "password", "senderEmail", "callbackUrl"],
    secretKeys: ["password"],
    requiredFields: ["baseUrl", "smtpPort", "senderEmail", "username", "password"]
  },
  sms: {
    label: "SMS Provider",
    description: "Optional SMS alerts and critical security messages.",
    category: "notifications",
    env: config.integrations.sms,
    fields: ["enabled", "environment", "baseUrl", "apiKey", "apiSecret", "clientId", "clientSecret", "username", "password", "senderId", "testNumber", "webhookSecret", "callbackUrl"],
    secretKeys: ["apiKey", "apiSecret", "clientSecret", "password", "webhookSecret"],
    requiredFields: ["baseUrl", "apiKey", "senderId", "testNumber"]
  }
};

// WHICH COMPANY SUPPLIES WHICH TITOPAY CAPABILITY. Every row is a TitoPay
// capability first and a vendor second, and a row with no contracted vendor
// says NOT_ROUTED rather than naming a candidate.
//
// KYC used to default to a named verification vendor. Nothing has ever called
// it: no contract, no credential, no request. A default is a decision, and
// that one was never taken, so the row is unrouted until it is. The credential
// slot for that vendor stays in the integration list, because having somewhere
// to put keys is not the same as having chosen a supplier.
const NOT_ROUTED = "none";

const PROVIDER_ROUTING_SERVICES = [
  { key: "airtime", label: "Airtime", defaultProvider: "flash" },
  { key: "data", label: "Data", defaultProvider: "flash" },
  { key: "electricity", label: "Electricity", defaultProvider: "flash" },
  { key: "bill_payments", label: "Bill Payments", defaultProvider: "flash" },
  { key: "gift_cards", label: "Gift Cards", defaultProvider: "flash" },
  { key: "cash_services", label: "Cash Services", defaultProvider: "flash" },
  { key: "vouchers", label: "Vouchers", defaultProvider: "ott" },
  { key: "card_payments", label: "Card Payments", defaultProvider: "peach_payments" },
  { key: "card_topups", label: "Card Top-ups", defaultProvider: "peach_payments" },
  { key: "kyc", label: "Identity Verification", defaultProvider: NOT_ROUTED },
  { key: "email", label: "Email", defaultProvider: "smtp" },
  { key: "sms", label: "SMS", defaultProvider: "sms" }
];

const FEATURE_FLAGS = [
  ["chat", "Chat"],
  ["voice_calls", "Voice Calls"],
  ["qr_payments", "QR Payments"],
  ["qr_generator", "QR Generator"],
  ["flash", "Flash"],
  ["ott", "OTT"],
  ["peach", "Peach"],
  ["docfox", "DocFox"],
  ["sms", "SMS"],
  ["email", "Email"],
  ["notifications", "Notifications"],
  ["wallets", "Wallets"],
  ["marketplace", "Marketplace"],
  ["marketing", "Marketing"],
  ["support", "Support"],
  ["analytics", "Analytics"],
  ["security_centre", "Security Centre"],
  ["developer_tools", "Developer Tools"],
  ["engineering_tools", "Engineering Tools"],
  ["pricing_engine", "Pricing Engine"],
  ["integration_centre", "Integration Centre"]
].map(([key, label]) => ({ key, label, enabled: true }));

function platformSettingKey(key) {
  return `integration_${key}`;
}

function webhookSettingKey() {
  return "integration_webhook_events";
}

function providerRoutingSettingKey() {
  return "provider_routing";
}

function featureFlagsSettingKey() {
  return "feature_flags";
}

function companyDocumentsSettingKey() {
  return "company_documents";
}

function marketingSmsCampaignsSettingKey() {
  return "marketing_sms_campaigns";
}

function marketingEmailCampaignsSettingKey() { return "marketing_email_campaigns"; }

function pwaCustomerReviewsSettingKey() {
  return "pwa_customer_reviews";
}

const INTEGRATION_FIELD_LABELS = {
  enabled: "Enable provider",
  environment: "Environment",
  baseUrl: "Base URL / Host",
  apiKey: "API Key",
  apiSecret: "API Secret",
  clientId: "Client ID",
  clientSecret: "Client Secret",
  username: "Username",
  password: "Password",
  merchantId: "Merchant ID",
  accountNumber: "Flash Account Number",
  entityId: "Entity ID",
  providerName: "Provider Name",
  webhookSecret: "Webhook Secret",
  callbackUrl: "Callback URL",
  senderEmail: "Sender Email",
  senderId: "Sender ID",
  testNumber: "Test Mobile Number",
  smtpPort: "SMTP Port"
};

const SECRET_FIELD_NAMES = new Set(["apiKey", "apiSecret", "clientSecret", "password", "webhookSecret"]);
const URL_FIELD_NAMES = new Set(["callbackUrl"]);
const ENDPOINT_FIELD_NAMES = new Set(["baseUrl"]);

function integrationEncryptionKey() {
  return crypto
    .createHash("sha256")
    .update(config.refreshSecret || config.accessSecret)
    .digest();
}

function encryptSecret(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", integrationEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
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

// A masked display value (••••1234) is what the portal SHOWS for a stored
// secret; it is never a credential. If one is ever submitted back — a browser
// autofilling the field, a client echoing the displayed value, a retried
// request — storing it silently replaces the real credential with the mask.
// The provider then rejects every authentication attempt, and the Admin form
// still looks correctly filled in, so the corruption is invisible.
function isMaskedSecretPlaceholder(value) {
  // maskSecret() renders a stored secret as "••••" + its last four characters.
  // That U+2022 prefix is the only placeholder the portal ever emits, and no
  // API credential contains it — so match it exactly rather than guessing at
  // asterisk patterns, which would silently discard a real secret that happens
  // to start with one.
  const text = String(value ?? "").trim();
  return /^\u2022{4}/.test(text);
}

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 4) return "configured";
  return `••••${text.slice(-4)}`;
}

function optionalText(value, label, max = 500) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  return boundedText(value, label, { min: 0, max });
}

function validateOptionalUrl(value, label) {
  const text = optionalText(value, label, 500);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      throw new Error("Unsupported protocol");
    }
    return parsed.toString();
  } catch (_error) {
    throw new AppError(400, `${label} must be a valid URL`);
  }
}

function validateOptionalEndpoint(value, label) {
  const text = optionalText(value, label, 500);
  if (!text) return "";
  if (/\s/.test(text)) throw new AppError(400, `${label} must not contain spaces`);
  return text;
}

function booleanFromBody(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no", "off", "disabled"].includes(String(value).trim().toLowerCase());
}

function integrationFieldDefinitions(provider) {
  return provider.fields.map((name) => ({
    name,
    label: INTEGRATION_FIELD_LABELS[name] || name,
    type: name === "enabled" ? "boolean" : name === "environment" ? "select" : SECRET_FIELD_NAMES.has(name) ? "secret" : name === "smtpPort" ? "number" : "text",
    secret: SECRET_FIELD_NAMES.has(name),
    readOnly: Array.isArray(provider.readOnlyFields) && provider.readOnlyFields.includes(name)
  }));
}

function envConfigured(provider) {
  const env = provider.env || {};
  return Object.entries(env).some(([key, value]) => {
    if (["mode", "provider", "senderId", "senderEmail", "port"].includes(key)) return false;
    return Boolean(String(value || "").trim());
  });
}

function publicIntegrationState(key, stored = {}) {
  stored = stored && typeof stored === "object" ? stored : {};
  const provider = INTEGRATION_PROVIDERS[key];
  const env = provider.env || {};
  const storedSecrets = stored.secrets || {};
  const configured = providerConfigured(provider, stored);
  const secrets = {};
  for (const secretKey of provider.secretKeys) {
    secrets[secretKey] = storedSecrets[`${secretKey}Masked`] || maskSecret(env[secretKey]);
  }
  const health = stored.health || {};
  const environment = stored.environment || stored.mode || env.mode || env.provider || "production";
  return {
    key,
    label: provider.label,
    description: provider.description,
    category: provider.category,
    mode: stored.enabled === false ? "disabled" : environment,
    environment,
    baseUrl: stored.baseUrl || env.baseUrl || env.apiUrl || "",
    clientId: stored.clientId || env.clientId || "",
    username: stored.username || env.username || "",
    merchantId: stored.merchantId || env.merchantId || "",
    accountNumber: stored.accountNumber || env.accountNumber || "",
    entityId: stored.entityId || env.entityId || "",
    callbackUrl: stored.callbackUrl || env.callbackUrl || "",
    providerName: stored.providerName || env.providerName || "",
    senderEmail: stored.senderEmail || env.senderEmail || "",
    senderId: stored.senderId || env.senderId || "",
    smtpPort: stored.smtpPort || env.smtpPort || env.port || "",
    configured,
    enabled: stored.enabled !== false,
    secrets,
    // Capability metadata lets the Admin Portal render Peach as one provider
    // with two independent sections without hard-coding anything about Peach.
    capability: provider.capability || null,
    capabilityLabel: provider.capabilityLabel || null,
    peachGroup: provider.peachGroup || null,
    // Documented default endpoint, shown as a placeholder only. The saved value
    // always wins, so the endpoint stays configurable and is never assumed.
    // Where a provider documents one endpoint per environment, the placeholder
    // follows the selected environment and the whole map goes with it so the
    // form can swap it as the operator changes the dropdown.
    defaultBaseUrl: provider.defaultBaseUrls?.[environment] || provider.defaultBaseUrl || "",
    defaultBaseUrls: provider.defaultBaseUrls || null,
    fields: integrationFieldDefinitions(provider),
    health: {
      status: health.status || "not_tested",
      responseTimeMs: health.responseTimeMs ?? null,
      lastSuccessfulConnectionAt: health.lastSuccessfulConnectionAt || null,
      lastTestedAt: health.lastTestedAt || null,
      errorMessage: health.errorMessage || ""
    },
    updatedAt: stored.updatedAt || null
  };
}

async function getStoredIntegration(key) {
  const { rows } = await pool.query(
    "SELECT value, updated_at FROM platform_settings WHERE key = $1 LIMIT 1",
    [platformSettingKey(key)]
  );
  if (!rows[0]) return null;
  return { ...(rows[0].value || {}), updatedAt: rows[0].updated_at };
}

async function getPlatformSettingValue(key, fallback = {}) {
  const { rows } = await pool.query("SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [key]);
  return rows[0]?.value || fallback;
}

async function savePlatformSettingValue(key, value, adminId) {
  const { rows } = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::JSONB, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING value, updated_at`,
    [key, JSON.stringify(value), adminId]
  );
  return { value: rows[0].value, updatedAt: rows[0].updated_at };
}

function canApproveMarketingSms(role) {
  const normalized = normalizeAdminRole(role);
  return ["owner", "root", "ceo", "coo", "super_admin", "senior_marketing"].includes(normalized);
}

// Which of the three approval seats this admin occupies.
//
// Three people can now approve or reject: the CEO, the COO and Senior
// Marketing. Each holds one seat, so the same person cannot approve twice under
// two hats, and super_admin/owner act in the CEO seat as they always have.
function marketingApprovalSeat(role) {
  const normalized = normalizeAdminRole(role);
  if (["ceo", "super_admin", "owner", "root"].includes(normalized)) return "ceo";
  if (normalized === "coo") return "coo";
  if (normalized === "senior_marketing") return "senior_marketing";
  return null;
}

// Senior Marketing may raise something to the CEO or COO rather than decide it.
function canEscalateMarketing(role) {
  return normalizeAdminRole(role) === "senior_marketing";
}

function maskPhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 6) return "••••";
  return `${text.slice(0, 4)}••••${text.slice(-3)}`;
}

function normalizePhoneForSms(value) {
  const text = String(value || "").replace(/[^\d+]/g, "");
  if (!text) return "";
  if (text.startsWith("+")) return text;
  if (text.startsWith("0")) return `+27${text.slice(1)}`;
  if (text.startsWith("27")) return `+${text}`;
  return text;
}

async function getMarketingSmsCampaigns() {
  const stored = await getPlatformSettingValue(marketingSmsCampaignsSettingKey(), { campaigns: [] });
  return Array.isArray(stored.campaigns) ? stored.campaigns : [];
}

async function saveMarketingSmsCampaigns(campaigns, adminId) {
  const trimmed = [...campaigns]
    .sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0))
    .slice(0, 100);
  await savePlatformSettingValue(marketingSmsCampaignsSettingKey(), { campaigns: trimmed }, adminId);
  return trimmed;
}

async function getMarketingEmailCampaigns(){const stored=await getPlatformSettingValue(marketingEmailCampaignsSettingKey(),{campaigns:[]});return Array.isArray(stored.campaigns)?stored.campaigns:[];}
async function saveMarketingEmailCampaigns(campaigns,adminId){const trimmed=[...campaigns].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,100);await savePlatformSettingValue(marketingEmailCampaignsSettingKey(),{campaigns:trimmed},adminId);return trimmed;}
async function resolveSpecificEmailRecipient(identifier){const value=boundedText(identifier,"Specific user",{min:3,max:160}),username=value.replace(/^@/,"");const {rows}=await pool.query(`SELECT id,full_name,username,email,account_type FROM users WHERE status='active' AND email IS NOT NULL AND TRIM(email)<>'' AND (LOWER(username)=LOWER($2) OR LOWER(email)=LOWER($1)) LIMIT 2`,[value,username]);if(!rows.length)throw new AppError(404,"No active TitoPay user with an email address matches that identifier");if(rows.length>1)throw new AppError(409,"That identifier matches more than one user");return rows[0];}
async function countMarketingEmailRecipients(audience,targetUserId=null){const params=[];let where="";if(audience==="specific"){params.push(targetUserId);where=`AND id=$1`;}else if(audience!=="both"){params.push(audience);where=`AND LOWER(account_type)=$1`;}const {rows}=await pool.query(`SELECT COUNT(*)::int count FROM users WHERE status='active' AND email IS NOT NULL AND TRIM(email)<>'' ${where}`,params);return rows[0]?.count||0;}
async function listMarketingEmailRecipients(audience,targetUserId=null){const params=[];let where="";if(audience==="specific"){params.push(targetUserId);where=`AND id=$1`;}else if(audience!=="both"){params.push(audience);where=`AND LOWER(account_type)=$1`;}const {rows}=await pool.query(`SELECT id,full_name,username,email,account_type FROM users WHERE status='active' AND email IS NOT NULL AND TRIM(email)<>'' ${where} ORDER BY created_at`,params);return rows;}

async function resolveSpecificSmsRecipient(identifier) {
  const recipient = boundedText(identifier, "Specific user", { min: 3, max: 160 });
  const recipientUsername = recipient.replace(/^@/, "");
  const recipientDigits = recipient.replace(/\D/g, "");
  const recipientPhone = recipientDigits.length >= 7 ? recipientDigits : null;
  const { rows } = await pool.query(
    `SELECT id, full_name, username, email, phone, account_type
       FROM users
      WHERE status = 'active'
        AND phone IS NOT NULL
        AND TRIM(phone) <> ''
        AND (
          LOWER(username) = LOWER($3)
          OR LOWER(COALESCE(email, '')) = LOWER($1)
          OR (
            $2::TEXT IS NOT NULL
            AND REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
          )
        )
      LIMIT 2`,
    [recipient, recipientPhone, recipientUsername]
  );
  if (!rows.length) {
    throw new AppError(404, "No active TitoPay user with a cellphone number matches that username, email or cellphone number");
  }
  if (rows.length > 1) throw new AppError(409, "That identifier matches more than one user");
  return rows[0];
}

async function countMarketingSmsRecipients(audience, targetUserId = null) {
  if (audience === "specific") {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::INT AS count
         FROM users
        WHERE id = $1
          AND status = 'active'
          AND phone IS NOT NULL
          AND TRIM(phone) <> ''`,
      [targetUserId]
    );
    return rows[0]?.count || 0;
  }
  const params = [];
  let audienceSql = "";
  if (audience !== "both") {
    params.push(audience);
    audienceSql = `AND LOWER(account_type) = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT AS count
     FROM users
     WHERE phone IS NOT NULL
       AND TRIM(phone) <> ''
       AND status = 'active'
       ${audienceSql}`,
    params
  );
  return rows[0]?.count || 0;
}

async function listMarketingSmsRecipients(audience, targetUserId = null) {
  if (audience === "specific") {
    const { rows } = await pool.query(
      `SELECT id, full_name, username, phone, account_type
         FROM users
        WHERE id = $1
          AND status = 'active'
          AND phone IS NOT NULL
          AND TRIM(phone) <> ''
        LIMIT 1`,
      [targetUserId]
    );
    return rows
      .map((row) => ({ ...row, smsPhone: normalizePhoneForSms(row.phone) }))
      .filter((row) => row.smsPhone);
  }
  const params = [];
  let audienceSql = "";
  if (audience !== "both") {
    params.push(audience);
    audienceSql = `AND LOWER(account_type) = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT id, full_name, username, phone, account_type
     FROM users
     WHERE phone IS NOT NULL
       AND TRIM(phone) <> ''
       AND status = 'active'
       ${audienceSql}
     ORDER BY created_at ASC`,
    params
  );
  return rows
    .map((row) => ({ ...row, smsPhone: normalizePhoneForSms(row.phone) }))
    .filter((row) => row.smsPhone);
}

function publicMarketingSmsCampaign(campaign) {
  return {
    ...campaign,
    recipientsPreview: undefined,
    deliveryResults: Array.isArray(campaign.deliveryResults)
      ? campaign.deliveryResults.slice(0, 20).map((item) => ({
        ...item,
        phone: item.phone ? maskPhone(item.phone) : ""
      }))
      : []
  };
}

async function getPwaCustomerReviews() {
  const stored = await getPlatformSettingValue(pwaCustomerReviewsSettingKey(), { reviews: [] });
  return Array.isArray(stored.reviews) ? stored.reviews : [];
}

function maskEmail(value) {
  const text = String(value || "").trim();
  if (!text || !text.includes("@")) return "";
  const [local, domain] = text.split("@");
  return `${local.slice(0, 2)}•••@${domain}`;
}

function publicPwaCustomerReview(review = {}) {
  return {
    id: review.id,
    source: review.source || "pwa_profile",
    rating: Number(review.rating || 0),
    category: review.category || "general",
    message: review.message || "",
    status: review.status || "new",
    contactPermission: Boolean(review.contactPermission),
    appVersion: review.appVersion || "",
    userId: review.userId || "",
    userName: review.userName || "TitoPay user",
    username: review.username || "",
    accountType: review.accountType || "personal",
    email: review.contactPermission ? maskEmail(review.email) : "",
    phone: review.contactPermission ? maskPhone(review.phone) : "",
    createdAt: review.createdAt || null
  };
}

async function getProviderRouting() {
  const stored = await getPlatformSettingValue(providerRoutingSettingKey(), {});
  const mapping = stored.mapping || {};
  return {
    services: PROVIDER_ROUTING_SERVICES.map((service) => ({
      ...service,
      provider: Object.prototype.hasOwnProperty.call(mapping, service.key) ? mapping[service.key] : service.defaultProvider
    })),
    providers: [
      // A capability may legitimately have no supplier, and an operator has to
      // be able to say so without picking one at random.
      { key: NOT_ROUTED, label: "Not configured" },
      ...Object.entries(INTEGRATION_PROVIDERS)
        .filter(([, provider]) => provider.routingEligible !== false)
        .map(([key, provider]) => ({ key, label: provider.label }))
    ],
    updatedAt: stored.updatedAt || null
  };
}

async function saveProviderRouting(body = {}, adminId) {
  const supportedProviders = new Set([
    NOT_ROUTED,
    ...Object.entries(INTEGRATION_PROVIDERS)
      .filter(([, provider]) => provider.routingEligible !== false)
      .map(([key]) => key)
  ]);
  const submitted = body.mapping || body;
  const mapping = {};
  for (const service of PROVIDER_ROUTING_SERVICES) {
    const selected = String(submitted[service.key] || service.defaultProvider).trim();
    if (!supportedProviders.has(selected)) throw new AppError(400, `Unsupported provider for ${service.label}`);
    mapping[service.key] = selected;
  }
  const updatedAt = new Date().toISOString();
  await savePlatformSettingValue(providerRoutingSettingKey(), { mapping, updatedAt }, adminId);
  return getProviderRouting();
}

async function getFeatureFlags() {
  const stored = await getPlatformSettingValue(featureFlagsSettingKey(), {});
  const flags = stored.flags || {};
  return {
    flags: FEATURE_FLAGS.map((flag) => ({
      ...flag,
      enabled: Object.prototype.hasOwnProperty.call(flags, flag.key) ? Boolean(flags[flag.key]) : flag.enabled
    })),
    updatedAt: stored.updatedAt || null
  };
}

async function saveFeatureFlags(body = {}, adminId) {
  const submitted = body.flags || body;
  const allowed = new Set(FEATURE_FLAGS.map((flag) => flag.key));
  const flags = {};
  for (const flag of FEATURE_FLAGS) flags[flag.key] = Boolean(submitted[flag.key]);
  for (const key of Object.keys(submitted)) {
    if (!allowed.has(key)) throw new AppError(400, `Unsupported feature flag: ${key}`);
  }
  const updatedAt = new Date().toISOString();
  await savePlatformSettingValue(featureFlagsSettingKey(), { flags, updatedAt }, adminId);
  return getFeatureFlags();
}

const COMPANY_DOCUMENT_CATEGORIES = [
  "HR Policies",
  "Employment Contracts",
  "Employee Handbook",
  "POPIA",
  "PAIA",
  "AML",
  "FICA",
  "Board Documents",
  "Training Material",
  "SOPs",
  "Forms",
  "Staff Notices"
];

async function getCompanyDocuments() {
  const stored = await getPlatformSettingValue(companyDocumentsSettingKey(), { documents: [] });
  return {
    documents: Array.isArray(stored.documents) ? stored.documents : [],
    updatedAt: stored.updatedAt || null
  };
}

function companyDocumentPayload(body = {}, existing = {}) {
  const title = boundedText(body.title ?? existing.title, "Document title", { min: 1, max: 160 });
  const category = boundedText(body.category ?? existing.category, "Document category", { min: 1, max: 80 });
  const fileUrl = boundedText(body.fileUrl ?? body.file_url ?? existing.fileUrl, "Document URL", { min: 1, max: 600 });
  if (!COMPANY_DOCUMENT_CATEGORIES.includes(category)) throw new AppError(400, "Unsupported document category");
  if (!/^https?:\/\//i.test(fileUrl) && !fileUrl.startsWith("/")) throw new AppError(400, "Document URL must be an HTTPS URL or approved storage path");
  return {
    title,
    category,
    fileUrl,
    description: boundedText(body.description ?? existing.description ?? "", "Document description", { max: 500 }),
    requiresAcknowledgement: Boolean(body.requiresAcknowledgement ?? body.requires_acknowledgement ?? existing.requiresAcknowledgement),
    status: body.status || existing.status || "active"
  };
}

async function createCompanyDocument(body = {}, actor) {
  const current = await getCompanyDocuments();
  const now = new Date().toISOString();
  const payload = companyDocumentPayload(body);
  const document = {
    id: crypto.randomUUID(),
    ...payload,
    version: 1,
    archivedAt: null,
    replacedBy: null,
    acknowledgements: [],
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now
  };
  const next = { documents: [document, ...current.documents], updatedAt: now };
  await savePlatformSettingValue(companyDocumentsSettingKey(), next, actor.userId);
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "company_document_created",
    entityType: "company_document",
    entityId: document.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { title: document.title, category: document.category, version: document.version }
  });
  return document;
}

async function updateCompanyDocument(documentId, body = {}, actor) {
  const current = await getCompanyDocuments();
  const now = new Date().toISOString();
  const index = current.documents.findIndex((item) => item.id === documentId);
  if (index < 0) throw new AppError(404, "Document record not found");
  const existing = current.documents[index];
  const payload = companyDocumentPayload(body, existing);
  const fileChanged = payload.fileUrl !== existing.fileUrl;
  const updated = {
    ...existing,
    ...payload,
    version: fileChanged ? Number(existing.version || 1) + 1 : Number(existing.version || 1),
    updatedBy: actor.userId,
    updatedAt: now,
    archivedAt: payload.status === "archived" ? (existing.archivedAt || now) : null
  };
  const documents = current.documents.slice();
  documents[index] = updated;
  await savePlatformSettingValue(companyDocumentsSettingKey(), { documents, updatedAt: now }, actor.userId);
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: fileChanged ? "company_document_replaced" : "company_document_updated",
    entityType: "company_document",
    entityId: updated.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { title: updated.title, category: updated.category, version: updated.version, status: updated.status }
  });
  return updated;
}

async function acknowledgeCompanyDocument(documentId, actor) {
  const current = await getCompanyDocuments();
  const now = new Date().toISOString();
  const index = current.documents.findIndex((item) => item.id === documentId);
  if (index < 0) throw new AppError(404, "Document record not found");
  const existing = current.documents[index];
  const acknowledgements = (existing.acknowledgements || []).filter((item) => item.userId !== actor.userId || item.version !== existing.version);
  acknowledgements.push({
    userId: actor.userId,
    email: actor.email,
    role: actor.role,
    date: now.slice(0, 10),
    time: now,
    version: existing.version,
    ipAddress: actor.ipAddress
  });
  const documents = current.documents.slice();
  documents[index] = { ...existing, acknowledgements, updatedAt: now };
  await savePlatformSettingValue(companyDocumentsSettingKey(), { documents, updatedAt: now }, actor.userId);
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "company_document_acknowledged",
    entityType: "company_document",
    entityId: existing.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { title: existing.title, version: existing.version }
  });
  return documents[index];
}

async function listIntegrationConfigs() {
  const items = await Promise.all(
    Object.keys(INTEGRATION_PROVIDERS).map(async (key) => publicIntegrationState(key, await getStoredIntegration(key)))
  );
  return items;
}

async function saveIntegrationConfig({ providerKey, body, adminId }) {
  const current = await getStoredIntegration(providerKey);
  const provider = INTEGRATION_PROVIDERS[providerKey];
  const submittedMode = String(body.environment || body.mode || current?.environment || "production").trim().toLowerCase();
  const enabled = submittedMode === "disabled" ? false : booleanFromBody(body.enabled, current?.enabled !== false);
  const environment = submittedMode === "disabled"
    ? (current?.environment || "production")
    : requireEnum(submittedMode || "production", ["sandbox", "production"], "Integration environment");
  const value = {
    label: provider.label,
    enabled,
    environment,
    mode: enabled ? environment : "disabled",
    configured: false,
    health: current?.health || { status: "not_tested" },
    logs: Array.isArray(current?.logs) ? current.logs.slice(0, 100) : [],
    secrets: { ...(current?.secrets || {}) }
  };

  for (const field of provider.fields) {
    if (field === "enabled" || field === "environment") continue;
    if (Array.isArray(provider.readOnlyFields) && provider.readOnlyFields.includes(field)) {
      value[field] = current?.[field] || provider.env?.[field] || "";
      continue;
    }
    if (SECRET_FIELD_NAMES.has(field)) {
      const submittedValue = body[field] || (field === "clientSecret" ? body.secret : "");
      // A blank field means "keep the stored secret"; so does the masked value
      // the form displays for it. Neither may overwrite a real credential.
      if (submittedValue && !isMaskedSecretPlaceholder(submittedValue)) {
        value.secrets[`${field}Encrypted`] = encryptSecret(submittedValue);
        value.secrets[`${field}Masked`] = maskSecret(submittedValue);
      }
      continue;
    }
    const submittedValue = body[field] ?? (field === "senderEmail" || field === "senderId" ? body.sender : undefined);
    const existingValue = current?.[field] || "";
    if (URL_FIELD_NAMES.has(field)) value[field] = validateOptionalUrl(submittedValue ?? existingValue, INTEGRATION_FIELD_LABELS[field] || field);
    else if (field === "smtpPort") {
      const raw = optionalText(submittedValue ?? existingValue, INTEGRATION_FIELD_LABELS[field] || field, 10);
      if (raw && Number.isNaN(Number(raw))) throw new AppError(400, "SMTP Port must be a number");
      value[field] = raw;
    }
    else if (ENDPOINT_FIELD_NAMES.has(field)) value[field] = validateOptionalEndpoint(submittedValue ?? existingValue, INTEGRATION_FIELD_LABELS[field] || field);
    else value[field] = optionalText(submittedValue ?? existingValue, INTEGRATION_FIELD_LABELS[field] || field, 500);
  }

  value.configured = providerConfigured(provider, value);

  const { rows } = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::JSONB, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING value, updated_at`,
    [platformSettingKey(providerKey), JSON.stringify(value), adminId]
  );
  return publicIntegrationState(providerKey, { ...rows[0].value, updatedAt: rows[0].updated_at });
}

async function disableIntegrationConfig(providerKey, adminId) {
  const provider = INTEGRATION_PROVIDERS[providerKey];
  const current = await getStoredIntegration(providerKey) || { label: provider.label, secrets: {}, logs: [] };
  const nextValue = {
    ...current,
    label: provider.label,
    enabled: false,
    mode: "disabled",
    configured: providerConfigured(provider, current),
    health: {
      ...(current.health || {}),
      status: "disabled",
      errorMessage: "",
      lastTestedAt: current.health?.lastTestedAt || null
    }
  };
  const stored = await writeIntegrationStoredValue(providerKey, nextValue, adminId);
  return publicIntegrationState(providerKey, stored);
}

async function rotateIntegrationCredentials(providerKey, body = {}, adminId) {
  const provider = INTEGRATION_PROVIDERS[providerKey];
  const current = await getStoredIntegration(providerKey) || { label: provider.label, enabled: true, secrets: {}, logs: [] };
  const nextValue = {
    ...current,
    label: provider.label,
    secrets: { ...(current.secrets || {}) },
    health: { ...(current.health || {}), status: "not_tested", lastTestedAt: null, errorMessage: "" },
    credentialRotation: {
      requestedAt: new Date().toISOString(),
      requestedBy: adminId
    }
  };
  let rotatedCount = 0;
  for (const field of provider.secretKeys) {
    const submitted = body[field];
    if (submitted && !isMaskedSecretPlaceholder(submitted)) {
      nextValue.secrets[`${field}Encrypted`] = encryptSecret(submitted);
      nextValue.secrets[`${field}Masked`] = maskSecret(submitted);
      rotatedCount += 1;
    }
  }
  if (!rotatedCount && provider.secretKeys.includes("webhookSecret")) {
    const generatedSecret = crypto.randomBytes(32).toString("hex");
    nextValue.secrets.webhookSecretEncrypted = encryptSecret(generatedSecret);
    nextValue.secrets.webhookSecretMasked = maskSecret(generatedSecret);
    nextValue.credentialRotation.generatedWebhookSecret = true;
    rotatedCount += 1;
  }
  nextValue.configured = providerConfigured(provider, nextValue);
  const stored = await writeIntegrationStoredValue(providerKey, nextValue, adminId);
  return {
    provider: publicIntegrationState(providerKey, stored),
    rotatedSecrets: rotatedCount
  };
}

async function writeIntegrationStoredValue(providerKey, value, adminId = null) {
  const { rows } = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::JSONB, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING value, updated_at`,
    [platformSettingKey(providerKey), JSON.stringify(value), adminId]
  );
  return { ...rows[0].value, updatedAt: rows[0].updated_at };
}

function providerSecretValue(stored, provider, field) {
  const candidates = [
    stored?.secrets?.[`${field}Encrypted`],
    stored?.[`${field}Encrypted`],
    stored?.secrets?.[field],
    stored?.[field]
  ].filter((value) => value !== undefined && value !== null && String(value).trim() !== "");

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text || isMaskedSecretPlaceholder(text)) continue;
    if (!text.startsWith("enc:")) return text;
    try {
      // A row poisoned before the save guard existed decrypts to the mask
      // itself. Treat that as unconfigured rather than authenticating with it.
      const decrypted = decryptSecret(text);
      if (isMaskedSecretPlaceholder(decrypted)) continue;
      return decrypted;
    } catch (_error) {
      continue;
    }
  }

  return provider.env?.[field] || "";
}

function isPlatformOwnerRole(role) {
  return ["owner", "root", "ceo", "super_admin", "developer"].includes(normalizeAdminRole(role));
}

function adminPositionLabel(role) {
  const normalized = normalizeAdminRole(role);
  return {
    ceo: "CEO",
    coo: "COO",
    cfo: "CFO",
    cto: "CTO",
    owner: "Owner",
    root: "Platform Owner",
    developer: "Developer",
    super_admin: "Super Admin",
    customer_support: "Customer Support",
    finance: "Finance",
    compliance: "Compliance",
    hr_admin: "HR Admin",
    hr_administrator: "HR Administrator",
    hr_director: "HR Director"
  }[normalized] || normalized.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function requirePlatformOwnerAccess(req, message = "Only Super Admin can manage this area") {
  if (!isPlatformOwnerRole(req.auth?.role)) throw new AppError(403, message);
}

function requireSuperAdminIntegrationAccess(req) {
  requirePlatformOwnerAccess(req, "Only platform owner roles can view provider integrations");
}

function requireCompanyDocumentsAccess(req) {
  const role = normalizeAdminRole(req.auth?.role);
  if (!["owner", "root", "ceo", "super_admin", "hr_admin", "hr_administrator", "hr_director"].includes(role)) {
    throw new AppError(403, "Company Documents access required");
  }
}

function effectiveProviderConfig(providerKey, stored = {}) {
  const provider = INTEGRATION_PROVIDERS[providerKey];
  const env = provider.env || {};
  const effective = {
    enabled: stored.enabled !== false,
    environment: stored.environment || stored.mode || env.mode || env.provider || "production"
  };
  for (const field of provider.fields) {
    if (field === "enabled" || field === "environment") continue;
    if (SECRET_FIELD_NAMES.has(field)) effective[field] = providerSecretValue(stored, provider, field);
    else effective[field] = stored[field] || env[field] || (field === "baseUrl" ? env.apiUrl : "") || "";
  }
  return effective;
}

function configuredValueForField(stored, provider, field) {
  if (SECRET_FIELD_NAMES.has(field)) return providerSecretValue(stored, provider, field);
  return stored?.[field] || provider.env?.[field] || (field === "baseUrl" ? provider.env?.apiUrl : "") || "";
}

function providerConfigured(provider, stored = {}) {
  return provider.requiredFields.every((field) => {
    if (Array.isArray(field)) return field.some((option) => Boolean(configuredValueForField(stored, provider, option)));
    return Boolean(configuredValueForField(stored, provider, field));
  });
}

function missingProviderFieldsFromEffective(provider, effective = {}) {
  return provider.requiredFields
    .filter((field) => {
      if (Array.isArray(field)) return !field.some((option) => Boolean(effective[option]));
      return !effective[field];
    })
    .map((field) => Array.isArray(field) ? field.join(" or ") : field);
}

function providerAuthenticationType(providerKey, effective = {}) {
  if (providerKey === "sms") return "bearer";
  if (providerKey === "peach_payments" || providerKey === "peach_payouts") return "oauth_client_credentials";
  // Flash Partner API v4: Basic API key on POST /token, Bearer thereafter.
  if (providerKey === "flash") return "oauth_client_credentials";
  if (providerKey === "ott" && effective.username && effective.password) return "basic_username_password";
  if (providerKey === "docfox" && effective.apiKey) return "bearer_api_key";
  if (effective.apiKey) return "x-api-key";
  if (effective.clientId || effective.clientSecret) return "client_headers";
  return "none";
}

function providerHeaders(providerKey, effective = {}) {
  if (providerKey === "sms") {
    const apiToken = String(effective.apiKey || "").trim();
    return {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    };
  }
  const headers = {
    "user-agent": "TitoPay-Integration-Health/1.0",
    accept: "application/json,text/plain,*/*"
  };
  const apiKey = effective.apiKey || "";
  const apiSecret = effective.apiSecret || "";
  const clientId = effective.clientId || "";
  const clientSecret = effective.clientSecret || "";
  if (apiKey) headers["x-api-key"] = apiKey;
  if (apiSecret) headers["x-api-secret"] = apiSecret;
  if (clientId) headers["x-client-id"] = clientId;
  if (clientSecret) headers["x-client-secret"] = clientSecret;
  if (providerKey === "docfox" && apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (providerKey === "ott" && effective.username && effective.password) {
    headers.authorization = `Basic ${Buffer.from(`${effective.username}:${effective.password}`).toString("base64")}`;
  }
  return headers;
}

function simcloudTokenDetails(apiToken = "") {
  const token = String(apiToken || "").trim();
  return {
    authorizationScheme: "Bearer",
    tokenLength: token.length,
    tokenLast4: token ? token.slice(-4) : ""
  };
}

function hostFromEndpoint(endpoint) {
  const text = String(endpoint || "").trim();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `tcp://${text}`).hostname;
  } catch (_error) {
    return text.split(":")[0];
  }
}

function portFromEndpoint(endpoint, fallback) {
  const text = String(endpoint || "").trim();
  try {
    const parsed = new URL(text.includes("://") ? text : `tcp://${text}`);
    return Number(parsed.port || fallback);
  } catch (_error) {
    const [, port] = text.split(":");
    return Number(port || fallback);
  }
}

function testTcpEndpoint(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "Connection timed out" });
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve({ ok: false, error: error.message });
    });
  });
}

async function testHttpEndpoint(endpoint, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const url = String(endpoint || "").includes("://") ? endpoint : `https://${endpoint}`;
  try {
    let response = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal, headers });
    let responseText = "";
    let method = "HEAD";
    if (response.status === 405) {
      response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal, headers });
      method = "GET";
      responseText = await response.text().catch(() => "");
    }
    return {
      ok: response.status < 400,
      statusCode: response.status,
      error: response.status >= 400 ? `Provider responded with HTTP ${response.status}` : "",
      providerResponse: {
        method,
        statusCode: response.status,
        statusText: response.statusText || "",
        contentType: response.headers.get("content-type") || "",
        body: responseText ? responseText.slice(0, 1000) : ""
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? "Connection timed out" : error.message,
      providerResponse: {
        method: "HEAD",
        statusCode: null,
        statusText: "",
        contentType: "",
        body: error.name === "AbortError" ? "Connection timed out" : error.message
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function postSimcloudSms({ baseUrl, apiToken, recipient, message }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const url = String(baseUrl || "").includes("://") ? baseUrl : `https://${baseUrl}`;
  const body = {
    recipient,
    message
  };
  const headers = {
    Authorization: `Bearer ${String(apiToken || "").trim()}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const responseBody = await response.text().catch(() => "");
    return {
      ok: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      error: response.status >= 400 ? `SIMcloud responded with HTTP ${response.status}` : "",
      providerResponse: {
        method: "POST",
        statusCode: response.status,
        statusText: response.statusText || "",
        contentType: response.headers.get("content-type") || "",
        body: responseBody.slice(0, 2000)
      }
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      error: error.name === "AbortError" ? "SIMcloud connection timed out" : error.message,
      providerResponse: {
        method: "POST",
        statusCode: null,
        statusText: "",
        contentType: "",
        body: error.name === "AbortError" ? "SIMcloud connection timed out" : error.message
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testSimcloudSmsProvider(effective) {
  const apiToken = String(effective.apiKey || "").trim();
  const recipient = String(effective.testNumber || "").trim();
  const message = "TitoPay SIMcloud SMS test.";
  const tokenDetails = simcloudTokenDetails(apiToken);
  const connection = await postSimcloudSms({
    baseUrl: effective.baseUrl,
    apiToken,
    recipient,
    message
  });

  console.info("[integration-test] SIMcloud SMS request", {
    authorizationScheme: tokenDetails.authorizationScheme,
    tokenLength: tokenDetails.tokenLength,
    tokenLast4: tokenDetails.tokenLast4,
    contentType: "application/json",
    recipient,
    responseStatus: connection.statusCode,
    responseBody: connection.providerResponse?.body || ""
  });

  return {
    ...connection,
    authenticationType: "bearer",
    simcloud: {
      authorizationScheme: tokenDetails.authorizationScheme,
      tokenLength: tokenDetails.tokenLength,
      tokenLast4: tokenDetails.tokenLast4,
      contentType: "application/json",
      responseStatus: connection.statusCode,
      responseBody: connection.providerResponse?.body || ""
    }
  };
}

async function testSmtpProvider(effective) {
  const port = Number(effective.smtpPort || effective.port || config.integrations.email.smtpPort || 587);
  const transport = nodemailer.createTransport({
    host: effective.baseUrl,
    port,
    secure: port === 465,
    auth: effective.username || effective.password
      ? { user: effective.username, pass: effective.password }
      : undefined,
    tls: { rejectUnauthorized: config.integrations.email.smtpRejectUnauthorized }
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    transport.close();
  }
}

async function testProviderConnection(providerKey, adminId) {
  const provider = INTEGRATION_PROVIDERS[providerKey];
  const current = await getStoredIntegration(providerKey);
  const stored = current || {
    label: provider.label,
    enabled: true,
    environment: provider.env?.mode || provider.env?.provider || "production",
    secrets: {},
    logs: []
  };
  const effective = effectiveProviderConfig(providerKey, stored);
  const started = Date.now();
  const testedAt = new Date().toISOString();
  let connection = { ok: false, error: "Provider is disabled" };
  // Payout and Flash report their own not_configured state, which distinguishes
  // a missing endpoint or account number from missing credentials.
  const missing = providerKey === "peach_payouts" || providerKey === "flash"
    ? []
    : missingProviderFieldsFromEffective(provider, effective);
  const authenticationType = providerAuthenticationType(providerKey, effective);

  console.info("[integration-test] configuration loaded", {
    provider: providerKey,
    loadedFromDatabase: Boolean(current),
    configured: providerConfigured(provider, stored),
    enabled: effective.enabled,
    environment: effective.environment
  });
  console.info("[integration-test] effective provider configuration", {
    provider: providerKey,
    apiKeyExists: Boolean(effective.apiKey),
    baseUrl: effective.baseUrl || "",
    senderId: providerKey === "sms" ? effective.senderId || "" : undefined,
    authenticationType
  });

  if (effective.enabled) {
    if (missing.length) {
      connection = { ok: false, error: `Missing required configuration: ${missing.join(", ")}` };
    } else if (providerKey === "smtp") {
      const host = hostFromEndpoint(effective.baseUrl);
      connection = host ? await testSmtpProvider({ ...effective, baseUrl: host }) : { ok: false, error: "SMTP host is not configured" };
    } else if (providerKey === "sms") {
      connection = await testSimcloudSmsProvider(effective);
    } else if (providerKey === "peach_payments") {
      // Real Peach Checkout V2 authentication: only an issued access token
      // counts as connected. Never a URL reachability probe.
      connection = await testCheckoutAuthentication(effective);
    } else if (providerKey === "peach_payouts") {
      // Peach Payouts only: the payout endpoint with the payout credentials.
      // It never falls back to Checkout authentication, so Collection being
      // connected can never make Payout look connected.
      connection = await testPayoutConnection(effective);
    } else if (providerKey === "flash") {
      // Flash Partner API v4: a real POST /token followed by a real read of the
      // configured account's product list. Never a URL reachability probe, and
      // never a purchase.
      connection = await testFlashConnection(effective);
    } else if (providerKey === "pos_provider") {
      connection = {
        ok: true,
        providerResponse: {
          receiver: effective.callbackUrl || `${String(config.apiBaseUrl || "").replace(/\/+$/, "")}/v1/webhooks/pos-provider`,
          signature: "HMAC-SHA256",
          replayProtection: true,
          webhookSecretConfigured: true
        }
      };
    } else if (effective.baseUrl) {
      connection = await testHttpEndpoint(effective.baseUrl, providerHeaders(providerKey, effective));
    } else {
      connection = { ok: false, error: "Base URL is not configured" };
    }
  }

  const health = {
    // A provider that classified its own outcome keeps that classification, so
    // "authentication failed" and "account validation failed" survive instead of
    // collapsing into one indistinguishable "failed". Providers that report
    // nothing keep the previous two-state behaviour exactly.
    status: connection.ok
      ? (connection.status || (providerKey === "pos_provider" ? "ready" : "connected"))
      : (connection.status || "failed"),
    environment: effective.environment,
    responseTimeMs: Date.now() - started,
    lastTestedAt: testedAt,
    lastSuccessfulConnectionAt: connection.ok ? testedAt : (stored.health?.lastSuccessfulConnectionAt || null),
    errorMessage: connection.ok ? "" : connection.error,
    providerResponse: connection.providerResponse || null,
    authenticationType
  };
  const logEntry = {
    id: crypto.randomUUID(),
    provider: providerKey,
    status: health.status,
    environment: health.environment,
    responseTimeMs: health.responseTimeMs,
    errorMessage: health.errorMessage,
    providerResponse: health.providerResponse,
    authenticationType,
    simcloud: providerKey === "sms" ? connection.simcloud || null : null,
    createdAt: testedAt
  };
  const nextValue = {
    ...stored,
    label: provider.label,
    configured: providerConfigured(provider, stored),
    health,
    logs: [logEntry, ...(Array.isArray(stored.logs) ? stored.logs : [])].slice(0, 100)
  };
  await writeIntegrationStoredValue(providerKey, nextValue, adminId);
  return {
    ...health,
    provider: providerKey,
    effectiveConfiguration: {
      apiKey: Boolean(effective.apiKey),
      baseUrl: effective.baseUrl || "",
      environment: effective.environment || "production",
      senderId: providerKey === "sms" ? effective.senderId || "" : undefined,
      testNumber: providerKey === "sms" ? Boolean(effective.testNumber) : undefined,
      // Presence only — credential values never leave the server.
      clientId: providerKey === "peach_payments" ? Boolean(effective.clientId) : undefined,
      clientSecret: providerKey === "peach_payments" ? Boolean(effective.clientSecret) : undefined,
      merchantId: providerKey === "peach_payments" ? Boolean(effective.merchantId) : undefined,
      integration: providerKey === "peach_payments" ? "checkout_v2" : undefined,
      // Flash: the account number is an identifier, not a credential, and it is
      // the field an operator most often gets wrong. The resolved base URL is
      // shown because a blank field falls back to the documented endpoint.
      accountNumber: providerKey === "flash" ? effective.accountNumber || "" : undefined,
      resolvedBaseUrl: providerKey === "flash" ? connection.providerResponse?.baseUrl || "" : undefined
    }
  };
}

async function listIntegrationLogs() {
  const configs = await Promise.all(
    Object.keys(INTEGRATION_PROVIDERS).map(async (key) => ({ key, stored: await getStoredIntegration(key) }))
  );
  return configs
    .flatMap(({ key, stored }) => (stored?.logs || []).map((item) => ({
      ...item,
      provider: key,
      label: INTEGRATION_PROVIDERS[key].label
    })))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 250);
}

async function listStoredWebhookEvents() {
  const { rows } = await pool.query("SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [webhookSettingKey()]);
  return Array.isArray(rows[0]?.value?.events) ? rows[0].value.events : [];
}

async function listWebhookEvents() {
  const [storedEvents, peachResult, posResult] = await Promise.all([
    listStoredWebhookEvents(),
    pool.query(
      `SELECT key, value, updated_at
         FROM platform_settings
        WHERE key LIKE 'peach_webhook_%'
        ORDER BY updated_at DESC
        LIMIT 100`
    ),
    pool.query(
      `SELECT event_id, provider, event_type, request_id, created_at
         FROM pos_provider_events
        ORDER BY created_at DESC
        LIMIT 100`
    )
  ]);
  const peachEvents = peachResult.rows.map((row) => ({
    id: `peach:${row.value?.id || row.key}`,
    provider: "peach_payments",
    eventType: row.value?.eventType || "payment_event",
    status: row.value?.status || "received",
    retryCount: 0,
    errorMessage: "",
    requestId: "",
    createdAt: row.value?.receivedAt || row.updated_at,
    processedAt: row.value?.processedAt || null,
    retryable: false
  }));
  const posEvents = posResult.rows.map((row) => ({
    id: `pos:${row.event_id}`,
    provider: "pos_provider",
    eventType: row.event_type || "provider_event",
    status: "processed",
    retryCount: 0,
    errorMessage: "",
    requestId: row.request_id || "",
    createdAt: row.created_at,
    retryable: false
  }));
  return [
    ...storedEvents.map((event) => ({ ...event, retryable: true })),
    ...peachEvents,
    ...posEvents
  ]
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))
    .slice(0, 250);
}

async function saveWebhookEvents(events, adminId) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::JSONB, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [webhookSettingKey(), JSON.stringify({ events: events.slice(0, 250) }), adminId]
  );
}

async function generateQrAsset({ type, label, destinationUrl, createdBy }) {
  const reference = `TPQR-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const payload = {
    type,
    label,
    destinationUrl,
    reference,
    brand: "TitoPay",
    createdAt: new Date().toISOString()
  };
  const qrText = destinationUrl;
  const [pngDataUrl, svg] = await Promise.all([
    QRCode.toDataURL(qrText, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 1024,
      color: { dark: "#061A3D", light: "#FFFFFF" }
    }),
    QRCode.toString(qrText, {
      type: "svg",
      errorCorrectionLevel: "H",
      margin: 2,
      color: { dark: "#061A3D", light: "#FFFFFF" }
    })
  ]);
  await writeAuditLog({
    actorType: "admin",
    actorId: createdBy,
    action: "admin_qr_asset_generated",
    entityType: "qr_asset",
    metadata: { type, label, destinationUrl, reference }
  });
  return { ...payload, pngDataUrl, svg };
}

function requireAdminScope(req, _res, next) {
  if (req.auth?.userType !== "admin") {
    next(new AppError(403, "Admin access required"));
    return;
  }
  next();
}

async function listAdminUsersForSearch() {
  try {
    await ensureAuthenticationPreferenceSchema();
    await ensureWalletNumbersForAllWallets(pool);
    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.account_type,
         u.full_name,
         u.username,
         u.email,
         u.phone,
         u.status,
         u.profile_locked,
         u.preferred_authentication_method,
         u.authentication_method_updated_at,
         COALESCE(u.last_successful_authentication_at, u.last_login_at) AS last_successful_authentication_at,
         COALESCE(u.last_failed_authentication_at, u.last_failed_login_at) AS last_failed_authentication_at,
         CASE
           WHEN u.preferred_authentication_method = 'EMAIL' AND NULLIF(TRIM(u.email), '') IS NOT NULL THEN 'AVAILABLE'
           WHEN u.preferred_authentication_method = 'SMS' AND NULLIF(TRIM(u.phone), '') IS NOT NULL THEN 'AVAILABLE'
           WHEN u.preferred_authentication_method = 'PUSH' THEN 'FALLBACK_REQUIRED'
           ELSE 'UNAVAILABLE'
         END AS authentication_verification_status,
         u.fica_status,
         u.profile_photo_url,
         u.business_logo_url,
         u.created_at,
         w.wallet_number AS wallet_id,
         w.id AS wallet_uuid,
         w.kind AS wallet_type,
         COALESCE(m.business_name, '') AS business_name,
         COALESCE(tx.recent_transactions, 0)::INT AS recent_transactions,
         COALESCE(risk.risk_flags, ARRAY[]::TEXT[]) AS risk_flags,
         COALESCE(dev.linked_devices, 0)::INT AS linked_devices
       FROM users u
       LEFT JOIN LATERAL (
         SELECT id, wallet_number, kind
         FROM wallets
         WHERE user_id = u.id
         ORDER BY created_at ASC
         LIMIT 1
       ) w ON TRUE
       LEFT JOIN merchants m ON m.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS recent_transactions
         FROM transactions
         WHERE user_id = u.id
           AND created_at >= NOW() - INTERVAL '30 days'
       ) tx ON TRUE
       LEFT JOIN LATERAL (
         SELECT ARRAY_REMOVE(ARRAY[
           CASE WHEN u.profile_locked THEN 'profile_locked' END,
           CASE WHEN u.status <> 'active' THEN 'account_' || u.status END,
           CASE WHEN EXISTS (SELECT 1 FROM duplicate_account_flags daf WHERE daf.user_id = u.id AND daf.status = 'open') THEN 'duplicate_account' END,
           CASE WHEN EXISTS (SELECT 1 FROM security_events se WHERE se.user_id = u.id AND se.success = FALSE AND se.created_at >= NOW() - INTERVAL '7 days') THEN 'recent_security_failures' END
         ], NULL) AS risk_flags
       ) risk ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS linked_devices
         FROM trusted_devices
         WHERE user_id = u.id AND revoked_at IS NULL
       ) dev ON TRUE
       ORDER BY u.created_at DESC
       LIMIT 250`
    );
    return rows;
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("admin.users.fullSearch", error);
    const { rows } = await safeQuery(
      pool,
      "admin.users.basicSearch",
      `SELECT
         u.id,
         u.account_type,
         u.full_name,
         u.username,
         u.email,
         u.phone,
         u.status,
         u.profile_locked,
         u.fica_status,
         NULL::TEXT AS profile_photo_url,
         NULL::TEXT AS business_logo_url,
         u.created_at,
         NULL::TEXT AS wallet_id,
         NULL::UUID AS wallet_uuid,
         NULL::TEXT AS wallet_type,
         ''::TEXT AS business_name,
         0::INT AS recent_transactions,
         ARRAY[]::TEXT[] AS risk_flags,
         0::INT AS linked_devices
       FROM users u
       ORDER BY u.created_at DESC
       LIMIT 250`,
      [],
      []
    );
    return rows;
  }
}

router.use(adminRequestLogger);

router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const result = await login({ ...req.body, scope: "admin" }, meta(req));
    const adminId = result.userId || result.user?.id;
    res.json({
      ok: true,
      sessionIdleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
      ...result,
      adminId,
      accountId: adminId
    });
  } catch (error) {
    next(error);
  }
});

router.use(requireAuth);
router.use(requireAdminScope);

router.post("/logout", async (req, res, next) => {
  try {
    await logout(req.body.refreshToken, req.auth);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/logout-all", async (req, res, next) => {
  try {
    await logoutAll(req.auth);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/me", async (req, res, next) => {
  try {
  const role = normalizeAdminRole(req.auth.role);
  const permissions = await getEffectiveAdminRolePermissions(role);
  const fullName = req.auth.fullName || req.auth.full_name || req.auth.username || "TitoPay Admin";
  const position = adminPositionLabel(role);
  res.json({
    ok: true,
    id: req.auth.userId,
    fullName,
    full_name: fullName,
    position,
    email: req.auth.email,
    username: req.auth.username,
    role,
    permissions,
    session: {
      id: req.auth.sessionId,
      idleTimeoutSeconds: config.sessionIdleTimeoutSeconds
    },
    admin: {
      id: req.auth.userId,
      fullName,
      full_name: fullName,
      position,
      email: req.auth.email,
      username: req.auth.username,
      role,
      permissions
    }
  });
  } catch (error) {
    next(error);
  }
});

router.get("/staff", requireAdminPermission("engineering"), async (_req, res, next) => {
  try {
    const { rows } = await safeQuery(
      pool,
      "admin.staff.list",
      `SELECT
         id,
         full_name,
         username,
         email,
         role,
         status,
         last_login_at,
         last_login_ip,
         failed_login_attempts,
         locked_until,
         created_at,
         updated_at
       FROM admin_users
       ORDER BY
         CASE WHEN status = 'active' THEN 0 ELSE 1 END,
         role ASC,
         full_name ASC
       LIMIT 250`,
      [],
      []
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.post("/staff", requireSuperAdmin, async (req, res, next) => {
  try {
    const fullName = boundedText(req.body.fullName || req.body.full_name, "Full name", { min: 2, max: 160 }).trim();
    const username = boundedText(req.body.username, "Username", { min: 3, max: 80 }).trim().replace(/^@/, "").toLowerCase();
    const email = boundedText(req.body.email, "Email", { min: 5, max: 180 }).trim().toLowerCase();
    const role = normalizeAdminRole(req.body.role || "customer_support");
    const status = requireEnum(req.body.status || "active", ["active", "inactive", "suspended"], "Staff status");
    const temporaryPassword = boundedText(req.body.password || req.body.temporaryPassword, "Temporary password", { min: 8, max: 200 });

    if (!/^[a-z0-9._-]+$/.test(username)) {
      throw new AppError(400, "Username may only contain letters, numbers, dots, underscores and hyphens");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError(400, "Enter a valid staff email address");
    }
    if (!ADMIN_ROLE_PERMISSIONS[role]) {
      throw new AppError(400, "Invalid staff role");
    }

    const passwordHash = await hashPassword(temporaryPassword);
    const staffId = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, full_name, username, email, role, status, created_at`,
      [staffId, fullName, username, email, role, passwordHash, status]
    );

    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "admin_staff_created",
      entityType: "admin_user",
      entityId: staffId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { email, username, role, status }
    });

    res.status(201).json({ ok: true, item: rows[0] });
  } catch (error) {
    if (error?.code === "23505") {
      next(new AppError(409, "A staff account already exists with that username or email"));
      return;
    }
    next(error);
  }
});

router.get("/chat-monitor/overview", requireSuperAdmin, async (_req, res, next) => {
  try {
    const presence = getChatPresenceSnapshot();
    const onlineIds = presence.users.map((item) => item.userId);
    const [
      conversationStats,
      conversations,
      onlineUsers,
      deliveryFailures,
      socketFailures,
      queueStatus
    ] = await Promise.all([
      safeQuery(
        pool,
        "admin.chatMonitor.conversationStats",
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active')::INT AS active,
           COUNT(*) FILTER (WHERE status = 'active' AND updated_at >= NOW() - INTERVAL '15 minutes')::INT AS active_recently,
           COUNT(*) FILTER (WHERE status = 'blocked')::INT AS blocked,
           COUNT(*)::INT AS total
         FROM chat_threads`,
        [],
        [{ active: 0, active_recently: 0, blocked: 0, total: 0 }]
      ),
      safeQuery(
        pool,
        "admin.chatMonitor.conversations",
        `SELECT
           t.id,
           t.thread_type,
           t.status,
           t.created_at,
           t.updated_at,
           jsonb_build_object(
             'id', ua.id,
             'name', ua.full_name,
             'username', ua.username,
             'accountType', ua.account_type,
             'verified', ua.status = 'active' AND LOWER(ua.fica_status) IN ('approved', 'verified')
           ) AS participant_a,
           jsonb_build_object(
             'id', ub.id,
             'name', ub.full_name,
             'username', ub.username,
             'accountType', ub.account_type,
             'verified', ub.status = 'active' AND LOWER(ub.fica_status) IN ('approved', 'verified')
           ) AS participant_b,
           COALESCE(ms.message_count, 0)::INT AS message_count,
           COALESCE(ms.pending_delivery_count, 0)::INT AS pending_delivery_count,
           COALESCE(ms.failed_count, 0)::INT AS failed_count,
           lm.status AS last_message_status,
           lm.created_at AS last_message_at
         FROM chat_threads t
         JOIN users ua ON ua.id = t.participant_a
         JOIN users ub ON ub.id = t.participant_b
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) AS message_count,
             COUNT(*) FILTER (WHERE status = 'sent') AS pending_delivery_count,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
           FROM chat_messages
           WHERE thread_id = t.id
         ) ms ON TRUE
         LEFT JOIN LATERAL (
           SELECT status, created_at
           FROM chat_messages
           WHERE thread_id = t.id
           ORDER BY created_at DESC
           LIMIT 1
         ) lm ON TRUE
         WHERE t.status = 'active'
         ORDER BY COALESCE(lm.created_at, t.updated_at) DESC
         LIMIT 100`,
        [],
        []
      ),
      safeQuery(
        pool,
        "admin.chatMonitor.onlineUsers",
        `SELECT id, full_name, username, account_type, fica_status, status
         FROM users
         WHERE id = ANY($1::UUID[])`,
        [onlineIds],
        []
      ),
      safeQuery(
        pool,
        "admin.chatMonitor.deliveryFailures",
        `SELECT
           m.id,
           m.thread_id,
           m.status,
           m.created_at,
           EXTRACT(EPOCH FROM (NOW() - m.created_at))::INT AS age_seconds,
           su.full_name AS sender_name,
           su.username AS sender_username,
           ru.full_name AS recipient_name,
           ru.username AS recipient_username,
           CASE
             WHEN m.status = 'failed' THEN 'failed'
             ELSE 'delivery_timeout'
           END AS failure_type
         FROM chat_messages m
         JOIN users su ON su.id = m.sender_user_id
         JOIN users ru ON ru.id = m.recipient_user_id
         WHERE m.status = 'failed'
            OR (m.status = 'sent' AND m.created_at < NOW() - INTERVAL '60 seconds')
         ORDER BY m.created_at DESC
         LIMIT 100`,
        [],
        []
      ),
      safeQuery(
        pool,
        "admin.chatMonitor.socketFailures",
        `SELECT
           id,
           event_type,
           COALESCE(metadata->>'reason', 'request_processing_failed') AS reason,
           ip_address,
           LEFT(COALESCE(user_agent, ''), 180) AS user_agent,
           created_at,
           COUNT(*) OVER ()::INT AS total_in_window
         FROM security_logs
         WHERE event_type IN (
           'titopay_chat_socket_connection_failed',
           'titopay_chat_socket_error'
         )
           AND created_at >= NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC
         LIMIT 100`,
        [],
        []
      ),
      safeQuery(
        pool,
        "admin.chatMonitor.queueStatus",
        `SELECT
           status,
           COUNT(*)::INT AS count,
           MIN(created_at) AS oldest_created_at,
           MAX(updated_at) AS latest_updated_at
         FROM notifications
         WHERE notification_type = 'titopay_chat'
         GROUP BY status
         ORDER BY status`,
        [],
        []
      )
    ]);

    const userById = new Map(onlineUsers.rows.map((user) => [String(user.id), user]));
    const presenceUsers = presence.users.map((item) => {
      const user = userById.get(String(item.userId)) || {};
      return {
        userId: item.userId,
        name: user.full_name || user.username || "TitoPay user",
        username: user.username || "",
        accountType: user.account_type || "",
        verificationStatus: user.fica_status || "",
        connections: item.connections,
        connectedAt: item.connectedAt
      };
    });
    const staleDeliveries = deliveryFailures.rows.filter((item) => item.failure_type === "delivery_timeout").length;
    const failedDeliveries = deliveryFailures.rows.filter((item) => item.failure_type === "failed").length;
    const socketFailureCount = socketFailures.rows[0]?.total_in_window || 0;
    const queuedNotifications = queueStatus.rows
      .filter((item) => ["queued", "sent"].includes(item.status))
      .reduce((total, item) => total + item.count, 0);

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      metrics: {
        activeConversations: conversationStats.rows[0]?.active || 0,
        activeRecently: conversationStats.rows[0]?.active_recently || 0,
        onlineUsers: presence.userCount,
        activeConnections: presence.connectionCount,
        deliveryFailures: failedDeliveries,
        staleDeliveries,
        socketFailures24h: socketFailureCount,
        queuedNotifications
      },
      conversations: conversations.rows,
      onlineUsers: presenceUsers,
      deliveryFailures: deliveryFailures.rows,
      socketFailures: socketFailures.rows.map(({ total_in_window, ...item }) => item),
      queueStatus: queueStatus.rows
    });
  } catch (error) {
    next(error);
  }
});

// WHAT THE DATABASE HEALTH PAGE ASKS.
//
// This used to test a hardcoded list of fifteen tables, written when the
// platform was much smaller, against a schema now well past a hundred and
// fifty. It could report everything green while the tables behind a broken
// console page were missing — which is exactly how a failing Compliance
// Dashboard came to be read as a deployment problem.
//
// It now asks the same question the diagnosis asks, from the same map, so the
// two can never disagree.
router.get("/module-health", requireSuperAdmin, async (_req, res, next) => {
  try {
    const { PAGE_TABLES } = require("../services/console-diagnosis-service");
    const required = [...new Set(Object.values(PAGE_TABLES).flat())].sort();
    const { rows } = await pool.query(
      `SELECT table_name, to_regclass('public.' || table_name) IS NOT NULL AS "exists"
       FROM unnest($1::TEXT[]) AS required(table_name)
       ORDER BY table_name`,
      [required]
    );
    // Which console page each table stands behind, so a missing row says what
    // it will break rather than only that it is absent.
    const pagesFor = {};
    for (const [page, tables] of Object.entries(PAGE_TABLES)) {
      for (const table of tables) (pagesFor[table] ||= []).push(page);
    }
    res.json({
      ok: true,
      apiBase: "/v1",
      build: API_BUILD,
      tables: rows.map((row) => ({ ...row, pages: pagesFor[row.table_name] || [] }))
    });
  } catch (error) { next(error); }
});

// THE DIAGNOSIS, REACHABLE WITHOUT A SHELL.
//
// Same answer as `npm run db:diagnose`, from the same service, because the one
// tool that names the real cause should not be the one tool that needs SSH.
// Super admin only: it returns real table names and real Postgres errors, and
// that detail must never reach anyone else.
router.get("/diagnostics/console", requireSuperAdmin, async (req, res, next) => {
  try {
    const { runConsoleDiagnosis } = require("../services/console-diagnosis-service");
    res.json({ ok: true, diagnosis: await runConsoleDiagnosis({ actorId: req.auth?.userId || null }) });
  } catch (error) { next(error); }
});

router.get("/maintenance", requireSuperAdmin, async (_req, res, next) => {
  try {
    const setting = await getPlatformSetting("maintenance_mode", {
      pwa: { enabled: false, note: "", expectedBackAt: "" },
      admin: { enabled: false, note: "", expectedBackAt: "" },
      hr: { enabled: false, note: "", expectedBackAt: "" }
    });
    res.json({ ok: true, maintenance: setting.value, updatedAt: setting.updatedAt });
  } catch (error) {
    next(error);
  }
});

router.put("/maintenance", requireSuperAdmin, async (req, res, next) => {
  try {
    const normalizeTarget = (key) => ({
      enabled: Boolean(req.body?.[key]?.enabled),
      note: boundedText(req.body?.[key]?.note || "", `${key} maintenance note`, { min: 0, max: 280 }),
      expectedBackAt: String(req.body?.[key]?.expectedBackAt || "").trim().slice(0, 80)
    });
    const value = {
      pwa: normalizeTarget("pwa"),
      admin: normalizeTarget("admin"),
      hr: normalizeTarget("hr")
    };
    const saved = await setPlatformSetting("maintenance_mode", value, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "maintenance_mode_updated",
      entityType: "platform_settings",
      entityId: null,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { pwa: value.pwa.enabled, admin: value.admin.enabled, hr: value.hr.enabled }
    });
    res.json({ ok: true, maintenance: saved.value, updatedAt: saved.updatedAt });
  } catch (error) {
    next(error);
  }
});

async function readDashboardMetric(scope, sql, fallbackRow) {
  try {
    const result = await pool.query(sql);
    return {
      row: result.rows[0] || fallbackRow,
      available: true
    };
  } catch (error) {
    console.error("[admin-dashboard-metric]", {
      scope,
      code: error?.code,
      message: error?.message
    });
    return {
      row: fallbackRow,
      available: false
    };
  }
}

router.get("/dashboard/overview", requireAdminPermission("dashboard"), async (_req, res, next) => {
  try {
    const [users, merchants, transactions, revenue, locked, compliance] = await Promise.all([
      readDashboardMetric("users", "SELECT COUNT(*)::INT AS count FROM users", { count: 0 }),
      readDashboardMetric("merchants", "SELECT COUNT(*)::INT AS count FROM merchants", { count: 0 }),
      readDashboardMetric("transactions", "SELECT COUNT(*)::INT AS count FROM transactions", { count: 0 }),
      readDashboardMetric("revenue", "SELECT COALESCE(SUM(fee_collected), 0)::NUMERIC AS total FROM revenue_ledger", { total: 0 }),
      readDashboardMetric("lockedProfiles", "SELECT COUNT(*)::INT AS count FROM users WHERE profile_locked = TRUE", { count: 0 }),
      readDashboardMetric("compliance", "SELECT COUNT(*)::INT AS count FROM kyc_reviews WHERE status = 'pending'", { count: 0 })
    ]);
    const metrics = { users, merchants, transactions, revenue, lockedProfiles: locked, compliance };
    const unavailableMetrics = Object.entries(metrics)
      .filter(([, metric]) => !metric.available)
      .map(([name]) => name);

    res.json({
      ok: true,
      degraded: unavailableMetrics.length > 0,
      unavailableMetrics,
      users: Number(users.row?.count || 0),
      merchants: Number(merchants.row?.count || 0),
      transactions: Number(transactions.row?.count || 0),
      revenue: Number(revenue.row?.total || 0),
      lockedProfiles: Number(locked.row?.count || 0),
      pendingCompliance: Number(compliance.row?.count || 0)
    });
  } catch (error) {
    next(error);
  }
});

router.get("/users", requireAdminPermission("users"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listAdminUsersForSearch() });
  } catch (error) {
    next(error);
  }
});

router.get("/global-search", requireSuperAdmin, async (_req, res, next) => {
  try {
    const [users, merchants, wallets, transactions] = await Promise.all([
      listAdminUsersForSearch(),
      listMerchants(),
      listAllWallets(),
      listAllTransactions()
    ]);
    res.json({
      ok: true,
      users,
      merchants,
      wallets,
      transactions,
      routes: {
        users: "/v1/admin/users",
        merchants: "/v1/admin/merchants",
        wallets: "/v1/admin/wallets",
        transactions: "/v1/admin/transactions"
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/users/:id/:action", requireAdminPermission("profile_lock"), async (req, res, next) => {
  try {
    const userId = requireUuid(req.params.id, "User ID");
    const actions = {
      suspend: { sql: "status = 'suspended'", audit: "user_suspended" },
      activate: { sql: "status = 'active'", audit: "user_activated" },
      lock: { sql: "profile_locked = TRUE", audit: "profile_locked" },
      unlock: { sql: "profile_locked = FALSE", audit: "profile_unlocked" }
    };
    const selected = actions[req.params.action];
    if (!selected) return res.status(400).json({ ok: false, error: "Unsupported user action" });
    const { rows } = await pool.query(
      `UPDATE users
          SET ${selected.sql}, updated_at = NOW()
        WHERE id = $1
        RETURNING id, status, profile_locked`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "User not found" });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: selected.audit,
      entityType: "user",
      entityId: userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { status: rows[0].status, profileLocked: rows[0].profile_locked }
    });
    res.json({
      ok: true,
      user: {
        id: rows[0].id,
        status: rows[0].status,
        profileLocked: rows[0].profile_locked,
        profile_locked: rows[0].profile_locked
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/merchants", requireAdminPermission("merchants"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listMerchants() });
  } catch (error) {
    next(error);
  }
});

router.get("/transactions", requireAdminPermission("transactions"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listAllTransactions(req.query || {}) });
  } catch (error) {
    next(error);
  }
});

router.get("/wallets", requireAdminPermission("wallets"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listAllWallets() });
  } catch (error) {
    next(error);
  }
});

router.post("/wallets/:id/:action", requireSuperAdmin, async (req, res, next) => {
  try {
    const walletId = requireUuid(req.params.id, "Wallet ID");
    const action = requireEnum(req.params.action, ["freeze", "suspend", "close", "activate"], "Wallet action");
    const nextStatus = {
      freeze: "frozen",
      suspend: "suspended",
      close: "closed",
      activate: "active"
    }[action];
    const { rows } = await pool.query(
      `UPDATE wallets
       SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [walletId, nextStatus]
    );
    if (!rows[0]) throw new AppError(404, "Wallet not found");
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: `wallet_${action}`,
      entityType: "wallet",
      entityId: walletId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { status: nextStatus }
    });
    res.json({ ok: true, wallet: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/support/tickets", requireAdminPermission("support"), async (_req, res, next) => {
  try {
    const rows = await listSupportTicketsForAdmin();
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.post("/support/tickets/:id/reply", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const ticketId = requireUuid(req.params.id, "Ticket ID");
    const result = await addSupportTicketAdminReply(req.auth, ticketId, req.body || {});
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_ticket_reply_sent",
      entityType: "support_ticket",
      entityId: ticketId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { replyId: result.reply.id }
    });
    res.status(201).json({ ok: true, item: result.ticket, reply: result.reply });
  } catch (error) {
    next(error);
  }
});

router.post("/support/tickets/:id/status", requireAdminPermission("support"), async (req, res, next) => {
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const ticketId = requireUuid(req.params.id, "Ticket ID");
    const status = requireEnum(req.body.status, ["open", "in_progress", "pending", "resolved", "escalated", "closed"], "Ticket status");
    const assignedTo = status === "in_progress"
      ? (req.auth.email || req.auth.username || "Customer Care")
      : null;
    const { rows } = await client.query(
      `UPDATE support_tickets
       SET status = $2,
           assigned_to = CASE WHEN $3::TEXT IS NULL THEN assigned_to ELSE $3 END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [ticketId, status, assignedTo]
    );
    if (!rows[0]) throw new AppError(404, "Ticket not found");
    if (["resolved", "closed"].includes(status) && rows[0].user_id) {
      await createUserInAppNotification({
        userId: rows[0].user_id,
        type: "support_resolved",
        title: status === "resolved" ? "Customer Care request resolved" : "Customer Care request closed",
        body: `Reference ${rows[0].ticket_ref || ticketId} has been ${status}. You can rate the service in TitoPay Assistant.`,
        metadata: {
          ticketId,
          ticketRef: rows[0].ticket_ref,
          supportStatus: status,
          clientNotificationId: `support-${status}-${rows[0].ticket_ref || ticketId}`
        },
        db: client
      });
    }
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_ticket_status_updated",
      entityType: "support_ticket",
      entityId: ticketId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { status, assignedTo },
      db: client
    });
    await client.query("COMMIT");
    if(rows[0].user_id){try{const {rows:accounts}=await pool.query("SELECT email,full_name FROM users WHERE id=$1",[rows[0].user_id]);if(accounts[0]?.email&&await shouldSendCustomerEmail(rows[0].user_id,"support"))await queueEmail({recipient:accounts[0].email,templateKey:["resolved","closed"].includes(status)?"support_ticket_resolved":"support_ticket_updated",userId:rows[0].user_id,variables:{fullName:accounts[0].full_name,email:accounts[0].email,ticketReference:rows[0].ticket_ref||ticketId},idempotencyKey:`support-ticket-${status}:${ticketId}`,metadata:{ticketId,status}});}catch(error){console.error("[support] status email queue failed",{ticketId,status,message:error.message});}}
    res.json({ ok: true, item: rows[0] });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => null);
    next(error);
  } finally {
    client?.release();
  }
});

router.get("/support/conversations", requireAdminPermission("support"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.client_thread_id,
         t.thread_type,
         t.status,
         t.created_by,
         t.metadata,
         t.created_at,
         t.updated_at,
         jsonb_build_object(
           'id', ua.id,
           'full_name', ua.full_name,
           'username', ua.username,
           'email', ua.email,
           'phone', ua.phone,
           'account_type', ua.account_type
         ) AS participant_a,
         jsonb_build_object(
           'id', ub.id,
           'full_name', ub.full_name,
           'username', ub.username,
           'email', ub.email,
           'phone', ub.phone,
           'account_type', ub.account_type
         ) AS participant_b,
         lm.body AS last_message,
         lm.status AS last_message_status,
         lm.sender_user_id AS last_message_sender_id,
         lm.created_at AS last_message_at
       FROM chat_threads t
       JOIN users ua ON ua.id = t.participant_a
       JOIN users ub ON ub.id = t.participant_b
       LEFT JOIN LATERAL (
         SELECT sender_user_id, body, status, created_at
         FROM chat_messages
         WHERE thread_id = t.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lm ON TRUE
       ORDER BY t.updated_at DESC
       LIMIT 250`
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/support/conversations/:id/messages", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const conversationId = requireUuid(req.params.id, "Conversation ID");
    const { rows } = await pool.query(
      `SELECT
         m.id,
         m.thread_id,
         m.sender_user_id,
         m.recipient_user_id,
         m.body,
         m.message_type,
         m.status,
         m.created_at,
         su.full_name AS sender_name,
         su.username AS sender_username,
         ru.full_name AS recipient_name,
         ru.username AS recipient_username
       FROM chat_messages m
       JOIN users su ON su.id = m.sender_user_id
       JOIN users ru ON ru.id = m.recipient_user_id
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC
       LIMIT 300`,
      [conversationId]
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/support/conversations/:id/context", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const conversationId = requireUuid(req.params.id, "Conversation ID");
    const [messages, calls, thread] = await Promise.all([
      pool.query(
        `SELECT
           m.id,
           m.thread_id,
           m.sender_user_id,
           m.recipient_user_id,
           m.body,
           m.message_type,
           m.status,
           m.created_at,
           su.full_name AS sender_name,
           su.username AS sender_username,
           ru.full_name AS recipient_name,
           ru.username AS recipient_username
         FROM chat_messages m
         JOIN users su ON su.id = m.sender_user_id
         JOIN users ru ON ru.id = m.recipient_user_id
         WHERE m.thread_id = $1
         ORDER BY m.created_at ASC
         LIMIT 300`,
        [conversationId]
      ),
      pool.query(
        `SELECT id, call_type, status, started_at, ended_at, duration_seconds, metadata
         FROM chat_call_logs
         WHERE thread_id = $1
         ORDER BY started_at DESC
         LIMIT 100`,
        [conversationId]
      ),
      pool.query("SELECT id, metadata FROM chat_threads WHERE id = $1 LIMIT 1", [conversationId])
    ]);
    if (!thread.rows[0]) throw new AppError(404, "Conversation not found");
    res.json({
      ok: true,
      messages: messages.rows,
      calls: calls.rows,
      internalNotes: Array.isArray(thread.rows[0].metadata?.internal_notes) ? thread.rows[0].metadata.internal_notes : []
    });
  } catch (error) {
    next(error);
  }
});

router.post("/support/conversations/:id/notes", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const conversationId = requireUuid(req.params.id, "Conversation ID");
    const note = boundedText(req.body?.note, "Internal note", { min: 2, max: 1000 });
    const entry = {
      id: crypto.randomUUID(),
      note,
      createdAt: new Date().toISOString(),
      createdBy: req.auth.userId,
      createdByLabel: req.auth.email || req.auth.username || "Admin"
    };
    const { rows } = await pool.query(
      `UPDATE chat_threads
       SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::JSONB),
             '{internal_notes}',
             COALESCE(metadata->'internal_notes', '[]'::JSONB) || $2::JSONB,
             TRUE
           ),
           updated_at = NOW()
       WHERE id = $1
       RETURNING metadata`,
      [conversationId, JSON.stringify([entry])]
    );
    if (!rows[0]) throw new AppError(404, "Conversation not found");
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_internal_note_added",
      entityType: "chat_thread",
      entityId: conversationId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { noteId: entry.id }
    });
    res.json({ ok: true, note: entry });
  } catch (error) {
    next(error);
  }
});

router.post("/support/conversations/:id/assign", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const conversationId = requireUuid(req.params.id, "Conversation ID");
    const assignedTo = req.auth.email || req.auth.username || "Customer Care";
    const { rows } = await pool.query(
      `UPDATE chat_threads
       SET metadata = COALESCE(metadata, '{}'::JSONB)
           || jsonb_build_object(
                'assigned_to', $2::TEXT,
                'assigned_admin_id', $3::TEXT,
                'assigned_at', NOW()
              ),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [conversationId, assignedTo, req.auth.userId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Conversation not found" });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_chat_assigned",
      entityType: "chat_thread",
      entityId: conversationId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { assignedTo }
    });
    res.json({ ok: true, item: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post("/support/conversations/:id/close", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const conversationId = requireUuid(req.params.id, "Conversation ID");
    const { rows } = await pool.query(
      `UPDATE chat_threads
       SET status = 'archived',
           metadata = COALESCE(metadata, '{}'::JSONB)
             || jsonb_build_object(
                  'closed_by', $2::TEXT,
                  'closed_at', NOW()
                ),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [conversationId, req.auth.userId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Conversation not found" });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_chat_closed",
      entityType: "chat_thread",
      entityId: conversationId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent
    });
    res.json({ ok: true, item: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/profile-change-requests", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const items = await listProfileChangeRequests(req.query.status);
    const pending = items.filter((item) => ["pending", "in_review"].includes(item.status));
    const overdue = pending.filter((item) => item.dueAt && new Date(item.dueAt).getTime() < Date.now()).length;
    res.json({
      ok: true,
      items,
      metrics: {
        total: items.length,
        pending: pending.length,
        overdue,
        slaHours: 72
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post("/profile-change-requests/:id/approve", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const requestId = requireUuid(req.params.id, "Profile change request ID");
    const request = await approveProfileChangeRequest(requestId, req.auth.userId, {
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      notes: req.body?.notes
    });
    res.json({ ok: true, request });
  } catch (error) {
    next(error);
  }
});

router.post("/profile-change-requests/:id/reject", requireAdminPermission("support"), async (req, res, next) => {
  try {
    const requestId = requireUuid(req.params.id, "Profile change request ID");
    const request = await rejectProfileChangeRequest(
      requestId,
      req.auth.userId,
      boundedText(req.body?.notes || "Rejected by Support", "Support note", { min: 2, max: 500 }),
      {
        ipAddress: req.auth.ipAddress,
        userAgent: req.auth.userAgent
      }
    );
    res.json({ ok: true, request });
  } catch (error) {
    next(error);
  }
});

router.get("/compliance/queue", requireAdminPermission("compliance"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT cr.*, u.full_name, u.username, u.account_type
       FROM kyc_reviews cr
       JOIN users u ON u.id = cr.user_id
       ORDER BY cr.created_at DESC
       LIMIT 250`
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.post("/compliance/reviews/:id/status", requireAdminPermission("compliance"), async (req, res, next) => {
  try {
    const reviewId = requireUuid(req.params.id, "Review ID");
    const status = requireEnum(req.body.status, ["pending", "submitted", "pending_review", "approved", "rejected"], "Review status");
    const { rows } = await pool.query(
      `UPDATE kyc_reviews
       SET status = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [reviewId, status, req.auth.userId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Review not found" });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "compliance_review_status_updated",
      entityType: "compliance_review",
      entityId: reviewId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { status }
    });
    res.json({ ok: true, item: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get("/revenue", requireAdminPermission("revenue"), async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await revenueSummary()) });
  } catch (error) {
    next(error);
  }
});

router.get("/security", requireAdminPermission("security"), async (_req, res, next) => {
  try {
    const adminAuthPolicy = await getAdminAuthenticationPolicy();
    const [loginAttempts, otpLogs, adminSessions, profileLockEvents, securityLogs] = await Promise.all([
      pool.query("SELECT actor_type, action, created_at FROM audit_logs WHERE action IN ('login_failed','account_lockout','login_success') ORDER BY created_at DESC LIMIT 50"),
      pool.query("SELECT user_type, purpose, expires_at, attempts AS attempt_count, created_at FROM otp_codes ORDER BY created_at DESC LIMIT 50"),
      pool.query(
        `SELECT s.*, au.full_name, au.email
         FROM sessions s
         LEFT JOIN admin_users au ON au.id = s.user_id
         WHERE s.user_type = 'admin'
         ORDER BY s.created_at DESC
         LIMIT 50`
      ),
      pool.query("SELECT actor_type, action, created_at FROM audit_logs WHERE action IN ('profile_locked','profile_unlocked') ORDER BY created_at DESC LIMIT 50"),
      pool.query("SELECT actor_type, actor_id, event_type, severity, ip_address, success, created_at FROM security_logs ORDER BY created_at DESC LIMIT 50")
    ]);
    res.json({
      ok: true,
      loginAttempts: loginAttempts.rows,
      otpLogs: otpLogs.rows,
      adminSessions: adminSessions.rows,
      profileLockEvents: profileLockEvents.rows,
      securityLogs: securityLogs.rows,
      otpPolicy: {
        authenticationMode: adminAuthPolicy.mode,
        otpRequired: adminAuthPolicy.otpRequired,
        superAdminRequired: adminAuthPolicy.otpRequired,
        staffRequired: adminAuthPolicy.otpRequired,
        financeRequired: adminAuthPolicy.otpRequired,
        complianceRequired: adminAuthPolicy.otpRequired,
        customerSupportRequired: adminAuthPolicy.otpRequired,
        source: adminAuthPolicy.source,
        note: adminAuthPolicy.otpRequired
          ? "Password + Email OTP is enabled. Admin sign-ins require email verification before dashboard access."
          : "Password Only is enabled. Admin sign-ins do not depend on SMTP or OTP delivery."
      },
      smtp: getEmailProviderStatus(),
      emailTemplates: [
        { key: "otp", name: "OTP Email Template", subject: "Your TitoPay verification code", status: "ready" },
        { key: "password_reset", name: "Password Reset Template", subject: "Your TitoPay password reset code", status: "ready" },
        { key: "security_alert", name: "Security Alert Template", subject: "TitoPay security alert", status: "ready" }
      ]
    });
  } catch (error) {
    next(error);
  }
});

router.put("/security/authentication-mode", requireAdminPermission("security"), async (req, res, next) => {
  try {
    requirePlatformOwnerAccess(req, "Only platform owner roles can change admin authentication mode");
    const mode = requireEnum(req.body?.mode, ["password_only", "password_email_otp"], "Authentication mode");
    const policy = await setAdminAuthenticationPolicy({
      mode,
      updatedBy: req.auth.userId
    });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "admin_authentication_mode_updated",
      entityType: "platform_settings",
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { mode: policy.mode, otpRequired: policy.otpRequired }
    });
    res.json({ ok: true, otpPolicy: policy });
  } catch (error) {
    next(error);
  }
});

// The security wording customers read. The GET always returns a complete,
// non-empty object, so the console edits real copy rather than empty boxes on a
// platform that has never saved this setting. fallbackOnError is off here on
// purpose: the console must never present the defaults as if they were the
// saved copy, because the next Save would make that true.
router.get("/security-content", requireAdminPermission("security"), async (_req, res, next) => {
  try {
    // stored/updatedAt/updatedBy travel with the wording so the page can say
    // whether it is showing someone's saved copy or the wording TitoPay ships
    // with. Those look identical on screen otherwise.
    const record = await getSecurityContentRecord();
    res.json({ ok: true, ...record });
  } catch (error) {
    next(error);
  }
});

router.put("/security-content", requireAdminPermission("security"), async (req, res, next) => {
  try {
    const content = await saveSecurityContent(req.body?.content ?? req.body, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "security_content_updated",
      entityType: "platform_settings",
      // entity_id is a UUID column, and a platform setting is keyed by name.
      // Passing the key here made Postgres reject the insert, so every save
      // stored the copy and THEN answered 500, leaving an admin looking at an
      // error beside content that had in fact changed, with nothing in the log.
      // The key belongs in the metadata, the way the other settings routes do.
      entityId: null,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      // The copy itself goes in the log, not just the fact that it changed.
      // When a customer reports being told something odd by "the app", the
      // question is what the app said on that day and who wrote it.
      metadata: {
        settingKey: SECURITY_CONTENT_KEY,
        title: content.title,
        cardHeading: content.cardHeading,
        cardBody: content.cardBody,
        tipCount: content.tips.length
      }
    });
    res.json({ ok: true, content });
  } catch (error) {
    next(error);
  }
});

router.post("/security/smtp/test", requireAdminPermission("security"), async (req, res, next) => {
  try {
    const to = req.body?.to || req.auth.email;
    if (!to) throw new AppError(400, "No test email recipient available");
    const result = await sendSmtpTestEmail({ to });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "smtp_test_email_sent",
      entityType: "admin_security",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { to, providerResponse: result }
    });
    res.json({ ok: true, to, result });
  } catch (error) {
    next(error);
  }
});

router.get("/integrations/config", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, providers: await listIntegrationConfigs() });
  } catch (error) {
    next(error);
  }
});

router.get("/integrations/config/:provider", requireSuperAdmin, async (req, res, next) => {
  try {
    const providerKey = requireEnum(req.params.provider, Object.keys(INTEGRATION_PROVIDERS), "Integration provider");
    res.json({ ok: true, provider: publicIntegrationState(providerKey, await getStoredIntegration(providerKey)) });
  } catch (error) {
    next(error);
  }
});

router.get("/integrations/health", requireSuperAdmin, async (_req, res, next) => {
  try {
    const providers = await listIntegrationConfigs();
    res.json({
      ok: true,
      health: providers.map((provider) => ({
        key: provider.key,
        label: provider.label,
        enabled: provider.enabled,
        environment: provider.environment,
        configured: provider.configured,
        ...provider.health
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/integrations/logs", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, logs: await listIntegrationLogs() });
  } catch (error) {
    next(error);
  }
});

router.get("/integrations/webhooks", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, webhooks: await listWebhookEvents() });
  } catch (error) {
    next(error);
  }
});

router.post("/integrations/webhooks/:id/retry", requireSuperAdmin, async (req, res, next) => {
  try {
    const webhookId = boundedText(req.params.id, "Webhook ID", { min: 2, max: 120 });
    const events = await listStoredWebhookEvents();
    const index = events.findIndex((event) => String(event.id) === webhookId);
    if (index === -1) throw new AppError(404, "Webhook event not found");
    events[index] = {
      ...events[index],
      status: "retry_queued",
      retryCount: Number(events[index].retryCount || 0) + 1,
      lastRetryQueuedAt: new Date().toISOString()
    };
    await saveWebhookEvents(events, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "integration_webhook_retry_queued",
      entityType: "platform_settings",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { webhookId, provider: events[index].provider, retryCount: events[index].retryCount }
    });
    res.json({ ok: true, webhook: events[index] });
  } catch (error) {
    next(error);
  }
});

router.get("/provider-routing", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await getProviderRouting()) });
  } catch (error) {
    next(error);
  }
});

router.put("/provider-routing", requireSuperAdmin, async (req, res, next) => {
  try {
    const routing = await saveProviderRouting(req.body || {}, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "provider_routing_updated",
      entityType: "platform_settings",
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { mapping: Object.fromEntries(routing.services.map((service) => [service.key, service.provider])) }
    });
    res.json({ ok: true, ...routing });
  } catch (error) {
    next(error);
  }
});

router.get("/features", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await getFeatureFlags()) });
  } catch (error) {
    next(error);
  }
});

router.put("/features", requireSuperAdmin, async (req, res, next) => {
  try {
    const flags = await saveFeatureFlags(req.body || {}, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "feature_flags_updated",
      entityType: "platform_settings",
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { flags: Object.fromEntries(flags.flags.map((flag) => [flag.key, flag.enabled])) }
    });
    res.json({ ok: true, ...flags });
  } catch (error) {
    next(error);
  }
});

router.get("/company-documents", requireAuth, async (req, res, next) => {
  try {
    requireCompanyDocumentsAccess(req);
    const result = await getCompanyDocuments();
    res.json({ ok: true, categories: COMPANY_DOCUMENT_CATEGORIES, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/company-documents", requireAuth, async (req, res, next) => {
  try {
    requireCompanyDocumentsAccess(req);
    const document = await createCompanyDocument(req.body, req.auth);
    res.status(201).json({ ok: true, document });
  } catch (error) {
    next(error);
  }
});

router.put("/company-documents/:id", requireAuth, async (req, res, next) => {
  try {
    requireCompanyDocumentsAccess(req);
    const document = await updateCompanyDocument(requireUuid(req.params.id, "Document ID"), req.body, req.auth);
    res.json({ ok: true, document });
  } catch (error) {
    next(error);
  }
});

router.post("/company-documents/:id/archive", requireAuth, async (req, res, next) => {
  try {
    requireCompanyDocumentsAccess(req);
    const document = await updateCompanyDocument(requireUuid(req.params.id, "Document ID"), { ...req.body, status: "archived" }, req.auth);
    res.json({ ok: true, document });
  } catch (error) {
    next(error);
  }
});

router.post("/company-documents/:id/acknowledge", requireAuth, async (req, res, next) => {
  try {
    requireCompanyDocumentsAccess(req);
    const document = await acknowledgeCompanyDocument(requireUuid(req.params.id, "Document ID"), req.auth);
    res.json({ ok: true, document });
  } catch (error) {
    next(error);
  }
});

router.put("/integrations/:provider", requireSuperAdmin, async (req, res, next) => {
  try {
    const providerKey = requireEnum(req.params.provider, Object.keys(INTEGRATION_PROVIDERS), "Integration provider");
    const provider = await saveIntegrationConfig({
      providerKey,
      body: req.body || {},
      adminId: req.auth.userId
    });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "integration_settings_updated",
      entityType: "platform_settings",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: {
        provider: providerKey,
        enabled: provider.enabled,
        environment: provider.environment,
        configured: provider.configured
      }
    });
    res.json({ ok: true, provider });
  } catch (error) {
    next(error);
  }
});

router.post("/integrations/:provider/disable", requireSuperAdmin, async (req, res, next) => {
  try {
    const providerKey = requireEnum(req.params.provider, Object.keys(INTEGRATION_PROVIDERS), "Integration provider");
    const provider = await disableIntegrationConfig(providerKey, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "integration_disabled",
      entityType: "platform_settings",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { provider: providerKey }
    });
    res.json({ ok: true, provider });
  } catch (error) {
    next(error);
  }
});

router.post("/integrations/:provider/rotate", requireSuperAdmin, async (req, res, next) => {
  try {
    const providerKey = requireEnum(req.params.provider, Object.keys(INTEGRATION_PROVIDERS), "Integration provider");
    const result = await rotateIntegrationCredentials(providerKey, req.body || {}, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "integration_credentials_rotated",
      entityType: "platform_settings",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { provider: providerKey, rotatedSecrets: result.rotatedSecrets }
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/integrations/:provider/test", requireSuperAdmin, async (req, res, next) => {
  try {
    const providerKey = requireEnum(req.params.provider, Object.keys(INTEGRATION_PROVIDERS), "Integration provider");
    const result = await testProviderConnection(providerKey, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "integration_status_tested",
      entityType: "platform_settings",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: {
        provider: providerKey,
        status: result.status,
        environment: result.environment,
        responseTimeMs: result.responseTimeMs,
        errorMessage: result.errorMessage
      }
    });
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

router.get("/marketing/sms-campaigns", requireAdminPermission("marketing"), async (req, res, next) => {
  try {
    const campaigns = await getMarketingSmsCampaigns();
    const [personalRecipients, businessRecipients] = await Promise.all([
      countMarketingSmsRecipients("personal"),
      countMarketingSmsRecipients("business")
    ]);
    res.json({
      ok: true,
      canApprove: canApproveMarketingSms(req.auth.role),
      audiences: {
        personal: personalRecipients,
        business: businessRecipients,
        both: personalRecipients + businessRecipients
      },
      campaigns: campaigns.map(publicMarketingSmsCampaign)
    });
  } catch (error) {
    next(error);
  }
});

router.post("/marketing/sms-campaigns", requireAdminPermission("marketing"), async (req, res, next) => {
  try {
    const audience = requireEnum(req.body?.audience, ["personal", "business", "specific", "both"], "Audience");
    const title = boundedText(req.body?.title, "Campaign title", { min: 3, max: 120 });
    const message = boundedText(req.body?.message, "SMS message", { min: 5, max: 612 });
    const specificRecipient = audience === "specific"
      ? await resolveSpecificSmsRecipient(req.body?.recipient)
      : null;
    const estimatedRecipients = await countMarketingSmsRecipients(audience, specificRecipient?.id || null);
    if (!estimatedRecipients) throw new AppError(400, "No active TitoPay users with cellphone numbers match this audience");
    const campaigns = await getMarketingSmsCampaigns();
    const campaign = {
      id: crypto.randomUUID(),
      title,
      channel: "sms",
      audience,
      targetUserId: specificRecipient?.id || null,
      targetLabel: specificRecipient
        ? specificRecipient.username || specificRecipient.full_name || "Specific TitoPay user"
        : null,
      message,
      status: "pending_approval",
      estimatedRecipients,
      sentCount: 0,
      failedCount: 0,
      createdBy: req.auth.userId,
      createdByRole: normalizeAdminRole(req.auth.role),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      deliveryResults: []
    };
    campaigns.unshift(campaign);
    await saveMarketingSmsCampaigns(campaigns, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "marketing_sms_campaign_submitted",
      entityType: "marketing_sms_campaign",
      entityId: campaign.id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: {
        audience,
        estimatedRecipients,
        messageLength: message.length
      }
    });
    res.status(201).json({ ok: true, campaign: publicMarketingSmsCampaign(campaign) });
  } catch (error) {
    next(error);
  }
});

router.post("/marketing/sms-campaigns/:id/approve", requireAdminPermission("marketing_sms_approve"), async (req, res, next) => {
  try {
    if (!canApproveMarketingSms(req.auth.role)) throw new AppError(403, "CEO or COO approval is required");
    const campaignId = boundedText(req.params.id, "Campaign ID", { min: 6, max: 80 });
    const campaigns = await getMarketingSmsCampaigns();
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new AppError(404, "SMS campaign not found");
    if (campaign.status !== "pending_approval") {
      throw new AppError(409, `SMS campaign is already ${String(campaign.status || "processed").replaceAll("_", " ")}`);
    }

    const recipients = await listMarketingSmsRecipients(campaign.audience, campaign.targetUserId || null);
    if (!recipients.length) throw new AppError(400, "No active TitoPay users with cellphone numbers match this audience");

    const deliveryResults = [];
    let sentCount = 0;
    let failedCount = 0;
    for (const recipient of recipients) {
      try {
        const result = await deliverSms({
          to: recipient.smsPhone,
          body: campaign.message,
          metadata: {
            purpose: "marketing_bulk_sms",
            campaignId: campaign.id,
            audience: campaign.audience,
            userId: recipient.id
          }
        });
        sentCount += 1;
        deliveryResults.push({
          userId: recipient.id,
          phone: recipient.smsPhone,
          ok: true,
          providerMessageId: result.id || result.messageId || null
        });
      } catch (error) {
        failedCount += 1;
        deliveryResults.push({
          userId: recipient.id,
          phone: recipient.smsPhone,
          ok: false,
          error: error.message
        });
      }
    }

    campaign.status = failedCount && !sentCount ? "failed" : failedCount ? "sent_with_failures" : "sent";
    campaign.estimatedRecipients = recipients.length;
    campaign.sentCount = sentCount;
    campaign.failedCount = failedCount;
    campaign.approvedBy = req.auth.userId;
    campaign.approvedByRole = normalizeAdminRole(req.auth.role);
    campaign.approvedAt = new Date().toISOString();
    campaign.sentAt = campaign.approvedAt;
    campaign.updatedAt = campaign.approvedAt;
    campaign.deliveryResults = deliveryResults;
    await saveMarketingSmsCampaigns(campaigns, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "marketing_sms_campaign_approved_and_sent",
      entityType: "marketing_sms_campaign",
      entityId: campaign.id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: {
        audience: campaign.audience,
        recipients: recipients.length,
        sentCount,
        failedCount,
        approvedByRole: campaign.approvedByRole
      }
    });
    res.json({ ok: true, campaign: publicMarketingSmsCampaign(campaign) });
  } catch (error) {
    next(error);
  }
});

router.get("/marketing/email-campaigns",requireAdminPermission("marketing"),async(req,res,next)=>{try{const campaigns=await getMarketingEmailCampaigns();const [personal,business]=await Promise.all([countMarketingEmailRecipients("personal"),countMarketingEmailRecipients("business")]);res.json({ok:true,canApprove:canApproveMarketingSms(req.auth.role),audiences:{personal,business,both:personal+business},campaigns});}catch(error){next(error);}});

router.post("/marketing/email-campaigns",requireAdminPermission("marketing"),async(req,res,next)=>{try{const audience=requireEnum(req.body?.audience,["personal","business","specific","both"],"Audience"),title=boundedText(req.body?.title,"Campaign title",{min:3,max:120}),subject=boundedText(req.body?.subject,"Email subject",{min:3,max:200}),htmlBody=boundedText(req.body?.htmlBody,"HTML body",{min:5,max:50000}),textBody=boundedText(req.body?.textBody,"Plain-text body",{min:5,max:20000});const specific=audience==="specific"?await resolveSpecificEmailRecipient(req.body?.recipient):null,estimatedRecipients=await countMarketingEmailRecipients(audience,specific?.id||null);if(!estimatedRecipients)throw new AppError(400,"No active TitoPay users with email addresses match this audience");const campaigns=await getMarketingEmailCampaigns();const campaign={id:crypto.randomUUID(),channel:"email",title,subject,htmlBody,textBody,audience,targetUserId:specific?.id||null,targetLabel:specific?.username||specific?.full_name||null,status:"pending_approval",estimatedRecipients,queuedCount:0,failedCount:0,createdBy:req.auth.userId,createdByRole:normalizeAdminRole(req.auth.role),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};campaigns.unshift(campaign);await saveMarketingEmailCampaigns(campaigns,req.auth.userId);await writeAuditLog({actorType:"admin",actorId:req.auth.userId,action:"marketing_email_campaign_submitted",entityType:"marketing_email_campaign",entityId:campaign.id,ipAddress:req.auth.ipAddress,userAgent:req.auth.userAgent,metadata:{audience,estimatedRecipients,subject}});res.status(201).json({ok:true,campaign});}catch(error){next(error);}});

router.post("/marketing/email-campaigns/:id/approve",requireAdminPermission("marketing_email_approve"),async(req,res,next)=>{try{if(!canApproveMarketingSms(req.auth.role))throw new AppError(403,"CEO or COO approval is required");const campaigns=await getMarketingEmailCampaigns(),campaign=campaigns.find((item)=>item.id===req.params.id);if(!campaign)throw new AppError(404,"Email campaign not found");if(campaign.status!=="pending_approval")throw new AppError(409,"Email campaign has already been published");const {marketingOptOutEmails,buildUnsubscribeUrl}=require("../services/email-centre-service");const optedOut=await marketingOptOutEmails();const recipients=(await listMarketingEmailRecipients(campaign.audience,campaign.targetUserId||null)).filter((recipient)=>!optedOut.has(String(recipient.email).toLowerCase()));let queuedCount=0,failedCount=0;for(const recipient of recipients){try{const names=String(recipient.full_name||"").split(/\s+/);await queueRawEmail({recipient:recipient.email,subject:campaign.subject,htmlBody:campaign.htmlBody,textBody:campaign.textBody,userId:recipient.id,variables:{firstName:names[0]||"there",lastName:names.slice(1).join(" "),fullName:recipient.full_name,email:recipient.email,accountType:recipient.account_type},idempotencyKey:`marketing-email:${campaign.id}:${recipient.id}`,metadata:{campaignId:campaign.id,audience:campaign.audience,approvedBy:req.auth.userId},unsubscribeUrl:buildUnsubscribeUrl(recipient.email)});queuedCount++;}catch(error){failedCount++;console.error("[marketing-email] queue failed",{campaignId:campaign.id,userId:recipient.id,message:error.message});}}campaign.status=failedCount&&!queuedCount?"failed":failedCount?"published_with_failures":"published";campaign.estimatedRecipients=recipients.length;campaign.queuedCount=queuedCount;campaign.failedCount=failedCount;campaign.approvedBy=req.auth.userId;campaign.approvedByRole=normalizeAdminRole(req.auth.role);campaign.approvedAt=new Date().toISOString();campaign.publishedAt=campaign.approvedAt;campaign.updatedAt=campaign.approvedAt;await saveMarketingEmailCampaigns(campaigns,req.auth.userId);await writeAuditLog({actorType:"admin",actorId:req.auth.userId,action:"marketing_email_campaign_approved_and_published",entityType:"marketing_email_campaign",entityId:campaign.id,ipAddress:req.auth.ipAddress,userAgent:req.auth.userAgent,metadata:{audience:campaign.audience,recipients:recipients.length,queuedCount,failedCount,approvedByRole:campaign.approvedByRole}});res.json({ok:true,campaign});}catch(error){next(error);}});

// Compliance: the tier limit configuration and the EDD flag queue. The
// numbers here ARE the institution's risk framework, so every change is
// permission-gated and audit-logged.
router.get("/compliance/limits", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    res.json({ ok: true, config: await compliance.loadComplianceConfig(), defaults: compliance.DEFAULT_CONFIG });
  } catch (error) { next(error); }
});

router.put("/compliance/limits", requireAdminPermission("services"), async (req, res, next) => {
  try {
    // A limit change is a risk-framework change: it carries a stated reason,
    // and the audit record keeps the previous and new values side by side.
    const reason = String(req.body?.reason || "").trim();
    if (!reason) throw new AppError(400, "State the reason for this limit change. It becomes part of the audit record.");
    const compliance = require("../services/compliance-service");
    const config = await compliance.saveComplianceConfig(req.auth, req.body?.config || req.body || {}, { reason });
    // Warnings never block a save. They tell the operator what the change they
    // just made implies, which a form full of numbers cannot show on its own.
    res.json({ ok: true, config, warnings: config.warnings || [] });
  } catch (error) { next(error); }
});

// THE WORDING ON THE SAME SCREEN. The numbers above have been editable since
// the limit engine shipped; the sentences around them were hard-coded, which
// is the wrong way round, because a sentence is what a compliance review
// actually asks to change.
router.get("/compliance/limits-content", requireAdminPermission("services"), async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await require("../services/limits-content-service").getLimitsContentRecord()) });
  } catch (error) { next(error); }
});

router.put("/compliance/limits-content", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const content = require("../services/limits-content-service");
    const saved = await content.saveLimitsContent(req.auth, req.body?.content || {}, {
      reset: req.body?.reset === true
    });
    await writeAuditLog({
      actorType: "admin",
      actorId: req.auth?.userId || null,
      action: "limits_screen_content_updated",
      entityType: "platform_settings",
      // The settings key is not a UUID, so it travels in the metadata; the
      // audit write rejects a non-UUID entity id and used to lose the record.
      entityId: null,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: { entityKey: content.LIMITS_CONTENT_KEY, content: saved.content }
    });
    res.json({ ok: true, ...saved });
  } catch (error) { next(error); }
});

// Limit configuration history: every version, and a reversal path.
router.get("/compliance/limits/versions", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    res.json({ ok: true, versions: await compliance.listComplianceConfigVersions(50) });
  } catch (error) { next(error); }
});

router.post("/compliance/limits/versions/:id/restore", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    const config = await compliance.restoreComplianceConfigVersion(req.auth, req.params.id, req.body?.reason);
    res.json({ ok: true, config });
  } catch (error) { next(error); }
});

// Held payments: what is waiting, and the compliance decision to release or
// return one. Both paths post real ledger movements and are audit-logged.
router.get("/compliance/pending-credits", requireAdminPermission("services"), async (req, res, next) => {
  try {
    await require("../services/pending-credit-service").ensurePendingCreditSchema();
    const { rows } = await pool.query(
      `SELECT pc.*, s.full_name AS sender_name, r.full_name AS recipient_name, r.username AS recipient_username
       FROM pending_credits pc
       LEFT JOIN users s ON s.id = pc.sender_user_id
       LEFT JOIN users r ON r.id = pc.recipient_user_id
       ORDER BY (pc.status = 'awaiting_verification') DESC, pc.created_at DESC LIMIT 300`);
    res.json({ ok: true, items: rows });
  } catch (error) { next(error); }
});

router.post("/compliance/pending-credits/:id/:action", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const pending = require("../services/pending-credit-service");
    const note = String(req.body?.note || "").trim();
    if (!note) throw new AppError(400, "State the reason for this decision. It becomes part of the record.");
    const action = requireEnum(req.params.action, "action", ["release", "return"]);
    const result = action === "release"
      ? await pending.releaseHold(req.params.id, { actorId: req.auth.userId, note })
      : await pending.returnHold(req.params.id, { actorId: req.auth.userId, note });
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.get("/compliance/flags", requireAdminPermission("services"), async (req, res, next) => {
  try {
    await require("../services/compliance-service").ensureComplianceSchema();
    const { rows } = await pool.query(
      `SELECT cf.*, u.full_name, u.username, u.account_type
       FROM compliance_flags cf JOIN users u ON u.id = cf.user_id
       ORDER BY (cf.status = 'open') DESC, cf.created_at DESC LIMIT 200`);
    res.json({ ok: true, flags: rows });
  } catch (error) { next(error); }
});

router.post("/compliance/flags/:id/resolve", requireAdminPermission("services"), async (req, res, next) => {
  try {
    await require("../services/compliance-service").ensureComplianceSchema();
    const note = String(req.body?.note || "").slice(0, 500);
    const { rows } = await pool.query(
      `UPDATE compliance_flags SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, resolution_note = $3
       WHERE id = $1 AND status = 'open' RETURNING user_id`,
      [req.params.id, req.auth.userId, note || null]);
    if (!rows[0]) throw new AppError(404, "Flag not found or already resolved");
    const landing = String(req.body?.riskStatus || "").trim();
    if (landing) {
      await require("../services/compliance-service").setRiskStatus(rows[0].user_id, landing, `flag_resolved:${req.params.id}`, {}, req.auth);
    } else {
      await pool.query(
        `UPDATE users SET edd_status = 'cleared', risk_status = 'normal' WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM compliance_flags WHERE user_id = $1 AND status = 'open')`,
        [rows[0].user_id]);
    }
    await writeAuditLog({ actorType: "admin", actorId: req.auth.userId, action: "edd_flag_resolved",
      entityType: "compliance_flag", entityId: req.params.id, ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent, metadata: { note } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Risk management: manual risk decisions and the screening list. Every
// change is audit-logged; screening sweeps run on demand.
router.post("/compliance/users/:id/risk", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    const status = String(req.body?.riskStatus || "").trim();
    const reason = String(req.body?.reason || "").slice(0, 300);
    if (!reason) throw new AppError(400, "A reason is required for a manual risk decision");
    const result = await compliance.setRiskStatus(req.params.id, status, `manual:${reason}`, {}, req.auth);
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.get("/compliance/screening", requireAdminPermission("services"), async (req, res, next) => {
  try {
    await require("../services/compliance-service").ensureComplianceSchema();
    const { rows } = await pool.query(
      "SELECT id, label, name_pattern, (id_number_hash IS NOT NULL) AS has_id_hash, active, created_at FROM compliance_screening_list ORDER BY created_at DESC LIMIT 500");
    res.json({ ok: true, entries: rows });
  } catch (error) { next(error); }
});

router.post("/compliance/screening", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    await compliance.ensureComplianceSchema();
    const label = boundedText(req.body?.label, "Label", { min: 2, max: 200 });
    const namePattern = String(req.body?.namePattern || "").trim().slice(0, 200) || null;
    const idNumber = String(req.body?.idNumber || "").replace(/\s+/g, "");
    const idHash = /^\d{13}$/.test(idNumber)
      ? crypto.createHash("sha256").update(`titopay-id:${idNumber}`).digest("hex")
      : null;
    if (!namePattern && !idHash) throw new AppError(400, "Provide a name pattern or a 13 digit ID number to screen against");
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO compliance_screening_list (id, label, name_pattern, id_number_hash, added_by) VALUES ($1,$2,$3,$4,$5)",
      [id, label, namePattern, idHash, req.auth.userId]);
    await writeAuditLog({ actorType: "admin", actorId: req.auth.userId, action: "screening_entry_added",
      entityType: "compliance_screening", entityId: id, metadata: { label, hasName: Boolean(namePattern), hasId: Boolean(idHash) } });
    res.status(201).json({ ok: true, id });
  } catch (error) { next(error); }
});

router.post("/compliance/screening/run", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    await compliance.ensureComplianceSchema();
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE status = 'active' ORDER BY created_at DESC LIMIT 5000");
    let hits = 0;
    for (const row of rows) {
      const result = await compliance.screenUser(row.id);
      if (result.hit) hits += 1;
    }
    await writeAuditLog({ actorType: "admin", actorId: req.auth.userId, action: "screening_sweep_run",
      entityType: "compliance_screening", entityId: null, metadata: { screened: rows.length, hits } });
    res.json({ ok: true, screened: rows.length, hits });
  } catch (error) { next(error); }
});

// MONEY INTEGRITY AND CASE MANAGEMENT. The integrity engine observes the
// ledger and raises alerts; the endpoints here are how authorised staff see,
// investigate and resolve them. Nothing on this surface can move money or
// edit a financial record: resolution is a decision plus a note, and every
// decision is audit-logged.
router.get("/integrity/alerts", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    await integrity.ensureIntegritySchema();
    const { rows } = await pool.query(
      `SELECT a.*, u.full_name, u.username
       FROM money_integrity_alerts a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY (a.status = 'open') DESC,
                CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                a.created_at DESC
       LIMIT 300`);
    res.json({ ok: true, alerts: rows });
  } catch (error) { next(error); }
});

router.post("/integrity/alerts/:id/resolve", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    const result = await integrity.resolveAlert(req.params.id, req.auth, req.body?.note);
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.post("/integrity/sweep", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    const result = await integrity.runIntegritySweep({ triggeredBy: req.auth.userId });
    await writeAuditLog({ actorType: "admin", actorId: req.auth.userId, action: "integrity_sweep_run",
      entityType: "reconciliation_run", entityId: result.runId, metadata: result.found });
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.get("/integrity/config", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    res.json({ ok: true, config: await integrity.loadIntegrityConfig(), defaults: integrity.DEFAULT_INTEGRITY_CONFIG });
  } catch (error) { next(error); }
});

router.put("/integrity/config", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    const config = await integrity.saveIntegrityConfig(req.auth, req.body?.config || {}, { reason: req.body?.reason });
    res.json({ ok: true, config });
  } catch (error) { next(error); }
});

router.get("/integrity/reconciliation", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    await integrity.ensureIntegritySchema();
    const [runs, exceptions] = await Promise.all([
      pool.query("SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 50"),
      pool.query(
        `SELECT e.*, t.reference AS transaction_reference, t.service_code
         FROM reconciliation_exceptions e LEFT JOIN transactions t ON t.id = e.transaction_id
         ORDER BY (e.status = 'open') DESC, e.created_at DESC LIMIT 300`)
    ]);
    res.json({ ok: true, runs: runs.rows, exceptions: exceptions.rows });
  } catch (error) { next(error); }
});

router.post("/integrity/reconciliation/run", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    const result = await integrity.runProviderReconciliation({
      provider: String(req.body?.provider || "provider").slice(0, 60),
      entries: req.body?.entries,
      actor: req.auth
    });
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.post("/integrity/reconciliation/exceptions/:id/resolve", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    const result = await integrity.resolveReconciliationException(req.params.id, req.auth, req.body?.note);
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

// Compliance cases: the flag queue with ownership and decisions. Assigning
// and deciding are recorded moves; a decision closes the case through the
// same clearing rules the flag resolver uses.
router.get("/compliance/cases", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    await integrity.ensureIntegritySchema();
    const status = String(req.query.status || "").trim();
    const { rows } = await pool.query(
      `SELECT cf.*, u.full_name, u.username, u.account_type, u.risk_status, u.fica_status,
              a.full_name AS assigned_to_name
       FROM compliance_flags cf
       JOIN users u ON u.id = cf.user_id
       LEFT JOIN users a ON a.id = cf.assigned_to
       ${status ? "WHERE cf.status = $1" : ""}
       ORDER BY (cf.status = 'open') DESC, cf.created_at DESC LIMIT 300`,
      status ? [status] : []);
    res.json({ ok: true, cases: rows });
  } catch (error) { next(error); }
});

router.post("/compliance/cases/:id/assign", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    await integrity.ensureIntegritySchema();
    const assignee = requireUuid(req.body?.adminId, "adminId");
    const { rows } = await pool.query(
      "UPDATE compliance_flags SET assigned_to = $2 WHERE id = $1 AND status = 'open' RETURNING id, flag_type",
      [req.params.id, assignee]);
    if (!rows[0]) throw new AppError(404, "Case not found or already closed.");
    await writeAuditLog({ actorType: "admin", actorId: req.auth.userId, action: "compliance_case_assigned",
      entityType: "compliance_flag", entityId: req.params.id, metadata: { assignee, flagType: rows[0].flag_type } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/compliance/cases/:id/decide", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    await integrity.ensureIntegritySchema();
    const decision = String(req.body?.decision || "").trim().slice(0, 120);
    const note = String(req.body?.note || "").trim().slice(0, 500);
    if (!decision) throw new AppError(400, "Record the decision taken on this case.");
    if (!note) throw new AppError(400, "A decision carries a note explaining it.");
    const { rows } = await pool.query(
      `UPDATE compliance_flags
       SET status = 'resolved', decision = $2, resolved_at = NOW(), resolved_by = $3, resolution_note = $4
       WHERE id = $1 AND status = 'open' RETURNING user_id, flag_type`,
      [req.params.id, decision, req.auth.userId, note]);
    if (!rows[0]) throw new AppError(404, "Case not found or already closed.");
    const landing = String(req.body?.riskStatus || "").trim();
    if (landing) {
      await require("../services/compliance-service").setRiskStatus(rows[0].user_id, landing, `case_decided:${req.params.id}`, {}, req.auth);
    } else {
      await pool.query(
        `UPDATE users SET edd_status = 'cleared', risk_status = 'normal' WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM compliance_flags WHERE user_id = $1 AND status = 'open')`,
        [rows[0].user_id]);
    }
    await writeAuditLog({ actorType: "admin", actorId: req.auth.userId, action: "compliance_case_decided",
      entityType: "compliance_flag", entityId: req.params.id,
      metadata: { decision, note, flagType: rows[0].flag_type } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// The compliance and integrity dashboard: one call, the whole picture.
router.get("/compliance/overview", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    const integrity = require("../services/money-integrity-service");
    await compliance.ensureComplianceSchema();
    await integrity.ensureIntegritySchema();
    const [kyc, risk, flags, alerts, recon, accounts, transactions30d] = await Promise.all([
      pool.query(`SELECT CASE WHEN LOWER(COALESCE(fica_status,'')) IN ('verified','approved','complete','completed') THEN 'fully_verified'
                              WHEN basic_verified_at IS NOT NULL THEN 'basic_verified' ELSE 'unverified' END AS level,
                         COUNT(*)::INT AS count
                  FROM users GROUP BY 1`),
      pool.query("SELECT COALESCE(risk_status,'normal') AS risk, COUNT(*)::INT AS count FROM users GROUP BY 1"),
      pool.query("SELECT flag_type, COUNT(*)::INT AS count FROM compliance_flags WHERE status = 'open' GROUP BY flag_type"),
      pool.query("SELECT severity, COUNT(*)::INT AS count FROM money_integrity_alerts WHERE status = 'open' GROUP BY severity"),
      pool.query("SELECT COUNT(*)::INT AS open FROM reconciliation_exceptions WHERE status = 'open'"),
      pool.query("SELECT status, COUNT(*)::INT AS count FROM users WHERE status IN ('suspended','blocked','inactive') GROUP BY status"),
      pool.query(`SELECT status, COUNT(*)::INT AS count FROM transactions
                  WHERE created_at >= NOW() - INTERVAL '30 days' AND status IN ('failed','reversed','refunded','cancelled')
                  GROUP BY status`)
    ]);
    res.json({
      ok: true,
      kyc: kyc.rows, risk: risk.rows, openFlags: flags.rows,
      openIntegrityAlerts: alerts.rows, openReconciliationExceptions: recon.rows[0]?.open || 0,
      restrictedAccounts: accounts.rows, problemTransactions30d: transactions30d.rows
    });
  } catch (error) { next(error); }
});

// Dry-run transaction check for support and operations: what would the
// compliance engine say, without moving anything or changing any state.
router.post("/compliance/transaction-check", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const compliance = require("../services/compliance-service");
    const userId = requireUuid(req.body?.userId, "userId");
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "Provide the amount to check.");
    const decision = { allowed: true, refusals: [] };
    try { await compliance.assertCanSendAmount(userId, amount); }
    catch (error) { decision.allowed = false; decision.refusals.push({ check: "send", reason: error.message }); }
    if (req.body?.recipientId) {
      try { await compliance.assertCanReceiveAmount(requireUuid(req.body.recipientId, "recipientId"), amount); }
      catch (error) { decision.allowed = false; decision.refusals.push({ check: "receive", reason: error.message }); }
    }
    res.json({ ok: true, ...decision });
  } catch (error) { next(error); }
});

// Regulatory reporting evidence: trigger, review, decision, submission
// reference and responsible person, for whichever obligations TitoPay's
// compliance framework determines apply.
router.get("/compliance/reports", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    await integrity.ensureIntegritySchema();
    const { rows } = await pool.query(
      `SELECT r.*, a.full_name AS responsible_name
       FROM regulatory_report_events r LEFT JOIN users a ON a.id = r.responsible_admin
       ORDER BY r.created_at DESC LIMIT 200`);
    res.json({ ok: true, reports: rows });
  } catch (error) { next(error); }
});

router.post("/compliance/reports", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const integrity = require("../services/money-integrity-service");
    const result = await integrity.recordRegulatoryReportEvent(req.auth, req.body || {});
    res.status(201).json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.get("/marketing/announcements", requireAdminPermission("marketing"), async (req, res, next) => {
  try {
    const [{ rows }, audienceCounts] = await Promise.all([
      pool.query(
        `SELECT c.*,
                COALESCE(
                  JSON_AGG(
                    JSON_BUILD_OBJECT(
                      'role', a.approval_role,
                      'approvedBy', a.approved_by,
                      'approvedAt', a.approved_at
                    ) ORDER BY a.approved_at
                  ) FILTER (WHERE a.approval_role IS NOT NULL),
                  '[]'::JSON
                ) AS approvals
           FROM announcement_campaigns c
           LEFT JOIN announcement_approvals a ON a.campaign_id = c.id
          GROUP BY c.id
          ORDER BY c.created_at DESC
          LIMIT 100`
      ),
      pool.query(
        `SELECT account_type, COUNT(*)::INT AS count
           FROM users
          WHERE status = 'active'
          GROUP BY account_type`
      )
    ]);
    const counts = Object.fromEntries(audienceCounts.rows.map((row) => [row.account_type, row.count]));
    const authenticatedRole = normalizeAdminRole(req.auth.role);
    const approvalRole = authenticatedRole === "super_admin"
      ? "ceo"
      : ["ceo", "coo"].includes(authenticatedRole)
        ? authenticatedRole
        : null;
    res.json({
      ok: true,
      approvalRole,
      audiences: {
        personal: counts.personal || 0,
        business: counts.business || 0,
        both: (counts.personal || 0) + (counts.business || 0)
      },
      campaigns: rows
    });
  } catch (error) {
    next(error);
  }
});

router.post("/marketing/announcements", requireAdminPermission("marketing"), async (req, res, next) => {
  try {
    const audience = requireEnum(req.body?.audience, ["personal", "business", "specific", "both"], "Audience");
    const category = requireEnum(req.body?.category, ["general", "marketing", "service", "security"], "Category");
    const title = boundedText(req.body?.title, "Announcement title", { min: 3, max: 120 });
    const body = boundedText(req.body?.body, "Announcement message", { min: 5, max: 1200 });
    let targetUserId = null;
    let countResult;
    if (audience === "specific") {
      const recipient = boundedText(req.body?.recipient, "Specific user", { min: 3, max: 160 });
      const recipientUsername = recipient.replace(/^@/, "");
      const recipientDigits = recipient.replace(/\D/g, "");
      const recipientPhone = recipientDigits.length >= 7 ? recipientDigits : null;
      const specificUser = await pool.query(
        `SELECT id
           FROM users
          WHERE status = 'active'
            AND (
              LOWER(username) = LOWER($3)
              OR LOWER(COALESCE(email, '')) = LOWER($1)
              OR (
                $2::TEXT IS NOT NULL
                AND REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') = $2
              )
            )
          LIMIT 2`,
        [recipient, recipientPhone, recipientUsername]
      );
      if (!specificUser.rows.length) throw new AppError(404, "No active TitoPay user matches that username, email or cellphone number");
      if (specificUser.rows.length > 1) throw new AppError(409, "That identifier matches more than one user");
      targetUserId = specificUser.rows[0].id;
      countResult = { rows: [{ count: 1 }] };
    } else {
      const values = audience === "both" ? [] : [audience];
      const audienceFilter = audience === "both" ? "" : "AND account_type = $1";
      countResult = await pool.query(
        `SELECT COUNT(*)::INT AS count FROM users WHERE status = 'active' ${audienceFilter}`,
        values
      );
    }
    const estimatedRecipients = countResult.rows[0]?.count || 0;
    if (!estimatedRecipients) throw new AppError(400, "No active TitoPay users match this audience");
    const { rows } = await pool.query(
      `INSERT INTO announcement_campaigns
         (title, body, category, audience, target_user_id, estimated_recipients, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, body, category, audience, targetUserId, estimatedRecipients, req.auth.userId]
    );
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "in_app_announcement_submitted",
      entityType: "announcement_campaign",
      entityId: rows[0].id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { audience, category, targetUserId, estimatedRecipients }
    });
    res.status(201).json({ ok: true, campaign: { ...rows[0], approvals: [] } });
  } catch (error) {
    next(error);
  }
});

// Reject an announcement. Any of the three approval seats may do it, and a
// reason is required — "rejected" with no explanation tells the author nothing
// and leaves no defensible record of why a message to customers was stopped.
router.post("/marketing/announcements/:id/reject", requireAdminPermission("marketing"), async (req, res, next) => {
  try {
    const seat = marketingApprovalSeat(req.auth?.role);
    if (!seat) throw new AppError(403, "Rejection requires the CEO, the COO or Senior Marketing");
    const campaignId = requireUuid(req.params.id, "Announcement ID");
    const reason = boundedText(req.body?.reason, "Rejection reason", { min: 4, max: 500 });

    const { rows } = await pool.query(
      `UPDATE announcement_campaigns
          SET status = 'rejected', decision_reason = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status IN ('pending_approval', 'escalated')
        RETURNING id, title, status`,
      [campaignId, reason, req.auth.userId]
    );
    if (!rows[0]) {
      throw new AppError(409, "That announcement is no longer awaiting a decision.");
    }
    await writeAuditLog({
      actorType: "admin", actorId: req.auth.userId,
      action: "in_app_announcement_rejected", entityType: "announcement_campaign", entityId: campaignId,
      ipAddress: req.ip, userAgent: req.get("user-agent"),
      metadata: { seat, reason, title: rows[0].title }
    });
    res.json({ ok: true, announcement: rows[0] });
  } catch (error) { next(error); }
});

// Escalate to the CEO or COO. Senior Marketing only: the point of the seat is
// that it can decide most things and hand the rest up, so the two seats above
// it have nobody to escalate to and are refused here rather than silently
// allowed to mark their own work as needing someone else.
router.post("/marketing/announcements/:id/escalate", requireAdminPermission("marketing"), async (req, res, next) => {
  try {
    if (!canEscalateMarketing(req.auth?.role)) {
      throw new AppError(403, "Only Senior Marketing can escalate an announcement to the CEO or COO");
    }
    const campaignId = requireUuid(req.params.id, "Announcement ID");
    const note = boundedText(req.body?.note, "Escalation note", { min: 4, max: 500 });

    const { rows } = await pool.query(
      `UPDATE announcement_campaigns
          SET status = 'escalated', escalation_note = $2, escalated_by = $3, escalated_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending_approval'
        RETURNING id, title, status`,
      [campaignId, note, req.auth.userId]
    );
    if (!rows[0]) throw new AppError(409, "That announcement is not awaiting approval.");

    await writeAuditLog({
      actorType: "admin", actorId: req.auth.userId,
      action: "in_app_announcement_escalated", entityType: "announcement_campaign", entityId: campaignId,
      ipAddress: req.ip, userAgent: req.get("user-agent"),
      metadata: { note, title: rows[0].title }
    });
    res.json({ ok: true, announcement: rows[0] });
  } catch (error) { next(error); }
});

router.post("/marketing/announcements/:id/approve", requireAdminPermission("marketing"), async (req, res, next) => {
  const approvalRole = marketingApprovalSeat(req.auth?.role);
  if (!approvalRole) {
    next(new AppError(403, "Approval requires the CEO, the COO or Senior Marketing"));
    return;
  }
  const campaignId = requireUuid(req.params.id, "Announcement ID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const campaignResult = await client.query(
      "SELECT * FROM announcement_campaigns WHERE id = $1 FOR UPDATE",
      [campaignId]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw new AppError(404, "Announcement not found");
    if (!["pending_approval", "escalated"].includes(campaign.status)) {
      throw new AppError(409, "Announcement has already been decided");
    }
    // An escalated announcement was deliberately handed upwards. Letting Senior
    // Marketing then approve it themselves would make the escalation
    // meaningless, so only the two seats above can close one out.
    if (campaign.status === "escalated" && approvalRole === "senior_marketing") {
      throw new AppError(403, "This announcement was escalated and needs the CEO or COO");
    }
    const approvalResult = await client.query(
      `INSERT INTO announcement_approvals (campaign_id, approval_role, approved_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, approval_role) DO NOTHING
       RETURNING approval_role`,
      [campaignId, approvalRole, req.auth.userId]
    );
    if (!approvalResult.rowCount) throw new AppError(409, `${approvalRole.toUpperCase()} approval is already recorded`);

    const approvalsResult = await client.query(
      "SELECT approval_role, approved_by, approved_at FROM announcement_approvals WHERE campaign_id = $1 ORDER BY approved_at",
      [campaignId]
    );
    let sentCount = 0;
    const audienceValues = campaign.audience === "both"
      ? []
      : campaign.audience === "specific"
        ? [campaign.target_user_id]
        : [campaign.audience];
    const audienceSql = campaign.audience === "both"
      ? ""
      : campaign.audience === "specific"
        ? "AND id = $1"
        : "AND account_type = $1";
    const recipientCount = await client.query(
      `SELECT COUNT(*)::INT AS count
         FROM users
        WHERE status = 'active' ${audienceSql}`,
      audienceValues
    );
    sentCount = recipientCount.rows[0]?.count || 0;
    await client.query(
      `UPDATE announcement_campaigns
          SET status = 'sent', sent_count = $2, sent_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [campaignId, sentCount]
    );
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: sentCount ? "in_app_announcement_approved_and_sent" : "in_app_announcement_approved",
      entityType: "announcement_campaign",
      entityId: campaignId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { approvalRole, sentCount }
    });
    res.json({
      ok: true,
      status: "sent",
      sentCount,
      approvals: approvalsResult.rows
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/marketing/reviews", requireAdminPermission("marketing"), async (_req, res, next) => {
  try {
    const reviews = await getPwaCustomerReviews();
    const total = reviews.length;
    const averageRating = total
      ? Math.round((reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / total) * 10) / 10
      : 0;
    const byCategory = reviews.reduce((acc, item) => {
      const key = item.category || "general";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    res.json({
      ok: true,
      summary: {
        total,
        averageRating,
        newCount: reviews.filter((item) => String(item.status || "new") === "new").length,
        byCategory
      },
      reviews: reviews.map(publicPwaCustomerReview)
    });
  } catch (error) {
    next(error);
  }
});

/* ---- Service Builder ------------------------------------------------------
   The console's Service Builder probes GET /service-builder/services on load
   and switches from browser-local storage to API storage the moment it
   answers with a services array. Definitions are configuration documents the
   console composed; nothing here executes them and no customer-facing
   behaviour reads this table. Gated by "services" — the same permission the
   console itself uses to decide who sees the builder. */
router.get("/service-builder/services", requireAdminPermission("services"), async (_req, res, next) => {
  try {
    res.json({ ok: true, services: await listServiceBuilderDefinitions() });
  } catch (error) {
    next(error);
  }
});

router.post("/service-builder/services", requireAdminPermission("services"), async (req, res, next) => {
  try {
    const saved = await saveServiceBuilderDefinition(req.body?.service, req.auth.userId);
    // audit_logs.entity_id is a UUID column; svc_… ids ride in metadata.
    await writeAuditLog({
      actorType: "admin", actorId: req.auth.userId, action: "service_builder_definition_saved",
      entityType: "service_builder_definition", entityId: null,
      ipAddress: req.auth.ipAddress, userAgent: req.auth.userAgent,
      metadata: { serviceId: saved.id, status: saved.status }
    });
    res.json({ ok: true, service: saved });
  } catch (error) {
    next(error);
  }
});

router.delete("/service-builder/services/:id", requireAdminPermission("services"), async (req, res, next) => {
  try {
    await deleteServiceBuilderDefinition(req.params.id);
    await writeAuditLog({
      actorType: "admin", actorId: req.auth.userId, action: "service_builder_definition_deleted",
      entityType: "service_builder_definition", entityId: null,
      ipAddress: req.auth.ipAddress, userAgent: req.auth.userAgent,
      metadata: { serviceId: String(req.params.id) }
    });
    res.json({ ok: true, deleted: true });
  } catch (error) {
    next(error);
  }
});

// The console's Ticketing page reads this for its money-and-count cards
// (gross, platform revenue, tickets sold/scanned) and the sales table. It
// lives here, beside every other /ticketing/* console route, because this is
// the path the console actually calls — the same handler also answers at
// /v1/ticketing/admin/analytics, where it was first registered, and for a
// while it answered ONLY there: the console's fetch 404ed, its catch turned
// that into zeros, and the dashboard reported no sales while orders existed.
router.get("/ticketing/analytics", requireAdminPermission("ticketing"), async (_req, res, next) => {
  try {
    res.json({ ok: true, analytics: await adminTicketingAnalytics() });
  } catch (error) {
    next(error);
  }
});

/* Campaign review. An organiser's message to their patrons is paid for at
   submission and held here until somebody at TitoPay has read it. Approving
   releases it; rejecting refunds every cent, because it never went. */
router.get("/ticketing/campaigns", requireAdminPermission("ticketing"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await campaigns.listPendingCampaigns() });
  } catch (error) {
    next(error);
  }
});

router.post("/ticketing/campaigns/:id/action", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const campaignId = requireUuid(req.params.id, "Campaign ID");
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["approve", "reject"].includes(decision)) throw new AppError(400, "Decision must be approve or reject");
    const result = decision === "approve"
      ? await campaigns.releaseCampaign(campaignId, req.auth.userId, { note: req.body?.note })
      : await campaigns.rejectCampaign(campaignId, req.auth.userId, { note: req.body?.note });
    await writeAuditLog({
      actorType: "admin", actorId: req.auth.userId, action: `event_campaign_${decision}d`,
      entityType: "event_campaign", entityId: campaignId,
      ipAddress: req.auth.ipAddress, userAgent: req.auth.userAgent, metadata: result
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/events", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listAdminEvents({ status: req.query.status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/events/:id", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await getAdminEvent(eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/ticketing/events/:id/action", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await adminTransitionEvent(eventId, req.body, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/events/:id/report", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, report: await eventSalesReport(eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/ticketing/events/:id/settlement", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.status(201).json({ ok: true, settlement: await createTicketSettlement(eventId, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/refunds", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listTicketRefunds({ status: req.query.status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

router.post("/ticketing/refunds/:id/action", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const refundId = requireUuid(req.params.id, "Refund ID");
    res.json({ ok: true, refund: await processTicketRefund(refundId, req.body, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

// Organiser change-request review queue. GET lists requests (optionally by
// status); the action endpoint approves (applying the effect — postpone/update
// narrowly, cancel through the safe refund-request cascade) or declines.
router.get("/ticketing/change-requests", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listEventChangeRequests({ status: req.query.status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

router.post("/ticketing/change-requests/:id/action", requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const requestId = requireUuid(req.params.id, "Change request ID");
    res.json({ ok: true, changeRequest: await processEventChangeRequest(requestId, req.body, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

/* ---- Event Tags ----------------------------------------------------------
   Admin oversight of an event's cashless credentials, behind its own
   "event_tags" permission rather than the broader "ticketing" one: reading
   sales reports is a reporting job, while blocking an attendee's wristband is
   a fraud-and-support job, and they are not the same people.

   Nothing here can create, activate or replace a tag — those stay with the
   organiser and the gate. Admin can look, and can stop a tag. */

router.get("/ticketing/events/:id/tags", requireAdminPermission("event_tags"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, items: await listEventTags(eventId, { status: req.query.status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/events/:id/tags/analytics", requireAdminPermission("event_tags"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, analytics: await eventTagAnalytics(eventId) });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/events/:id/vendors", requireAdminPermission("event_tags"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, items: await listEventVendors(eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/ticketing/tags/:tagId/status", requireAdminPermission("event_tags"), async (req, res, next) => {
  try {
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.json({
      ok: true,
      // PLATFORM_SCOPE: the admin console is gated by
      // requireAdminPermission("event_tags") and is deliberately not tied to
      // one event, unlike the organiser-facing route in ticketing.routes.js.
      tag: await setTagStatus(req.auth, PLATFORM_SCOPE, tagId, String(req.body?.status || "").toUpperCase(), { reason: req.body?.reason })
    });
  } catch (error) {
    next(error);
  }
});

router.get("/ticketing/tags/:tagId/audit", requireAdminPermission("event_tags"), async (req, res, next) => {
  try {
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.json({ ok: true, items: await tagAuditTrail(tagId, req.query.limit) });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/overview", requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, overview: await enterpriseDistributionOverview() });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/applications", requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listEnterpriseDistributionApplications(req.query.status || "") });
  } catch (error) {
    next(error);
  }
});

router.post("/enterprise-distribution/applications/:id/action", requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    const applicationId = requireUuid(req.params.id, "Application ID");
    res.json({ ok: true, ...(await transitionEnterpriseDistributionApplication(applicationId, req.body, req.auth, meta(req))) });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/organisations", requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listEnterpriseDistributionOrganisations() });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/batches", requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listEnterpriseDistributionBatches() });
  } catch (error) {
    next(error);
  }
});

router.post("/enterprise-distribution/batches/:id/release", requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    const batchId = requireUuid(req.params.id, "Batch ID");
    res.json({ ok: true, batch: await releaseEnterpriseDistributionBatch(batchId, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/payouts", requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listEnterpriseDistributionPayouts(req.query.status || "") });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/audit-logs", requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listEnterpriseDistributionAuditLogs(req.query.limit || 250) });
  } catch (error) {
    next(error);
  }
});

router.get("/enterprise-distribution/report", requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, report: await enterpriseDistributionReport() });
  } catch (error) {
    next(error);
  }
});

router.post("/qr-assets", requireAdminPermission("analytics"), async (req, res, next) => {
  try {
    const type = requireEnum(req.body?.type, [
      "website",
      "app_download",
      "merchant_onboarding",
      "merchant_qr",
      "business_registration",
      "business_qr",
      "personal_registration",
      "marketing",
      "campaign",
      "invoice",
      "invoice_qr",
      "product",
      "product_qr",
      "support",
      "support_qr",
      "event",
      "referral",
      "referral_qr",
      "dynamic_url"
    ], "QR type");
    const label = boundedText(req.body?.label, "QR label", { min: 2, max: 120 });
    const destinationUrl = validateOptionalUrl(req.body?.destinationUrl, "Destination URL");
    if (!destinationUrl) throw new AppError(400, "Destination URL is required");
    const asset = await generateQrAsset({ type, label, destinationUrl, createdBy: req.auth.userId });
    res.json({ ok: true, asset });
  } catch (error) {
    next(error);
  }
});

router.get("/audit", requireAdminPermission("audit"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listAuditLogs() });
  } catch (error) {
    next(error);
  }
});

router.get("/beneficiaries", requireSuperAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await adminListBeneficiaries(req.query) });
  } catch (error) {
    next(error);
  }
});

router.post("/beneficiaries/:id/disable", requireSuperAdmin, async (req, res, next) => {
  try {
    const relationship = await adminDisableBeneficiary(
      req.auth,
      requireUuid(req.params.id, "Beneficiary relationship ID"),
      req.body?.reason
    );
    res.json({ ok: true, relationship });
  } catch (error) {
    next(error);
  }
});

function canManageAdminRoles(role) {
  return ["developer", "super_admin"].includes(normalizeAdminRole(role));
}

const AVAILABLE_ADMIN_PERMISSIONS = [...new Set(
  [
    ...Object.values(ADMIN_ROLE_PERMISSIONS).flat().filter((permission) => permission !== "*"),
    "EMAIL_VIEW","EMAIL_SEND","EMAIL_TEMPLATE_EDIT","EMAIL_TEMPLATE_DELETE","EMAIL_QUEUE_MANAGE","EMAIL_LOG_VIEW","EMAIL_SETTINGS_EDIT","EMAIL_PROVIDER_EDIT","EMAIL_TEST_SEND",
    "EMAIL_OTP_VIEW","EMAIL_OTP_SETTINGS","EMAIL_OTP_LOGS","EMAIL_OTP_RESEND"
  ]
)].sort();

router.get("/roles", requireAdminPermission("engineering"), async (req, res, next) => {
  try {
    const { value: overrides } = await getPlatformSetting("admin_role_permission_overrides", {});
    const items = await Promise.all(Object.entries(ADMIN_ROLE_PERMISSIONS).map(async ([role, defaults]) => ({
      role,
      permissions: Array.isArray(overrides?.[role]) ? overrides[role] : defaults,
      builtin: true,
      protected: ["owner", "root", "super_admin", "developer", "ceo"].includes(role),
      customised: Array.isArray(overrides?.[role])
    })));
    res.json({
      ok: true,
      roles: Object.fromEntries(items.map((item) => [item.role, item.permissions])),
      items,
      availablePermissions: AVAILABLE_ADMIN_PERMISSIONS,
      canManage: canManageAdminRoles(req.auth.role)
    });
  } catch (error) {
    next(error);
  }
});

router.put("/roles/:role", requireAdminPermission("engineering"), async (req, res, next) => {
  try {
    if (!canManageAdminRoles(req.auth.role)) throw new AppError(403, "Developer or Super Admin access is required");
    const role = normalizeAdminRole(req.params.role);
    if (!Object.hasOwn(ADMIN_ROLE_PERMISSIONS, role)) throw new AppError(404, "Role not found");
    if (["owner", "root", "super_admin", "developer", "ceo"].includes(role)) {
      throw new AppError(409, "This full-access role is protected");
    }
    const requested = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions.map(String))] : null;
    if (!requested) throw new AppError(400, "Permissions are required");
    if (requested.some((permission) => permission !== "*" && !AVAILABLE_ADMIN_PERMISSIONS.includes(permission))) {
      throw new AppError(400, "One or more permissions are invalid");
    }
    const { value: overrides } = await getPlatformSetting("admin_role_permission_overrides", {});
    const updated = { ...(overrides || {}), [role]: requested.includes("*") ? ["*"] : requested };
    await setPlatformSetting("admin_role_permission_overrides", updated, req.auth.userId);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "admin_role_permissions_updated",
      entityType: "admin_role",
      // A role is named, not a UUID, and entity_id is a uuid column. This threw
      // AFTER the permissions had been saved, so changing a role's access
      // answered 500 while the change stood and nothing was logged. The role
      // now travels in the metadata, where it also becomes readable: the log
      // recorded the new permissions without ever saying whose they were.
      entityId: null,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { role, permissions: updated[role] }
    });
    res.json({ ok: true, role, permissions: updated[role] });
  } catch (error) {
    next(error);
  }
});

router.get("/security-summary", requireAdminPermission("security"), async (_req, res, next) => {
  try {
    const [sessions, otpCodes, auditLogs] = await Promise.all([
      pool.query("SELECT COUNT(*)::INT AS count FROM sessions WHERE revoked_at IS NULL"),
      pool.query("SELECT COUNT(*)::INT AS count FROM otp_codes WHERE used_at IS NULL AND expires_at > NOW()"),
      pool.query("SELECT COUNT(*)::INT AS count FROM audit_logs")
    ]);
    res.json({
      ok: true,
      security: {
        activeSessions: sessions.rows[0].count,
        activeOtpCodes: otpCodes.rows[0].count,
        auditLogs: auditLogs.rows[0].count
      }
    });
  } catch (error) {
    next(error);
  }
});

router.use((error, req, _res, next) => {
  console.error("[admin-api-error]", {
    method: req.method,
    path: req.originalUrl || req.url,
    requestId: req.requestId,
    adminId: req.auth?.userId || null,
    role: req.auth?.role || null,
    status: error?.statusCode || error?.status || 500,
    code: error?.code,
    name: error?.name || "Error",
    message: error?.message || "Unexpected Admin API error",
    stack: error?.stack
  });
  next(error);
});

module.exports = router;
