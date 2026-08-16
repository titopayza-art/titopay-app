"use strict";

// WHY IS A PAGE IN THE ADMIN CONSOLE NOT WORKING?
//
// The console answers "Unable to complete this admin action" and "Requires API
// build N" for every server-side failure, on purpose: an operator screen must
// not print database errors, table names or stack traces to whoever is looking
// at it. That is right for the console and useless for the person who has to
// fix it, so this reports the same failures with the detail put back.
//
// It uses the API's own connection settings, so it needs no psql, no
// credentials typed at a prompt and no database client installed. Run it from
// the API directory, the same place `npm start` runs from:
//
//     node scripts/diagnose-admin-console.js
//
// Reads run as themselves. The save probes at the end DO issue writes, because
// a read that works while a save fails is the whole shape of the problem, but
// every one of them runs inside a transaction that is always rolled back. It
// creates, alters and deletes nothing, so it is safe against production.

require("../src/config/env");
const { pool } = require("../src/db/pool");
const { API_BUILD } = require("../src/build-info");

// The tables each console page needs. A page whose tables are all present but
// which still fails is a different problem, and the probes below catch that.
const PAGE_TABLES = {
  "Compliance Dashboard": [
    "compliance_flags", "compliance_screening_list", "compliance_config_versions",
    "money_integrity_alerts", "regulatory_report_events", "pending_credits"
  ],
  "Revenue": ["revenue_ledger", "wallets", "transactions"],
  "Settings and Maintenance": ["platform_settings", "audit_logs"],
  "Security Content": ["platform_settings", "admin_users"],
  "Ticketing": ["events", "event_ticket_types", "ticket_orders", "ticket_refunds"],
  "Users and Wallets": ["users", "wallets", "transactions"],
  "Support Desk": ["support_tickets"],
  "Email Centre": ["email_queue", "email_templates"],
  "Marketing": ["marketing_campaigns"],
  "HR Portal": ["hr_employees"]
};

// Read-only probes that run the same query shape the failing endpoints run.
// Each one names the console page it stands behind.
const PROBES = [
  ["Compliance Dashboard", "compliance overview counts",
    "SELECT COUNT(*)::INT FROM compliance_flags"],
  ["Compliance Dashboard", "money integrity alerts",
    "SELECT COUNT(*)::INT FROM money_integrity_alerts"],
  ["Compliance Dashboard", "sanctions screening list",
    "SELECT COUNT(*)::INT FROM compliance_screening_list"],
  ["Compliance Dashboard", "regulatory report evidence",
    "SELECT COUNT(*)::INT FROM regulatory_report_events"],
  ["Compliance Dashboard", "held payments",
    "SELECT COUNT(*)::INT FROM pending_credits"],
  ["Compliance Dashboard", "limit config versions",
    "SELECT COUNT(*)::INT FROM compliance_config_versions"],
  ["Revenue", "revenue by service",
    "SELECT service_code, SUM(fee_collected)::NUMERIC FROM revenue_ledger GROUP BY service_code"],
  ["Revenue", "revenue wallet exists",
    "SELECT id FROM wallets WHERE kind = 'revenue' AND user_id IS NULL LIMIT 1"],
  ["Settings and Maintenance", "platform settings readable",
    "SELECT key FROM platform_settings LIMIT 1"],
  ["Settings and Maintenance", "audit log writable shape",
    "SELECT id, actor_type, action, entity_type, entity_id, metadata FROM audit_logs LIMIT 1"],
  ["Ticketing", "ticket orders",
    "SELECT COUNT(*)::INT FROM ticket_orders"],
  ["Users and Wallets", "wallet balances",
    "SELECT COUNT(*)::INT FROM wallets"]
];

const RESET = "[0m";
const paint = (code, text) => (process.stdout.isTTY ? `[${code}m${text}${RESET}` : text);
const good = (t) => paint("32", t);
const bad = (t) => paint("31", t);
const warn = (t) => paint("33", t);

async function tablesPresent() {
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  return new Set(rows.map((r) => r.tablename));
}

(async () => {
  console.log("");
  console.log("  TitoPay admin console diagnosis");
  console.log("  ================================");
  console.log(`  API build on this server: ${API_BUILD}`);

  let present;
  try {
    present = await tablesPresent();
  } catch (error) {
    console.log("");
    console.log(bad("  Could not reach the database at all."));
    console.log(`  ${error.message}`);
    console.log("");
    console.log("  Check POSTGRES_URL (or DATABASE_URL) in the API's environment.");
    await pool.end().catch(() => {});
    process.exit(1);
  }
  console.log(`  Tables in the database:   ${present.size}`);

  // ---- missing tables, by page -------------------------------------------
  console.log("");
  console.log("  TABLES EACH PAGE NEEDS");
  console.log("  ----------------------");
  const missingByPage = new Map();
  for (const [page, tables] of Object.entries(PAGE_TABLES)) {
    const missing = tables.filter((t) => !present.has(t));
    if (missing.length) missingByPage.set(page, missing);
    const label = page.padEnd(26);
    console.log(missing.length
      ? `  ${bad("MISSING")}  ${label} ${missing.join(", ")}`
      : `  ${good("ok")}       ${label}`);
  }

  // ---- live probes --------------------------------------------------------
  console.log("");
  console.log("  WHAT THE FAILING PANELS ACTUALLY RUN");
  console.log("  ------------------------------------");
  const failures = [];
  for (const [page, what, sql] of PROBES) {
    try {
      await pool.query(sql);
      console.log(`  ${good("ok")}       ${page.padEnd(26)} ${what}`);
    } catch (error) {
      failures.push({ page, what, message: error.message });
      console.log(`  ${bad("FAILS")}    ${page.padEnd(26)} ${what}`);
      console.log(`           ${bad(error.message)}`);
    }
  }

  // ---- write probes -------------------------------------------------------
  //
  // Reads passing while writes fail is the exact shape of "Save Maintenance
  // Mode did nothing", so the saves are attempted too. Every one runs inside a
  // transaction that is ALWAYS rolled back, so this still changes nothing.
  console.log("");
  console.log("  WHAT THE FAILING SAVE BUTTONS ACTUALLY RUN");
  console.log("  -----------------------------------------");
  const anyAdmin = await pool.query("SELECT id FROM admin_users ORDER BY created_at LIMIT 1").catch(() => ({ rows: [] }));
  const actor = anyAdmin.rows[0]?.id ?? null;
  const WRITES = [
    ["Save Maintenance Mode", `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('__diagnose_probe', '{}'::JSONB, $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`],
    ["Save Security Content", `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('__diagnose_probe2', '{"a":1}'::JSONB, $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`],
    ["Any audited admin action", `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES (gen_random_uuid(), 'admin', $1, 'diagnose_probe', 'platform_settings', NULL, '{}'::JSONB)`]
  ];
  for (const [what, sql] of WRITES) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql, [actor]);
      console.log(`  ${good("ok")}       ${what}`);
    } catch (error) {
      failures.push({ page: "save", what, message: error.message });
      console.log(`  ${bad("FAILS")}    ${what}`);
      console.log(`           ${bad(error.message)}`);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  // The three copies of this table do not agree: one declares a foreign key on
  // updated_by and two do not, and whichever ran first on this database is the
  // one that exists. Report which, because it changes what a save will accept.
  const fk = await pool.query(`
    SELECT COUNT(*)::INT AS n FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'platform_settings' AND c.contype = 'f'`).catch(() => ({ rows: [{ n: -1 }] }));
  console.log(`  ${paint("36", "note")}     platform_settings foreign keys on this database: ${fk.rows[0].n}`);

  // ---- verdict ------------------------------------------------------------
  console.log("");
  console.log("  WHAT TO DO");
  console.log("  ----------");
  if (!missingByPage.size && !failures.length) {
    console.log(good("  Every table and every query the console needs is working."));
    console.log("  If a page still fails, the cause is not the database. Check the API");
    console.log("  log for the request, and confirm the signed-in admin holds the");
    console.log("  permission that page requires.");
  } else {
    if (missingByPage.size) {
      console.log(warn("  Tables are missing. Create them from the shipped schema:"));
      console.log("");
      console.log("      node src/db/init.js");
      console.log("");
      console.log("  That is the same as `npm run db:init`, and it is safe to re-run:");
      console.log("  every statement is CREATE TABLE IF NOT EXISTS. Then run this");
      console.log("  diagnosis again.");
    }
    if (failures.length && !missingByPage.size) {
      console.log(warn("  The tables exist but a query still fails, so this is a column or"));
      console.log(warn("  type difference rather than a missing table. The exact database"));
      console.log("  error is printed above; that is the thing to fix.");
    }
    console.log("");
    console.log("  If a migration is also pending, apply it with:");
    console.log("");
    console.log("      node scripts/apply-migrations.js");
  }
  console.log("");

  await pool.end();
  process.exit(missingByPage.size || failures.length ? 1 : 0);
})().catch(async (error) => {
  console.error("");
  console.error(bad("  The diagnosis itself failed: " + error.message));
  console.error("");
  await pool.end().catch(() => {});
  process.exit(1);
});
