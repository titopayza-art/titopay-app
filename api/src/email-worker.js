"use strict";

const crypto = require("crypto");
const { pool } = require("./db/pool");
const { getSettings, claimJobs, processJob, requeueRetryable } = require("./services/email-centre-service");

const workerId = `${process.pid}-${crypto.randomUUID()}`;
let stopping = false;
let timer;

async function cycle() {
  if (stopping) return;
  try {
    await requeueRetryable();
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

