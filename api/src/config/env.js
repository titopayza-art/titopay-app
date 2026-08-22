const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), "api/.env") });
dotenv.config();

// A CONFIGURATION PROBLEM MUST NEVER BE AN OUTAGE.
//
// This is the lesson of 20 August 2026. Build 71 added a required variable, the
// process refused to start without it, and from behind nginx a process that
// refuses to start is a 502 with no explanation. Refusing to start is the
// LOUDEST possible complaint and the LEAST useful one: nobody can read the
// reason, because the thing that would have served it is dead.
//
// So nothing in this file throws any more. Every problem becomes a startup
// warning that is printed at boot, counted on GET /health, and listed by
// `node preflight.js`. The API comes up and TELLS you what is wrong, which is
// strictly more informative than a blank 502, and it keeps serving every
// customer whose request has nothing to do with the misconfigured thing.
//
// The security floors below are unchanged in what they consider wrong. They
// changed only in what they do about it.
const startupWarnings = [];

function warn(message) {
  startupWarnings.push(message);
  return undefined;
}

function requiredAnyOrWarn(names, { why = "" } = {}) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  warn(`${names.join(" or ")} is not set.${why ? ` ${why}` : ""}`);
  return "";
}

const GENERATE_HINT =
  "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"";

// A SECRET THAT EXISTS IS NOT THE SAME AS A SECRET THAT IS STRONG.
//
// A short signing key means anyone who guesses it can mint a token for any
// customer or admin. That is worth shouting about on every boot. It is not
// worth taking the platform down for, which only guarantees that nobody can
// read the shout.
//
// When no secret is set at all we generate a random one for this process rather
// than signing with an empty string. Tokens then stop verifying across a
// restart, which logs people out and is survivable, instead of being forgeable
// by anybody, which is not.
function requiredSecret(names, minBytes = 32) {
  const value = requiredAnyOrWarn(names, { why: `Signing keys must be at least ${minBytes} bytes. ${GENERATE_HINT}` });
  if (!value) {
    warn(`${names[0]} is missing, so this process generated a random one. Every restart will sign customers out until you set it.`);
    return require("crypto").randomBytes(48).toString("base64url");
  }
  if (Buffer.byteLength(value, "utf8") < minBytes) {
    warn(
      `${names[0]} is ${Buffer.byteLength(value, "utf8")} bytes; the minimum is ${minBytes}. ` +
      `A key this short is guessable, and a guessed key forges any session. ${GENERATE_HINT}`
    );
  }
  return value;
}

// THE KEY THAT MAKES AN IDENTITY HASH WORTH HASHING.
//
// Identity numbers were digested with a constant in-source prefix, which is a
// domain separator and not a secret, so a dumped users table gave up every
// customer's ID number: the valid South African ID space is about 1.46 billion
// numbers and a single GPU walks it in under a second. Keying the digest with a
// secret held outside the database is what makes a dump useless on its own.
//
// An explicit IDENTITY_PEPPER is what production SHOULD have, and not having it
// is warned about on every boot. It is no longer refused, because refusing it
// took the platform down on 20 August and a dead process cannot explain itself.
// The fallback derives the pepper from the access secret, which still lives
// outside the database, so a stolen dump is still useless on its own. The cost
// is that identity hashes are then tied to a key that ought to be rotatable,
// which is why the warning says to set the real thing.
function identityPepperFromEnv(environment) {
  const raw = String(process.env.IDENTITY_PEPPER || "").trim();
  if (raw) {
    if (Buffer.byteLength(raw, "utf8") < 32) {
      warn(`IDENTITY_PEPPER is ${Buffer.byteLength(raw, "utf8")} bytes; the minimum is 32. ` +
        "A short pepper is brute-forceable alongside the ID space it protects. " + GENERATE_HINT);
    }
    return raw;
  }
  if (environment === "production") {
    warn(
      "IDENTITY_PEPPER is not set. Identity numbers are being keyed with a value DERIVED from " +
      "JWT_ACCESS_SECRET instead. That is still a real secret held outside the database, so a stolen " +
      "database dump does not give up ID numbers, but it ties identity hashes to a key that should be " +
      "rotatable. Set an explicit IDENTITY_PEPPER, once, and never change it. " + GENERATE_HINT
    );
  }
  // The derivation, in production and out of it. HMAC under the access secret,
  // which lives outside the database, so a dump alone is still useless. The
  // legacy digest is written alongside it, so sanctions screening keeps matching
  // either way while an explicit pepper is still being set.
  return require("crypto")
    .createHmac("sha256", requiredAnyOrWarn(["JWT_ACCESS_SECRET", "JWT_SECRET"]) || "titopay-unconfigured")
    .update("titopay-identity-pepper-v1")
    .digest("hex");
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    warn(`${name} is not a number ("${String(raw).slice(0, 40)}"); using the default ${fallback}.`);
    return Number(fallback);
  }
  return value;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name] ?? fallback;
  return !["false", "0", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function adminOtpRequiredFromEnv() {
  // Secure by default: admin sign-in requires email OTP unless an operator
  // explicitly opts out (ADMIN_OTP_REQUIRED=false) as a documented break-glass.
  // This only seeds the initial policy / the DB-unavailable fallback; once a
  // Super Admin saves a choice, the persisted admin_authentication setting wins.
  if (process.env.ADMIN_OTP_REQUIRED !== undefined) {
    return booleanFromEnv("ADMIN_OTP_REQUIRED", true);
  }
  return booleanFromEnv("VERIFY_ADMIN_OTP", true);
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
  postgresUrl: requiredAnyOrWarn(["POSTGRES_URL", "DATABASE_URL"], {
    why: "The API will start and answer /health, but every request needing data will fail until it is set."
  }),
  accessSecret: requiredSecret(["JWT_ACCESS_SECRET", "JWT_SECRET"]),
  refreshSecret: requiredSecret(["JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"]),
  identityPepper: identityPepperFromEnv(envName),
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
      // LEFT EXACTLY AS IT WAS, DELIBERATELY.
      //
      // This defaulting to "production" when unset is the fail-open that
      // config/deployment-safety.js exists to surface, and the obvious move
      // was to change it here. That turned out to be the wrong place: this
      // value is read by GET /v1/integrations, which would then report an
      // empty provider where it has always reported "production", and that is
      // a live response shape changing for a reason that has nothing to do
      // with the caller.
      //
      // The safety layer reads process.env DIRECTLY and never consults this,
      // so it loses nothing by this staying put. An undeclared deployment
      // therefore behaves byte for byte as it did before, and is merely told
      // about itself at startup and on /health.
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
      // Left as it was. See the note on peachPayments.mode above.
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
      // Left as it was. See the note on peachPayments.mode above.
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
    process.env.DEVELOPERS_ORIGIN || "https://developers.titopay.co.za",
    "https://www.developers.titopay.co.za",
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

// Read by server.js to print at boot, by GET /health to count, and by
// preflight.js so an operator sees the same list before restarting.
module.exports = { config, startupWarnings };
