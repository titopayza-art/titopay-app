// Cashless Mode A: an event-specific prepaid balance held as a liability to
// the attendee in the ledger. The tag only identifies the attendee; the
// balance is never stored on the tag.
const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const ledger = require("../../lib/ledger");
const { reference } = require("../../lib/crypto");
const { conflict, notFound } = require("../../lib/errors");
const outbox = require("../messaging/outbox");
const templates = require("../messaging/templates");

async function cashlessEvent(q, eventId) {
  const { rows } = await q.query("SELECT * FROM events WHERE id = $1", [eventId]);
  const ev = rows[0];
  if (!ev) throw notFound("Event not found.");
  if (!ev.cashless_enabled) throw conflict("Cashless payments are not enabled for this event.", "cashless_disabled");
  return ev;
}

const balance = (q, userId, eventId) => ledger.balanceByCode(q, ledger.codes.attendeeWallet(userId, eventId).code);

async function startTopup(user, eventId, amountCents, idempotencyKey, paymentMethod = "card") {
  const { minTopupCents, maxTopupCents, maxBalanceCents } = config.cashless;
  if (amountCents < minTopupCents || amountCents > maxTopupCents) {
    throw conflict(`Top-ups must be between R${minTopupCents / 100} and R${maxTopupCents / 100}.`, "topup_limits");
  }
  const created = await db.withTx(async (c) => {
    const prior = await c.query("SELECT * FROM wallet_topups WHERE user_id = $1 AND idempotency_key = $2", [user.id, idempotencyKey]);
    if (prior.rows[0]) return { topup: prior.rows[0], replay: true };
    const ev = await cashlessEvent(c, eventId);
    if (ev.status !== "published" || new Date(ev.ends_at) < new Date()) throw conflict("Top-ups are closed for this event.", "event_closed");
    if (paymentMethod === "card" && !require("../payments/providers").cardPaymentsEnabled()) throw conflict("Card top-ups are not switched on yet.", "payments_not_configured");
    if (paymentMethod === "titopay_wallet" && !(await require("../wallets/service").activeToken(user.id))) throw conflict("Link your TitoPay wallet first.", "wallet_not_linked");
    const { rows: tk } = await c.query("SELECT 1 FROM tickets WHERE owner_user_id = $1 AND event_id = $2 AND status IN ('valid','used') LIMIT 1", [user.id, eventId]);
    if (!tk[0]) throw conflict("You need a ticket for this event to top up.", "no_ticket");
    // Serialise per wallet so pending top-ups are counted against the cap.
    const { balance: current } = await ledger.lockedBalance(c, ledger.codes.attendeeWallet(user.id, eventId));
    const { rows: pend } = await c.query("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM wallet_topups WHERE user_id = $1 AND event_id = $2 AND status = 'pending' AND created_at > now() - interval '1 hour'", [user.id, eventId]);
    if (current + pend[0].s + amountCents > maxBalanceCents) throw conflict(`An event balance cannot exceed R${maxBalanceCents / 100}.`, "balance_cap");
    const { rows } = await c.query(
      "INSERT INTO wallet_topups (reference, user_id, event_id, amount_cents, idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [reference("TU"), user.id, eventId, amountCents, idempotencyKey]);
    const { rows: p } = await c.query(
      "INSERT INTO payments (purpose, topup_id, user_id, provider, method, amount_cents) VALUES ('topup',$1,$2,$3,$4,$5) RETURNING *",
      [rows[0].id, user.id, require("../payments/providers").providerForMethod(paymentMethod), paymentMethod, amountCents]);
    return { topup: rows[0], payment: p[0], event: ev };
  });
  if (created.replay) {
    const { rows } = await db.query("SELECT * FROM payments WHERE topup_id = $1 ORDER BY created_at DESC LIMIT 1", [created.topup.id]);
    return { topup: created.topup, payment: rows[0], replay: true };
  }
  const payments = require("../payments/service");
  const payment = await payments.start(created.payment, { description: `Top-up ${created.topup.reference} — ${created.event.title}`, returnPath: `/account#/wallet/${eventId}` });
  return { topup: created.topup, payment };
}

// Called from payments.apply inside its transaction, only on a verified
// provider confirmation.
async function confirmTopup(c, payment) {
  const { rows } = await c.query("SELECT * FROM wallet_topups WHERE id = $1 FOR UPDATE", [payment.topup_id]);
  const t = rows[0];
  if (t.status === "confirmed") return;
  const journalId = await ledger.post(c, {
    kind: "wallet_topup", reference: t.reference, idempotencyKey: `topup:${t.id}`,
    lines: [
      { account: ledger.codes.providerClearing(payment.provider), debit: t.amount_cents },
      { account: ledger.codes.attendeeWallet(t.user_id, t.event_id), credit: t.amount_cents },
    ],
  });
  await c.query("UPDATE wallet_topups SET status = 'confirmed', confirmed_at = now(), journal_id = $2 WHERE id = $1", [t.id, journalId]);
  const { rows: u } = await c.query("SELECT email FROM users WHERE id = $1", [t.user_id]);
  const { rows: ev } = await c.query("SELECT title FROM events WHERE id = $1", [t.event_id]);
  await outbox.enqueue(c, { to: u[0].email, userId: t.user_id, ...templates.topupConfirmed({ event: ev[0], amount: t.amount_cents }) });
}

async function walletsFor(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT e.id, e.title, e.slug, e.starts_at, e.ends_at, e.status, e.cashless_enabled
       FROM events e
      WHERE e.cashless_enabled AND (
            EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.owner_user_id = $1 AND t.status IN ('valid','used'))
         OR EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.code = 'attendee_wallet:' || $1 || ':' || e.id))
      ORDER BY e.starts_at`, [userId]);
  const out = [];
  for (const ev of rows) out.push({ ...ev, balanceCents: await balance(db, userId, ev.id) });
  return out;
}

async function history(userId, eventId) {
  const { rows } = await db.query(
    `SELECT 'topup' AS kind, reference, amount_cents, status, created_at, NULL AS vendor FROM wallet_topups WHERE user_id = $1 AND event_id = $2
     UNION ALL
     SELECT 'purchase', s.reference, -s.total_cents, s.status, s.created_at, v.name FROM pos_sales s JOIN vendors v ON v.id = s.vendor_id
      WHERE s.user_id = $1 AND s.event_id = $2
     UNION ALL
     SELECT 'refund', r.reference, CASE WHEN r.kind = 'pos_sale' THEN r.amount_cents ELSE -r.amount_cents END, r.status, r.created_at, NULL
       FROM refunds r WHERE r.user_id = $1 AND r.event_id = $2 AND r.kind IN ('pos_sale','wallet_balance')
     ORDER BY created_at DESC LIMIT 200`, [userId, eventId]);
  return rows;
}

module.exports = { startTopup, confirmTopup, walletsFor, history, balance, cashlessEvent };
