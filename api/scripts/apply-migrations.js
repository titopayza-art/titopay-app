"use strict";

// Apply every pending migration in src/db/migrations, in filename order.
//
// This exists because the alternative was a person remembering to run each
// .sql file by hand after each deploy, and the first time that was missed the
// Marketing pages in production answered "Unable to complete the request" —
// which reads as a fault and is really a forgotten command.
//
// It uses the API's own connection settings, so it needs no psql, no
// credentials typed at a prompt and no database client installed. Run it from
// the API directory, the same place `npm start` runs from:
//
//     npm run db:apply-migrations
//
// Safe to run at any time, and safe to run twice. Applied migrations are
// recorded in schema_migrations and skipped; every migration in this project is
// additive and written IF NOT EXISTS regardless, so a re-run is a no-op even
// for a file that predates this tracking table.
//
// It never runs a .down.sql. Reversing something is a decision a person takes
// deliberately, with a backup, not something a deploy script does.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { config } = require("../src/config/env");

// SAY "THERE IS NO DATABASE CONFIGURED" IN THOSE WORDS.
//
// Without this check, an empty POSTGRES_URL let the Postgres client fall back
// to its defaults — localhost, port 5432, the OS username — and the operator
// read `password authentication failed for user "root"`, which sounds like a
// wrong password and is really a missing variable. Seen in production on
// 20 August 2026, minutes after the 502 was fixed.
//
// A shell over SSH is not the process manager. On cPanel (Passenger), pm2 and
// systemd setups the running API gets its variables injected by the manager,
// and a login shell does not inherit them — so this script can be missing its
// configuration on the same machine where the API is serving fine.
// libpq's own variables are a legitimate way to configure the client, and pg
// honours them when no connection string is given — a shell set up with
// PGHOST/PGDATABASE/PGUSER worked before this guard existed and must keep
// working. The refusal is only for a shell with NEITHER form of configuration,
// where the client's last resort is localhost as the OS username.
const hasLibpqConfig = ["PGHOST", "PGDATABASE", "PGUSER", "PGPORT"]
  .some((name) => process.env[name]);

if (!config.postgresUrl && !hasLibpqConfig) {
  console.error("\n  POSTGRES_URL is not set in this shell (DATABASE_URL works too), so there");
  console.error("  is no database to apply migrations to. (Without it the Postgres client");
  console.error("  falls back to your OS username, which is where a confusing `password");
  console.error("  authentication failed for user \"root\"` comes from.)");
  console.error("\n  The running API may be configured correctly even so: on cPanel, pm2 and");
  console.error("  systemd setups its variables come from the process manager, which this");
  console.error("  shell does not inherit. Either pass the same value the API uses:");
  console.error("\n      POSTGRES_URL=\"<connection string>\" npm run db:apply-migrations");
  console.error("\n  or create a .env in this directory with the same values, so every");
  console.error("  script here sees what the API sees. .env.example lists every name.\n");
  process.exit(1);
}

const { pool } = require("../src/db/pool");

const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

// psql's include directives, resolved here.
//
// 20260804_email_centre.up.sql is a single line: `\ir ../email-centre-schema.sql`.
// That is psql syntax, not SQL, so node-pg rejects it with "syntax error at or
// near \\". Rather than skip the migration or demand psql, the include is
// resolved and inlined — which is exactly what psql itself does.
//
// Includes are resolved relative to the including file, one level deep, which
// is all this project uses.
function resolveIncludes(sql, fromDir) {
  return sql.split("\n").map((line) => {
    const include = line.match(/^\s*\\i(?:r)?\s+(\S+)\s*$/);
    if (!include) return line;
    const target = path.resolve(fromDir, include[1]);
    if (!fs.existsSync(target)) {
      throw new Error(`${line.trim()} refers to ${include[1]}, which is not in this package`);
    }
    return fs.readFileSync(target, "utf8");
  }).join("\n");
}

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

function pendingFiles(applied) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".up.sql"))
    .sort()
    .filter((name) => !applied.has(name));
}

async function main() {
  await ensureTrackingTable();

  const { rows } = await pool.query("SELECT filename, checksum FROM schema_migrations");
  const applied = new Map(rows.map((row) => [row.filename, row.checksum]));
  const pending = pendingFiles(new Set(applied.keys()));

  // A migration that has already run but whose file has since changed is worth
  // saying out loud. It is not an error — the file may have been reformatted —
  // but it means what is in this build is not exactly what was applied.
  for (const [filename, checksum] of applied) {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    if (!fs.existsSync(filePath)) continue;
    const current = crypto.createHash("sha256")
      .update(fs.readFileSync(filePath, "utf8")).digest("hex");
    if (current !== checksum) {
      console.warn(`  NOTE  ${filename} was applied earlier and the file has changed since.`);
    }
  }

  if (!pending.length) {
    console.log(`\n  Nothing to apply. ${applied.size} migration(s) already recorded.\n`);
    await pool.end();
    return;
  }

  console.log(`\n  ${pending.length} migration(s) to apply:\n`);
  for (const filename of pending) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    const sql = resolveIncludes(raw, MIGRATIONS_DIR);
    const checksum = crypto.createHash("sha256").update(raw).digest("hex");
    const client = await pool.connect();
    try {
      // Each migration runs in its own transaction, so a failure leaves that
      // one migration fully applied or not at all — never half.
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
        [filename, checksum]);
      await client.query("COMMIT");
      console.log(`  applied  ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`\n  FAILED   ${filename}`);
      console.error(`           ${error.message}`);
      console.error("\n  Nothing from this migration was applied. Earlier migrations in this run "
        + "are already committed and do not need re-running.\n");
      client.release();
      await pool.end();
      process.exit(1);
    }
    client.release();
  }

  console.log(`\n  Done. Reload the Admin Portal.\n`);
  await pool.end();
}

main().catch(async (error) => {
  console.error("\n  Could not apply migrations:", error.message);
  console.error("  Check that this is being run from the API directory and that the "
    + "connection settings the API itself uses are readable.\n");
  await pool.end().catch(() => {});
  process.exit(1);
});
