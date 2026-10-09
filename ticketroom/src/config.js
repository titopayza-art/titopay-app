// Configuration is read once from the environment. Development gets safe,
// obviously-fake defaults; production refuses to start without real values.
const crypto = require("crypto");

const env = process.env;
const NODE_ENV = env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";
const isTest = NODE_ENV === "test";

const DEV_KEY = (label) => crypto.createHash("sha256").update(`ticketroom-dev-only:${label}`).digest("hex");

function secret(name) {
  const value = env[name];
  if (value) {
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be 32 bytes as 64 hex characters`);
    return value;
  }
  if (isProd) throw new Error(`${name} is required in production`);
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
    provider: env.PAYMENT_PROVIDER || "simulated",
    allowSimulated: env.ALLOW_SIMULATED_PROVIDER === "true" || !isProd,
    simWebhookSecret: secret("SIM_PROVIDER_WEBHOOK_SECRET"),
    webhookToleranceSeconds: int("WEBHOOK_TOLERANCE_SECONDS", 300),
  },

  fees: {
    // Buyer-paid service fee per paid ticket: fixed + basis points of price.
    ticketFeeBps: int("PLATFORM_FEE_BPS", 450),
    ticketFeeFixedCents: int("PLATFORM_FEE_FIXED_CENTS", 300),
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
    emailProvider: env.EMAIL_PROVIDER || "log",
    smsProvider: env.SMS_PROVIDER || "log",
    smsCostPerSegmentCents: int("SMS_COST_PER_SEGMENT_CENTS", 25),
    fromEmail: env.MAIL_FROM || "TicketRoom <no-reply@ticketroom.co.za>",
    smsSenderId: env.SMS_SENDER_ID || "TicketRoom",
  },

  retention: {
    webhookPayloadDays: int("RETENTION_WEBHOOK_PAYLOAD_DAYS", 90),
    messageDays: int("RETENTION_MESSAGE_DAYS", 180),
  },

  uploadDir: env.UPLOAD_DIR || require("path").resolve(__dirname, "..", "var", "uploads"),
  operator: "TitoPay (Pty) Ltd",
};

if (isProd) {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required in production");
  if (config.payments.provider === "simulated" && !config.payments.allowSimulated) {
    throw new Error("PAYMENT_PROVIDER=simulated is refused in production. Configure an approved provider adapter.");
  }
}

module.exports = config;
