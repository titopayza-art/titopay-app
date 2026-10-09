// Background jobs. Each tick is independent and safe to run concurrently on
// several instances (row locks / SKIP LOCKED / idempotent state transitions).
const orders = require("./modules/orders/service");
const outbox = require("./modules/messaging/outbox");
const marketing = require("./modules/marketing/service");
const automated = require("./modules/messaging/automated");
const db = require("./lib/db");
const config = require("./config");

// Data minimisation (POPIA s14): personal data that has served its purpose is
// removed on a schedule. Financial records (orders, payments, ledger, refunds)
// are NOT touched here; they follow the statutory retention period.
const retention = [
  "DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'",
  "DELETE FROM password_resets WHERE created_at < now() - interval '7 days'",
  `UPDATE webhook_events SET payload = jsonb_build_object('redacted', true) WHERE received_at < now() - make_interval(days => ${config.retention.webhookPayloadDays}) AND NOT payload ? 'redacted'`,
  `UPDATE message_outbox SET body = '[redacted]', to_address = '[redacted]' WHERE created_at < now() - make_interval(days => ${config.retention.messageDays}) AND body <> '[redacted]'`,
];

const jobs = [
  { name: "expire-orders", everyMs: 30_000, run: () => orders.expireDue() },
  { name: "deliver-outbox", everyMs: 5_000, run: () => outbox.deliverBatch(50) },
  { name: "event-reminders", everyMs: 10 * 60_000, run: () => automated.reminders() },
  { name: "abandoned-checkouts", everyMs: 15 * 60_000, run: () => automated.abandonedCheckouts() },
  { name: "scheduled-campaigns", everyMs: 60_000, run: () => marketing.dueScheduled() },
  { name: "complete-events", everyMs: 15 * 60_000, run: () => db.query("UPDATE events SET status = 'completed', updated_at = now() WHERE status = 'published' AND ends_at < now() - interval '2 days'") },
  { name: "expire-tags", everyMs: 15 * 60_000, run: () => db.query("UPDATE tags t SET status = 'expired', updated_at = now() FROM events e WHERE e.id = t.event_id AND t.status IN ('active','assigned') AND e.ends_at < now() - interval '2 days'") },
  { name: "retention", everyMs: 6 * 3600_000, run: async () => { for (const sql of retention) await db.query(sql); } },
  { name: "expire-transfers", everyMs: 15 * 60_000, run: () => db.query("UPDATE ticket_transfers SET status = 'expired' WHERE status = 'pending' AND expires_at < now()") },
];

function start() {
  const timers = jobs.map((job) => {
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await job.run(); } catch (err) { console.error(`[worker:${job.name}]`, err.message); } finally { busy = false; }
    }, job.everyMs);
    t.unref();
    return t;
  });
  return () => timers.forEach(clearInterval);
}

module.exports = { start, jobs };
