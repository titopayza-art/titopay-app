"use strict";

// Standalone webhook delivery worker.
//
// The API runs the same loop in-process by default (WEBHOOK_WORKER_INLINE is
// on unless set to "0"), so webhooks deliver on any deployment. Run this file
// as its own process to move delivery off the request path at scale - then
// set WEBHOOK_WORKER_INLINE=0 on the API. Running both is safe: fan-out is
// advisory-locked and delivery claims with FOR UPDATE SKIP LOCKED, so the two
// never double-send; it only wastes a little polling.

const { pool } = require("./db/pool");
const webhooks = require("./services/webhook-service");

let stopping = false;
let timer = null;

async function cycle() {
  try {
    const { fanned, delivered } = await webhooks.runWorkerTick();
    if (fanned.created || delivered.claimed) {
      console.info("[webhook-worker] cycle", { fannedOut: fanned.created, ...delivered });
    }
  } catch (error) {
    console.error("[webhook-worker] cycle failed", { message: error.message, code: error.code });
  } finally {
    if (!stopping) timer = setTimeout(cycle, Number(process.env.WEBHOOK_WORKER_POLL_MS || 5000));
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  console.info("[webhook-worker] shutting down", { signal });
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

webhooks.ensureWebhookSchema()
  .catch((error) => console.error("[webhook-worker] schema ensure failed", { message: error.message }))
  .then(() => cycle());
