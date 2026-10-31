const { Pool, types } = require("pg");
const config = require("../config");

// bigint (int8) columns carry money in cents. Parse to Number but refuse any
// value that would lose precision instead of silently rounding.
types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds safe integer range`);
  return n;
});

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      options: "-c search_path=tr,public",
      max: Number(process.env.PG_POOL_MAX || 20),
    });
    pool.on("error", (err) => console.error("[db] idle client error", err.code || err.message));
  }
  return pool;
}

const query = (text, params) => getPool().query(text, params);

const RETRYABLE = new Set(["40001", "40P01"]);

// Runs fn inside a transaction. Deadlocks and serialisation failures are retried
// because every financial operation is written to be safely re-runnable.
async function withTx(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

async function close() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = { query, withTx, getPool, close };
