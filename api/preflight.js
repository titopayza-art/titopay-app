#!/usr/bin/env node
"use strict";

// WILL THIS BUILD START, WITH THE CONFIGURATION THIS SERVER ACTUALLY HAS?
//
// Answered BEFORE the restart, while the old process is still serving traffic.
//
// On 20 August 2026 the API went to 502 after a deploy. Nothing had crashed:
// build 71 had added IDENTITY_PEPPER as a required variable, the new code
// refused to start without it, and refusing to start is indistinguishable from
// being down when nginx is in front. The guard was right. What was missing was
// any way to learn that a new variable was needed WITHOUT restarting into it.
//
// So this is the missing step. It loads the real configuration exactly the way
// src/config/env.js does, reports every problem in one pass rather than dying on
// the first, and exits non-zero so a deploy script can stop. It reads
// configuration and connects to nothing unless asked. It never prints a secret's
// value — only whether it is present and long enough.
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
      (names[0].startsWith("JWT") ? "\n      Note: changing a JWT secret signs everyone out. Nothing is lost; they sign in again." : ""));
    return;
  }
  notes.push(`${found.name} set${minBytes ? `, ${bytes} bytes` : ""}.`);
}

// The startup-blocking set. Anything src/config/env.js can THROW on belongs
// here, and api/test/deployment-preflight.test.js fails the build if the two
// ever drift apart.
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

// ------------------------------------------------------------ the real loader

// Belt and braces: even with the list above satisfied, load the actual config so
// that a requirement added to env.js and NOT mirrored here still surfaces now
// rather than at restart.
if (!problems.length) {
  try {
    require("./src/config/env");
    notes.push("src/config/env.js loaded cleanly.");
  } catch (error) {
    fail(`The API's own configuration loader rejected this environment: ${error.message}`,
      "This is the exact error the API would print instead of starting.");
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
    console.log(`\nThis build will start with the configuration on this server.`);
    console.log(`Safe to restart.\n`);
    process.exit(0);
  }

  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} that would stop the API from starting:\n`);
  for (const { message, remedy } of problems) {
    console.log(`  ✗  ${message}`);
    console.log(`      ${remedy}\n`);
  }
  console.log("DO NOT RESTART YET. The API currently running is unaffected by");
  console.log("the files you just extracted; it keeps serving until it restarts.");
  console.log("Fix the above, run this again, and restart once it passes.\n");
  process.exit(1);
})();
