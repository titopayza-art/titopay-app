// Refund lifecycle: requested -> approved -> processing -> completed | failed
//                   requested -> rejected
// The approver must be a different person from the requester (also enforced
// by a CHECK constraint). Provider refunds use the refund id as idempotency
// key, so retrying a failed or uncertain refund can never pay out twice.
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const ledger = require("../../lib/ledger");
const { reference } = require("../../lib/crypto");
const { bpsOf } = require("../../lib/money");
const { conflict, notFound, forbidden, bad } = require("../../lib/errors");
const { getProvider } = require("../payments/providers");
const outbox = require("../messaging/outbox");
const templates = require("../messaging/templates");

async function requestOrderRefund(actor, { orderId, ticketIds, reason, includeFees }, q = null) {
  const run = async (c) => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) throw notFound("Order not found.");
    if (!["paid", "partially_refunded"].includes(order.status)) throw conflict("Only paid orders can be refunded.", "order_not_refundable");
    if (order.total_cents === 0) throw conflict("Free orders have nothing to refund.", "order_not_refundable");
    const { rows: open } = await c.query(
      `SELECT rt.ticket_id FROM refund_tickets rt JOIN refunds r ON r.id = rt.refund_id
        WHERE r.order_id = $1 AND r.status IN ('requested','approved','processing')`, [orderId]);
    const busy = new Set(open.map((r) => r.ticket_id));
    const { rows: all } = await c.query("SELECT * FROM tickets WHERE order_id = $1", [orderId]);
    const chosen = ticketIds?.length ? all.filter((t) => ticketIds.includes(t.id)) : all.filter((t) => t.status === "valid");
    if (ticketIds?.length && chosen.length !== ticketIds.length) throw bad("Some tickets are not part of this order.");
    if (!chosen.length) throw conflict("No refundable tickets on this order.", "nothing_to_refund");
    for (const t of chosen) {
      if (t.status !== "valid") throw conflict(`Ticket ${t.code} is ${t.status} and cannot be refunded.`, "ticket_not_valid");
      if (busy.has(t.id)) throw conflict(`Ticket ${t.code} already has a refund in progress.`, "refund_in_progress");
    }
    // Discount is shared pro rata across ticket prices.
    const gross = chosen.reduce((s, t) => s + t.price_cents, 0);
    const amount = order.subtotal_cents === 0 ? 0 : gross - Math.round((order.discount_cents * gross) / order.subtotal_cents);
    const fees = includeFees ? chosen.reduce((s, t) => s + t.fee_cents, 0) : 0;
    if (amount + fees <= 0) throw conflict("Nothing to refund.", "nothing_to_refund");
    const { rows: r } = await c.query(
      `INSERT INTO refunds (reference, kind, order_id, event_id, user_id, amount_cents, fee_refund_cents, reason, requested_by)
       VALUES ($1,'order',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [reference("RF"), orderId, order.event_id, order.user_id, amount, fees, reason, actor?.id || null]);
    for (const t of chosen) await c.query("INSERT INTO refund_tickets (refund_id, ticket_id) VALUES ($1,$2)", [r[0].id, t.id]);
    await audit.record(c, { actor, action: "refund.requested", entityType: "refund", entityId: r[0].id, details: { orderId, amount, fees, tickets: chosen.length } });
    return r[0];
  };
  return q ? run(q) : db.withTx(run);
}

async function requestPosRefund(actor, saleId, reason) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE", [saleId]);
    const s = rows[0];
    if (!s || s.status !== "confirmed") throw conflict("Only approved sales can be refunded.", "sale_not_refundable");
    const { rows: r } = await c.query(
      `INSERT INTO refunds (reference, kind, pos_sale_id, event_id, user_id, amount_cents, reason, requested_by)
       VALUES ($1,'pos_sale',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [reference("RF"), s.id, s.event_id, s.user_id, s.total_cents, reason, actor.id]);
    await audit.record(c, { actor, action: "refund.requested", entityType: "refund", entityId: r[0].id, details: { saleId, amount: s.total_cents } });
    return r[0];
  });
}

async function requestWalletRefund(user, eventId) {
  return db.withTx(async (c) => {
    const { balance } = await ledger.lockedBalance(c, ledger.codes.attendeeWallet(user.id, eventId));
    if (balance <= 0) throw conflict("There is no balance to refund.", "nothing_to_refund");
    const { rows } = await c.query(
      `INSERT INTO refunds (reference, kind, event_id, user_id, amount_cents, reason, requested_by)
       VALUES ($1,'wallet_balance',$2,$3,$4,'Unused cashless balance',$3) RETURNING *`,
      [reference("RF"), eventId, user.id, balance]);
    await audit.record(c, { actor: user, action: "refund.requested", entityType: "refund", entityId: rows[0].id, details: { kind: "wallet_balance", amount: balance } });
    return rows[0];
  });
}

// Who may decide which refund: order & wallet refunds — platform finance.
// POS refunds — platform finance, or the event organiser's owner/manager.
async function canDecide(c, actor, refund) {
  if (actor.platformRoles.has("finance")) return true;
  if (refund.kind === "pos_sale") {
    const { rows } = await c.query(
      `SELECT 1 FROM events e JOIN organiser_members m ON m.organiser_id = e.organiser_id
        WHERE e.id = $1 AND m.user_id = $2 AND m.role IN ('owner','manager')`, [refund.event_id, actor.id]);
    return !!rows[0];
  }
  return false;
}

async function decide(actor, refundId, approve, note) {
  const refund = await db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM refunds WHERE id = $1 FOR UPDATE", [refundId]);
    const r = rows[0];
    if (!r) throw notFound("Refund not found.");
    if (!(await canDecide(c, actor, r))) throw forbidden("You cannot approve this refund.");
    if (r.status !== "requested") throw conflict(`This refund is already ${r.status}.`, "bad_transition");
    if (r.requested_by === actor.id) throw forbidden("You cannot approve or reject a refund you requested.");
    const status = approve ? "approved" : "rejected";
    const { rows: u } = await c.query("UPDATE refunds SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1 RETURNING *", [refundId, status, actor.id, note || null]);
    await audit.record(c, { actor, action: `refund.${status}`, entityType: "refund", entityId: refundId, details: { note } });
    return u[0];
  });
  if (refund.status === "approved") return execute(actor, refundId);
  return refund;
}

// Moves an approved/failed refund through the provider and the ledger.
async function execute(actor, refundId) {
  const r = await db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM refunds WHERE id = $1 FOR UPDATE", [refundId]);
    if (!["approved", "failed"].includes(rows[0]?.status)) throw conflict("Only approved or failed refunds can be processed.", "bad_transition");
    await c.query("UPDATE refunds SET status = 'processing', updated_at = now() WHERE id = $1", [refundId]);
    return rows[0];
  });
  try {
    if (r.kind === "pos_sale") return await completePos(actor, r);
    if (r.kind === "order") return await completeOrder(actor, r);
    return await completeWallet(actor, r);
  } catch (err) {
    await db.query("UPDATE refunds SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1", [refundId, String(err.message).slice(0, 300)]);
    await audit.record(null, { actor, action: "refund.failed", entityType: "refund", entityId: refundId, details: { error: err.message } });
    throw err;
  }
}

async function completeOrder(actor, r) {
  const { rows: pay } = await db.query("SELECT * FROM payments WHERE order_id = $1 AND status IN ('confirmed','partially_refunded') ORDER BY confirmed_at LIMIT 1", [r.order_id]);
  const payment = pay[0];
  if (!payment) throw conflict("No confirmed payment found for this order.", "no_payment");
  const total = r.amount_cents + r.fee_refund_cents;
  const { refundReference } = await getProvider(payment.provider).refund({ providerReference: payment.provider_reference, amountCents: total, idempotencyKey: `refund:${r.id}` });
  return db.withTx(async (c) => {
    const { rows: o } = await c.query("SELECT o.*, e.organiser_id FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1 FOR UPDATE OF o", [r.order_id]);
    const order = o[0];
    const journalId = await ledger.post(c, {
      kind: "ticket_refund", reference: r.reference, idempotencyKey: `refund:${r.id}`, createdBy: actor?.id,
      lines: [
        { account: ledger.codes.organiserPayable(order.organiser_id, order.event_id), debit: r.amount_cents },
        { account: ledger.codes.feeRevenue(), debit: r.fee_refund_cents },
        { account: ledger.codes.providerClearing(payment.provider), credit: total },
      ],
    });
    await c.query("UPDATE tickets SET status = 'refunded', updated_at = now() WHERE id IN (SELECT ticket_id FROM refund_tickets WHERE refund_id = $1) AND status = 'valid'", [r.id]);
    await c.query("UPDATE tags SET ticket_id = NULL WHERE ticket_id IN (SELECT ticket_id FROM refund_tickets WHERE refund_id = $1)", [r.id]);
    // Paid-but-unfulfilled orders have no tickets; release nothing for them.
    const { rows: n } = await c.query("SELECT count(*)::int AS n FROM refund_tickets WHERE refund_id = $1", [r.id]);
    if (n[0].n) {
      await c.query(
        `UPDATE ticket_types tt SET quantity_sold = quantity_sold - x.n
           FROM (SELECT t.ticket_type_id, count(*)::int AS n FROM refund_tickets rt JOIN tickets t ON t.id = rt.ticket_id WHERE rt.refund_id = $1 GROUP BY 1) x
          WHERE tt.id = x.ticket_type_id`, [r.id]);
    }
    const refunded = order.refunded_cents + total;
    await c.query("UPDATE orders SET refunded_cents = $2, status = $3, updated_at = now() WHERE id = $1", [order.id, refunded, refunded >= order.total_cents ? "refunded" : "partially_refunded"]);
    await c.query("UPDATE payments SET refunded_cents = refunded_cents + $2, status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END, updated_at = now() WHERE id = $1", [payment.id, total]);
    const { rows: done } = await c.query("UPDATE refunds SET status = 'completed', provider_refund_reference = $2, journal_id = $3, failure_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *", [r.id, refundReference, journalId]);
    await outbox.enqueue(c, { to: order.buyer_email, userId: order.user_id, ...templates.refundCompleted({ reference: r.reference, amount: total }) });
    await audit.record(c, { actor, action: "refund.completed", entityType: "refund", entityId: r.id, organiserId: order.organiser_id, details: { amount: total, providerRef: refundReference } });
    return done[0];
  });
}

async function completePos(actor, r) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE", [r.pos_sale_id]);
    const sale = rows[0];
    if (sale.status !== "confirmed") throw conflict("Sale already reversed.", "bad_transition");
    const journalId = await ledger.reverse(c, sale.journal_id, { kind: "pos_reversal", reference: r.reference, idempotencyKey: `refund:${r.id}`, createdBy: actor?.id });
    await c.query("UPDATE pos_sales SET status = 'reversed', reversed_at = now(), reversal_journal_id = $2 WHERE id = $1", [sale.id, journalId]);
    const { rows: done } = await c.query("UPDATE refunds SET status = 'completed', journal_id = $2, failure_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *", [r.id, journalId]);
    await audit.record(c, { actor, action: "refund.completed", entityType: "refund", entityId: r.id, details: { saleId: sale.id } });
    return done[0];
  });
}

// Unused balance goes back to the cards that funded it, newest top-up first.
async function completeWallet(actor, r) {
  const { rows: topups } = await db.query(
    `SELECT p.* FROM payments p JOIN wallet_topups t ON t.id = p.topup_id
      WHERE t.user_id = $1 AND t.event_id = $2 AND p.status IN ('confirmed','partially_refunded') ORDER BY p.confirmed_at DESC`, [r.user_id, r.event_id]);
  // Recompute against the live balance: spending may have happened since the request.
  const live = await ledger.balanceByCode(db, ledger.codes.attendeeWallet(r.user_id, r.event_id).code);
  const target = Math.min(r.amount_cents, live);
  if (target <= 0) throw conflict("The balance has already been spent.", "nothing_to_refund");
  let remaining = target;
  const parts = [];
  for (const p of topups) {
    if (!remaining) break;
    const take = Math.min(remaining, p.amount_cents - p.refunded_cents);
    if (take <= 0) continue;
    const { refundReference } = await getProvider(p.provider).refund({ providerReference: p.provider_reference, amountCents: take, idempotencyKey: `refund:${r.id}:${p.id}` });
    parts.push({ payment: p, take, refundReference });
    remaining -= take;
  }
  if (remaining) throw conflict("The balance is larger than the refundable top-ups. Escalate to finance.", "refund_unfunded");
  return db.withTx(async (c) => {
    const { balance } = await ledger.lockedBalance(c, ledger.codes.attendeeWallet(r.user_id, r.event_id));
    if (balance < target) throw conflict("Balance changed during processing; retry.", "balance_changed");
    const lines = [{ account: ledger.codes.attendeeWallet(r.user_id, r.event_id), debit: target }];
    for (const part of parts) {
      lines.push({ account: ledger.codes.providerClearing(part.payment.provider), credit: part.take });
      await c.query("UPDATE payments SET refunded_cents = refunded_cents + $2, status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1", [part.payment.id, part.take]);
    }
    const journalId = await ledger.post(c, { kind: "wallet_refund", reference: r.reference, idempotencyKey: `refund:${r.id}`, createdBy: actor?.id, lines });
    const { rows: done } = await c.query(
      "UPDATE refunds SET status = 'completed', amount_cents = $2, journal_id = $3, provider_refund_reference = $4, failure_reason = NULL, updated_at = now() WHERE id = $1 RETURNING *",
      [r.id, target, journalId, parts.map((p) => p.refundReference).join(",")]);
    const { rows: u } = await c.query("SELECT email FROM users WHERE id = $1", [r.user_id]);
    await outbox.enqueue(c, { to: u[0].email, userId: r.user_id, ...templates.refundCompleted({ reference: r.reference, amount: target }) });
    await audit.record(c, { actor, action: "refund.completed", entityType: "refund", entityId: r.id, details: { amount: target } });
    return done[0];
  });
}

module.exports = { requestOrderRefund, requestPosRefund, requestWalletRefund, decide, execute, bpsOf };
