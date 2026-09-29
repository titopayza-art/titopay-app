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

// MAIL COMING IN, ON THE PROCESS THAT ALREADY SENDS MAIL GOING OUT.
//
// The mailbox is polled here rather than from the web process for the same
// reason the integrity sweep is: this is one process however many API workers
// are running, so the mailbox is read once per interval instead of once per
// worker. The operator sets the interval, so the cycle counter cannot encode
// it - the elapsed time is checked instead, and the settings themselves are
// only re-read every ~30 seconds so a 2-second loop does not query for them
// four hundred times between polls.
let cyclesSinceMailboxCheck = 0;
let lastMailboxPollAt = 0;
async function pollInboundMailbox() {
  if (++cyclesSinceMailboxCheck < 15) return;
  cyclesSinceMailboxCheck = 0;
  const mailbox = require("./services/inbound-mailbox-service");
  const settings = await mailbox.getMailboxSettings();
  if (!settings.enabled) return;
  const due = Date.now() - lastMailboxPollAt >= Math.max(15, settings.pollSeconds) * 1000;
  if (!due) return;
  lastMailboxPollAt = Date.now();
  // pollMailbox returns its failures rather than throwing, but the require and
  // the settings read could still fail, and a mailbox being unreachable must
  // never stop this process sending mail or running the money sweep.
  const result = await mailbox.pollMailbox();
  if (result.ingested || result.failed || result.skipped || result.error) {
    console.info("[email-worker] inbound mailbox", result);
  }
}
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
      // Held payments nobody claimed go back to the sender, in full.
      const returned = await require("./services/pending-credit-service").returnExpiredHolds()
        .catch((error) => { console.error("[email-worker] pending credit sweep failed", { message: error.message }); return []; });
      if (returned.length) console.info("[email-worker] returned unclaimed payments", { count: returned.length });
    }
    await pollInboundMailbox().catch((error) =>
      console.error("[email-worker] inbound mailbox poll failed", { message: error.message }));
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

