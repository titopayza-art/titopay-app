"use strict";

const { pool } = require("../src/db/pool");
const { ADMIN_ROLE_PERMISSIONS, getAdminRolePermissions, isRootAdminRole } = require("../src/services/auth-service");

const API_BASE = (process.env.API_BASE || process.env.VERIFY_API_BASE || "https://api.titopay.co.za/v1").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_ACCESS_TOKEN || process.env.TITOPAY_ADMIN_TOKEN || "";

const REQUIRED_ENV_GROUPS = [
  ["POSTGRES_URL", "DATABASE_URL"],
  ["JWT_ACCESS_SECRET", "JWT_SECRET"],
  ["JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"]
];

const RECOMMENDED_ENV_GROUPS = [
  ["COOKIE_SECRET"],
  ["APP_ORIGIN"],
  ["ADMIN_ORIGIN"],
  ["SMS_API_KEY"],
  ["SMS_SENDER_ID"],
  ["PEACH_PAYMENTS_BASE_URL"],
  ["PEACH_PAYMENTS_ENTITY_ID", "PEACH_PAYMENTS_MERCHANT_ID"],
  ["PEACH_PAYMENTS_API_KEY"],
  ["DOCFOX_BASE_URL"],
  ["OTT_BASE_URL"],
  ["FLASH_BASE_URL"],
  ["STUN_URLS"],
  ["TURN_URLS"]
];

const REQUIRED_TABLES = [
  "admin_users",
  "platform_settings",
  "users",
  "wallets",
  "merchants",
  "merchant_wallets",
  "pricing_rules",
  "service_config",
  "sessions",
  "otp_codes",
  "qr_codes",
  "transactions",
  "notifications",
  "trusted_devices",
  "active_sessions",
  "security_events",
  "duplicate_account_flags",
  "login_attempts",
  "remote_logout_events",
  "pin_attempts",
  "user_qr_codes",
  "business_qr_codes",
  "wallet_ledger",
  "revenue_ledger",
  "support_tickets",
  "kyc_reviews",
  "audit_logs",
  "security_logs",
  "chat_threads",
  "chat_messages",
  "chat_call_logs"
];

const REQUIRED_COLUMNS = {
  users: [
    "id",
    "account_type",
    "full_name",
    "username",
    "email",
    "phone",
    "password_hash",
    "status",
    "profile_locked",
    "fica_status",
    "failed_login_attempts",
    "locked_until",
    "last_failed_login_at"
  ],
  wallets: [
    "id",
    "wallet_number",
    "user_id",
    "kind",
    "currency",
    "available_balance",
    "reserved_balance",
    "status"
  ],
  pricing_rules: [
    "id",
    "service_code",
    "service_name",
    "fee_type",
    "fee_value",
    "flat_fee",
    "percentage_fee",
    "minimum_fee",
    "maximum_fee",
    "vat_percentage",
    "enabled",
    "effective_date",
    "active"
  ],
  sessions: ["id", "user_type", "user_id", "scope", "refresh_token_hash", "access_jti", "expires_at", "revoked_at"],
  active_sessions: ["id", "user_id", "admin_user_id", "session_id", "active", "created_at", "last_seen_at", "revoked_at"],
  otp_codes: ["id", "user_type", "user_id", "purpose", "code_hash", "channels", "attempts", "expires_at", "used_at"],
  user_qr_codes: ["id", "user_id", "qr_code_id", "status", "created_at"],
  business_qr_codes: ["id", "user_id", "qr_code_id", "status", "created_at"],
  qr_codes: ["id", "user_id", "merchant_id", "code_type", "amount", "status", "reference", "payload", "image_svg", "image_data_url"],
  transactions: ["id", "user_id", "wallet_id", "service_code", "amount", "fee", "total", "status", "direction", "reference"],
  chat_threads: ["id", "participant_one_id", "participant_two_id", "status", "metadata", "created_at", "updated_at"],
  chat_messages: ["id", "thread_id", "sender_user_id", "body", "status", "delivered_at", "read_at", "created_at"],
  chat_call_logs: ["id", "thread_id", "caller_user_id", "recipient_user_id", "call_type", "status", "started_at"],
  notifications: ["id", "user_id", "admin_user_id", "channel", "notification_type", "status", "metadata", "created_at"],
  platform_settings: ["key", "value", "updated_by", "created_at", "updated_at"],
  audit_logs: ["id", "actor_type", "actor_id", "action", "entity_type", "metadata", "created_at"],
  security_logs: ["id", "actor_type", "actor_id", "event_type", "severity", "success", "metadata", "created_at"]
};

const PRICING_CODES = [
  "wallet_transfer",
  "bank_transfer",
  "cash_withdrawal",
  "cash_deposit",
  "merchant_qr",
  "personal_qr",
  "qr_payment",
  "airtime",
  "data",
  "electricity",
  "flash",
  "ott",
  "vouchers",
  "gift_cards",
  "stockvel",
  "business_wallet",
  "personal_wallet",
  "send_money",
  "merchant_payouts",
  "marketplace"
];

const ADMIN_ENDPOINTS = [
  "/admin/me",
  "/admin/dashboard/overview",
  "/admin/users",
  "/admin/wallets",
  "/admin/chat-monitor/overview",
  "/admin/global-search?q=test",
  "/pricing",
  "/admin/transactions",
  "/admin/merchants",
  "/admin/module-health",
  "/admin/support/tickets",
  "/admin/support/conversations",
  "/admin/compliance/queue",
  "/admin/revenue",
  "/admin/security",
  "/admin/security-summary",
  "/admin/integrations/config",
  "/admin/integrations/health",
  "/admin/integrations/logs",
  "/admin/integrations/webhooks",
  "/admin/provider-routing",
  "/admin/features",
  "/admin/company-documents",
  "/admin/marketing/sms-campaigns",
  "/admin/audit",
  "/admin/roles"
];

function groupPresent(names) {
  return names.some((name) => Boolean(process.env[name]));
}

function line(status, label, details = "") {
  const prefix = status === "pass" ? "PASS" : status === "warn" ? "WARN" : "FAIL";
  console.log(`${prefix} ${label}${details ? ` - ${details}` : ""}`);
}

async function checkEnvironment(report) {
  const missingRequired = REQUIRED_ENV_GROUPS.filter((group) => !groupPresent(group));
  const missingRecommended = RECOMMENDED_ENV_GROUPS.filter((group) => !groupPresent(group));
  report.environment = {
    requiredOk: missingRequired.length === 0,
    missingRequired: missingRequired.map((group) => group.join(" or ")),
    missingRecommended: missingRecommended.map((group) => group.join(" or "))
  };
  if (missingRequired.length) {
    for (const group of missingRequired) line("fail", "required environment", group.join(" or "));
  } else {
    line("pass", "required environment", "database and JWT secrets are configured");
  }
  for (const group of missingRecommended) line("warn", "recommended environment missing", group.join(" or "));
}

async function checkDatabase(report) {
  const tableResult = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1)
     ORDER BY table_name`,
    [REQUIRED_TABLES]
  );
  const foundTables = new Set(tableResult.rows.map((row) => row.table_name));
  const missingTables = REQUIRED_TABLES.filter((table) => !foundTables.has(table));

  const columnResult = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1)
     ORDER BY table_name, ordinal_position`,
    [Object.keys(REQUIRED_COLUMNS)]
  );
  const columnsByTable = new Map();
  for (const row of columnResult.rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  }
  const missingColumns = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const found = columnsByTable.get(table) || new Set();
    for (const column of columns) {
      if (!found.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  const walletConstraint = await pool.query(
    `SELECT COUNT(*)::INT AS invalid
     FROM wallets
     WHERE wallet_number IS NULL
        OR wallet_number !~ '^[0-9]{1,10}$'`
  ).catch((error) => ({ rows: [{ invalid: -1, error: error.message }] }));

  report.database = {
    missingTables,
    missingColumns,
    invalidWalletNumbers: walletConstraint.rows[0]?.invalid
  };

  if (missingTables.length) line("fail", "database tables", missingTables.join(", "));
  else line("pass", "database tables", `${REQUIRED_TABLES.length} required tables found`);
  if (missingColumns.length) line("fail", "database columns", missingColumns.join(", "));
  else line("pass", "database columns", "required runtime columns found");
  if (walletConstraint.rows[0]?.invalid === 0) line("pass", "wallet IDs", "all wallet_number values are numeric and max 10 digits");
  else line("fail", "wallet IDs", `invalid rows: ${walletConstraint.rows[0]?.invalid}`);
}

async function checkPricing(report) {
  const result = await pool.query(
    "SELECT service_code FROM pricing_rules WHERE service_code = ANY($1)",
    [PRICING_CODES]
  );
  const found = new Set(result.rows.map((row) => row.service_code));
  const missing = PRICING_CODES.filter((code) => !found.has(code));
  report.pricing = { missing };
  if (missing.length) line("fail", "pricing defaults", missing.join(", "));
  else line("pass", "pricing defaults", `${PRICING_CODES.length} pricing rules found`);
}

async function checkRbac(report) {
  const ceo = getAdminRolePermissions("CEO");
  const superAdmin = getAdminRolePermissions("super admin");
  const ok = isRootAdminRole("CEO") && isRootAdminRole("super_admin") && ceo.includes("*") && superAdmin.includes("*");
  report.rbac = {
    ceoRoot: isRootAdminRole("CEO"),
    superAdminRoot: isRootAdminRole("super_admin"),
    ceoPermissions: ceo,
    superAdminPermissions: superAdmin,
    roles: Object.keys(ADMIN_ROLE_PERMISSIONS)
  };
  line(ok ? "pass" : "fail", "RBAC", ok ? "CEO and Super Admin have unrestricted access" : "CEO/Super Admin permission mismatch");
}

async function checkEndpoint(endpoint) {
  const startedAt = Date.now();
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      Accept: "application/json",
      ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {})
    }
  });
  const body = await response.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch (_error) {
    json = null;
  }
  return {
    endpoint,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    requestId: json?.requestId || response.headers.get("x-request-id") || null,
    error: json?.error || null,
    bodyPreview: body.slice(0, 240)
  };
}

async function checkAdminEndpoints(report) {
  if (!ADMIN_TOKEN) {
    report.adminEndpoints = {
      skipped: true,
      reason: "ADMIN_ACCESS_TOKEN is not set"
    };
    line("warn", "admin endpoint audit", "set ADMIN_ACCESS_TOKEN to test protected production pages");
    return;
  }
  const results = [];
  for (const endpoint of ADMIN_ENDPOINTS) {
    try {
      const result = await checkEndpoint(endpoint);
      results.push(result);
      line(result.status >= 500 ? "fail" : result.ok ? "pass" : "warn", `${result.status} ${endpoint}`, `${result.durationMs}ms${result.error ? ` ${result.error}` : ""}`);
    } catch (error) {
      const result = { endpoint, status: 0, ok: false, error: error.message };
      results.push(result);
      line("fail", `000 ${endpoint}`, error.message);
    }
  }
  report.adminEndpoints = {
    apiBase: API_BASE,
    tested: results.length,
    failures: results.filter((item) => !item.ok),
    http500: results.filter((item) => item.status >= 500)
  };
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE
  };
  await checkEnvironment(report);
  await checkDatabase(report);
  await checkPricing(report);
  await checkRbac(report);
  await checkAdminEndpoints(report);

  const criticalFailures = [
    ...report.environment.missingRequired,
    ...report.database.missingTables,
    ...report.database.missingColumns,
    ...(report.database.invalidWalletNumbers === 0 ? [] : [`invalid wallet_number rows: ${report.database.invalidWalletNumbers}`]),
    ...report.pricing.missing,
    ...(report.adminEndpoints?.http500 || []).map((item) => `${item.status} ${item.endpoint}`)
  ];

  console.log("\nProduction backend audit report:");
  console.log(JSON.stringify(report, null, 2));

  if (criticalFailures.length) {
    console.error("\nCritical backend audit failures:");
    for (const failure of criticalFailures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("\nProduction backend audit passed with no critical failures.");
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ status: "failed", error: error.message, stack: error.stack }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
