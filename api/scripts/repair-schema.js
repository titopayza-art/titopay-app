"use strict";

// CREATE THE TABLES A CONSOLE PAGE NEEDS, AND TOUCH NOTHING ELSE.
//
// This exists because the obvious command is not the safe one.
//
// `node src/db/init.js` applies the same schema files, but it ALSO calls
// syncApprovedPricingSchedule(), which writes every rule in
// APPROVED_PRICING_SCHEDULE over pricing_rules with ON CONFLICT DO UPDATE and
// forces enabled = TRUE, active = TRUE on all of them. On a live platform that
// silently discards every fee an operator has set in the console. Measured, on
// a database with a hand-set fee:
//
//     before          airtime  fee 9.99, disabled
//     after init.js   airtime  fee 1.00, enabled      <- the operator's change is gone
//     after this      airtime  fee 9.99, disabled     <- untouched
//
// So: init.js is the right command for a NEW database, and this is the right
// command for an existing one that is missing tables.
//
//     node scripts/repair-schema.js
//
// It applies schema.sql, email-centre-schema.sql and hr-schema.sql, all of
// which are CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout,
// so running it against a complete database is a no-op. Two statements inside
// schema.sql do touch existing rows, and both are narrow enough to state
// plainly:
//
//   - wallets with a NULL or malformed wallet_number are given one. A wallet
//     that already has a valid number is not read.
//   - service_config.qr-pay has its fee raised to 0.50 IF it is currently
//     below that. Nothing else in service_config is written.
//
// Run it from the API directory, the same place `npm start` runs from. It uses
// the API's own connection settings, so it needs no psql and no credentials
// typed at a prompt. Migrations are separate: follow this with
// `node scripts/apply-migrations.js`.

require("../src/config/env");
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db/pool");

const DB_DIR = path.join(__dirname, "..", "src", "db");
const SCHEMA_FILES = ["schema.sql", "email-centre-schema.sql", "hr-schema.sql"];

const RESET = "[0m";
const paint = (code, text) => (process.stdout.isTTY ? `[${code}m${text}${RESET}` : text);
const good = (t) => paint("32", t);
const bad = (t) => paint("31", t);
const note = (t) => paint("36", t);

async function countTables() {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::INT AS n FROM information_schema.tables WHERE table_schema = 'public'");
  return rows[0].n;
}

(async () => {
  console.log("");
  console.log("  TitoPay schema repair");
  console.log("  =====================");

  const before = await countTables();
  console.log(`  Tables before: ${before}`);
  console.log("");

  for (const name of SCHEMA_FILES) {
    const file = path.join(DB_DIR, name);
    if (!fs.existsSync(file)) {
      console.log(`  ${note("skip")}     ${name} is not in this package`);
      continue;
    }
    const sql = fs.readFileSync(file, "utf8");
    if (!sql.trim()) continue;
    // Each file runs as ONE statement, which is deliberate: a forward reference
    // inside it must roll the whole file back rather than leave half a schema.
    await pool.query(sql);
    console.log(`  ${good("applied")}  ${name}`);
  }

  const after = await countTables();
  console.log("");
  console.log(`  Tables after:  ${after}  (${after - before} created)`);
  console.log("");
  console.log("  Pricing rules and service fees were not read or written.");
  console.log("  Next: node scripts/apply-migrations.js");
  console.log("        node scripts/diagnose-admin-console.js");
  console.log("");

  await pool.end();
})().catch(async (error) => {
  console.error("");
  console.error(bad("  The repair failed: " + error.message));
  console.error("  Nothing from the file that failed was applied.");
  console.error("");
  await pool.end().catch(() => {});
  process.exit(1);
});
