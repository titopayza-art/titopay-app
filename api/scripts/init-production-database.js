"use strict";

// A CLEAN PRODUCTION DATABASE, PROVEN CLEAN BEFORE IT IS USED.
//
//   node scripts/init-production-database.js            report only, writes nothing
//   node scripts/init-production-database.js --apply    do it
//
// WHY THIS EXISTS.
//
// "Sandbox" on TitoPay is not a separate database. It is one environment
// variable per integration that chooses which URL and keys the server talks
// to, and there is no column on wallets or transactions recording which mode
// created a row. So flipping PEACH_PAYMENTS_MODE to production changes nothing
// about the data: every test balance stays exactly where it is.
//
// That matters because a wallet balance is a claim on real money the moment
// the keys are live. A test account holding R5000 could request a withdrawal
// and TitoPay would attempt to send R5000 of real money to a real bank
// account, funded from a float that never received it. Every fake fee in
// revenue_ledger would also appear in the first real revenue report.
//
// The safe answer is to START production on a database with no customers in
// it, and keep the existing one as the test environment. Nothing is deleted,
// so nothing can go wrong irreversibly, and "is it clean?" becomes a row count
// rather than a hope.
//
// WHAT THIS SCRIPT WILL NOT DO.
//
// It contains no DROP, no DELETE, no TRUNCATE, and no UPDATE to any customer
// row. It only creates what an empty database is missing. If it finds customer
// data it REFUSES TO RUN AT ALL, with no override flag, because a flag that
// lets you point this at a live database is the exact accident it exists to
// prevent. Re-running it against its own output is safe and changes nothing:
// the refusal is on CUSTOMER data, and platform rows are what the script
// itself creates. Once the database has actually been USED, though — a
// payment, a queued email, a registration — it refuses, permanently. That is
// the intended direction: this is a setup step, not a repair tool.
//
// WHAT IT SETS UP.
//
//   1. The schema, from the same files npm run db:init uses
//   2. The approved pricing schedule
//   3. The service catalogue and the email templates
//   4. The revenue wallet, which NOTHING else in the codebase creates and
//      whose absence failed every fee-bearing payment in production
//   5. The suspense wallet
//   6. One admin account, when ADMIN_PASSWORD is supplied
//   7. A verification pass that counts what exists and proves the invariants
//
//   ADMIN_FULL_NAME  ADMIN_USERNAME  ADMIN_EMAIL  ADMIN_ROLE  ADMIN_PASSWORD
//
// are read exactly as scripts/create-admin-user.js reads them. Leave
// ADMIN_PASSWORD unset to skip that step and create the account separately.

const fs = require("node:fs");
const path = require("node:path");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");

const APPLY = process.argv.includes("--apply");

// Every table that holds something belonging to a CUSTOMER. If any of these
// has a row, this is not a fresh production database and the script stops.
//
// Platform tables are deliberately absent from this list: admin_users,
// pricing_rules, service_config, email_templates and platform_settings are
// what the script itself creates, so their presence is the expected state on a
// second run rather than a reason to refuse.
const CUSTOMER_TABLES = [
  "users",
  "transactions",
  "wallet_ledger",
  "revenue_ledger",
  "merchants",
  "qr_codes",
  "tickets",
  "ticket_orders",
  "events",
  "notifications",
  "email_queue",
  "kyc_reviews",
  "support_tickets",
  "beneficiaries",
  "payment_requests"
];

const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);

async function tableExists(name) {
  const { rows } = await pool.query("SELECT to_regclass($1) AS name", [`public.${name}`]);
  return Boolean(rows[0]?.name);
}

async function countRows(name) {
  if (!await tableExists(name)) return null;
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${name}`);
  return rows[0].count;
}

// A customer wallet is any wallet belonging to a user. The revenue and
// suspense wallets have user_id NULL and are platform infrastructure, so they
// are counted separately and are not a reason to refuse.
async function countCustomerWallets() {
  if (!await tableExists("wallets")) return null;
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM wallets WHERE user_id IS NOT NULL");
  return rows[0].count;
}

async function describeTarget() {
  const { rows } = await pool.query(
    "SELECT current_database() AS name, inet_server_addr()::text AS host, inet_server_port() AS port, current_user AS role"
  );
  return rows[0];
}

async function main() {
  const target = await describeTarget();
  console.log("");
  console.log("  TITOPAY PRODUCTION DATABASE SETUP");
  console.log("  ---------------------------------");
  console.log(`  database   ${target.name}`);
  console.log(`  server     ${target.host || "local socket"}:${target.port}`);
  console.log(`  role       ${target.role}`);
  console.log(`  mode       ${APPLY ? "APPLY — this will write" : "REPORT ONLY — nothing will be written"}`);
  console.log("");

  // ---- 1. REFUSE IF THIS IS NOT A FRESH DATABASE --------------------------
  //
  // This runs before anything else and before any write, so a wrong
  // POSTGRES_URL costs nothing but a printed report.
  const occupied = [];
  const customerWallets = await countCustomerWallets();
  if (customerWallets) occupied.push(["wallets (customer)", customerWallets]);
  for (const table of CUSTOMER_TABLES) {
    const count = await countRows(table);
    if (count) occupied.push([table, count]);
  }

  if (occupied.length) {
    console.error("  REFUSING TO RUN. This database already holds customer data.");
    console.error("");
    for (const [table, count] of occupied) {
      console.error(`    ${pad(table, 22)} ${padLeft(count.toLocaleString(), 10)} rows`);
    }
    console.error("");
    console.error("  Nothing has been read beyond these counts and nothing has been written.");
    console.error("  A fresh production database means an empty one. Point POSTGRES_URL at a");
    console.error("  new database and run this again. There is deliberately no override.");
    console.error("");
    await pool.end();
    process.exit(1);
  }

  console.log("  No customer data found. This is a fresh database.");
  console.log("");

  if (!APPLY) {
    console.log("  Would set up, in order:");
    console.log("    1. schema.sql, email-centre-schema.sql, hr-schema.sql");
    console.log("    2. the approved pricing schedule");
    console.log("    3. the service catalogue and the email templates");
    console.log("    4. the revenue wallet");
    console.log("    5. the suspense wallet");
    console.log(`    6. an admin account${process.env.ADMIN_PASSWORD ? "" : "  (skipped: ADMIN_PASSWORD is not set)"}`);
    console.log("    7. a verification pass");
    console.log("");
    console.log("  Re-run with --apply to do it.");
    console.log("");
    await pool.end();
    return;
  }

  // ---- 2. SCHEMA ----------------------------------------------------------
  //
  // The same files, in the same order, that npm run db:init applies. On an
  // empty database every statement is a create; there is nothing to overwrite.
  const schemaDir = path.join(__dirname, "..", "src", "db");
  for (const file of ["schema.sql", "email-centre-schema.sql", "hr-schema.sql"]) {
    const filePath = path.join(schemaDir, file);
    if (!fs.existsSync(filePath)) { console.log(`  schema     ${pad(file, 28)} not present, skipped`); continue; }
    const sql = fs.readFileSync(filePath, "utf8");
    if (!sql.trim()) continue;
    await pool.query(sql);
    console.log(`  schema     ${pad(file, 28)} applied`);
  }

  // ---- 3. PRICING ---------------------------------------------------------
  //
  // syncApprovedPricingSchedule overwrites every pricing rule, which is why it
  // must never be run casually against a live database. Here it is correct:
  // there is nothing to overwrite, and the platform needs its published rates.
  const { syncApprovedPricingSchedule } = require("../src/services/pricing-service");
  const rules = await syncApprovedPricingSchedule();
  console.log(`  pricing    ${pad("approved schedule", 28)} ${rules.length} rules`);

  // ---- 4. CATALOGUE AND TEMPLATES ----------------------------------------
  const services = require("../src/services/service-management-service");
  if (typeof services.ensureDefaultServices === "function") {
    await services.ensureDefaultServices();
    console.log(`  services   ${pad("default catalogue", 28)} seeded`);
  }
  const emailCentre = require("../src/services/email-centre-service");
  await emailCentre.ensureEmailSchema();
  await emailCentre.seedDefaultTemplates();
  console.log(`  email      ${pad("default templates", 28)} ${emailCentre.DEFAULT_TEMPLATES.length} templates`);

  // ---- 5. THE PLATFORM WALLETS -------------------------------------------
  //
  // Nothing in the codebase creates the revenue wallet. Its absence is what
  // failed every fee-bearing payment in production with a blanket 5xx, so it
  // is provisioned here rather than left to be discovered by a customer.
  const { rows: revenueRows } = await pool.query(
    "SELECT id, wallet_number FROM wallets WHERE kind = 'revenue' AND user_id IS NULL LIMIT 2"
  );
  if (revenueRows.length > 1) {
    console.error("\n  More than one revenue wallet exists. Fee postings take the first, so this");
    console.error("  must be resolved by hand before any revenue is recorded.\n");
    await pool.end();
    process.exit(1);
  }
  if (revenueRows.length === 1) {
    console.log(`  wallets    ${pad("revenue", 28)} already present (${revenueRows[0].wallet_number})`);
  } else {
    const { generateUniqueWalletNumber } = require("../src/lib/wallet-id");
    // It takes the queryable to check the number against; called with nothing
    // it throws on the first candidate.
    const walletNumber = await generateUniqueWalletNumber(pool);
    await pool.query(
      `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
       VALUES ($1, $2, NULL, 'revenue', 'ZAR', 0, 0, 'active')`,
      [uuidv4(), walletNumber]
    );
    console.log(`  wallets    ${pad("revenue", 28)} created (${walletNumber})`);
  }

  const { getSuspenseWallet } = require("../src/services/wallet-service");
  const suspense = await getSuspenseWallet();
  console.log(`  wallets    ${pad("suspense", 28)} ${suspense.wallet_number}`);

  // ---- 5b. STAMP THE DATABASE WITH ITS OWN IDENTITY ----------------------
  //
  // The API refuses to start when the environment it is told it is in
  // disagrees with the environment the database says it is. Stamping here
  // means the new database is known to be production from the moment it
  // exists, rather than taking whichever identity the first process to boot
  // happens to declare.
  //
  // Additive and idempotent: one platform_settings row, ON CONFLICT DO
  // NOTHING, so it can never overwrite an existing identity.
  const { verifyDatabaseIdentity, IDENTITY_KEY } = require("../src/config/deployment-safety");
  const declaredEnv = String(process.env.TITOPAY_ENV || "").trim();
  if (declaredEnv) {
    const identity = await verifyDatabaseIdentity(pool, declaredEnv);
    if (!identity.ok) {
      console.error(`\n  ${identity.problems.join("\n  ")}\n`);
      await pool.end();
      process.exit(1);
    }
    console.log(`  identity   ${pad(IDENTITY_KEY, 28)} ${identity.stamped}${identity.wrote ? " (stamped now)" : " (already set)"}`);
  } else {
    console.log(`  identity   ${pad("not stamped", 28)} TITOPAY_ENV is not set; the API will stamp it on first boot`);
  }

  // ---- 6. THE FIRST ADMIN -------------------------------------------------
  //
  // Delegated to the existing script rather than reimplemented, so the
  // password policy and the role list stay defined in exactly one place.
  if (process.env.ADMIN_PASSWORD) {
    const { execFileSync } = require("node:child_process");
    try {
      execFileSync(process.execPath, [path.join(__dirname, "create-admin-user.js")], {
        stdio: "pipe", env: process.env
      });
      console.log(`  admin      ${pad(process.env.ADMIN_EMAIL || "ceo@titopay.co.za", 28)} created`);
    } catch (error) {
      console.error(`\n  The admin account could not be created: ${String(error.stderr || error.message).trim()}`);
      console.error("  Everything else above is done. Fix the variables and run npm run admin:create.\n");
    }
  } else {
    console.log(`  admin      ${pad("skipped", 28)} ADMIN_PASSWORD is not set`);
  }

  // ---- 7. PROVE IT ---------------------------------------------------------
  //
  // The point of starting fresh is that "clean" is a countable fact rather
  // than a hope, so it is counted, and a failed invariant exits non-zero.
  console.log("");
  console.log("  VERIFICATION");
  console.log("  ------------");
  const failures = [];

  const stillEmpty = [["wallets (customer)", await countCustomerWallets()]];
  for (const table of CUSTOMER_TABLES) stillEmpty.push([table, await countRows(table)]);
  for (const [table, count] of stillEmpty) {
    if (count === null) continue;
    if (count !== 0) failures.push(`${table} holds ${count} rows and should hold none`);
  }
  console.log(`  customers            ${padLeft(stillEmpty.filter(([, c]) => c === 0).length, 4)} tables empty, as they should be`);

  const ruleCount = await countRows("pricing_rules");
  const { rows: disabled } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM pricing_rules WHERE enabled IS NOT TRUE OR active IS NOT TRUE"
  );
  if (!ruleCount) failures.push("no pricing rules exist, so every service would be free");
  if (disabled[0].count) failures.push(`${disabled[0].count} pricing rules are disabled`);
  console.log(`  pricing rules        ${padLeft(ruleCount, 4)} rules, all enabled`);

  const { rows: qrRules } = await pool.query(
    `SELECT service_code, flat_fee, percentage_fee, maximum_fee FROM pricing_rules
      WHERE service_code IN ('qr_payment','merchant_qr_payment') ORDER BY service_code`
  );
  for (const rule of qrRules) {
    console.log(`    ${pad(rule.service_code, 20)} R${Number(rule.flat_fee).toFixed(2)} + ${Number(rule.percentage_fee)}%`
      + `${Number(rule.maximum_fee) > 0 ? ` capped at R${Number(rule.maximum_fee).toFixed(2)}` : ""}`);
  }

  const { rows: revenueCheck } = await pool.query(
    "SELECT COUNT(*)::int AS count, COALESCE(SUM(available_balance),0) AS balance FROM wallets WHERE kind='revenue' AND user_id IS NULL"
  );
  if (revenueCheck[0].count !== 1) failures.push(`there are ${revenueCheck[0].count} revenue wallets and there must be exactly one`);
  if (Number(revenueCheck[0].balance) !== 0) failures.push(`the revenue wallet opens at R${revenueCheck[0].balance} rather than zero`);
  console.log(`  revenue wallet       ${padLeft(revenueCheck[0].count, 4)} wallet, opening balance R${Number(revenueCheck[0].balance).toFixed(2)}`);

  const templates = await countRows("email_templates");
  console.log(`  email templates      ${padLeft(templates, 4)}`);
  const admins = await countRows("admin_users");
  if (!admins) failures.push("no admin account exists, so nobody can sign in to the console");
  console.log(`  admin accounts       ${padLeft(admins, 4)}`);

  console.log("");
  if (failures.length) {
    console.error("  NOT READY:");
    for (const failure of failures) console.error(`    - ${failure}`);
    console.error("");
    await pool.end();
    process.exit(1);
  }
  console.log("  Ready. This database has a full schema, published pricing, a revenue");
  console.log("  wallet opening at zero, and no customers.");
  console.log("");
  console.log("  Before the first real payment, set the integration modes EXPLICITLY.");
  console.log("  Each defaults to \"production\" when unset, so going live can happen by");
  console.log("  omission: PEACH_PAYMENTS_MODE, DOCFOX_MODE, OTT_MODE.");
  console.log("");
  await pool.end();
}

main().catch(async (error) => {
  console.error("");
  console.error(`  FAILED: ${error.message}`);
  console.error("  Nothing further has been written.");
  console.error("");
  await pool.end().catch(() => {});
  process.exit(1);
});
