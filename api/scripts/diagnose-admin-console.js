"use strict";

// WHY IS A PAGE IN THE ADMIN CONSOLE NOT WORKING?
//
// The console answers "Unable to complete this admin action" for every
// server-side failure, on purpose: an operator screen must not print database
// errors, table names or stack traces to whoever is looking at it. That is
// right for the console and useless for the person who has to fix it, so this
// reports the same failures with the detail put back.
//
// THE LOGIC IS NO LONGER HERE. It lives in
// src/services/console-diagnosis-service.js, and the admin console reads the
// SAME answer from GET /admin/diagnostics/console. This file is now only a
// printer, which is the point: the tool that names the real cause used to
// require a shell, and the shell is exactly what you do not have when a
// console page breaks at two in the morning. Both routes to the answer are
// the same code, so they cannot drift apart.
//
// It uses the API's own connection settings, so it needs no psql, no
// credentials typed at a prompt and no database client installed. Run it from
// the API directory, the same place `npm start` runs from:
//
//     node scripts/diagnose-admin-console.js
//
// Reads run as themselves. The save probes DO issue writes, because a read
// that works while a save fails is the whole shape of the problem, but every
// one of them runs inside a transaction that is always rolled back. It
// creates, alters and deletes nothing, so it is safe against production.

require("../src/config/env");
const { pool } = require("../src/db/pool");
const { runConsoleDiagnosis } = require("../src/services/console-diagnosis-service");

const RESET = "[0m";
const paint = (code, text) => (process.stdout.isTTY ? `[${code}m${text}${RESET}` : text);
const good = (t) => paint("32", t);
const bad = (t) => paint("31", t);
const warn = (t) => paint("33", t);
const note = (t) => paint("36", t);

(async () => {
  const d = await runConsoleDiagnosis();

  console.log("");
  console.log("  TitoPay admin console diagnosis");
  console.log("  ================================");
  console.log(`  API build on this server: ${d.apiBuild}`);

  if (!d.reachable) {
    console.log("");
    console.log(bad("  Could not reach the database at all."));
    console.log(`  ${d.databaseError.message}`);
    console.log("");
    console.log(`  ${d.verdict.guidance}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  console.log(`  Tables in the database:   ${d.tableCount}`);
  console.log(`  Migrations applied:       ${d.notes.appliedMigrations ?? "unknown"}`);

  // ---- missing tables, by page ---------------------------------------------
  console.log("");
  console.log("  TABLES EACH PAGE NEEDS");
  console.log("  ----------------------");
  for (const entry of d.pages) {
    const label = entry.page.padEnd(26);
    console.log(entry.missing.length
      ? `  ${bad("MISSING")}  ${label} ${entry.missing.join(", ")}`
      : `  ${good("ok")}       ${label}`);
  }

  // ---- live probes ----------------------------------------------------------
  console.log("");
  console.log("  WHAT THE FAILING PANELS ACTUALLY RUN");
  console.log("  ------------------------------------");
  for (const probe of d.probes) {
    if (probe.ok) {
      console.log(`  ${good("ok")}       ${probe.page.padEnd(26)} ${probe.what}`);
    } else {
      console.log(`  ${bad("FAILS")}    ${probe.page.padEnd(26)} ${probe.what}`);
      console.log(`           ${bad(probe.error.message)}${probe.error.code ? bad(`  [${probe.error.code}]`) : ""}`);
    }
  }

  // ---- write probes ---------------------------------------------------------
  console.log("");
  console.log("  WHAT THE FAILING SAVE BUTTONS ACTUALLY RUN");
  console.log("  -----------------------------------------");
  for (const write of d.writes) {
    if (write.ok) {
      console.log(`  ${good("ok")}       ${write.what}`);
    } else {
      console.log(`  ${bad("FAILS")}    ${write.what}`);
      console.log(`           ${bad(write.error.message)}${write.error.code ? bad(`  [${write.error.code}]`) : ""}`);
    }
  }
  console.log(`  ${note("note")}     platform_settings foreign keys: ${d.notes.platformSettingsForeignKeys ?? "unknown"}`);
  console.log(`  ${note("note")}     platform_settings columns: ${(d.notes.platformSettingsColumns || ["unknown"]).join(", ")}`);

  // ---- which company supplies which capability -------------------------------
  console.log("");
  console.log("  WHICH PROVIDER SUPPLIES WHICH CAPABILITY");
  console.log("  ----------------------------------------");
  for (const entry of d.providers) {
    const paintState = entry.state === "wired" ? good : entry.state === "none" ? warn : bad;
    const label = (entry.state === "missing" ? "MISSING" : entry.state).padEnd(8);
    console.log(`  ${paintState(label)} ${String(entry.capability).padEnd(14)}${String(entry.configured || "-").padEnd(18)}${entry.variable || ""} (${entry.source || "-"})`);
  }
  console.log("");
  console.log("  none    TitoPay has no supplier contracted for that capability. The");
  console.log("          operations refuse; they never return a fabricated result.");
  console.log("  MISSING the configured provider has no adapter, which IS a fault:");
  console.log("          check the *_PROVIDER value in the API environment.");

  // ---- verdict ---------------------------------------------------------------
  console.log("");
  console.log("  WHAT TO DO");
  console.log("  ----------");
  console.log(d.verdict.ok ? good(`  ${d.verdict.headline}`) : warn(`  ${d.verdict.headline}`));
  console.log(`  ${d.verdict.guidance}`);
  console.log("");
  console.log("  The Database Health page in the admin console now shows this same");
  console.log("  report, so this command is the fallback rather than the only way in.");
  console.log("");

  await pool.end();
  process.exit(d.verdict.ok ? 0 : 1);
})().catch(async (error) => {
  console.error("");
  console.error(bad("  The diagnosis itself failed: " + error.message));
  console.error("");
  await pool.end().catch(() => {});
  process.exit(1);
});
