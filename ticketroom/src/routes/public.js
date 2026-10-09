// Public discovery, checkout and order status.
const express = require("express");
const db = require("../lib/db");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { verifyLink, reference } = require("../lib/crypto");
const { notFound, bad } = require("../lib/errors");
const { wrap, requireAuth } = require("../middleware/http");
const orders = require("../modules/orders/service");
const marketing = require("../modules/marketing/service");

const router = express.Router();

const PUBLIC_EVENT = `e.id, e.slug, e.title, e.summary, e.category, e.venue_name, e.address, e.city, e.province, e.starts_at, e.ends_at,
  e.doors_open_at, e.image_upload_id, e.featured, e.age_restriction, e.status, e.sales_start_at, e.sales_end_at, o.name AS organiser_name,
  (SELECT MIN(price_cents) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale') AS from_price_cents,
  (SELECT COALESCE(SUM(quantity_total - quantity_sold - quantity_held),0) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale')::int AS remaining`;

router.get("/events", limit("browse", 300, 60e3), wrap(async (req, res) => {
  const q = String(req.query.q || "").slice(0, 80).trim();
  const params = [];
  const where = ["e.status = 'published'", "e.ends_at > now()"];
  if (q) { params.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`); where.push(`(e.title ILIKE $${params.length} OR e.venue_name ILIKE $${params.length} OR e.city ILIKE $${params.length} OR o.name ILIKE $${params.length})`); }
  if (req.query.category) { params.push(String(req.query.category)); where.push(`e.category = $${params.length}`); }
  if (req.query.city) { params.push(String(req.query.city)); where.push(`e.city = $${params.length}`); }
  if (req.query.when === "weekend") where.push("e.starts_at < date_trunc('week', now()) + interval '7 days' AND e.starts_at > date_trunc('week', now()) + interval '4 days'");
  if (req.query.when === "month") where.push("e.starts_at < now() + interval '30 days'");
  const { rows } = await db.query(
    `SELECT ${PUBLIC_EVENT} FROM events e JOIN organisers o ON o.id = e.organiser_id
      WHERE ${where.join(" AND ")} ORDER BY e.featured DESC, e.starts_at LIMIT 60`, params);
  const { rows: cities } = await db.query("SELECT city, count(*)::int AS n FROM events WHERE status = 'published' AND ends_at > now() GROUP BY city ORDER BY n DESC");
  res.json({ events: rows, cities });
}));

router.get("/events/:slug", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${PUBLIC_EVENT}, e.description, e.refund_policy, e.accessibility_info, e.transfers_enabled, e.cashless_enabled, e.capacity
       FROM events e JOIN organisers o ON o.id = e.organiser_id
      WHERE e.slug = $1 AND e.status IN ('published','cancelled','completed')`, [req.params.slug]);
  const ev = rows[0];
  if (!ev) throw notFound("Event not found.");
  const { rows: types } = await db.query(
    `SELECT id, name, description, price_cents, per_order_limit, sales_start_at, sales_end_at,
            GREATEST(quantity_total - quantity_sold - quantity_held, 0)::int AS remaining
       FROM ticket_types WHERE event_id = $1 AND status = 'on_sale' ORDER BY sort_order, price_cents`, [ev.id]);
  const { ticketFee } = require("../lib/money");
  res.json({ event: { ...ev, salesOpen: orders.salesOpen(ev) }, ticketTypes: types.map((t) => ({ ...t, fee_cents: ticketFee(t.price_cents) })) });
}));

// Tracking link click (?ref=CODE on an event page).
router.post("/events/:slug/click", limit("click", 30, 60e3), wrap(async (req, res) => {
  const b = check(req.body, { ref: r.str({ max: 40, pattern: /^[A-Za-z0-9_-]+$/ }) });
  await db.query("UPDATE tracking_links SET clicks = clicks + 1 WHERE code = $2 AND event_id = (SELECT id FROM events WHERE slug = $1)", [req.params.slug, b.ref]);
  res.json({ ok: true });
}));

const itemsRule = r.array(r.object({ ticketTypeId: r.uuid(), quantity: r.int({ min: 1, max: 50 }) }), { min: 1, max: 10 });

router.post("/checkout/quote", limit("quote", 120, 60e3), wrap(async (req, res) => {
  const b = check(req.body, { eventSlug: r.str({ max: 120 }), items: itemsRule, promoCode: r.str({ optional: true, max: 40 }) });
  const { rows } = await db.query("SELECT * FROM events WHERE slug = $1", [b.eventSlug]);
  if (!rows[0]) throw notFound("Event not found.");
  res.json({ quote: orders.publicQuote(await orders.quote(db, rows[0], b.items, b.promoCode)) });
}));

router.post("/orders", requireAuth, limit("order", 20, 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, {
    eventSlug: r.str({ max: 120 }), items: itemsRule, promoCode: r.str({ optional: true, max: 40 }),
    ref: r.str({ optional: true, max: 40, pattern: /^[A-Za-z0-9_-]+$/ }), buyerPhone: r.phone({ optional: true }),
    marketingOptIn: r.object({ email: r.bool(), sms: r.bool() }, { optional: true }), idempotencyKey: r.idemKey(),
  });
  const result = await orders.createOrder(req.user, b);
  res.status(result.replay ? 200 : 201).json({
    order: { reference: result.order.reference, status: result.order.status, totalCents: result.order.total_cents, expiresAt: result.order.expires_at },
    payment: result.payment ? { status: result.payment.status, redirectUrl: result.payment.redirectUrl || null } : null,
  });
}));

router.get("/orders/:ref", requireAuth, wrap(async (req, res) => {
  const { order, items, payment } = await orders.getForUser(req.user, req.params.ref);
  const { rows: tks } = await db.query("SELECT id, code, status FROM tickets WHERE order_id = $1 AND owner_user_id = $2", [order.id, req.user.id]);
  res.json({
    order: {
      reference: order.reference, status: order.status, subtotalCents: order.subtotal_cents, discountCents: order.discount_cents,
      feeCents: order.fee_cents, totalCents: order.total_cents, refundedCents: order.refunded_cents, expiresAt: order.expires_at, paidAt: order.paid_at,
      event: { title: order.title, slug: order.slug, startsAt: order.starts_at, venue: order.venue_name, city: order.city },
    },
    items, tickets: tks, payment: payment ? { status: payment.status } : null,
  });
}));

// Re-open the hosted checkout for an unpaid order (e.g. the buyer closed the tab).
router.post("/orders/:ref/pay", requireAuth, limit("pay", 10, 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const { order } = await orders.getForUser(req.user, req.params.ref);
  if (order.status !== "pending_payment" || new Date(order.expires_at) < new Date()) throw bad("This order can no longer be paid. Start a new order.");
  const payments = require("../modules/payments/service");
  const config = require("../config");
  const { rows } = await db.query("UPDATE payments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('initiated') RETURNING id", [order.id]);
  void rows;
  const { rows: p } = await db.query("INSERT INTO payments (purpose, order_id, user_id, provider, amount_cents) VALUES ('order',$1,$2,$3,$4) RETURNING *",
    [order.id, req.user.id, config.payments.provider, order.total_cents]);
  const started = await payments.start(p[0], { description: `${order.title} — ${order.reference}`, returnPath: `/orders/${order.reference}` });
  res.json({ payment: { status: started.status, redirectUrl: started.redirectUrl } });
}));

router.post("/orders/:ref/cancel", requireAuth, wrap(async (req, res) => res.json(await orders.cancelPending(req.user, req.params.ref))));

// One-click unsubscribe from a signed link. POST so link scanners cannot opt people out.
router.post("/unsubscribe", limit("unsub", 30, 60e3), wrap(async (req, res) => {
  const b = check(req.body, { token: r.str({ max: 600 }) });
  const data = verifyLink(b.token);
  if (!data?.u) throw bad("This unsubscribe link is invalid or has expired. You can manage preferences in your account.");
  await db.withTx((c) => marketing.setConsent(c, data.u, data.o || null, data.c, false, "unsubscribe_link"));
  const { rows } = data.o ? await db.query("SELECT name FROM organisers WHERE id = $1", [data.o]) : { rows: [{ name: "TicketRoom" }] };
  res.json({ ok: true, organiser: rows[0]?.name, channel: data.c });
}));

router.post("/support", limit("support", 5, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, {
    email: req.user ? r.email({ optional: true }) : r.email(), category: r.oneOf(["tickets", "refund", "tag", "payment", "account", "other"]),
    subject: r.str({ min: 3, max: 140 }), body: r.text({ max: 4000 }),
  });
  const { rows } = await db.query(
    "INSERT INTO support_cases (reference, user_id, email, category, subject, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING reference",
    [reference("SC"), req.user?.id || null, req.user?.email || b.email, b.category, b.subject, b.body]);
  res.status(201).json({ reference: rows[0].reference });
}));

module.exports = router;
