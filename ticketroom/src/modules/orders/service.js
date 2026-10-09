const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const ledger = require("../../lib/ledger");
const { reference } = require("../../lib/crypto");
const { ticketFee, bpsOf } = require("../../lib/money");
const { bad, conflict, notFound } = require("../../lib/errors");
const tickets = require("../tickets/service");
const outbox = require("../messaging/outbox");
const templates = require("../messaging/templates");

const MAX_TICKETS_PER_ORDER = 20;

function salesOpen(event, now = new Date()) {
  if (event.status !== "published") return false;
  if (event.sales_start_at && new Date(event.sales_start_at) > now) return false;
  const end = event.sales_end_at ? new Date(event.sales_end_at) : new Date(event.ends_at);
  return end > now;
}

// Prices come from the database only. Client-sent prices are never read.
async function quote(q, event, items, promoCode, { lockPromo = false } = {}) {
  if (!salesOpen(event)) throw conflict("Ticket sales for this event are closed.", "sales_closed");
  const seen = new Set();
  let count = 0;
  const lines = [];
  for (const it of items) {
    if (seen.has(it.ticketTypeId)) throw bad("Each ticket type may appear once.");
    seen.add(it.ticketTypeId);
    const { rows } = await q.query("SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2", [it.ticketTypeId, event.id]);
    const tt = rows[0];
    if (!tt || tt.status !== "on_sale") throw conflict("A selected ticket type is not on sale.", "ticket_type_unavailable");
    const now = new Date();
    if ((tt.sales_start_at && new Date(tt.sales_start_at) > now) || (tt.sales_end_at && new Date(tt.sales_end_at) <= now)) {
      throw conflict(`${tt.name} is not on sale right now.`, "ticket_type_unavailable");
    }
    if (it.quantity > tt.per_order_limit) throw conflict(`You can buy at most ${tt.per_order_limit} × ${tt.name} per order.`, "limit_exceeded");
    count += it.quantity;
    lines.push({ ticketType: tt, quantity: it.quantity, unitPrice: tt.price_cents, unitFee: ticketFee(tt.price_cents) });
  }
  if (count === 0) throw bad("Choose at least one ticket.");
  if (count > MAX_TICKETS_PER_ORDER) throw conflict(`At most ${MAX_TICKETS_PER_ORDER} tickets per order.`, "limit_exceeded");

  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  let discount = 0;
  let promo = null;
  if (promoCode) {
    const { rows } = await q.query(
      `SELECT * FROM promo_codes WHERE event_id = $1 AND upper(code) = upper($2) AND active
          AND (valid_from IS NULL OR valid_from <= now()) AND (valid_to IS NULL OR valid_to > now())
          AND (max_uses IS NULL OR used_count < max_uses) ${lockPromo ? "FOR UPDATE" : ""}`, [event.id, promoCode]);
    promo = rows[0];
    if (!promo) throw conflict("That promo code is not valid for this event.", "promo_invalid");
    discount = promo.kind === "percent" ? bpsOf(subtotal, promo.value * 100) : Math.min(promo.value, subtotal);
  }
  // A fully discounted order is a comp: no service fee is charged on it.
  let fee = lines.reduce((s, l) => s + l.unitFee * l.quantity, 0);
  if (subtotal - discount === 0) {
    fee = 0;
    lines.forEach((l) => { l.unitFee = 0; });
  }
  return { lines, subtotal, discount, fee, total: subtotal - discount + fee, promo };
}

const publicQuote = (qt) => ({
  lines: qt.lines.map((l) => ({ ticketTypeId: l.ticketType.id, name: l.ticketType.name, quantity: l.quantity, unitPriceCents: l.unitPrice, unitFeeCents: l.unitFee })),
  subtotalCents: qt.subtotal, discountCents: qt.discount, feeCents: qt.fee, totalCents: qt.total,
  promoCode: qt.promo?.code || null, currency: "ZAR",
});

async function createOrder(user, input) {
  const result = await db.withTx(async (c) => {
    const prior = await c.query("SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2", [user.id, input.idempotencyKey]);
    if (prior.rows[0]) return { order: prior.rows[0], replay: true };

    // Locking the event row serialises checkouts for one event so the capacity
    // check below cannot race. Per-type limits are also guarded by a CHECK.
    const { rows: evRows } = await c.query("SELECT * FROM events WHERE slug = $1 FOR UPDATE", [input.eventSlug]);
    const event = evRows[0];
    if (!event) throw notFound("Event not found.");
    const qt = await quote(c, event, input.items, input.promoCode, { lockPromo: true });

    const { rows: cap } = await c.query("SELECT COALESCE(SUM(quantity_sold + quantity_held),0)::int AS used FROM ticket_types WHERE event_id = $1", [event.id]);
    const wanted = qt.lines.reduce((s, l) => s + l.quantity, 0);
    if (cap[0].used + wanted > event.capacity) throw conflict("Not enough tickets left for this event.", "sold_out");

    for (const l of qt.lines) {
      const { rowCount } = await c.query(
        `UPDATE ticket_types SET quantity_held = quantity_held + $2
          WHERE id = $1 AND quantity_sold + quantity_held + $2 <= quantity_total`, [l.ticketType.id, l.quantity]);
      if (!rowCount) throw conflict(`Not enough ${l.ticketType.name} tickets left.`, "sold_out");
    }
    if (qt.promo) await c.query("UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1", [qt.promo.id]);

    let trackingId = null;
    if (input.ref) {
      const { rows } = await c.query("SELECT id FROM tracking_links WHERE event_id = $1 AND code = $2", [event.id, input.ref]);
      trackingId = rows[0]?.id || null;
    }

    const { rows } = await c.query(
      `INSERT INTO orders (reference, event_id, user_id, status, buyer_name, buyer_email, buyer_phone, subtotal_cents,
                           discount_cents, fee_cents, total_cents, promo_code_id, tracking_link_id, idempotency_key, expires_at)
       VALUES ($1,$2,$3,'pending_payment',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now() + make_interval(mins => $14)) RETURNING *`,
      [reference("TR"), event.id, user.id, user.fullName, user.email, input.buyerPhone || user.phone || null, qt.subtotal, qt.discount, qt.fee, qt.total,
        qt.promo?.id || null, trackingId, input.idempotencyKey, config.orders.holdMinutes]);
    let order = rows[0];
    for (const l of qt.lines) {
      await c.query("INSERT INTO order_items (order_id, ticket_type_id, quantity, unit_price_cents, unit_fee_cents) VALUES ($1,$2,$3,$4,$5)",
        [order.id, l.ticketType.id, l.quantity, l.unitPrice, l.unitFee]);
    }

    // Marketing consent is opt-in, per organiser and per channel (POPIA s69).
    const marketing = require("../marketing/service");
    for (const channel of ["email", "sms"]) {
      if (input.marketingOptIn?.[channel]) await marketing.setConsent(c, user.id, event.organiser_id, channel, true, `checkout:${order.reference}`);
    }

    let payment = null;
    if (order.total_cents === 0) {
      order = (await fulfil(c, order.id, null)).order;
    } else {
      const { rows: p } = await c.query(
        `INSERT INTO payments (purpose, order_id, user_id, provider, amount_cents) VALUES ('order',$1,$2,$3,$4) RETURNING *`,
        [order.id, user.id, config.payments.provider, order.total_cents]);
      payment = p[0];
    }
    await audit.record(c, { actor: user, action: "order.created", entityType: "order", entityId: order.id, organiserId: event.organiser_id, details: { reference: order.reference, total: order.total_cents } });
    return { order, payment, event };
  });

  if (result.replay) return { order: result.order, replay: true, payment: await latestPayment(result.order.id) };
  if (result.payment) {
    const payments = require("../payments/service");
    result.payment = await payments.start(result.payment, {
      description: `${result.event.title} — ${result.order.reference}`,
      returnPath: `/orders/${result.order.reference}`,
    });
  }
  return result;
}

async function latestPayment(orderId) {
  const { rows } = await db.query("SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1", [orderId]);
  return rows[0] || null;
}

// Converts holds into sales and issues tickets. Safe to call repeatedly.
// If the order had expired (holds released) we try to re-reserve; when the
// tickets are gone the money is kept as owed and a refund is raised.
async function fulfil(c, orderId, payment) {
  const { rows } = await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
  const order = rows[0];
  if (["paid", "paid_unfulfilled", "refunded", "partially_refunded"].includes(order.status)) return { order, alreadyDone: true };
  const { rows: items } = await c.query("SELECT * FROM order_items WHERE order_id = $1", [orderId]);
  const { rows: evRows } = await c.query("SELECT * FROM events WHERE id = $1", [order.event_id]);
  const event = evRows[0];

  let fulfilled = true;
  if (order.status === "pending_payment") {
    for (const it of items) {
      await c.query("UPDATE ticket_types SET quantity_held = quantity_held - $2, quantity_sold = quantity_sold + $2 WHERE id = $1", [it.ticket_type_id, it.quantity]);
    }
  } else {
    // expired / cancelled / failed: inventory was released; try to take it again.
    await c.query("SELECT id FROM events WHERE id = $1 FOR UPDATE", [order.event_id]);
    const { rows: cap } = await c.query("SELECT COALESCE(SUM(quantity_sold + quantity_held),0)::int AS used FROM ticket_types WHERE event_id = $1", [order.event_id]);
    const wanted = items.reduce((s, i) => s + i.quantity, 0);
    if (cap[0].used + wanted > event.capacity || ["cancelled", "suspended"].includes(event.status)) fulfilled = false;
    await c.query("SAVEPOINT rereserve");
    if (fulfilled) {
      for (const it of items) {
        const { rowCount } = await c.query(
          "UPDATE ticket_types SET quantity_sold = quantity_sold + $2 WHERE id = $1 AND quantity_sold + quantity_held + $2 <= quantity_total", [it.ticket_type_id, it.quantity]);
        if (!rowCount) { fulfilled = false; break; }
      }
    }
    if (!fulfilled) await c.query("ROLLBACK TO SAVEPOINT rereserve");
    await c.query("RELEASE SAVEPOINT rereserve");
  }

  const newStatus = fulfilled ? "paid" : "paid_unfulfilled";
  const { rows: upd } = await c.query("UPDATE orders SET status = $2, paid_at = now(), updated_at = now() WHERE id = $1 RETURNING *", [orderId, newStatus]);

  if (order.total_cents > 0) {
    // Money in: provider holds it; organiser is owed the ticket revenue, the
    // platform earns the service fee.
    await ledger.post(c, {
      kind: "ticket_sale", reference: order.reference, idempotencyKey: `order-paid:${order.id}`,
      memo: `Order ${order.reference}`,
      lines: [
        { account: ledger.codes.providerClearing(payment.provider), debit: order.total_cents },
        { account: ledger.codes.organiserPayable(event.organiser_id, event.id), credit: order.subtotal_cents - order.discount_cents },
        { account: ledger.codes.feeRevenue(), credit: order.fee_cents },
      ],
    });
  }

  if (fulfilled) {
    const issued = await tickets.issueForOrder(c, upd[0]);
    await outbox.enqueue(c, { to: order.buyer_email, userId: order.user_id, ...templates.orderConfirmed({ order: upd[0], event, ticketCount: issued.length }) });
  } else {
    const { rows: r } = await c.query(
      `INSERT INTO refunds (reference, kind, order_id, event_id, user_id, amount_cents, fee_refund_cents, reason, requested_by)
       VALUES ($1,'order',$2,$3,$4,$5,$6,'Payment arrived after reservation expired and tickets were no longer available', NULL) RETURNING id`,
      [reference("RF"), order.id, order.event_id, order.user_id, order.subtotal_cents - order.discount_cents, order.fee_cents]);
    await outbox.enqueue(c, { to: order.buyer_email, userId: order.user_id, ...templates.orderNeedsRefund({ order, event }) });
    await audit.record(c, { action: "order.paid_unfulfilled", entityType: "order", entityId: order.id, organiserId: event.organiser_id, details: { refundId: r[0].id } });
  }
  return { order: upd[0], fulfilled };
}

async function releaseHolds(c, order) {
  const { rows: items } = await c.query("SELECT * FROM order_items WHERE order_id = $1", [order.id]);
  for (const it of items) await c.query("UPDATE ticket_types SET quantity_held = quantity_held - $2 WHERE id = $1", [it.ticket_type_id, it.quantity]);
  if (order.promo_code_id) await c.query("UPDATE promo_codes SET used_count = used_count - 1 WHERE id = $1 AND used_count > 0", [order.promo_code_id]);
}

async function cancelPending(user, ref) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM orders WHERE reference = $1 AND user_id = $2 FOR UPDATE", [ref, user.id]);
    const order = rows[0];
    if (!order) throw notFound("Order not found.");
    if (order.status !== "pending_payment") throw conflict("Only unpaid orders can be cancelled.", "order_not_pending");
    await releaseHolds(c, order);
    await c.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [order.id]);
    await c.query("UPDATE payments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('initiated','pending')", [order.id]);
    return { status: "cancelled" };
  });
}

// Before expiring, ask the provider about any payment in flight: an order is
// never expired while its money might have been taken.
async function expireDue() {
  const payments = require("../payments/service");
  const { rows } = await db.query("SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at < now() ORDER BY expires_at LIMIT 100");
  let expired = 0;
  for (const { id } of rows) {
    const { rows: pend } = await db.query("SELECT * FROM payments WHERE order_id = $1 AND status = 'pending' AND provider_reference IS NOT NULL", [id]);
    let paid = false;
    for (const p of pend) {
      try {
        const r = await payments.syncStatus(p.id);
        if (r === "confirmed") paid = true;
      } catch (err) {
        // Cannot reach the provider: do not expire yet, try again next sweep.
        console.warn(`[expiry] provider status check failed for payment ${p.id}: ${err.message}`);
        paid = true;
      }
    }
    if (paid) continue;
    await db.withTx(async (c) => {
      const { rows: o } = await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]);
      if (o[0].status !== "pending_payment") return;
      await releaseHolds(c, o[0]);
      await c.query("UPDATE orders SET status = 'expired', updated_at = now() WHERE id = $1", [id]);
      await c.query("UPDATE payments SET status = 'cancelled', failure_reason = 'order expired', updated_at = now() WHERE order_id = $1 AND status IN ('initiated','pending')", [id]);
      expired++;
    });
  }
  return expired;
}

async function getForUser(user, ref) {
  const { rows } = await db.query(
    `SELECT o.*, e.title, e.slug, e.starts_at, e.venue_name, e.city FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.reference = $1 AND o.user_id = $2`, [ref, user.id]);
  if (!rows[0]) throw notFound("Order not found.");
  const { rows: items } = await db.query(
    `SELECT oi.quantity, oi.unit_price_cents, oi.unit_fee_cents, tt.name FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = $1`, [rows[0].id]);
  const payment = await latestPayment(rows[0].id);
  return { order: rows[0], items, payment };
}

module.exports = { quote, publicQuote, createOrder, fulfil, cancelPending, expireDue, getForUser, salesOpen, releaseHolds, latestPayment };
