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

// Delivery adapters.
//   log        — records delivery, sends nothing (default; email + SMS)
//   bulksms    — BulkSMS JSON API  (POST {base}/messages, Basic token auth)
//   clickatell — Clickatell One API (POST {base}/v1/message, Authorization: <api key>)
// The SMS adapters follow each gateway's published API shape and are tested
// against the local mock. Verify with the gateway's test account before live.
const http = require("../../lib/http");
const sms = (text) => text.replace(/\s+\n/g, "\n").slice(0, 918); // max 6 concatenated GSM segments

const adapters = {
  log: {
    name: "log (SIMULATED — not delivered)",
    async send(msg) {
      if (!config.isTest) console.log(`[outbox:${msg.channel}] -> ${mask(msg.to_address)} ${msg.subject ? `"${msg.subject}"` : ""}`);
      return { providerMessageId: `log_${randomToken(9)}` };
    },
    health: async () => ({ ok: true, detail: "log adapter: messages are recorded, not delivered" }),
  },
  smtp: {
    name: "SMTP",
    transport() {
      if (!this._t) {
        const c = config.messaging.smtp;
        this._t = require("nodemailer").createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass } });
      }
      return this._t;
    },
    async send(msg) {
      const info = await this.transport().sendMail({ from: config.messaging.fromEmail, to: msg.to_address, subject: msg.subject || "TicketRoom", text: msg.body, html: require("./html").toHtml(msg.subject || "TicketRoom", msg.body) });
      return { providerMessageId: String(info.messageId || "") };
    },
    async health() {
      try { await this.transport().verify(); return { ok: true, detail: `SMTP login OK (${config.messaging.smtp.host})` }; }
      catch (err) { return { ok: false, detail: `SMTP: ${err.message}` }; }
    },
  },
  bulksms: {
    name: "BulkSMS",
    async send(msg) {
      const c = config.integrations.bulksms;
      const r = await http.call({ integration: "bulksms", environment: c.env, operation: "send_sms", url: `${c.baseUrl}/messages`, method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${c.tokenId}:${c.tokenSecret}`).toString("base64")}` },
        json: [{ to: msg.to_address, body: sms(msg.body), from: config.messaging.smsSenderId }] });
      if (!r.ok) throw new Error(`BulkSMS HTTP ${r.status}`);
      const id = Array.isArray(r.body) ? r.body[0]?.id : r.body?.id;
      return { providerMessageId: String(id || "") };
    },
    async health() {
      const c = config.integrations.bulksms;
      if (!c.tokenId || !c.tokenSecret) return { ok: false, detail: "BULKSMS_TOKEN_ID / BULKSMS_TOKEN_SECRET not set" };
      try {
        const r = await http.call({ integration: "bulksms", environment: c.env, operation: "health", url: `${c.baseUrl}/profile`, headers: { authorization: `Basic ${Buffer.from(`${c.tokenId}:${c.tokenSecret}`).toString("base64")}` }, timeoutMs: 5000 });
        if (r.status === 401 || r.status === 403) return { ok: false, detail: "credentials rejected" };
        return { ok: true, detail: `reachable (HTTP ${r.status}) — ${c.env}` };
      } catch (err) { return { ok: false, detail: err.message }; }
    },
  },
  clickatell: {
    name: "Clickatell",
    async send(msg) {
      const c = config.integrations.clickatell;
      const r = await http.call({ integration: "clickatell", environment: c.env, operation: "send_sms", url: `${c.baseUrl}/v1/message`, method: "POST",
        headers: { authorization: c.apiKey }, json: { messages: [{ channel: "sms", to: msg.to_address.replace(/^\+/, ""), content: sms(msg.body) }] } });
      const m = r.body?.messages?.[0];
      if (!r.ok || m?.accepted === false) throw new Error(`Clickatell HTTP ${r.status}${m?.error ? `: ${m.error}` : ""}`);
      return { providerMessageId: String(m?.apiMessageId || "") };
    },
    async health() {
      const c = config.integrations.clickatell;
      return c.apiKey ? { ok: true, detail: `configured for ${c.env} (${c.baseUrl}); send a test campaign SMS to verify` } : { ok: false, detail: "CLICKATELL_API_KEY not set" };
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
