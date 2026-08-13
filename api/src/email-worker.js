"use strict";

const crypto = require("crypto");
const { pool } = require("./db/pool");
const { getSettings, claimJobs, processJob, requeueRetryable, sweepExpiredOtpEmails } = require("./services/email-centre-service");
const { API_BUILD } = require("./build-info");

const workerId = `${process.pid}-${crypto.randomUUID()}`;
let stopping = false;
let timer;

// The worker is a separate process, so "the API is on build N" says nothing
// about the code delivering the mail - an unrestarted worker once shipped
// ticket emails while silently dropping their PDF attachments, because only
// the web process had been updated. Each cycle the worker stamps its build
// into the database, and /health reports it, so one request answers whether
// BOTH processes are current.
let heartbeatCycles = 0;
async function heartbeat() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::JSONB,
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('email_worker_heartbeat', $1::JSONB, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ build: API_BUILD, workerId, at: new Date().toISOString() })]
    );
  } catch (error) {
    console.error("[email-worker] heartbeat failed", { message: error.message });
  }
}

let cyclesSinceSweep = 0;
let cyclesSinceIntegrity = 0;
async function cycle() {
  if (stopping) return;
  try {
    // Every ~30 seconds, and on the first cycle, so a fresh restart shows up
    // in /health within one poll.
    if (heartbeatCycles === 0 || ++heartbeatCycles >= 15) {
      heartbeatCycles = 1;
      await heartbeat();
    }
    await requeueRetryable();
    // Every ~5 minutes: expired verification codes stop existing in readable
    // form in our own database, and stale challenge hashes are purged.
    if (++cyclesSinceSweep >= 150) {
      cyclesSinceSweep = 0;
      const swept = await sweepExpiredOtpEmails().catch((error) => { console.error("[email-worker] otp sweep failed", { message: error.message }); return null; });
      if (swept && (swept.redacted || swept.purged)) console.info("[email-worker] otp sweep", swept);
    }
    // Every ~30 minutes the money integrity sweep verifies recent ledger
    // activity: balances against postings, duplicates, orphans, unbalanced
    // legs, stale in-flight payments. The worker is a single process, so
    // this runs exactly once per interval however many API workers exist.
    if (++cyclesSinceIntegrity >= 900) {
      cyclesSinceIntegrity = 0;
      const audit = await require("./services/money-integrity-service").runIntegritySweep({})
        .catch((error) => { console.error("[email-worker] integrity sweep failed", { message: error.message }); return null; });
      if (audit && audit.exceptionCount) console.warn("[email-worker] integrity sweep found issues", audit);
    }
    const settings = await getSettings();
    const jobs = await claimJobs(workerId, settings.worker_concurrency);
    const results = await Promise.allSettled(jobs.map(processJob));
    const failed = results.filter((result) => result.status === "rejected").length;
    console.info("[email-worker] cycle", { workerId, claimed:jobs.length, failed });
  } catch (error) {
    console.error("[email-worker] cycle failed", { workerId, message:error.message, code:error.code });
  } finally {
    if (!stopping) timer = setTimeout(cycle, Number(process.env.EMAIL_WORKER_POLL_MS || 2000));
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  console.info("[email-worker] shutting down", { workerId, signal });
  await pool.end().catch(()=>{});
  process.exit(0);
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
cycle();

