#!/usr/bin/env node
"use strict";

// WHAT IS WRONG WITH THIS SERVER'S CONFIGURATION?
//
// Answered BEFORE the restart, while the old process is still serving traffic.
//
// On 20 August 2026 the API went to 502 after a deploy. Nothing had crashed:
// build 71 had added IDENTITY_PEPPER as a required variable and the new code
// refused to start without it. Refusing to start is indistinguishable from being
// down when nginx is in front, so the complaint nobody could read cost a day.
//
// Since build 74 the API does not refuse to start for ANY configuration problem.
// It comes up, prints what is wrong, and counts it on GET /health. So this tool
// is no longer the thing standing between you and an outage; it is the place to
// read the same list early, with remedies, and fix it properly.
//
// It reports every problem in one pass, exits non-zero so a deploy script can
// stop, connects to nothing unless asked, and never prints a secret's value —
// only whether it is present and long enough.
//
//   node preflight.js              config only, the fast check
//   node preflight.js --database   also prove the database is reachable
//
// Run it after unzipping and BEFORE restarting. If it fails, the running API is
// untouched and you have lost nothing.

const path = require("path");
const fs = require("fs");

const wantDatabase = process.argv.includes("--database");
const problems = [];
const notes = [];

function fail(message, remedy) {
  problems.push({ message, remedy });
}

// ---------------------------------------------------------------- environment

// Same order src/config/env.js uses, so this sees exactly what the API will see.
require("dotenv").config({ path: path.resolve(process.cwd(), "api/.env") });
require("dotenv").config();

const environment = process.env.NODE_ENV || "development";
const GENERATE = 'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"';

// A BARE SHELL IS NOT THE PROCESS MANAGER.
//
// Seen in production on 20 August 2026, minutes after the 502 was fixed: this
// preflight, run over SSH, reported every variable missing on the very machine
// where the API was serving fine. Both were true. On cPanel (Passenger), pm2
// and systemd setups the running API gets its variables injected by the
// process manager, and a login shell does not inherit them. So when this shell
// sees NOTHING — no TitoPay variable and no .env file here — the honest
// reading is usually "your configuration lives somewhere this shell cannot
// see", not "your API is unconfigured", and the report below says so instead
// of letting three ✗ marks read as an emergency.
const CORE_NAMES = [
  "POSTGRES_URL", "DATABASE_URL",
  "JWT_ACCESS_SECRET", "JWT_SECRET",
  "JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET",
  "IDENTITY_PEPPER"
];
// "Nothing" is judged against EVERY name the API reads, not just the required
// core. A shell holding NODE_ENV=production and the SMTP block plainly does see
// TitoPay configuration, and telling that operator they see "no configuration
// at all" would be false — their missing core variables are real problems to
// fix, not somebody else's environment. .env.example is the declaration of all
// names and ships beside this file; if it is somehow absent, fall back to the
// core list rather than guessing.
function knownNames() {
  try {
    return fs.readFileSync(path.join(__dirname, ".env.example"), "utf8")
      .split("\n")
      .map((line) => (line.match(/^([A-Z][A-Z0-9_]*)=/) || [])[1])
      .filter(Boolean);
  } catch {
    return CORE_NAMES;
  }
}
const shellSeesNothing =
  knownNames().every((name) => !process.env[name])
  && !fs.existsSync(path.resolve(process.cwd(), ".env"))
  && !fs.existsSync(path.resolve(process.cwd(), "api", ".env"));

function present(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && String(value) !== "") return { name, value: String(value) };
  }
  return null;
}

function checkRequired(names, { minBytes = 0, productionOnly = false, why = "" } = {}) {
  const label = names.join(" or ");
  const found = present(names);
  if (!found) {
    if (productionOnly && environment !== "production") {
      notes.push(`${label} is not set, which is allowed outside production (NODE_ENV=${environment}).`);
      return;
    }
    fail(`${label} is not set.${why ? ` ${why}` : ""}`,
      minBytes ? `Add it to .env. Generate one with:\n      ${GENERATE}` : "Add it to .env.");
    return;
  }
  const bytes = Buffer.byteLength(found.value, "utf8");
  if (minBytes && bytes < minBytes) {
    fail(`${found.name} is ${bytes} bytes; the minimum is ${minBytes}.`,
      `Replace it in .env with a longer value:\n      ${GENERATE}` +
      (names[0].startsWith("JWT")
        ? "\n      Note: changing a JWT secret signs everyone out (they sign in again)." +
          "\n      AND: if EMAIL_ENCRYPTION_KEY is not set, stored email credentials are" +
          "\n      encrypted under JWT_REFRESH_SECRET - rotating it breaks them. Set" +
          "\n      EMAIL_ENCRYPTION_KEY to the CURRENT refresh secret value FIRST."
        : ""));
    return;
  }
  notes.push(`${found.name} set${minBytes ? `, ${bytes} bytes` : ""}.`);
}

// The configuration that matters. Nothing here is fatal any more, but each one
// is either a security floor or a feature that will not work. Anything
// src/config/env.js warns about belongs here too, and
// api/test/deployment-preflight.test.js fails the build if the two drift apart.
checkRequired(["POSTGRES_URL", "DATABASE_URL"], { why: "The API cannot reach its database without it." });
checkRequired(["JWT_ACCESS_SECRET", "JWT_SECRET"], { minBytes: 32 });
checkRequired(["JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"], { minBytes: 32 });
checkRequired(["IDENTITY_PEPPER"], {
  minBytes: 32,
  productionOnly: true,
  why: "Identity numbers are keyed with it. Set it once and never change it: if it changes, ID numbers verified under the old value stop matching."
});

if (environment !== "production") {
  notes.push(`NODE_ENV is "${environment}", not "production". Production-only requirements were not enforced.`);
}

// THE COUPLING THAT BROKE EMAIL ON 20 AUGUST 2026. Stored email credentials
// (the SMTP password saved in the admin Email Centre) are encrypted under
// EMAIL_ENCRYPTION_KEY - or, when it is absent, under a key DERIVED FROM
// JWT_REFRESH_SECRET. A routine JWT rotation that morning therefore silently
// broke every stored email credential: every send failed with `Missing
// credentials for "PLAIN"` while nothing looked wrong. Saying so here, before
// a rotation, is the whole point of this tool.
if (present(["EMAIL_ENCRYPTION_KEY"])) {
  notes.push("EMAIL_ENCRYPTION_KEY set. Stored email credentials survive JWT rotations.");
} else if (present(["JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET"])) {
  fail("EMAIL_ENCRYPTION_KEY is not set, so stored email credentials are encrypted under "
    + "JWT_REFRESH_SECRET. Rotating that secret will silently break every stored email "
    + "credential (`Missing credentials for \"PLAIN\"` on every send).",
    "Pin the key BEFORE any rotation, to the value the credentials are already encrypted under:\n"
    + "      echo \"EMAIL_ENCRYPTION_KEY=$(grep '^JWT_REFRESH_SECRET=' .env | cut -d= -f2-)\" >> .env\n"
    + "      Then restart. Set once, never change.");
}

// ------------------------------------------------------------ the real loader

// Belt and braces: even with the list above satisfied, load the actual config so
// that a requirement added to env.js and NOT mirrored here still surfaces now
// rather than at restart.
if (!problems.length) {
  try {
    const { startupWarnings } = require("./src/config/env");
    for (const warning of startupWarnings || []) fail(warning, "See api/.env.example for what to set.");
    if (!startupWarnings || !startupWarnings.length) notes.push("src/config/env.js reports no warnings.");
  } catch (error) {
    fail(`The API's own configuration loader raised: ${error.message}`,
      "Nothing in src/config/env.js should throw any more, so this is a bug worth reporting.");
  }
}

// ------------------------------------------------------------------- database

(async () => {
  if (wantDatabase && !problems.length) {
    try {
      const { pool } = require("./src/db/pool");
      const { rows } = await pool.query("SELECT 1 AS ok");
      if (rows[0]?.ok === 1) notes.push("Database reachable.");
      const applied = await pool
        .query("SELECT COUNT(*) c FROM schema_migrations")
        .then((r) => Number(r.rows[0].c))
        .catch(() => null);
      if (applied !== null) notes.push(`${applied} migrations recorded as applied.`);
      await pool.end().catch(() => {});
    } catch (error) {
      fail(`The database could not be reached: ${error.message}`,
        "Check POSTGRES_URL, and that the database server is up.");
    }
  }

  // --------------------------------------------------------------- the answer

  let build = "unknown";
  try { build = require("./src/build-info").API_BUILD; } catch { /* not fatal */ }

  console.log(`\nTitoPay API preflight  ·  build ${build}  ·  NODE_ENV=${environment}\n`);
  for (const note of notes) console.log(`  ok    ${note}`);

  if (!problems.length) {
    console.log(`\nConfiguration is complete. This build will start cleanly.`);
    console.log(`Safe to restart.\n`);
    process.exit(0);
  }

  if (shellSeesNothing) {
    console.log("\nTHIS SHELL SEES NO TITOPAY CONFIGURATION AT ALL — no variable set and no");
    console.log(".env file in this directory. That usually does NOT mean the API is broken:");
    console.log("on cPanel (Passenger), pm2 and systemd setups the running API gets its");
    console.log("variables from the process manager, and an SSH shell does not inherit");
    console.log("them. The service can be configured correctly while this check, run the");
    console.log("way you just ran it, sees nothing.");
    console.log("");
    console.log("To check the RUNNING API, ask it directly:");
    console.log("    curl -s https://api.titopay.co.za/v1/health");
    console.log("Its configWarnings field counts the problems the live process started");
    console.log("with. Zero means the RUNNING process has a complete configuration —");
    console.log("the process serving now, which is the OLD build until you restart; a");
    console.log("variable this new build adds will not show there until it runs. And if");
    console.log("that request itself fails, the running API is telling you its own");
    console.log("configuration is genuinely broken, most often the database connection.");
    console.log("");
    console.log("To make the scripts in this directory (this preflight, db:apply-migrations)");
    console.log("see what the API sees, create a .env here with the same values the process");
    console.log("manager injects. .env.example lists every name.");
  }

  console.log(`\n${problems.length} configuration problem${problems.length === 1 ? "" : "s"} in this shell's view:\n`);
  for (const { message, remedy } of problems) {
    console.log(`  ✗  ${message}`);
    console.log(`      ${remedy}\n`);
  }
  console.log("The API will still START and serve with these problems — since build");
  console.log("74 no configuration fault is fatal, so you will not get a 502 from this.");
  console.log("But fix them: each one above is a real weakness or a degraded feature.");
  console.log("");
  console.log("DO NOT RESTART YET if you can avoid it. The API currently running is");
  console.log("unaffected by the files you just extracted; it keeps serving until it");
  console.log("restarts, so fixing these first costs you nothing.\n");
  process.exit(1);
})();
