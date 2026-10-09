// Organiser analytics. All queries are scoped by organiser id by the caller.
const db = require("../../lib/db");
const ledger = require("../../lib/ledger");

const PAID = "('paid','partially_refunded','refunded')";

async function eventAnalytics(event) {
  const id = event.id;
  const [totals, daily, byType, checkins, byHour, links, promos, vendors, topups] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ${PAID})::int AS orders,
              COALESCE(SUM(subtotal_cents - discount_cents) FILTER (WHERE status IN ${PAID}),0)::bigint AS ticket_revenue_cents,
              COALESCE(SUM(fee_cents) FILTER (WHERE status IN ${PAID}),0)::bigint AS fees_cents,
              COALESCE(SUM(organiser_fee_cents) FILTER (WHERE status IN ${PAID}),0)::bigint
                - COALESCE((SELECT SUM(r.organiser_fee_cents) FROM refunds r WHERE r.order_id IN (SELECT id FROM orders WHERE event_id = $1) AND r.status = 'completed'),0)::bigint AS organiser_fee_cents,
              COALESCE(SUM(refunded_cents),0)::bigint AS refunded_cents,
              COUNT(*) FILTER (WHERE status = 'expired')::int AS abandoned,
              COUNT(*) FILTER (WHERE status = 'pending_payment')::int AS pending
         FROM orders WHERE event_id = $1`, [id]),
    db.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              COALESCE((SELECT SUM(oi.quantity) FROM orders o JOIN order_items oi ON oi.order_id = o.id
                         WHERE o.event_id = $1 AND o.status IN ${PAID} AND o.paid_at::date = d::date),0)::int AS tickets,
              COALESCE((SELECT SUM(o.subtotal_cents - o.discount_cents) FROM orders o
                         WHERE o.event_id = $1 AND o.status IN ${PAID} AND o.paid_at::date = d::date),0)::bigint AS revenue_cents
         FROM generate_series((now() - interval '29 days')::date, now()::date, interval '1 day') d ORDER BY d`, [id]),
    db.query(
      `SELECT tt.id, tt.name, tt.price_cents, tt.quantity_total, tt.quantity_sold, tt.quantity_held,
              (SELECT count(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status = 'used')::int AS checked_in
         FROM ticket_types tt WHERE tt.event_id = $1 ORDER BY tt.sort_order, tt.price_cents`, [id]),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'used')::int AS admitted, COUNT(*) FILTER (WHERE status IN ('valid','used'))::int AS issued
         FROM tickets WHERE event_id = $1`, [id]),
    db.query(
      `SELECT to_char(date_trunc('hour', occurred_at AT TIME ZONE 'Africa/Johannesburg'), 'HH24:00') AS hour, count(*)::int AS n
         FROM admission_log WHERE event_id = $1 AND outcome = 'admitted' GROUP BY 1 ORDER BY 1`, [id]),
    db.query(
      `SELECT l.code, l.label, l.clicks,
              (SELECT count(*) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN ${PAID})::int AS orders,
              (SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN ${PAID})::bigint AS revenue_cents
         FROM tracking_links l WHERE l.event_id = $1 ORDER BY revenue_cents DESC`, [id]),
    db.query(
      `SELECT p.code, p.kind, p.value, p.used_count, p.max_uses, p.active,
              (SELECT COALESCE(SUM(o.discount_cents),0) FROM orders o WHERE o.promo_code_id = p.id AND o.status IN ${PAID})::bigint AS discount_given_cents
         FROM promo_codes p WHERE p.event_id = $1 ORDER BY p.used_count DESC`, [id]),
    db.query(
      `SELECT v.id, v.name, COUNT(s.id) FILTER (WHERE s.status = 'confirmed')::int AS sales,
              COALESCE(SUM(s.total_cents) FILTER (WHERE s.status = 'confirmed'),0)::bigint AS gross_cents
         FROM vendors v LEFT JOIN pos_sales s ON s.vendor_id = v.id WHERE v.event_id = $1 GROUP BY v.id ORDER BY gross_cents DESC`, [id]),
    db.query("SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'confirmed'),0)::bigint AS topups_cents, COUNT(DISTINCT user_id) FILTER (WHERE status = 'confirmed')::int AS wallets FROM wallet_topups WHERE event_id = $1", [id]),
  ]);
  const payable = await ledger.balanceByCode(db, ledger.codes.organiserPayable(event.organiser_id, id).code);
  const sold = byType.rows.reduce((s, t) => s + t.quantity_sold, 0);
  const tr = totals.rows[0];
  return {
    totals: { ...tr, organiser_fee_cents: Number(tr.organiser_fee_cents), ticketsSold: sold, capacity: event.capacity, payableCents: payable, isFree: event.is_free },
    daily: daily.rows, byType: byType.rows, checkins: checkins.rows[0], checkinsByHour: byHour.rows,
    trackingLinks: links.rows, promoCodes: promos.rows, vendors: vendors.rows, cashless: topups.rows[0],
  };
}

async function organiserDashboard(organiserId) {
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.slug, e.status, e.starts_at, e.capacity,
            COALESCE((SELECT SUM(quantity_sold) FROM ticket_types WHERE event_id = e.id),0)::int AS sold,
            e.is_free,
            COALESCE((SELECT SUM(subtotal_cents - discount_cents) FROM orders WHERE event_id = e.id AND status IN ${PAID}),0)::bigint AS revenue_cents,
            COALESCE((SELECT SUM(organiser_fee_cents) FROM orders WHERE event_id = e.id AND status IN ${PAID}),0)::bigint AS organiser_fee_cents
       FROM events e WHERE e.organiser_id = $1 ORDER BY e.starts_at DESC`, [organiserId]);
  const { rows: last7 } = await db.query(
    `SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0)::bigint AS revenue_cents, COUNT(*)::int AS orders
       FROM orders o JOIN events e ON e.id = o.event_id WHERE e.organiser_id = $1 AND o.status IN ${PAID} AND o.paid_at > now() - interval '7 days'`, [organiserId]);
  return {
    events: rows,
    totals: {
      events: rows.length,
      live: rows.filter((e) => e.status === "published" && new Date(e.starts_at) > new Date()).length,
      ticketsSold: rows.reduce((s, e) => s + e.sold, 0),
      revenueCents: rows.reduce((s, e) => s + e.revenue_cents, 0),
      organiserFeeCents: rows.reduce((s, e) => s + e.organiser_fee_cents, 0),
      last7RevenueCents: last7[0].revenue_cents,
      last7Orders: last7[0].orders,
    },
  };
}

module.exports = { eventAnalytics, organiserDashboard };
