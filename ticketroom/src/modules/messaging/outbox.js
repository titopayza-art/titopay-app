// Transactional and marketing messages are written to an outbox inside the
// business transaction, then delivered by a worker. A failure to send never
// rolls back a payment, and nothing is sent for a transaction that rolled back.
const config = require("../../config");
const db = require("../../lib/db");
const { randomToken } = require("../../lib/crypto");

function mask(addr) {
  const s = String(addr || "");
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return `${u.slice(0, 1)}***@${d}`;
  }
  return s.length > 4 ? `${s.slice(0, 3)}*****${s.slice(-2)}` : "***";
}

// Delivery adapters. Only "log" exists: it records delivery without sending
// anything. Real SMTP / SMS gateways are pending provider selection and are
// deliberately not faked here (see docs/INTEGRATIONS.md).
const adapters = {
  log: {
    name: "log (SIMULATED — not delivered)",
    async send(msg) {
      if (!config.isTest) console.log(`[outbox:${msg.channel}] -> ${mask(msg.to_address)} ${msg.subject ? `"${msg.subject}"` : ""}`);
      return { providerMessageId: `log_${randomToken(9)}` };
    },
  },
};

function adapterFor(channel) {
  const name = channel === "sms" ? config.messaging.smsProvider : config.messaging.emailProvider;
  const a = adapters[name];
  if (!a) throw new Error(`no ${channel} adapter "${name}" is installed`);
  return { key: name, ...a };
}

async function enqueue(client, { channel = "email", kind = "transactional", to, subject, body, userId, campaignId }) {
  if (!to) return null;
  const { rows } = await client.query(
    `INSERT INTO message_outbox (channel, kind, to_address, subject, body, user_id, campaign_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING RETURNING id`,
    [channel, kind, to, subject || null, body, userId || null, campaignId || null]);
  return rows[0]?.id || null;
}

// Sends one batch. Marketing messages are re-checked against consent at send
// time so an opt-out between queueing and sending is honoured.
async function deliverBatch(limit = 50) {
  const claimed = await db.withTx(async (c) => {
    const { rows } = await c.query(
      `SELECT o.*, c.organiser_id FROM message_outbox o LEFT JOIN campaigns c ON c.id = o.campaign_id
        WHERE o.status = 'queued' AND o.attempts < 5
        ORDER BY o.created_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit]);
    for (const m of rows) await c.query("UPDATE message_outbox SET attempts = attempts + 1 WHERE id = $1", [m.id]);
    return rows;
  });
  let sent = 0;
  for (const m of claimed) {
    try {
      if (m.kind === "marketing") {
        const { rows } = await db.query(
          `SELECT granted FROM marketing_consents WHERE user_id = $1 AND organiser_id IS NOT DISTINCT FROM $2 AND channel = $3`,
          [m.user_id, m.organiser_id, m.channel]);
        if (!rows[0]?.granted) {
          await db.query("UPDATE message_outbox SET status = 'suppressed', last_error = 'consent withdrawn' WHERE id = $1", [m.id]);
          continue;
        }
      }
      const adapter = adapterFor(m.channel);
      const { providerMessageId } = await adapter.send(m);
      await db.query("UPDATE message_outbox SET status = 'sent', provider = $2, provider_message_id = $3, sent_at = now(), last_error = NULL WHERE id = $1", [m.id, adapter.key, providerMessageId]);
      if (m.campaign_id) await db.query("UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = $1", [m.campaign_id]);
      sent++;
    } catch (err) {
      const final = m.attempts + 1 >= 5;
      await db.query("UPDATE message_outbox SET status = $2, last_error = $3 WHERE id = $1", [m.id, final ? "failed" : "queued", String(err.message).slice(0, 300)]);
      if (final && m.campaign_id) await db.query("UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = $1", [m.campaign_id]);
    }
  }
  return sent;
}

module.exports = { enqueue, deliverBatch, mask, adapterFor };
