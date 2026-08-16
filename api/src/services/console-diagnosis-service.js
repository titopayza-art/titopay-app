"use strict";

// WHY IS A PAGE IN THE ADMIN CONSOLE NOT WORKING?
//
// The console answers "Unable to complete this admin action" for every
// server-side failure, on purpose: an operator screen must not print database
// errors, table names or stack traces to whoever is looking at it. That is
// right for the console and useless for the person who has to fix it.
//
// This is the same failure set with the detail put back. It used to live only
// in scripts/diagnose-admin-console.js, which meant the one tool that could
// name the real cause was the one tool you needed a shell to reach — and the
// shell is exactly what you do not have at two in the morning. The logic moved
// here so the script and the console read the SAME answer and can never drift
// apart: the script prints what this returns, and the endpoint returns it.
//
// THREE RULES.
//
//   1. IT ONLY READS. Every probe is a SELECT. The three save probes at the
//      end DO issue writes, because a read that works while a save fails is
//      the whole shape of the problem, but each one runs inside a transaction
//      that is ALWAYS rolled back. It creates, alters and deletes nothing, so
//      it is safe against production at any time.
//   2. IT NEVER THROWS. A diagnosis that dies on the first failure diagnoses
//      nothing. Every probe catches its own error and reports it as a result.
//   3. WHAT IT RETURNS IS FOR OPERATORS ONLY. It contains real table names and
//      real Postgres errors, so the endpoint that serves it is super-admin
//      only and its output must never reach a customer.

const { pool } = require("../db/pool");
const { API_BUILD } = require("../build-info");

// The tables each console page needs. A page whose tables are all present but
// which still fails is a different problem, and the probes below catch that.
//
// This is also what the Database Health page checks. It used to check a
// hardcoded list of fifteen tables written when the platform was much smaller,
// against a schema that is now well past a hundred and fifty: it could report
// everything green while the tables behind a broken screen were missing.
const PAGE_TABLES = {
  "Compliance Dashboard": [
    "compliance_flags", "compliance_screening_list", "compliance_config_versions",
    "money_integrity_alerts", "regulatory_report_events", "pending_credits",
    "reconciliation_exceptions", "kyc_reviews", "kyc_verifications"
  ],
  "Revenue": ["revenue_ledger", "wallets", "transactions"],
  "Settings and Maintenance": ["platform_settings", "audit_logs"],
  "Security Content": ["platform_settings", "admin_users"],
  "Security and Audit": ["security_logs", "security_events", "trusted_devices", "audit_logs"],
  "Ticketing": ["events", "event_ticket_types", "ticket_orders", "ticket_refunds", "tickets"],
  "Users and Wallets": ["users", "wallets", "transactions", "wallet_ledger"],
  "Merchants": ["merchants", "merchant_wallets"],
  "Support Desk": ["support_tickets"],
  "Email Centre": ["email_queue", "email_templates"],
  "Marketing": ["marketing_campaigns", "marketing_leads", "announcement_campaigns",
    "announcement_approvals", "announcement_reads"],
  "Pricing": ["pricing_rules"],
  "Beneficiaries": ["beneficiaries"],
  "Stokvels": ["stockvel_groups", "stockvel_members"],
  "TitoKids": ["titokids_children"],
  "Enterprise Distribution": ["enterprise_distribution_applications"],
  "Business Verification": ["business_profiles", "business_representatives", "business_verifications"],
  "HR Portal": ["hr_employees"],
  // Role permission overrides are a platform_settings KEY, not a table of
  // their own, so admin_users is the whole storage requirement here.
  "Staff and Roles": ["admin_users"]
};

// Read-only probes that run the same query shape the failing endpoints run.
// Each one names the console page it stands behind.
const PROBES = [
  ["Compliance Dashboard", "compliance overview counts",
    "SELECT COUNT(*)::INT FROM compliance_flags"],
  ["Compliance Dashboard", "money integrity alerts",
    "SELECT COUNT(*)::INT FROM money_integrity_alerts"],
  ["Compliance Dashboard", "reconciliation exceptions",
    "SELECT COUNT(*)::INT FROM reconciliation_exceptions WHERE status = 'open'"],
  ["Compliance Dashboard", "sanctions screening list",
    "SELECT COUNT(*)::INT FROM compliance_screening_list"],
  ["Compliance Dashboard", "regulatory report evidence",
    "SELECT COUNT(*)::INT FROM regulatory_report_events"],
  ["Compliance Dashboard", "held payments",
    "SELECT COUNT(*)::INT FROM pending_credits"],
  ["Compliance Dashboard", "limit config versions",
    "SELECT COUNT(*)::INT FROM compliance_config_versions"],
  ["Compliance Dashboard", "risk status column on users",
    "SELECT COALESCE(risk_status,'normal') AS risk, COUNT(*)::INT FROM users GROUP BY 1"],
  ["Compliance Dashboard", "the FICA review queue",
    "SELECT COUNT(*)::INT FROM kyc_reviews"],
  ["Revenue", "revenue by service",
    "SELECT service_code, SUM(fee_collected)::NUMERIC FROM revenue_ledger GROUP BY service_code"],
  ["Revenue", "revenue wallet exists",
    "SELECT id FROM wallets WHERE kind = 'revenue' AND user_id IS NULL LIMIT 1"],
  ["Settings and Maintenance", "platform settings readable",
    "SELECT key FROM platform_settings LIMIT 1"],
  ["Settings and Maintenance", "the maintenance mode setting",
    "SELECT value FROM platform_settings WHERE key = 'maintenance_mode' LIMIT 1"],
  ["Settings and Maintenance", "audit log writable shape",
    "SELECT id, actor_type, action, entity_type, entity_id, metadata FROM audit_logs LIMIT 1"],
  ["Ticketing", "ticket orders",
    "SELECT COUNT(*)::INT FROM ticket_orders"],
  ["Users and Wallets", "wallet balances",
    "SELECT COUNT(*)::INT FROM wallets"],
  ["Business Verification", "business profiles",
    "SELECT COUNT(*)::INT FROM business_profiles"]
];

// The save statements behind the buttons that report "Unable to complete this
// admin action". Reads passing while writes fail is the exact shape of "Save
// Maintenance Mode did nothing", so the saves are attempted too.
function writeProbes(actorId) {
  return [
    ["Save Maintenance Mode", `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('__diagnose_probe', '{}'::JSONB, $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [actorId]],
    ["Save Security Content", `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('__diagnose_probe2', '{"a":1}'::JSONB, $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [actorId]],
    ["Save Limits", `INSERT INTO compliance_config_versions (id, config_key, value, reason, created_by)
       VALUES (gen_random_uuid(), '__diagnose_probe', '{}'::JSONB, 'diagnosis probe', $1)`, [actorId]],
    ["Any audited admin action", `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES (gen_random_uuid(), 'admin', $1, 'diagnose_probe', 'platform_settings', NULL, '{}'::JSONB)`, [actorId]]
  ];
}

function errorDetail(error) {
  // Postgres puts the useful part in `message`; `code` tells an engineer the
  // class of fault without needing the sentence parsed.
  return { message: String(error?.message || error), code: error?.code || null };
}

async function tablesPresent() {
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  return new Set(rows.map((row) => row.tablename));
}

// Which company supplies which capability. "Is the identity provider live?"
// used to be unanswerable from outside, because the console showed a vendor
// name it had never called.
function providerSummary() {
  try {
    require("../providers/payment-provider");
    require("../providers/payout-provider");
    require("../providers/kyc-provider");
    require("../providers/vas-provider");
    return require("../providers").describeProviders().map((entry) => ({
      ...entry,
      state: entry.configured === "none" ? "none" : entry.registered ? "wired" : "missing"
    }));
  } catch (error) {
    return [{ capability: "provider registry", state: "missing", error: errorDetail(error).message }];
  }
}

async function runConsoleDiagnosis({ actorId = null } = {}) {
  const startedAt = new Date().toISOString();

  let present = null;
  let databaseError = null;
  try {
    present = await tablesPresent();
  } catch (error) {
    databaseError = errorDetail(error);
  }

  if (!present) {
    // Rule 2: even total failure is a result, not an exception.
    return {
      startedAt, apiBuild: API_BUILD, reachable: false, databaseError,
      tableCount: 0, pages: [], probes: [], writes: [], notes: {}, providers: providerSummary(),
      verdict: {
        ok: false,
        headline: "The API could not reach the database at all.",
        guidance: "Check POSTGRES_URL (or DATABASE_URL) in the API's environment. Nothing else in this report could be measured."
      }
    };
  }

  const pages = Object.entries(PAGE_TABLES).map(([page, tables]) => ({
    page,
    required: tables,
    missing: tables.filter((table) => !present.has(table))
  }));

  const probes = [];
  for (const [page, what, sql] of PROBES) {
    try {
      await pool.query(sql);
      probes.push({ page, what, ok: true });
    } catch (error) {
      probes.push({ page, what, ok: false, error: errorDetail(error) });
    }
  }

  // Every write runs inside a transaction that is always rolled back.
  const writes = [];
  for (const [what, sql, params] of writeProbes(actorId)) {
    const client = await pool.connect().catch(() => null);
    if (!client) {
      writes.push({ what, ok: false, error: { message: "No database connection available.", code: null } });
      continue;
    }
    try {
      await client.query("BEGIN");
      await client.query(sql, params);
      writes.push({ what, ok: true });
    } catch (error) {
      writes.push({ what, ok: false, error: errorDetail(error) });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  // Five files declare platform_settings and they disagree: three put a
  // foreign key on updated_by, two do not. CREATE TABLE IF NOT EXISTS means
  // whichever ran FIRST on this database is the one that exists, forever, and
  // it changes what a save will accept. Report which, and which columns the
  // table actually has, because a missing column is the other candidate.
  const notes = {};
  // pg_class.relname is NOT schema-qualified, so without the namespace join
  // this counted every platform_settings in the database and reported the sum
  // as if it were one table's keys. A production database with archived or
  // restored schemas alongside public read 35 where the real answer was 1, and
  // a number like that reads as a fault when nothing is wrong. The columns
  // query below has always filtered to public; this now agrees with it.
  notes.platformSettingsForeignKeys = await pool.query(`
    SELECT COUNT(*)::INT AS n FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'public' AND t.relname = 'platform_settings' AND c.contype = 'f'`)
    .then((r) => r.rows[0].n).catch(() => null);
  notes.platformSettingsColumns = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'platform_settings'
     ORDER BY ordinal_position`)
    .then((r) => r.rows.map((row) => row.column_name)).catch(() => null);
  notes.appliedMigrations = await pool.query(
    "SELECT COUNT(*)::INT AS n FROM schema_migrations")
    .then((r) => r.rows[0].n).catch(() => null);

  const missingByPage = pages.filter((entry) => entry.missing.length);
  const failingProbes = probes.filter((entry) => !entry.ok);
  const failingWrites = writes.filter((entry) => !entry.ok);
  const ok = !missingByPage.length && !failingProbes.length && !failingWrites.length;

  return {
    startedAt,
    apiBuild: API_BUILD,
    reachable: true,
    databaseError: null,
    tableCount: present.size,
    pages,
    probes,
    writes,
    notes,
    providers: providerSummary(),
    verdict: {
      ok,
      headline: ok
        ? "Every table, query and save the console needs is working."
        : missingByPage.length
          ? `${missingByPage.length} console page${missingByPage.length === 1 ? "" : "s"} ${missingByPage.length === 1 ? "is" : "are"} missing tables.`
          : "The tables exist, but a query or a save still fails.",
      guidance: ok
        ? "If a page still fails, the cause is not the database. Check the API log for the request, and confirm the signed-in admin holds the permission that page requires."
        : missingByPage.length
          // NOT src/db/init.js. That applies the same schema files and then
          // writes the shipped pricing schedule over pricing_rules, forcing
          // enabled = TRUE on every one, which discards fees an operator has
          // set in the console. It is the right command for a new database and
          // the wrong one here. scripts/repair-schema.js is init.js without
          // that step.
          ? "Create them from the shipped schema with `node scripts/repair-schema.js`, which is safe to re-run because every statement is CREATE TABLE IF NOT EXISTS and it never writes pricing, then apply any pending migration with `node scripts/apply-migrations.js` and run this diagnosis again."
          : "This is a column or type difference rather than a missing table. The exact database error is on each failing row; that is the thing to fix."
    }
  };
}

module.exports = {
  PAGE_TABLES,
  PROBES,
  runConsoleDiagnosis
};
