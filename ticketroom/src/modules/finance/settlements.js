// Organiser and vendor settlements.
//
// IMPORTANT: no money is moved by this code. A payout is a request that
// finance approves (maker-checker) and then records as paid after making the
// transfer through TitoPay's approved banking process outside this system.
// Automated payouts require the payment arrangement to be approved first.
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const ledger = require("../../lib/ledger");
const { reference } = require("../../lib/crypto");
const { conflict, notFound, forbidden, bad } = require("../../lib/errors");

// Per-event organiser balances, with availability: an event's revenue is
// available once it has ended and the organiser's hold period has passed, and
// only if the event was not cancelled (refunds come first).
async function organiserBalances(organiserId, q = db) {
  const { rows } = await q.query(
    `SELECT e.id AS event_id, e.title, e.status, e.ends_at, o.payout_hold_days,
            COALESCE(-SUM(le.amount_cents),0)::bigint AS balance_cents,
            (e.status NOT IN ('cancelled','suspended') AND e.ends_at + make_interval(days => o.payout_hold_days) < now()) AS releasable,
            a.code
       FROM events e JOIN organisers o ON o.id = e.organiser_id
       LEFT JOIN ledger_accounts a ON a.code = 'organiser_payable:' || e.organiser_id || ':' || e.id
       LEFT JOIN ledger_entries le ON le.account_id = a.id
      WHERE e.organiser_id = $1
      GROUP BY e.id, o.payout_hold_days, a.code ORDER BY e.ends_at`, [organiserId]);
  const { rows: open } = await q.query("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM payouts WHERE organiser_id = $1 AND beneficiary_type = 'organiser' AND status IN ('requested','approved')", [organiserId]);
  const { rows: pendingRefunds } = await q.query(
    `SELECT COALESCE(SUM(r.amount_cents),0)::bigint AS s FROM refunds r JOIN events e ON e.id = r.event_id
      WHERE e.organiser_id = $1 AND r.kind = 'order' AND r.status IN ('requested','approved','processing','failed')`, [organiserId]);
  const total = rows.reduce((s, r) => s + r.balance_cents, 0);
  const releasable = rows.filter((r) => r.releasable).reduce((s, r) => s + Math.max(0, r.balance_cents), 0);
  const available = Math.max(0, releasable - open[0].s - pendingRefunds[0].s);
  return { events: rows, totalCents: total, availableCents: available, inFlightCents: open[0].s, pendingRefundsCents: pendingRefunds[0].s };
}

async function requestPayout(actor, organiserId, amountCents) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM organisers WHERE id = $1 FOR UPDATE", [organiserId]);
    const org = rows[0];
    if (org.status !== "approved") throw conflict("Your organiser account must be approved first.", "organiser_not_approved");
    if (!org.bank_account_enc) throw conflict("Add your bank details before requesting a payout.", "no_bank_details");
    const bal = await organiserBalances(organiserId, c);
    if (amountCents > bal.availableCents) throw conflict("That is more than your available balance.", "insufficient_available");
    const { rows: p } = await c.query(
      `INSERT INTO payouts (reference, beneficiary_type, organiser_id, amount_cents, requested_by) VALUES ($1,'organiser',$2,$3,$4) RETURNING *`,
      [reference("PO"), organiserId, amountCents, actor.id]);
    await audit.record(c, { actor, action: "payout.requested", entityType: "payout", entityId: p[0].id, organiserId, details: { amountCents } });
    return p[0];
  });
}

async function requestVendorPayout(actor, vendor) {
  return db.withTx(async (c) => {
    const bal = await ledger.balanceByCode(c, `vendor_payable:${vendor.id}`);
    const { rows: ev } = await c.query("SELECT ends_at, status FROM events WHERE id = $1", [vendor.event_id]);
    if (new Date(ev[0].ends_at) > new Date()) throw conflict("Vendor settlements open after the event ends.", "event_not_ended");
    if (bal <= 0) throw conflict("Nothing is owed to this vendor.", "nothing_owed");
    const { rows: openR } = await c.query("SELECT 1 FROM refunds WHERE kind = 'pos_sale' AND status IN ('requested','approved','processing') AND pos_sale_id IN (SELECT id FROM pos_sales WHERE vendor_id = $1) LIMIT 1", [vendor.id]);
    if (openR[0]) throw conflict("Resolve open sale refunds before settling this vendor.", "refunds_open");
    const { rows: p } = await c.query(
      `INSERT INTO payouts (reference, beneficiary_type, organiser_id, vendor_id, amount_cents, requested_by) VALUES ($1,'vendor',$2,$3,$4,$5) RETURNING *`,
      [reference("PO"), vendor.organiser_id, vendor.id, bal, actor.id]);
    await audit.record(c, { actor, action: "payout.requested", entityType: "payout", entityId: p[0].id, organiserId: vendor.organiser_id, details: { vendorId: vendor.id, amountCents: bal } });
    return p[0];
  });
}

async function decide(actor, payoutId, approve, note) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM payouts WHERE id = $1 FOR UPDATE", [payoutId]);
    const p = rows[0];
    if (!p) throw notFound("Payout not found.");
    if (p.status !== "requested") throw conflict(`Payout is already ${p.status}.`, "bad_transition");
    if (p.requested_by === actor.id) throw forbidden("You cannot approve a payout you requested.");
    const status = approve ? "approved" : "rejected";
    const { rows: u } = await c.query("UPDATE payouts SET status = $2, approved_by = $3, approved_at = now(), notes = $4 WHERE id = $1 RETURNING *", [payoutId, status, actor.id, note || null]);
    await audit.record(c, { actor, action: `payout.${status}`, entityType: "payout", entityId: payoutId, organiserId: p.organiser_id, details: { note } });
    return u[0];
  });
}

// Records an EFT made outside the system. Re-checks balances under lock.
async function markPaid(actor, payoutId, bankReference) {
  if (!bankReference) throw bad("Enter the bank transfer reference.");
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM payouts WHERE id = $1 FOR UPDATE", [payoutId]);
    const p = rows[0];
    if (!p) throw notFound("Payout not found.");
    if (p.status !== "approved") throw conflict("Only approved payouts can be marked paid.", "bad_transition");
    const lines = [{ account: ledger.codes.platformBank(), credit: p.amount_cents }];
    if (p.beneficiary_type === "vendor") {
      const { rows: v } = await c.query("SELECT event_id FROM vendors WHERE id = $1", [p.vendor_id]);
      const { balance } = await ledger.lockedBalance(c, ledger.codes.vendorPayable(p.vendor_id, v[0].event_id));
      if (balance < p.amount_cents) throw conflict("Vendor balance is lower than this payout (a refund happened after approval).", "insufficient_available");
      lines.push({ account: ledger.codes.vendorPayable(p.vendor_id, v[0].event_id), debit: p.amount_cents });
    } else {
      // Allocate across releasable events, oldest first.
      const bal = await organiserBalances(p.organiser_id, c);
      let remaining = p.amount_cents;
      for (const ev of bal.events.filter((e) => e.releasable && e.balance_cents > 0)) {
        const take = Math.min(remaining, ev.balance_cents);
        if (take > 0) lines.push({ account: ledger.codes.organiserPayable(p.organiser_id, ev.event_id), debit: take });
        remaining -= take;
        if (!remaining) break;
      }
      if (remaining) throw conflict("Releasable balance is lower than this payout.", "insufficient_available");
    }
    const journalId = await ledger.post(c, { kind: "payout", reference: p.reference, idempotencyKey: `payout:${p.id}`, createdBy: actor.id, memo: `EFT ${bankReference}`, lines });
    const { rows: u } = await c.query("UPDATE payouts SET status = 'paid', paid_by = $2, paid_at = now(), bank_reference = $3, journal_id = $4 WHERE id = $1 RETURNING *", [payoutId, actor.id, bankReference, journalId]);
    await audit.record(c, { actor, action: "payout.paid", entityType: "payout", entityId: payoutId, organiserId: p.organiser_id, details: { bankReference, amount: p.amount_cents } });
    return u[0];
  });
}

module.exports = { organiserBalances, requestPayout, requestVendorPayout, decide, markPaid };
