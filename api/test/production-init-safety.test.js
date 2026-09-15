"use strict";

// THE PRODUCTION SETUP SCRIPT MUST NEVER BE ABLE TO DESTROY ANYTHING.
//
// scripts/init-production-database.js exists to stand up a clean production
// database. Its entire safety argument is that it only ever CREATES: it holds
// no DROP, no DELETE, no TRUNCATE, and it refuses outright if it finds
// customer data rather than offering to clear it.
//
// That argument is only worth anything if it stays true. A single DELETE added
// later, by anyone, for a good reason, turns a safe setup script into
// something that can empty a live fintech database. So it is asserted here,
// against the file's own source, and the suite fails if it ever stops holding.
//
// This deliberately reads the SOURCE rather than importing the module: the
// point is what the file is capable of, not what one code path happens to do.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "init-production-database.js");
const source = fs.readFileSync(SCRIPT_PATH, "utf8");

// Comments explain WHY there is no DELETE, so they would trip a naive scan.
// Only executable lines are considered.
const executable = source
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

test("the production setup script cannot destroy data", () => {
  for (const forbidden of [/\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]) {
    assert.doesNotMatch(executable, forbidden,
      `init-production-database.js contains ${forbidden}. This script may only ever create.`);
  }
});

test("the production setup script cannot be forced past its own safety check", () => {
  // The refusal is the whole point. A --force or --yes flag would reintroduce
  // exactly the accident it exists to prevent: pointing it at the live
  // database and answering the prompt without reading it.
  for (const override of [/--force/i, /--yes\b/i, /--overwrite/i, /SKIP_SAFETY/i]) {
    assert.doesNotMatch(executable, override,
      `init-production-database.js accepts ${override}, which would defeat the customer-data refusal.`);
  }
  assert.match(executable, /REFUSING TO RUN/,
    "the script no longer refuses when it finds customer data");
  assert.match(executable, /process\.exit\(1\)/,
    "the refusal must exit non-zero so a deploy pipeline stops on it");
});

test("it writes nothing unless --apply is passed", () => {
  assert.match(executable, /const APPLY = process\.argv\.includes\("--apply"\)/,
    "the apply flag is no longer how writing is gated");
  // The dry run must return BEFORE the first schema write, so the report is
  // genuinely read-only rather than read-mostly.
  const applyGate = executable.indexOf("if (!APPLY)");
  const firstWrite = executable.indexOf("schemaDir");
  assert.ok(applyGate > 0 && firstWrite > applyGate,
    "the --apply gate no longer sits before the first write");
});

test("every table that holds customer money is on the refusal list", () => {
  // The refusal is only as good as this list. These are the tables where a
  // missed entry would let the script run against a database that holds real
  // customer money and report it as clean.
  const required = [
    "users", "transactions", "wallet_ledger", "revenue_ledger",
    "merchants", "qr_codes", "notifications", "email_queue"
  ];
  const listed = executable.slice(
    executable.indexOf("const CUSTOMER_TABLES"),
    executable.indexOf("];", executable.indexOf("const CUSTOMER_TABLES"))
  );
  for (const table of required) {
    assert.match(listed, new RegExp(`"${table}"`),
      `${table} is not on CUSTOMER_TABLES, so a database holding them would be treated as fresh`);
  }
  // Customer wallets are checked separately, because the revenue and suspense
  // wallets legitimately exist on a fresh database and must not trip it.
  assert.match(executable, /countCustomerWallets/,
    "customer wallets are no longer counted, so a database full of wallets would pass as fresh");
  assert.match(executable, /user_id IS NOT NULL/,
    "the wallet count no longer excludes the platform wallets");
});
