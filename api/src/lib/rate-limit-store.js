"use strict";

// A rate-limit counter that every process shares.
//
// express-rate-limit's default store keeps its counters in the memory of one
// process. That is correct for a single process and wrong the moment there are
// several: with four workers behind a round-robin balancer, "five attempts per
// fifteen minutes" quietly becomes twenty, because each worker counts to five
// on its own. The limit that protects login, OTP and password reset would be
// weakened by exactly the factor we scale by.
//
// This backs the counter with the PostgreSQL that is already running, so the
// number means the same thing regardless of how many processes serve it. No new
// infrastructure, and one atomic statement per attempt.
//
// Keys are hashed before they are stored. A rate-limit key contains the
// identifier someone typed — an email address or a phone number — and there is
// no reason for a new table to accumulate those. The hash is enough to count
// with, and the identifier is still recorded in the security log, where it
// belongs and where access is already controlled.

const crypto = require("crypto");
const { pool } = require("../db/pool");

const EXPIRED_ROW_GRACE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

let tableAvailable = null;
let lastSweepAt = 0;

// One probe for the whole process. If the table is not there — code deployed
// ahead of its migration — say so once, loudly and actionably, rather than
// failing every login or silently counting nothing.
async function ensureTable() {
  if (tableAvailable !== null) return tableAvailable;
  try {
    await pool.query("SELECT 1 FROM rate_limit_counters LIMIT 1");
    tableAvailable = true;
  } catch (error) {
    tableAvailable = false;
    console.error(
      "[rate-limit-store] rate_limit_counters is not available; falling back to per-process counting. " +
      "Run the 20260810_rate_limit_counters migration. Until then, limits are counted per process, " +
      "which is the behaviour from before this change — protection is reduced, not absent.",
      { message: error.message }
    );
  }
  return tableAvailable;
}

function sweepExpired() {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  pool
    .query("DELETE FROM rate_limit_counters WHERE expires_at <= NOW() - INTERVAL '1 hour'")
    .catch((error) => console.warn("[rate-limit-store] sweep failed", { message: error.message }));
}

class SharedRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.windowMs = 60 * 1000;
    // Used only when the table is missing, so the degraded mode is exactly the
    // single-process behaviour we had before rather than no limiting at all.
    this.fallback = new Map();
  }

  init(options) {
    if (options && Number.isFinite(options.windowMs)) this.windowMs = options.windowMs;
  }

  storageKey(key) {
    return crypto.createHash("sha256").update(`${this.prefix}:${key}`).digest("hex");
  }

  fallbackIncrement(key, delta) {
    const now = Date.now();
    const existing = this.fallback.get(key);
    if (!existing || existing.resetTime.getTime() <= now) {
      const fresh = { totalHits: Math.max(0, delta), resetTime: new Date(now + this.windowMs) };
      this.fallback.set(key, fresh);
      return fresh;
    }
    existing.totalHits = Math.max(0, existing.totalHits + delta);
    return existing;
  }

  async increment(key) {
    if (!(await ensureTable())) return this.fallbackIncrement(key, 1);
    sweepExpired();
    try {
      // One statement, so two workers arriving together serialise on the row
      // rather than both reading the same count. The CASE arms roll the window
      // over in the same breath: an expired row restarts at one instead of
      // carrying a stale total forward.
      const { rows } = await pool.query(
        `INSERT INTO rate_limit_counters (key, hits, expires_at)
         VALUES ($1, 1, NOW() + make_interval(secs => $2))
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN rate_limit_counters.expires_at <= NOW()
                       THEN 1 ELSE rate_limit_counters.hits + 1 END,
           expires_at = CASE WHEN rate_limit_counters.expires_at <= NOW()
                             THEN NOW() + make_interval(secs => $2)
                             ELSE rate_limit_counters.expires_at END
         RETURNING hits, expires_at`,
        [this.storageKey(key), this.windowMs / 1000]
      );
      return { totalHits: Number(rows[0].hits), resetTime: new Date(rows[0].expires_at) };
    } catch (error) {
      // Deliberately permissive. If PostgreSQL cannot answer this, it cannot
      // answer the users query either, so the login this is guarding is already
      // failing — refusing it here would only turn a database blip into a
      // lockout for everyone. The event is logged so it is never silent.
      console.error("[rate-limit-store] increment failed; allowing the request", { message: error.message });
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    if (!(await ensureTable())) {
      this.fallbackIncrement(key, -1);
      return;
    }
    await pool
      .query(
        `UPDATE rate_limit_counters SET hits = GREATEST(0, hits - 1)
         WHERE key = $1 AND expires_at > NOW()`,
        [this.storageKey(key)]
      )
      .catch((error) => console.warn("[rate-limit-store] decrement failed", { message: error.message }));
  }

  async resetKey(key) {
    this.fallback.delete(key);
    if (!(await ensureTable())) return;
    await pool
      .query("DELETE FROM rate_limit_counters WHERE key = $1", [this.storageKey(key)])
      .catch((error) => console.warn("[rate-limit-store] resetKey failed", { message: error.message }));
  }
}

// express-rate-limit calls init() on the store it is given, so each limiter
// needs its own instance. The prefix keeps two limiters from sharing a counter
// when they happen to build the same key.
function sharedStore(prefix) {
  return new SharedRateLimitStore(prefix);
}

module.exports = { sharedStore, SharedRateLimitStore };
