const { Pool } = require("pg");
const net = require("net");
const { config } = require("../config/env");

function booleanSetting(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return !["false", "0", "no", "off", "disable", "disabled"].includes(
    String(value).trim().toLowerCase()
  );
}

function isLocalPostgresHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) return true;
  const addressType = net.isIP(host);
  if (addressType === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (addressType === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
  }
  return false;
}

function postgresSslForUrl(connectionString, environment, explicitSetting) {
  const explicit = booleanSetting(explicitSetting);
  if (explicit === false) return false;
  const rejectUnauthorized = booleanSetting(process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED);
  if (explicit === true) return { rejectUnauthorized: rejectUnauthorized !== false };

  try {
    const parsed = new URL(connectionString);
    const sslMode = String(parsed.searchParams.get("sslmode") || "").toLowerCase();
    if (sslMode === "disable") return false;
    if (["require", "verify-ca", "verify-full"].includes(sslMode)) {
      return { rejectUnauthorized: sslMode !== "require" && rejectUnauthorized !== false };
    }
    if (isLocalPostgresHost(parsed.hostname)) return false;
  } catch (_error) {
    // Unix socket/keyword connection strings are local unless SSL is explicit.
    return false;
  }

  return environment === "production"
    ? { rejectUnauthorized: rejectUnauthorized === true }
    : false;
}

// How many connections this process may hold.
//
// This was a flat 20, which is right for one process and dangerous for several:
// PostgreSQL here allows 100 connections in total, so eight API workers at 20
// each would ask for 160 and PostgreSQL would start refusing them. The API then
// returns errors while the database itself is perfectly healthy — and the
// symptom looks nothing like the cause.
//
// So the ceiling is divided rather than repeated. API_WORKERS is how many API
// processes are being run; the +1 is the email worker, which loads this same
// pool. POSTGRES_RESERVED_CONNECTIONS keeps room for migrations, backups and a
// human with psql during an incident.
//
// With API_WORKERS unset it resolves to 20 — byte-for-byte today's behaviour —
// so this changes nothing until someone actually runs more than one process.
function poolSize() {
  const explicit = Number(process.env.POSTGRES_POOL_MAX);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);

  const workers = Math.max(1, Math.floor(Number(process.env.API_WORKERS) || 1));
  const ceiling = Math.max(1, Math.floor(Number(process.env.POSTGRES_MAX_CONNECTIONS) || 100));
  const reserved = Math.max(0, Math.floor(Number(process.env.POSTGRES_RESERVED_CONNECTIONS) || 20));
  const share = Math.floor((ceiling - reserved) / (workers + 1));
  // Never above the historical 20, and never below 4 — a pool that small queues
  // more than it serves, and it is better to be told about it than to silently
  // starve.
  return Math.min(20, Math.max(4, share));
}

const pool = new Pool({
  connectionString: config.postgresUrl,
  max: poolSize(),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // A connection can NEVER be held indefinitely. If any code path opens a
  // transaction and does not COMMIT/ROLLBACK it (a leak), Postgres closes that
  // connection after 60s of sitting idle-in-transaction and returns it to the
  // pool - so leaked transactions can no longer accumulate until the pool is
  // exhausted and every query (login, /health) times out "trying to connect".
  // This only affects a connection doing NOTHING inside an open transaction; an
  // ACTIVE query is never touched - so a long migration or report (which runs
  // through this same pool) is safe, and only a genuine leak is reclaimed.
  idle_in_transaction_session_timeout: 60000,
  ssl: postgresSslForUrl(
    config.postgresUrl,
    config.env,
    process.env.POSTGRES_SSL ?? process.env.DATABASE_SSL
  )
});

function logSlowQuery(startedAt, args) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (durationMs <= 200) return;
  const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
  console.warn("[slow-db-query]", {
    durationMs: Math.round(durationMs * 10) / 10,
    statement: String(text || "unknown").replace(/\s+/g, " ").trim().slice(0, 240)
  });
}

const rawQuery = pool.query.bind(pool);
pool.query = async function measuredQuery(...args) {
  const startedAt = process.hrtime.bigint();
  try {
    return await rawQuery(...args);
  } finally {
    logSlowQuery(startedAt, args);
  }
};

pool.on("connect", (client) => {
  const clientQuery = client.query.bind(client);
  client.query = async function measuredClientQuery(...args) {
    const startedAt = process.hrtime.bigint();
    try {
      return await clientQuery(...args);
    } finally {
      logSlowQuery(startedAt, args);
    }
  };
});

module.exports = { pool, postgresSslForUrl, isLocalPostgresHost };
