const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const ledger = require("../../lib/ledger");
const { sha256, randomToken, reference, verifySecret } = require("../../lib/crypto");
const { bpsOf } = require("../../lib/money");
const { AppError, conflict, notFound, bad } = require("../../lib/errors");
const tags = require("../tags/service");

// A terminal key is shown once when the terminal is registered and stored
// only as a hash. The POS sends it on every request with the cashier session.
async function registerTerminal(actor, vendor, label) {
  const key = `trk_${randomToken(30)}`;
  const { rows } = await db.query(
    "INSERT INTO terminals (vendor_id, event_id, label, key_hash, registered_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, label, status, created_at",
    [vendor.id, vendor.event_id, label, sha256(key), actor.id]);
  await audit.record(null, { actor, action: "terminal.registered", entityType: "terminal", entityId: rows[0].id, organiserId: vendor.organiser_id, details: { vendorId: vendor.id } });
  return { ...rows[0], terminalKey: key };
}

// Authenticates terminal + cashier together. Both must be valid and belong to
// the same vendor; a stolen key alone or a cashier alone cannot transact.
async function terminalContext(user, key) {
  if (!key || key.length > 80) throw new AppError(401, "terminal_required", "This device is not registered as a terminal.");
  const { rows } = await db.query(
    `SELECT t.*, v.name AS vendor_name, v.status AS vendor_status, v.commission_bps, v.organiser_id,
            e.title AS event_title, e.status AS event_status, e.cashless_enabled, e.ends_at, vm.role AS member_role,
            om.role AS org_role
       FROM terminals t JOIN vendors v ON v.id = t.vendor_id JOIN events e ON e.id = t.event_id
       LEFT JOIN vendor_members vm ON vm.vendor_id = v.id AND vm.user_id = $2
       LEFT JOIN organiser_members om ON om.organiser_id = v.organiser_id AND om.user_id = $2
      WHERE t.key_hash = $1`, [sha256(key), user.id]);
  const t = rows[0];
  if (!t) throw new AppError(401, "terminal_unknown", "This terminal key is not recognised.");
  if (!t.member_role && !["owner", "manager"].includes(t.org_role)) throw new AppError(403, "terminal_wrong_vendor", "You are not a cashier for this vendor.");
  if (t.status !== "active") throw new AppError(403, "terminal_suspended", "This terminal has been suspended.");
  if (t.vendor_status !== "active") throw new AppError(403, "vendor_suspended", "This vendor is suspended.");
  db.query("UPDATE terminals SET last_seen_at = now() WHERE id = $1", [t.id]).catch(() => {});
  return t;
}

function requestHash(items, tagInput) {
  const canonical = items.map((i) => `${i.productId}:${i.quantity}`).sort().join(",");
  return sha256(`${canonical}|${sha256(String(tagInput).trim())}`);
}

const PIN_LIMIT = 5;

// Charges a tag. Returns { status: 'confirmed'|'declined', ... }.
async function charge(user, terminal, { items, tagInput, pin, idempotencyKey }) {
  if (!terminal.cashless_enabled || terminal.event_status !== "published") throw conflict("Cashless payments are not open for this event.", "cashless_closed");
  const hash = requestHash(items, tagInput);

  return db.withTx(async (c) => {
    const prior = await c.query("SELECT * FROM pos_sales WHERE terminal_id = $1 AND idempotency_key = $2", [terminal.id, idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) throw conflict("This request key was already used for a different sale.", "idempotency_mismatch");
      return { ...(await saleView(c, prior.rows[0])), replay: true };
    }

    // Prices from the database only.
    const lines = [];
    for (const it of items) {
      const { rows } = await c.query("SELECT * FROM products WHERE id = $1 AND vendor_id = $2 AND active", [it.productId, terminal.vendor_id]);
      if (!rows[0]) throw bad("A product in this sale is not available at this stall.");
      lines.push({ product: rows[0], quantity: it.quantity });
    }
    const total = lines.reduce((s, l) => s + l.product.price_cents * l.quantity, 0);
    if (total <= 0 || total > config.cashless.maxSaleCents) throw conflict("Sale amount is outside the allowed limit.", "sale_limit");

    const ref = reference("PS");
    const decline = async (reason, extra = {}) => {
      const { rows } = await c.query(
        `INSERT INTO pos_sales (reference, event_id, vendor_id, terminal_id, cashier_id, tag_id, user_id, total_cents, status, decline_reason, idempotency_key, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'declined',$9,$10,$11) RETURNING *`,
        [ref, terminal.event_id, terminal.vendor_id, terminal.id, user.id, extra.tagId || null, extra.userId || null, total, reason, idempotencyKey, hash]);
      return saleView(c, rows[0]);
    };

    const tag = await tags.resolve(c, tagInput);
    if (!tag) return decline("tag_unknown");
    if (tag.status !== "active") return decline(`tag_${tag.status}`, { tagId: tag.id });
    if (tag.event_id !== terminal.event_id) return decline("tag_wrong_event", { tagId: tag.id });
    if (tag.security_level === "uid_only" && total > config.cashless.uidOnlyMaxSaleCents) return decline("tag_not_payment_enabled", { tagId: tag.id, userId: tag.user_id });

    // Lock the attendee row (PIN counters) and the wallet account (balance).
    const { rows: u } = await c.query("SELECT id, status, spending_pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id = $1 FOR UPDATE", [tag.user_id]);
    const attendee = u[0];
    if (attendee.status !== "active") return decline("account_inactive", { tagId: tag.id, userId: tag.user_id });
    if (total >= config.cashless.pinThresholdCents) {
      if (!attendee.spending_pin_hash) return decline("pin_not_set", { tagId: tag.id, userId: tag.user_id });
      if (attendee.pin_locked_until && new Date(attendee.pin_locked_until) > new Date()) return decline("pin_locked", { tagId: tag.id, userId: tag.user_id });
      if (!pin) return decline("pin_required", { tagId: tag.id, userId: tag.user_id });
      if (!verifySecret(String(pin), attendee.spending_pin_hash)) {
        const n = attendee.pin_failed_attempts + 1;
        await c.query("UPDATE users SET pin_failed_attempts = $2::int, pin_locked_until = CASE WHEN $2::int >= $3::int THEN now() + interval '15 minutes' ELSE pin_locked_until END WHERE id = $1", [attendee.id, n, PIN_LIMIT]);
        return decline(n >= PIN_LIMIT ? "pin_locked" : "pin_incorrect", { tagId: tag.id, userId: tag.user_id });
      }
      await c.query("UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1", [attendee.id]);
    }

    const walletSpec = ledger.codes.attendeeWallet(tag.user_id, terminal.event_id);
    const { balance } = await ledger.lockedBalance(c, walletSpec);
    if (balance < total) return decline("insufficient_funds", { tagId: tag.id, userId: tag.user_id });

    const commission = bpsOf(total, terminal.commission_bps);
    const journalId = await ledger.post(c, {
      kind: "pos_sale", reference: ref, idempotencyKey: `pos:${terminal.id}:${idempotencyKey}`, createdBy: user.id,
      lines: [
        { account: walletSpec, debit: total },
        { account: ledger.codes.vendorPayable(terminal.vendor_id, terminal.event_id), credit: total - commission },
        { account: ledger.codes.commissionRevenue(), credit: commission },
      ],
    });
    const { rows } = await c.query(
      `INSERT INTO pos_sales (reference, event_id, vendor_id, terminal_id, cashier_id, tag_id, user_id, total_cents, commission_cents, status, idempotency_key, request_hash, journal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12) RETURNING *`,
      [ref, terminal.event_id, terminal.vendor_id, terminal.id, user.id, tag.id, tag.user_id, total, commission, idempotencyKey, hash, journalId]);
    for (const l of lines) {
      await c.query("INSERT INTO pos_sale_items (sale_id, product_id, name, unit_price_cents, quantity) VALUES ($1,$2,$3,$4,$5)",
        [rows[0].id, l.product.id, l.product.name, l.product.price_cents, l.quantity]);
    }
    await c.query("UPDATE tags SET last_used_at = now() WHERE id = $1", [tag.id]);
    return saleView(c, rows[0]);
  });
}

const DECLINE_TEXT = {
  tag_unknown: "Tag not recognised.",
  tag_blocked: "This tag is blocked.",
  tag_lost: "This tag was reported lost.",
  tag_revoked: "This tag was revoked.",
  tag_replaced: "This tag was replaced. Use the new tag.",
  tag_expired: "This tag has expired.",
  tag_unassigned: "This tag is not linked to anyone.",
  tag_assigned: "This tag is not activated.",
  tag_wrong_event: "This tag is for a different event.",
  tag_not_payment_enabled: "This tag type cannot be used to pay.",
  account_inactive: "The attendee's account is not active.",
  pin_not_set: "Purchases of this size need a spending PIN. The attendee can set one in their TicketRoom account.",
  pin_required: "Ask the attendee to enter their spending PIN.",
  pin_incorrect: "Incorrect PIN.",
  pin_locked: "Too many wrong PINs. Try again in 15 minutes.",
  insufficient_funds: "Insufficient balance.",
};

async function saleView(q, sale) {
  const { rows: items } = await q.query("SELECT product_id, name, unit_price_cents, quantity FROM pos_sale_items WHERE sale_id = $1", [sale.id]);
  return {
    id: sale.id, reference: sale.reference, status: sale.status, totalCents: sale.total_cents,
    declineReason: sale.decline_reason, message: sale.status === "confirmed" ? "Approved" : sale.status === "reversed" ? "Reversed" : DECLINE_TEXT[sale.decline_reason] || "Declined",
    createdAt: sale.created_at, idempotencyKey: sale.idempotency_key, items,
  };
}

async function saleByKey(terminal, key) {
  const { rows } = await db.query("SELECT * FROM pos_sales WHERE terminal_id = $1 AND idempotency_key = $2", [terminal.id, key]);
  if (!rows[0]) return { status: "not_found" };
  return saleView(db, rows[0]);
}

async function vendorSales(vendorId, limit = 50) {
  const { rows } = await db.query(
    `SELECT s.id, s.reference, s.status, s.total_cents, s.decline_reason, s.created_at, t.label AS terminal,
            (SELECT status FROM refunds r WHERE r.pos_sale_id = s.id ORDER BY created_at DESC LIMIT 1) AS refund_status
       FROM pos_sales s JOIN terminals t ON t.id = s.terminal_id WHERE s.vendor_id = $1 ORDER BY s.created_at DESC LIMIT $2`, [vendorId, limit]);
  return rows;
}

async function vendorSummary(vendorId) {
  const { rows: tot } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed_count,
            COALESCE(SUM(total_cents) FILTER (WHERE status = 'confirmed'),0)::bigint AS gross_cents,
            COALESCE(SUM(commission_cents) FILTER (WHERE status = 'confirmed'),0)::bigint AS commission_cents,
            COUNT(*) FILTER (WHERE status = 'declined')::int AS declined_count,
            COALESCE(SUM(total_cents) FILTER (WHERE status = 'reversed'),0)::bigint AS reversed_cents
       FROM pos_sales WHERE vendor_id = $1`, [vendorId]);
  const { rows: byProduct } = await db.query(
    `SELECT i.name, SUM(i.quantity)::int AS qty, SUM(i.quantity * i.unit_price_cents)::bigint AS cents
       FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id WHERE s.vendor_id = $1 AND s.status = 'confirmed'
      GROUP BY i.name ORDER BY cents DESC LIMIT 20`, [vendorId]);
  const payable = await ledger.balanceByCode(db, `vendor_payable:${vendorId}`);
  return { ...tot[0], byProduct, payableCents: payable };
}

module.exports = { registerTerminal, terminalContext, charge, saleByKey, vendorSales, vendorSummary, DECLINE_TEXT };
