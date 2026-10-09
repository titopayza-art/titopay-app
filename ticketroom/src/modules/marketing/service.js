// Organiser marketing: email and SMS campaigns to people who bought tickets
// from that organiser AND opted in to that organiser's marketing on that
// channel (POPIA s69 direct marketing). Every message carries the sender's
// identity and an opt-out. Consent is re-checked at send time.
const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { signLink } = require("../../lib/crypto");
const { conflict, notFound } = require("../../lib/errors");
const outbox = require("../messaging/outbox");

const NIL = "00000000-0000-0000-0000-000000000000";
const DAILY_CAMPAIGN_LIMIT = 10;

async function setConsent(q, userId, organiserId, channel, granted, source) {
  await q.query(
    `INSERT INTO marketing_consents (user_id, organiser_id, channel, granted, source) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, COALESCE(organiser_id, '${NIL}'::uuid), channel) DO UPDATE SET granted = EXCLUDED.granted, source = EXCLUDED.source, updated_at = now()`,
    [userId, organiserId || null, channel, granted, source]);
  await q.query("INSERT INTO consent_log (user_id, organiser_id, channel, granted, source) VALUES ($1,$2,$3,$4,$5)", [userId, organiserId || null, channel, granted, source]);
}

async function consentsFor(userId) {
  const { rows } = await db.query(
    `SELECT c.organiser_id, o.name AS organiser_name, c.channel, c.granted, c.updated_at
       FROM marketing_consents c LEFT JOIN organisers o ON o.id = c.organiser_id WHERE c.user_id = $1 ORDER BY o.name NULLS FIRST, c.channel`, [userId]);
  return rows;
}

// SQL for the consented audience of an organiser, optionally filtered by events:
// people who bought from (or hold tickets for) this organiser AND opted in.
function audienceSql(channel, eventIds) {
  const contact = channel === "sms" ? "u.phone" : "u.email";
  return {
    text: `SELECT DISTINCT u.id AS user_id, u.full_name, ${contact} AS address
             FROM users u
             JOIN marketing_consents mc ON mc.user_id = u.id AND mc.organiser_id = $1 AND mc.channel = $2 AND mc.granted
            WHERE u.status = 'active' AND ${contact} IS NOT NULL
              AND (EXISTS (SELECT 1 FROM orders o JOIN events e ON e.id = o.event_id
                            WHERE o.user_id = u.id AND e.organiser_id = $1 AND o.status IN ('paid','partially_refunded','refunded')
                            ${eventIds?.length ? "AND e.id = ANY($3::uuid[])" : ""})
                OR EXISTS (SELECT 1 FROM tickets t JOIN events e ON e.id = t.event_id
                            WHERE t.owner_user_id = u.id AND e.organiser_id = $1
                            ${eventIds?.length ? "AND e.id = ANY($3::uuid[])" : ""}))`,
    params: eventIds?.length ? [null, channel, eventIds] : [null, channel],
  };
}

async function audience(organiserId, channel, eventIds, q = db) {
  const sql = audienceSql(channel, eventIds);
  sql.params[0] = organiserId;
  const { rows } = await q.query(sql.text, sql.params);
  return rows;
}

async function audienceSummary(organiserId, eventIds) {
  const [email, sms] = await Promise.all([audience(organiserId, "email", eventIds), audience(organiserId, "sms", eventIds)]);
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT t.owner_user_id)::int AS n FROM tickets t JOIN events e ON e.id = t.event_id
      WHERE e.organiser_id = $1 AND t.status IN ('valid','used') ${eventIds?.length ? "AND e.id = ANY($2::uuid[])" : ""}`,
    eventIds?.length ? [organiserId, eventIds] : [organiserId]);
  return { ticketHolders: rows[0].n, emailOptIns: email.length, smsOptIns: sms.length };
}

// GSM-7 segments: 160 single, 153 per part when concatenated. Non-GSM text
// (emoji etc.) uses UCS-2: 70 / 67.
function smsSegments(text) {
  const gsm = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

function unsubscribeUrl(userId, organiserId, channel) {
  return `${config.publicBaseUrl}/unsubscribe?t=${signLink({ u: userId, o: organiserId, c: channel }, 60 * 60 * 24 * 365)}`;
}

function render(campaign, organiser, recipient) {
  const first = String(recipient.full_name || "").split(" ")[0] || "there";
  const body = campaign.body.replace(/\{\{\s*first_name\s*\}\}/g, first);
  const unsub = unsubscribeUrl(recipient.user_id, campaign.organiser_id, campaign.channel);
  if (campaign.channel === "sms") return { body: `${organiser.name}: ${body} Opt out: ${unsub}` };
  return {
    subject: campaign.subject,
    body: `${body}\n\n—\nYou are receiving this because you bought tickets from ${organiser.name} on TicketRoom and agreed to hear from them.\nUnsubscribe: ${unsub}\nTicketRoom is powered by TitoPay.`,
  };
}

function estimate(campaign, recipients) {
  if (campaign.channel !== "sms") return 0;
  const sample = render(campaign, { name: "Organiser" }, { user_id: "x", full_name: "Sample" }).body;
  return recipients * smsSegments(sample) * config.messaging.smsCostPerSegmentCents;
}

async function getCampaign(organiserId, id, q = db, lock = false) {
  const { rows } = await q.query(`SELECT * FROM campaigns WHERE id = $1 AND organiser_id = $2 ${lock ? "FOR UPDATE" : ""}`, [id, organiserId]);
  if (!rows[0]) throw notFound("Campaign not found.");
  return rows[0];
}

// Queues a campaign's messages. Unique (campaign, user) in the outbox makes a
// double "send" harmless.
async function send(actor, organiserId, campaignId) {
  return db.withTx(async (c) => {
    const camp = await getCampaign(organiserId, campaignId, c, true);
    if (!["draft", "scheduled"].includes(camp.status)) throw conflict(`This campaign is already ${camp.status}.`, "bad_transition");
    const { rows: org } = await c.query("SELECT * FROM organisers WHERE id = $1", [organiserId]);
    if (org[0].status !== "approved") throw conflict("Your organiser account must be approved before sending marketing.", "organiser_not_approved");
    const { rows: today } = await c.query("SELECT count(*)::int AS n FROM campaigns WHERE organiser_id = $1 AND status IN ('sending','sent') AND sent_at > now() - interval '1 day'", [organiserId]);
    if (today[0].n >= DAILY_CAMPAIGN_LIMIT) throw conflict(`You can send at most ${DAILY_CAMPAIGN_LIMIT} campaigns a day.`, "campaign_limit");
    const recipients = await audience(organiserId, camp.channel, camp.audience?.eventIds, c);
    for (const r of recipients) {
      const msg = render(camp, org[0], r);
      await outbox.enqueue(c, { channel: camp.channel, kind: "marketing", to: r.address, ...msg, userId: r.user_id, campaignId: camp.id });
    }
    const { rows } = await c.query(
      "UPDATE campaigns SET status = 'sent', sent_at = now(), recipients_count = $2, estimated_cost_cents = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [camp.id, recipients.length, estimate(camp, recipients.length)]);
    await audit.record(c, { actor, action: "campaign.sent", entityType: "campaign", entityId: camp.id, organiserId, details: { channel: camp.channel, recipients: recipients.length } });
    return rows[0];
  });
}

async function sendTest(actor, organiserId, campaignId) {
  const camp = await getCampaign(organiserId, campaignId);
  const { rows: org } = await db.query("SELECT * FROM organisers WHERE id = $1", [organiserId]);
  const to = camp.channel === "sms" ? actor.phone : actor.email;
  if (!to) throw conflict("Add a mobile number to your profile to receive test SMSes.", "no_phone");
  const msg = render(camp, org[0], { user_id: actor.id, full_name: actor.fullName });
  await db.withTx((c) => outbox.enqueue(c, { channel: camp.channel, kind: "transactional", to, subject: msg.subject ? `[TEST] ${msg.subject}` : undefined, body: msg.body, userId: actor.id }));
  return { sentTo: outbox.mask(to) };
}

async function dueScheduled() {
  const { rows } = await db.query("SELECT id, organiser_id, created_by FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now() LIMIT 20");
  for (const r of rows) {
    try { await send({ id: r.created_by }, r.organiser_id, r.id); } catch (err) {
      await db.query("UPDATE campaigns SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'scheduled'", [r.id]);
      console.warn(`[campaigns] scheduled send failed ${r.id}: ${err.message}`);
    }
  }
  return rows.length;
}

module.exports = { setConsent, consentsFor, audience, audienceSummary, smsSegments, render, estimate, getCampaign, send, sendTest, dueScheduled, unsubscribeUrl };
