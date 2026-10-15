// Automated emails: event reminders and abandoned-checkout nudges. Each
// message is claimed in notification_log first, so it goes out at most once
// even if the cron runner and the web process run at the same time.
const db = require("../../lib/db");
const config = require("../../config");
const settings = require("../site/settings");
const outbox = require("./outbox");
const templates = require("./templates");
const { signLink } = require("../../lib/crypto");

const BATCH = 500;

async function claimAndSend(key, msg) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("INSERT INTO notification_log (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key", [key]);
    if (!rows[0]) return false;
    await outbox.enqueue(c, msg);
    return true;
  });
}

// One reminder per ticket holder per event: the day before (event starts in
// 4–24 hours) and shortly before (starts within 3 hours).
async function reminders() {
  const s = await settings.get("emails");
  let sent = 0;
  const windows = [
    s.reminderDayBefore && { kind: "day", soon: false, from: "4 hours", to: "24 hours" },
    s.reminderSoon && { kind: "soon", soon: true, from: "0 minutes", to: "3 hours" },
  ].filter(Boolean);
  for (const w of windows) {
    const { rows } = await db.query(
      `SELECT e.id, e.title, e.starts_at, e.venue_name, e.address, e.city, e.age_restriction, e.transfers_enabled, e.cashless_enabled,
              u.id AS user_id, u.email, u.full_name, count(*)::int AS tickets
         FROM tickets t JOIN events e ON e.id = t.event_id JOIN users u ON u.id = t.owner_user_id
        WHERE t.status = 'valid' AND e.status = 'published' AND u.status = 'active'
          AND e.starts_at > now() + $1::interval AND e.starts_at <= now() + $2::interval
          AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.key = 'reminder:' || $3 || ':' || e.id || ':' || u.id)
        GROUP BY e.id, u.id LIMIT ${BATCH}`, [w.from, w.to, w.kind]);
    for (const x of rows) {
      const ok = await claimAndSend(`reminder:${w.kind}:${x.id}:${x.user_id}`, { to: x.email, userId: x.user_id, ...templates.eventReminder({ name: x.full_name, event: x, ticketCount: x.tickets, soon: w.soon }) });
      if (ok) sent++;
    }
  }
  return sent;
}

// An unpaid order that expired or was cancelled, where the buyer didn't book
// that event afterwards and the event is still on sale. Sent once per person
// per event, never to someone who unsubscribed from TicketRoom emails.
async function abandonedCheckouts() {
  const s = await settings.get("emails");
  if (!s.abandonedCheckout) return 0;
  const { rows } = await db.query(
    `SELECT DISTINCT ON (o.user_id, o.event_id) o.user_id, o.event_id, u.email, u.full_name,
            e.title, e.slug, e.starts_at, e.venue_name, e.address, e.city
       FROM orders o JOIN users u ON u.id = o.user_id JOIN events e ON e.id = o.event_id
      WHERE o.status IN ('expired','cancelled','failed') AND u.status = 'active'
        AND o.created_at < now() - make_interval(hours => $1) AND o.created_at > now() - interval '48 hours'
        AND e.status = 'published' AND e.starts_at > now() + interval '3 hours'
        AND COALESCE(e.sales_end_at, e.ends_at) > now() AND (e.sales_start_at IS NULL OR e.sales_start_at <= now())
        AND EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale' AND tt.quantity_sold + tt.quantity_held < tt.quantity_total)
        AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.user_id = o.user_id AND p.event_id = o.event_id AND p.status IN ('pending_payment','paid','partially_refunded'))
        AND NOT EXISTS (SELECT 1 FROM marketing_consents mc WHERE mc.user_id = o.user_id AND mc.organiser_id IS NULL AND mc.channel = 'email' AND NOT mc.granted)
        AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.key = 'abandoned:' || o.event_id || ':' || o.user_id)
      ORDER BY o.user_id, o.event_id, o.created_at DESC LIMIT ${BATCH}`, [s.abandonedDelayHours]);
  let sent = 0;
  for (const x of rows) {
    const unsubscribeUrl = `${config.publicBaseUrl}/unsubscribe?t=${signLink({ u: x.user_id, all: true }, 30 * 86400)}`;
    const ok = await claimAndSend(`abandoned:${x.event_id}:${x.user_id}`, {
      to: x.email, userId: x.user_id,
      ...templates.checkoutAbandoned({ name: x.full_name, event: x, eventUrl: `${config.publicBaseUrl}/events/${x.slug}`, unsubscribeUrl }),
    });
    if (ok) sent++;
  }
  return sent;
}

module.exports = { reminders, abandonedCheckouts };
