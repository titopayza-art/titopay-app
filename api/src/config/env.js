const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), "api/.env") });
dotenv.config();

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredAny(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }
  return value;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name] ?? fallback;
  return !["false", "0", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function adminOtpRequiredFromEnv() {
  if (process.env.ADMIN_OTP_REQUIRED !== undefined) {
    return booleanFromEnv("ADMIN_OTP_REQUIRED", false);
  }
  return booleanFromEnv("VERIFY_ADMIN_OTP", false);
}

function listFromEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function upperListFromEnv(name, fallback = "") {
  return (process.env[name] || fallback)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

const localPreviewOrigins = Array.from({ length: 31 }, (_, index) => 8000 + index).flatMap((port) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`
]);
const envName = process.env.NODE_ENV || "development";
const includeLocalCorsOrigins = envName !== "production" || booleanFromEnv("ALLOW_LOCAL_CORS_ORIGINS", false);

const config = {
  env: envName,
  apiHost: process.env.API_HOST || "127.0.0.1",
  apiPort: numberFromEnv("API_PORT", 8110),
  apiBaseUrl: process.env.API_BASE_URL || "https://api.titopay.co.za",
  trustProxy: process.env.TRUST_PROXY || "loopback",
  appOrigin: process.env.APP_ORIGIN || "https://app.titopay.co.za",
  adminOrigin: process.env.ADMIN_ORIGIN || "https://admin.titopay.co.za",
  hrOrigin: process.env.HR_ORIGIN || "https://hr.titopay.co.za",
  postgresUrl: requiredAny(["POSTGRES_URL", "DATABASE_URL"]),
  accessSecret: requiredAny(["JWT_ACCESS_SECRET", "JWT_SECRET"]),
  refreshSecret: requiredAny(["JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"]),
  cookieSecret: process.env.COOKIE_SECRET || "",
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || "15m",
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || "7d",
  adminOtpRequired: adminOtpRequiredFromEnv(),
  otpTtlSeconds: numberFromEnv("OTP_TTL_SECONDS", 300),
  sessionIdleTimeoutSeconds: numberFromEnv("SESSION_IDLE_TIMEOUT_SECONDS", 900),
  failedLoginLockoutThreshold: numberFromEnv("FAILED_LOGIN_LOCKOUT_THRESHOLD", 5),
  failedLoginLockoutSeconds: numberFromEnv("FAILED_LOGIN_LOCKOUT_SECONDS", 900),
  maxOtpAttempts: numberFromEnv("MAX_OTP_ATTEMPTS", 5),
  maxOtpResends: numberFromEnv("MAX_OTP_RESENDS", 5),
  customerRegistration: {
    geoLockEnabled: booleanFromEnv("CUSTOMER_REGISTRATION_GEO_LOCK", (process.env.NODE_ENV || "development") === "production"),
    allowedCountries: upperListFromEnv("CUSTOMER_REGISTRATION_ALLOWED_COUNTRIES", "ZA"),
    countryHeader: (process.env.GEO_COUNTRY_HEADER || "cf-ipcountry").toLowerCase(),
    requireSouthAfricanPhone: booleanFromEnv("CUSTOMER_REGISTRATION_REQUIRE_SA_PHONE", true)
  },
  pos: {
    qrExpirySeconds: numberFromEnv("POS_QR_EXPIRY_SECONDS", 120),
    signatureToleranceSeconds: numberFromEnv("POS_SIGNATURE_TOLERANCE_SECONDS", 300),
    maxAmount: numberFromEnv("POS_MAX_AMOUNT", 100000),
    providerWebhookSecret: process.env.POS_PROVIDER_WEBHOOK_SECRET || "",
    terminalEncryptionKey: process.env.POS_TERMINAL_ENCRYPTION_KEY || "",
    universalLinkBase: process.env.POS_QR_LINK_BASE || "https://app.titopay.co.za/pos/pay"
  },
  integrations: {
    peachPayments: {
      v2Enabled: booleanFromEnv("PEACH_PAYMENTS_V2_ENABLED", false),
      mode: process.env.PEACH_PAYMENTS_MODE || "production",
      baseUrl: process.env.PEACH_PAYMENTS_BASE_URL || "",
      sandboxBaseUrl: process.env.PEACH_PAYMENTS_SANDBOX_BASE_URL || "https://app.sandbox-next.peachpayments.com/api",
      productionBaseUrl: process.env.PEACH_PAYMENTS_PRODUCTION_BASE_URL || "https://app.next.peachpayments.com/api",
      apiKey: process.env.PEACH_PAYMENTS_API_KEY || "",
      apiSecret: process.env.PEACH_PAYMENTS_API_SECRET || "",
      clientId: process.env.PEACH_PAYMENTS_CLIENT_ID || "",
      clientSecret: process.env.PEACH_PAYMENTS_CLIENT_SECRET || "",
      merchantId: process.env.PEACH_PAYMENTS_MERCHANT_ID || "",
      entityId: process.env.PEACH_PAYMENTS_ENTITY_ID || "",
      webhookSecret: process.env.PEACH_PAYMENTS_WEBHOOK_SECRET || "",
      webhookUrl: process.env.PEACH_PAYMENTS_WEBHOOK_URL || "",
      callbackUrl: process.env.PEACH_PAYMENTS_CALLBACK_URL || ""
    },
    docfox: {
      mode: process.env.DOCFOX_MODE || "production",
      baseUrl: process.env.DOCFOX_BASE_URL || "",
      apiKey: process.env.DOCFOX_API_KEY || "",
      apiSecret: process.env.DOCFOX_API_SECRET || "",
      clientId: process.env.DOCFOX_CLIENT_ID || "",
      clientSecret: process.env.DOCFOX_CLIENT_SECRET || "",
      webhookSecret: process.env.DOCFOX_WEBHOOK_SECRET || "",
      callbackUrl: process.env.DOCFOX_CALLBACK_URL || ""
    },
    ott: {
      mode: process.env.OTT_MODE || "production",
      baseUrl: process.env.OTT_BASE_URL || "",
      apiKey: process.env.OTT_API_KEY || "",
      apiSecret: process.env.OTT_API_SECRET || "",
      username: process.env.OTT_USERNAME || "",
      password: process.env.OTT_PASSWORD || "",
      merchantId: process.env.OTT_MERCHANT_ID || "",
      webhookSecret: process.env.OTT_WEBHOOK_SECRET || "",
      callbackUrl: process.env.OTT_CALLBACK_URL || ""
    },
    email: {
      provider: process.env.EMAIL_PROVIDER || "production",
      apiUrl: process.env.EMAIL_API_URL || "",
      apiKey: process.env.EMAIL_API_KEY || "",
      fromAddress: process.env.EMAIL_FROM_ADDRESS || "no-reply@notify.titopay.co.za",
      fromName: process.env.EMAIL_FROM_NAME || "TitoPay",
      replyTo: process.env.EMAIL_REPLY_TO || "support@titopay.co.za",
      smtpHost: process.env.SMTP_HOST || "",
      smtpPort: numberFromEnv("SMTP_PORT", 587),
      smtpSecure: booleanFromEnv("SMTP_SECURE", false),
      smtpUser: process.env.SMTP_USER || "",
      smtpPassword: process.env.SMTP_PASSWORD || "",
      smtpRejectUnauthorized: booleanFromEnv("SMTP_REJECT_UNAUTHORIZED", true)
    },
  sms: {
      provider: process.env.SMS_PROVIDER || "production",
      apiUrl: process.env.SMS_API_URL || "https://simcloud.co.za/api/sms.php",
      apiKey: process.env.SMS_API_KEY || "",
      apiSecret: process.env.SMS_API_SECRET || "",
      clientId: process.env.SMS_CLIENT_ID || "",
      clientSecret: process.env.SMS_CLIENT_SECRET || "",
      username: process.env.SMS_USERNAME || "",
      password: process.env.SMS_PASSWORD || "",
      senderId: process.env.SMS_SENDER_ID || "TitoPay",
      webhookSecret: process.env.SMS_WEBHOOK_SECRET || "",
      callbackUrl: process.env.SMS_CALLBACK_URL || ""
    }
  },
  allowedOrigins: Array.from(new Set([
    process.env.APP_ORIGIN || "https://app.titopay.co.za",
    "https://www.app.titopay.co.za",
    process.env.ADMIN_ORIGIN || "https://admin.titopay.co.za",
    "https://www.admin.titopay.co.za",
    process.env.HR_ORIGIN || "https://hr.titopay.co.za",
    "https://www.hr.titopay.co.za",
    ...listFromEnv("CORS_ORIGINS"),
    ...(includeLocalCorsOrigins ? localPreviewOrigins : [])
  ])),
  chatIceServers: [
    { urls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302").split(",").map((value) => value.trim()).filter(Boolean) },
    ...(process.env.TURN_URLS ? [{
      urls: process.env.TURN_URLS.split(",").map((value) => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || ""
    }] : [])
  ]
};

module.exports = { config };
