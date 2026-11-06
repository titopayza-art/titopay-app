// Configuration is read once from the environment. Development gets safe,
// obviously-fake defaults; production refuses to start without real values.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");

// Shared hosting (cPanel "Setup Node.js App") is easiest to configure with a
// .env file in the app folder. Values already in the environment win.
(function loadDotEnv() {
  const file = process.env.DOTENV_PATH || path.join(APP_ROOT, ".env");
  if (process.env.NODE_ENV === "test" || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const env = process.env;
const NODE_ENV = env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";
const isTest = NODE_ENV === "test";

const DEV_KEY = (label) => crypto.createHash("sha256").update(`ticketroom-dev-only:${label}`).digest("hex");

// In production a key comes from the environment, or else from a secrets
// file that is generated once on first start and kept OUTSIDE the web root
// (var/secrets.json, mode 600). Back this file up: losing it invalidates
// every ticket QR, tag registration and encrypted bank detail.
const SECRETS_FILE = env.SECRETS_FILE || path.join(APP_ROOT, "var", "secrets.json");
let fileSecrets;
function fileSecret(name) {
  if (!fileSecrets) {
    fileSecrets = fs.existsSync(SECRETS_FILE) ? JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")) : {};
  }
  if (!fileSecrets[name]) {
    fileSecrets[name] = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(fileSecrets, null, 2), { mode: 0o600 });
  }
  return fileSecrets[name];
}

function secret(name) {
  const value = env[name];
  if (value) {
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be 32 bytes as 64 hex characters`);
    return value;
  }
  if (isProd) return fileSecret(name);
  return DEV_KEY(name);
}

function int(name, fallback) {
  if (env[name] === undefined || env[name] === "") return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

const config = {
  env: NODE_ENV,
  isProd,
  isTest,
  port: int("PORT", 8080),
  databaseUrl: env.DATABASE_URL || (isProd ? null : "postgres://ticketroom:ticketroom_dev@127.0.0.1:5432/ticketroom"),
  publicBaseUrl: (env.PUBLIC_BASE_URL || (isProd ? "https://ticketroom.co.za" : "http://127.0.0.1:8080")).replace(/\/$/, ""),
  trustProxy: env.TRUST_PROXY === "true",
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : isProd,
  sessionDays: int("SESSION_DAYS", 14),

  keys: {
    qr: secret("QR_SIGNING_KEY"),
    tagPepper: secret("TAG_PEPPER"),
    data: secret("DATA_ENCRYPTION_KEY"),
    links: secret("LINK_SIGNING_KEY"),
  },

  payments: {
    // Gateway used for card payments: none | simulated | yoco | payfast
    // "none" (the production default until a gateway is configured) keeps
    // paid ticket sales closed; free events and everything else still work.
    provider: env.PAYMENT_PROVIDER || (isProd ? "none" : "simulated"),
    allowSimulated: env.ALLOW_SIMULATED_PROVIDER === "true" || !isProd,
    simWebhookSecret: secret("SIM_PROVIDER_WEBHOOK_SECRET"),
    webhookToleranceSeconds: int("WEBHOOK_TOLERANCE_SECONDS", 300),
  },

  // External API environments. Each integration runs against one of:
  //   mock    — a local stand-in (scripts/mock-services.js); development and tests
  //   sandbox — the provider's test environment with test credentials
  //   live    — real money / real messages
  // Base URLs can be overridden (e.g. to point at the mock) but default to
  // the provider's documented host for the chosen environment.
  integrations: {
    mockBaseUrl: (env.MOCK_SERVICES_URL || "http://127.0.0.1:8090").replace(/\/$/, ""),
    allowNonLive: env.ALLOW_NON_LIVE_INTEGRATIONS === "true" || !isProd,
    yoco: {
      env: env.YOCO_ENV || "sandbox",
      baseUrl: (env.YOCO_BASE_URL || (env.YOCO_ENV === "mock" ? `${(env.MOCK_SERVICES_URL || "http://127.0.0.1:8090")}/yoco` : "https://payments.yoco.com")).replace(/\/$/, ""),
      secretKey: env.YOCO_SECRET_KEY || (isProd ? "" : "sk_test_ticketroom_dev"),
      webhookSecret: env.YOCO_WEBHOOK_SECRET || (isProd ? "" : "whsec_ZGV2LXlvY28td2ViaG9vay1zZWNyZXQ="),
    },
    payfast: {
      env: env.PAYFAST_ENV || "sandbox",
      processUrl: env.PAYFAST_PROCESS_URL || (env.PAYFAST_ENV === "live" ? "https://www.payfast.co.za/eng/process" : env.PAYFAST_ENV === "mock" ? `${(env.MOCK_SERVICES_URL || "http://127.0.0.1:8090")}/payfast/eng/process` : "https://sandbox.payfast.co.za/eng/process"),
      validateUrl: env.PAYFAST_VALIDATE_URL || (env.PAYFAST_ENV === "live" ? "https://www.payfast.co.za/eng/query/validate" : env.PAYFAST_ENV === "mock" ? `${(env.MOCK_SERVICES_URL || "http://127.0.0.1:8090")}/payfast/eng/query/validate` : "https://sandbox.payfast.co.za/eng/query/validate"),
      merchantId: env.PAYFAST_MERCHANT_ID || (isProd ? "" : "10000100"),
      merchantKey: env.PAYFAST_MERCHANT_KEY || (isProd ? "" : "46f0cd694581a"),
      passphrase: env.PAYFAST_PASSPHRASE || (isProd ? "" : "ticketroom-dev-passphrase"),
    },
    bulksms: {
      env: env.BULKSMS_ENV || "sandbox",
      baseUrl: (env.BULKSMS_BASE_URL || (env.BULKSMS_ENV === "mock" ? `${(env.MOCK_SERVICES_URL || "http://127.0.0.1:8090")}/bulksms/v1` : "https://api.bulksms.com/v1")).replace(/\/$/, ""),
      tokenId: env.BULKSMS_TOKEN_ID || (isProd ? "" : "dev-token-id"),
      tokenSecret: env.BULKSMS_TOKEN_SECRET || (isProd ? "" : "dev-token-secret"),
    },
    clickatell: {
      env: env.CLICKATELL_ENV || "sandbox",
      baseUrl: (env.CLICKATELL_BASE_URL || (env.CLICKATELL_ENV === "mock" ? `${(env.MOCK_SERVICES_URL || "http://127.0.0.1:8090")}/clickatell` : "https://platform.clickatell.com")).replace(/\/$/, ""),
      apiKey: env.CLICKATELL_API_KEY || (isProd ? "" : "dev-clickatell-key"),
    },
    titopay: {
      enabled: env.TITOPAY_WALLET_ENABLED ? env.TITOPAY_WALLET_ENABLED === "true" : !isProd,
      env: env.TITOPAY_ENV || "mock",
      baseUrl: (env.TITOPAY_API_BASE || (env.TITOPAY_ENV === "live" ? "https://api.titopay.co.za" : env.TITOPAY_ENV === "sandbox" ? "https://sandbox-api.titopay.co.za" : `${(env.MOCK_SERVICES_URL || "http://127.0.0.1:8090")}/titopay`)).replace(/\/$/, ""),
      clientId: env.TITOPAY_CLIENT_ID || (isProd ? "" : "ticketroom-dev"),
      clientSecret: env.TITOPAY_CLIENT_SECRET || (isProd ? "" : "dev-client-secret"),
      webhookSecret: env.TITOPAY_WEBHOOK_SECRET || (isProd ? "" : "dev-titopay-webhook-secret"),
      timeoutMs: int("TITOPAY_TIMEOUT_MS", 10000),
    },
  },

  fees: {
    // Consumer booking fee per PAID ticket (default R10). Free tickets: none.
    ticketFeeFixedCents: int("BOOKING_FEE_CENTS", 1000),
    ticketFeeBps: int("BOOKING_FEE_BPS", 0),
    // Organiser commission on ticket sales (default 5%), deducted from payouts.
    // Can be overridden per organiser by an admin.
    organiserCommissionBps: int("ORGANISER_COMMISSION_BPS", 500),
  },

  orders: {
    holdMinutes: int("ORDER_HOLD_MINUTES", 10),
  },

  cashless: {
    maxBalanceCents: int("CASHLESS_MAX_BALANCE_CENTS", 500000),
    minTopupCents: int("CASHLESS_MIN_TOPUP_CENTS", 2000),
    maxTopupCents: int("CASHLESS_MAX_TOPUP_CENTS", 200000),
    maxSaleCents: int("POS_MAX_SALE_CENTS", 300000),
    pinThresholdCents: int("POS_PIN_THRESHOLD_CENTS", 20000),
    // UID-only tags are identifiers, not credentials. 0 = they cannot pay.
    uidOnlyMaxSaleCents: int("UID_ONLY_MAX_SALE_CENTS", 0),
  },

  messaging: {
    // log | smtp. With SMTP_HOST set, production sends through SMTP (e.g. the
    // hello@ticketroom.co.za mailbox on Afrihost).
    emailProvider: env.EMAIL_PROVIDER || (env.SMTP_HOST ? "smtp" : "log"),
    smtp: {
      host: env.SMTP_HOST || "",
      port: int("SMTP_PORT", 465),
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : int("SMTP_PORT", 465) === 465,
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
    },
    // log (records only) | bulksms | clickatell
    smsProvider: env.SMS_PROVIDER || "log",
    smsCostPerSegmentCents: int("SMS_COST_PER_SEGMENT_CENTS", 25),
    fromEmail: env.MAIL_FROM || "TicketRoom <hello@ticketroom.co.za>",
    smsSenderId: env.SMS_SENDER_ID || "TicketRoom",
  },

  retention: {
    webhookPayloadDays: int("RETENTION_WEBHOOK_PAYLOAD_DAYS", 90),
    messageDays: int("RETENTION_MESSAGE_DAYS", 180),
  },

  uploadDir: env.UPLOAD_DIR || path.join(APP_ROOT, "var", "uploads"),
  appRoot: APP_ROOT,
  // First-start admin account (only created when no admin exists yet).
  bootstrapAdmin: { email: env.ADMIN_EMAIL || "", password: env.ADMIN_PASSWORD || "", name: env.ADMIN_NAME || "TicketRoom Admin" },
  // Legal operator name shown in legal notices. Set OPERATOR_LEGAL_NAME to the
  // registered company name (and add the registration number in the Terms).
  operator: env.OPERATOR_LEGAL_NAME || "TicketRoom",
};

if (isProd) {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required in production");
  const i = config.integrations;
  for (const [k, v] of Object.entries({ YOCO: i.yoco.env, PAYFAST: i.payfast.env, BULKSMS: i.bulksms.env, CLICKATELL: i.clickatell.env, TITOPAY: i.titopay.env })) {
    if (v === "mock" && ((k === "YOCO" && config.payments.provider === "yoco") || (k === "PAYFAST" && config.payments.provider === "payfast") || (k === "BULKSMS" && config.messaging.smsProvider === "bulksms") || (k === "CLICKATELL" && config.messaging.smsProvider === "clickatell") || (k === "TITOPAY" && i.titopay.enabled))) {
      throw new Error(`${k}_ENV=mock is never allowed in production`);
    }
  }
  const needLive = (name, envName) => {
    if (envName !== "live" && !i.allowNonLive) throw new Error(`${name} is in "${envName}" mode. Production needs "live" (or ALLOW_NON_LIVE_INTEGRATIONS=true for a staging deployment).`);
  };
  const p = config.payments.provider;
  if (p === "yoco") { needLive("YOCO", i.yoco.env); if (!i.yoco.secretKey || !i.yoco.webhookSecret) throw new Error("YOCO_SECRET_KEY and YOCO_WEBHOOK_SECRET are required"); }
  if (p === "payfast") { needLive("PAYFAST", i.payfast.env); if (!i.payfast.merchantId || !i.payfast.merchantKey || !i.payfast.passphrase) throw new Error("PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY and PAYFAST_PASSPHRASE are required"); }
  const sms = config.messaging.smsProvider;
  if (sms === "bulksms") { needLive("BULKSMS", i.bulksms.env); if (!i.bulksms.tokenId || !i.bulksms.tokenSecret) throw new Error("BULKSMS_TOKEN_ID and BULKSMS_TOKEN_SECRET are required"); }
  if (sms === "clickatell") { needLive("CLICKATELL", i.clickatell.env); if (!i.clickatell.apiKey) throw new Error("CLICKATELL_API_KEY is required"); }
  if (i.titopay.enabled) { needLive("TITOPAY", i.titopay.env); if (!i.titopay.clientId || !i.titopay.clientSecret || !i.titopay.webhookSecret) throw new Error("TITOPAY_CLIENT_ID, TITOPAY_CLIENT_SECRET and TITOPAY_WEBHOOK_SECRET are required when the TitoPay wallet is enabled"); }
  if (config.messaging.emailProvider === "smtp" && (!config.messaging.smtp.host || !config.messaging.smtp.user || !config.messaging.smtp.pass)) {
    throw new Error("EMAIL_PROVIDER=smtp needs SMTP_HOST, SMTP_USER and SMTP_PASS");
  }
  if (config.payments.provider === "simulated" && !config.payments.allowSimulated) {
    throw new Error("PAYMENT_PROVIDER=simulated is refused in production. Configure an approved provider adapter.");
  }
}

module.exports = config;
