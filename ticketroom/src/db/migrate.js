// Minimal, transactional, reversible migration runner.
//   node src/db/migrate.js up            apply all pending
//   node src/db/migrate.js down [n=1]    revert the last n
const fs = require("fs");
const path = require("path");
const { getPool, close } = require("../lib/db");

const DIR = path.join(__dirname, "migrations");

function list() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".up.sql")).map((f) => f.replace(".up.sql", "")).sort();
}

async function ensureMeta(client) {
  await client.query("CREATE SCHEMA IF NOT EXISTS tr_meta");
  await client.query(`CREATE TABLE IF NOT EXISTS tr_meta.migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
}

async function up({ log = console.log } = {}) {
  const client = await getPool().connect();
  try {
    await ensureMeta(client);
    const done = new Set((await client.query("SELECT name FROM tr_meta.migrations")).rows.map((r) => r.name));
    for (const name of list()) {
      if (done.has(name)) continue;
      const sql = fs.readFileSync(path.join(DIR, `${name}.up.sql`), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO tr_meta.migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        log(`applied ${name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

async function down(steps = 1, { log = console.log } = {}) {
  const client = await getPool().connect();
  try {
    await ensureMeta(client);
    const applied = (await client.query("SELECT name FROM tr_meta.migrations ORDER BY name DESC")).rows.map((r) => r.name);
    for (const name of applied.slice(0, steps)) {
      const sql = fs.readFileSync(path.join(DIR, `${name}.down.sql`), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("DELETE FROM tr_meta.migrations WHERE name = $1", [name]);
        await client.query("COMMIT");
        log(`reverted ${name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`revert of ${name} failed: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { up, down, list };

if (require.main === module) {
  const [cmd = "up", n] = process.argv.slice(2);
  (cmd === "down" ? down(Number(n || 1)) : up())
    .then(() => close())
    .catch((err) => { console.error(err.message); close().finally(() => process.exit(1)); });
}
