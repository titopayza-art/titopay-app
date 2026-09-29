"use strict";

// Boot-time performance indexes. Everything here is CREATE INDEX IF NOT
// EXISTS: idempotent, additive, and safe to run on every start. Kept in one
// place so "why is this index here" always has an answer next to it.

const { pool } = require("./pool");

async function ensurePerformanceIndexes() {
  // Every payment POST looks its idempotency key up TWICE (the fast path and
  // the locked re-check). Without an index that is two sequential scans of
  // the busiest table in the system per payment, getting slower with every
  // transaction ever recorded.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_client_idempotency
    ON transactions ((metadata->>'clientIdempotencyKey'))
    WHERE metadata->>'clientIdempotencyKey' IS NOT NULL
  `);
  // The stokvel register reads a group's contributions by metadata group id.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_stockvel_group
    ON transactions ((metadata->>'stockvelGroupId'))
    WHERE metadata->>'stockvelGroupId' IS NOT NULL
  `);
}

module.exports = { ensurePerformanceIndexes };
