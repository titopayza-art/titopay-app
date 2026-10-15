// TicketRoom back office. Roles:
//   admin   — platform operations: approvals, users, roles, events, tags, terminals
//   finance — refunds, payouts, reconciliation (financial approvals)
//   support — customer lookups, tag blocking, ticket reissue, support cases
// Technical admins cannot approve money movements unless also granted finance.
const express = require("express");
const db = require("../lib/db");
const audit = require("../lib/audit");
const ledger = require("../lib/ledger");
const { r, check } = require("../lib/validate");
const { wrap, requirePlatformRole } = require("../middleware/http");
const { conflict, notFound, bad, forbidden } = require("../lib/errors");
const tags = require("../modules/tags/service");
const tickets = require("../modules/tickets/service");
const refunds = require("../modules/finance/refunds");
const settlements = require("../modules/finance/settlements");
const reconciliation = require("../modules/finance/reconciliation");
const payments = require("../modules/payments/service");
const outbox = require("../modules/messaging/outbox");
const templates = require("../modules/messaging/templates");
const { limit } = require("../lib/ratelimit");

const router = express.Router();
const ANY = requirePlatformRole("admin", "finance", "support");
const ADMIN = requirePlatformRole("admin");
const FINANCE = requirePlatformRole("finance");
const ADMIN_OR_SUPPORT = requirePlatformRole("admin", "support");
router.use(ANY);

router.get("/dashboard", wrap(async (_req, res) => {
  const one = async (sql) => (await db.query(sql)).rows[0];
  const [users, orgs, events, sales, ops] = await Promise.all([
    one("SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7 FROM users WHERE status <> 'deleted'"),
    one("SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'approved')::int AS approved FROM organisers"),
    one("SELECT count(*) FILTER (WHERE status = 'pending_approval')::int AS pending, count(*) FILTER (WHERE status = 'published')::int AS live, count(*) FILTER (WHERE cancellation_requested_at IS NOT NULL AND status <> 'cancelled')::int AS cancel_requests FROM events"),
    one(`SELECT COALESCE(SUM(total_cents) FILTER (WHERE paid_at > now() - interval '1 day'),0)::bigint AS gmv24, COALESCE(SUM(total_cents),0)::bigint AS gmv_all,
                count(*) FILTER (WHERE paid_at > now() - interval '1 day')::int AS orders24
           FROM orders WHERE NOT test AND status IN ('paid','partially_refunded','refunded','paid_unfulfilled')`),
    one(`SELECT (SELECT count(*) FROM refunds WHERE status = 'requested')::int AS refunds_pending,
                (SELECT count(*) FROM refunds WHERE status = 'failed')::int AS refunds_failed,
                (SELECT count(*) FROM payouts WHERE status IN ('requested','approved'))::int AS payouts_open,
                (SELECT count(*) FROM webhook_events WHERE status IN ('failed','rejected') AND received_at > now() - interval '1 day')::int AS webhook_problems,
                (SELECT count(*) FROM reconciliation_items WHERE NOT resolved)::int AS recon_exceptions,
                (SELECT count(*) FROM support_cases WHERE status IN ('open','in_progress'))::int AS support_open,
                (SELECT count(*) FROM orders WHERE status = 'paid_unfulfilled')::int AS unfulfilled,
                (SELECT count(*) FROM message_outbox WHERE status = 'failed')::int AS messages_failed,
                (SELECT count(*) FROM payments WHERE status = 'pending' AND created_at < now() - interval '30 minutes')::int AS stale_payments,
                (SELECT count(*) FROM orders WHERE test AND status <> 'cancelled')::int AS test_orders`),
  ]);
  // Payments in test mode: the overview warns until they are switched to live.
  ops.payments_test = require("../modules/payments/providers").paymentsTest() ? 1 : 0;
  res.json({ users, organisers: orgs, events, sales, ops, ledger: await reconciliation.ledgerIntegrity() });
}));

// ---- organisers ------------------------------------------------------------
// ?q= searches by ID (EV-…, ORG-…, matched upper-cased) or name.
function searchTerms(req) {
  const q = String(req.query.q || "").slice(0, 80).trim();
  return q ? { ref: q.toUpperCase(), like: `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` } : { ref: null, like: null };
}

router.get("/organisers", wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const f = searchTerms(req);
  const { rows } = await db.query(
    `SELECT o.id, o.ref, o.name, o.status, o.contact_email, o.contact_phone, o.created_at, o.bank_account_last4,
            (SELECT count(*) FROM events WHERE organiser_id = o.id)::int AS events,
            o.commission_bps,
            (SELECT u.full_name FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_name
       FROM organisers o WHERE ($1::text IS NULL OR o.status = $1)
        AND ($2::text IS NULL OR o.ref = $2 OR lower(o.name) LIKE $3 OR lower(o.contact_email) LIKE $3)
      ORDER BY o.created_at DESC LIMIT 200`, [status, f.ref, f.like]);
  res.json({ organisers: rows });
}));

router.post("/organisers/:id/status", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["approved", "rejected", "suspended"]), reason: r.str({ optional: true, max: 400 }) });
  const { rows } = await db.query(
    `UPDATE organisers SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END, approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE approved_by END
      WHERE id = $1 RETURNING id, status`, [req.params.id, b.status, req.user.id]);
  if (!rows[0]) throw notFound("Organiser not found.");
  if (b.status === "suspended") await db.query("UPDATE events SET status = 'suspended', status_reason = 'organiser suspended' WHERE organiser_id = $1 AND status = 'published'", [req.params.id]);
  if (b.status === "approved" || b.status === "rejected") {
    const { rows: who } = await db.query(
      `SELECT o.name, o.contact_email, u.id AS user_id, u.full_name, u.email FROM organisers o
         LEFT JOIN organiser_members m ON m.organiser_id = o.id AND m.role = 'owner' LEFT JOIN users u ON u.id = m.user_id
        WHERE o.id = $1 ORDER BY m.created_at LIMIT 1`, [req.params.id]);
    const w = who[0];
    if (w) await db.withTx((c) => outbox.enqueue(c, { to: w.email || w.contact_email, userId: w.user_id,
      ...(b.status === "approved" ? templates.organiserApproved({ name: w.full_name, organiser: w.name }) : templates.organiserRejected({ name: w.full_name, organiser: w.name, reason: b.reason })) }));
  }
  await audit.record(null, { actor: req.user, action: `organiser.${b.status}`, entityType: "organiser", entityId: req.params.id, organiserId: req.params.id, details: { reason: b.reason } });
  res.json({ organiser: rows[0] });
}));

// Negotiated commission for one organiser (null = platform default).
router.post("/organisers/:id/commission", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { commissionBps: r.int({ optional: true, min: 0, max: 5000 }) });
  const { rows } = await db.query("UPDATE organisers SET commission_bps = $2 WHERE id = $1 RETURNING id, commission_bps", [req.params.id, b.commissionBps ?? null]);
  if (!rows[0]) throw notFound("Organiser not found.");
  await audit.record(null, { actor: req.user, action: "organiser.commission_set", entityType: "organiser", entityId: req.params.id, organiserId: req.params.id, details: { commissionBps: b.commissionBps ?? "default" } });
  res.json({ organiser: rows[0] });
}));

// ---- events ------------------------------------------------------------------
router.get("/events", wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const f = searchTerms(req);
  const { rows } = await db.query(
    `SELECT e.id, e.ref, e.title, e.slug, e.status, e.starts_at, e.city, e.capacity, e.featured, e.cashless_enabled, e.cancellation_requested_at, e.cancellation_reason, e.status_reason,
            o.name AS organiser_name, o.id AS organiser_id, o.ref AS organiser_ref,
            (SELECT COALESCE(SUM(quantity_sold),0) FROM ticket_types WHERE event_id = e.id)::int AS sold
       FROM events e JOIN organisers o ON o.id = e.organiser_id
      WHERE ($1::text IS NULL OR e.status = $1 OR ($1 = 'cancel_requests' AND e.cancellation_requested_at IS NOT NULL AND e.status <> 'cancelled'))
        AND ($2::text IS NULL OR e.ref = $2 OR o.ref = $2 OR lower(e.title) LIKE $3 OR lower(o.name) LIKE $3)
      ORDER BY e.starts_at DESC LIMIT 300`, [status, f.ref, f.like]);
  res.json({ events: rows });
}));

router.post("/events/:id/status", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { action: r.oneOf(["publish", "reject", "suspend", "reinstate", "feature", "unfeature"]), reason: r.str({ optional: true, max: 400 }) });
  const { rows } = await db.query("SELECT * FROM events WHERE id = $1", [req.params.id]);
  const ev = rows[0];
  if (!ev) throw notFound("Event not found.");
  const t = {
    publish: [["pending_approval"], "published"], reject: [["pending_approval"], "draft"], suspend: [["published"], "suspended"], reinstate: [["suspended"], "published"],
  }[b.action];
  if (t) {
    if (!t[0].includes(ev.status)) throw conflict(`Cannot ${b.action} an event that is ${ev.status}.`, "bad_transition");
    if (b.action !== "publish" && b.action !== "reinstate" && !b.reason) throw bad("Give a reason.", { reason: "Required." });
    await db.query("UPDATE events SET status = $2, status_reason = $3, published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END, updated_at = now() WHERE id = $1", [ev.id, t[1], b.reason || null]);
    if (b.action === "publish" || b.action === "reject") {
      const { rows: who } = await db.query(
        `SELECT u.id, u.full_name, u.email FROM users u WHERE u.id = $1
         UNION ALL SELECT u.id, u.full_name, u.email FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = $2 AND m.role = 'owner' LIMIT 1`, [ev.created_by, ev.organiser_id]);
      if (who[0]) await db.withTx((c) => outbox.enqueue(c, { to: who[0].email, userId: who[0].id,
        ...(b.action === "publish" ? templates.eventPublished({ name: who[0].full_name, event: ev, eventUrl: `${config.publicBaseUrl}/events/${ev.slug}` }) : templates.eventChangesRequested({ name: who[0].full_name, event: ev, reason: b.reason })) }));
    }
  } else {
    await db.query("UPDATE events SET featured = $2 WHERE id = $1", [ev.id, b.action === "feature"]);
  }
  await audit.record(null, { actor: req.user, action: `event.${b.action}`, entityType: "event", entityId: ev.id, organiserId: ev.organiser_id, details: { reason: b.reason } });
  res.json({ ok: true });
}));

// Cancelling an event stops sales and raises a full refund request for every
// paid order. Finance then approves them (bulk approve below).
router.post("/events/:id/cancel", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { reason: r.str({ min: 5, max: 400 }) });
  const out = await db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM events WHERE id = $1 FOR UPDATE", [req.params.id]);
    const ev = rows[0];
    if (!ev) throw notFound("Event not found.");
    if (ev.status === "cancelled") throw conflict("Already cancelled.", "bad_transition");
    await c.query("UPDATE events SET status = 'cancelled', status_reason = $2, updated_at = now() WHERE id = $1", [ev.id, b.reason]);
    const { rows: paid } = await c.query("SELECT id FROM orders WHERE event_id = $1 AND status IN ('paid','partially_refunded') AND total_cents > 0", [ev.id]);
    let raised = 0;
    for (const o of paid) {
      try {
        await c.query("SAVEPOINT rf");
        await refunds.requestOrderRefund(req.user, { orderId: o.id, reason: `Event cancelled: ${b.reason}`, includeFees: true }, c);
        await c.query("RELEASE SAVEPOINT rf");
        raised++;
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT rf");
      }
    }
    const { rows: holders } = await c.query(
      `SELECT u.id, u.email, u.full_name, bool_or(t.price_cents > 0) AS paid FROM tickets t JOIN users u ON u.id = t.owner_user_id
        WHERE t.event_id = $1 AND t.status IN ('valid','refunded') GROUP BY u.id`, [ev.id]);
    for (const h of holders) await outbox.enqueue(c, { to: h.email, userId: h.id, ...templates.eventCancelled({ name: h.full_name, event: ev, reason: b.reason, paid: h.paid }) });
    await c.query("UPDATE tickets SET status = 'revoked', revoked_reason = 'event cancelled', updated_at = now() WHERE event_id = $1 AND status = 'valid' AND price_cents = 0", [ev.id]);
    await audit.record(c, { actor: req.user, action: "event.cancelled", entityType: "event", entityId: ev.id, organiserId: ev.organiser_id, details: { reason: b.reason, refundsRaised: raised } });
    return { refundsRaised: raised };
  });
  res.json(out);
}));

// ---- users -------------------------------------------------------------------
// The platform owner: the first administrator. Only they act on their own account.
const { ownerId, userByEmail, accountType } = require("../lib/accounts");
async function guardOwner(actor, targetId, q = db) {
  if (targetId === (await ownerId(q)) && actor.id !== targetId) throw forbidden("That is the platform owner. Only the owner can change their own account.");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Customers and organisers. TicketRoom staff are managed under Staff & roles.
router.get("/users", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/[%_\\]/g, "").slice(0, 80);
  const type = ["customer", "organiser"].includes(String(req.query.type || "")) ? String(req.query.type) : "";
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.status, u.account_type, u.guest, u.created_at, u.email_verified_at,
            (SELECT string_agg(o.name, ', ' ORDER BY o.name) FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = u.id) AS organisations
       FROM users u
      WHERE u.account_type <> 'staff' AND ($2 = '' OR u.account_type = $2)
        AND ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC LIMIT 100`, [q, type]);
  const { rows: n } = await db.query("SELECT account_type, count(*)::int AS n FROM users WHERE account_type <> 'staff' GROUP BY account_type");
  res.json({ users: rows, counts: Object.fromEntries(n.map((x) => [x.account_type, x.n])) });
}));

router.get("/users/:id", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) throw notFound("User not found.");
  const { rows } = await db.query(
    `SELECT id, email, full_name, phone, status, account_type, guest, created_at, email_verified_at, (spending_pin_hash IS NOT NULL) AS has_pin
       FROM users WHERE id = $1 AND account_type <> 'staff'`, [req.params.id]);
  if (!rows[0]) throw notFound("User not found.");
  const q = (sql) => db.query(sql, [req.params.id]).then((x) => x.rows);
  res.json({
    user: rows[0],
    organisations: await q("SELECT o.id, o.name, o.ref, o.status, m.role FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = $1 ORDER BY o.name"),
    orders: await q("SELECT o.id, o.reference, o.status, o.total_cents, o.created_at, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 50"),
    tickets: await q("SELECT t.id, t.code, t.status, e.title, t.admitted_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.owner_user_id = $1 ORDER BY t.created_at DESC LIMIT 100"),
    tags: (await q("SELECT t.id, t.display_code, t.tag_type, t.status, e.title FROM tags t LEFT JOIN events e ON e.id = t.event_id WHERE t.user_id = $1")).map((t) => ({ ...t, display_code: tags.formatDisplay(t.display_code) })),
  });
}));

router.post("/users/:id/status", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["active", "suspended"]), reason: r.str({ min: 3, max: 400 }) });
  if (req.params.id === req.user.id) throw bad("You cannot change your own status.");
  if (!UUID.test(req.params.id)) throw notFound("User not found.");
  await guardOwner(req.user, req.params.id);
  await db.withTx(async (c) => {
    // Staff accounts are switched on and off under Staff & roles only.
    const { rowCount } = await c.query("UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' AND account_type <> 'staff'", [req.params.id, b.status]);
    if (!rowCount) throw notFound("User not found.");
    if (b.status === "suspended") await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.id]);
  });
  await audit.record(null, { actor: req.user, action: `user.${b.status}`, entityType: "user", entityId: req.params.id, details: { reason: b.reason } });
  res.json({ ok: true });
}));

// ---- TicketRoom staff (admin portal team) ------------------------------------------
// Staff accounts are made here and nowhere else. A customer's or organiser's
// account can never become staff: staff use their own work email.
const STAFF_ROLE_NAMES = { admin: "Admin", finance: "Finance", support: "Support" };
async function staffTarget(actor, id, q = db) {
  if (!UUID.test(String(id))) throw notFound("Staff member not found.");
  const { rows: [t] } = await q.query("SELECT * FROM users WHERE id = $1 AND account_type = 'staff'", [id]);
  if (!t) throw notFound("Staff member not found.");
  await guardOwner(actor, id, q);
  return t;
}
async function staffResetLink(q, userId, interval = "7 days") {
  const { randomToken, sha256 } = require("../lib/crypto");
  const token = randomToken(32);
  await q.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + $3::interval)", [sha256(token), userId, interval]);
  return `${config.publicBaseUrl}/admin#/reset/${token}`;
}
router.get("/staff", wrap(async (_req, res) => {
  const { rows } = await db.query(`SELECT u.id, u.full_name, u.email, u.status, u.created_at,
            COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
     FROM users u LEFT JOIN platform_roles r ON r.user_id = u.id WHERE u.account_type = 'staff' GROUP BY u.id ORDER BY u.full_name`);
  const owner = await ownerId();
  res.json({ staff: rows.map((x) => ({ ...x, owner: x.id === owner })) });
}));
// Add someone to the team: a new staff account and an email to set a password.
router.post("/staff", ADMIN, limit("staffteam", 30, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email(), fullName: r.str({ min: 2, max: 120 }), roles: r.array(r.oneOf(Object.keys(STAFF_ROLE_NAMES)), { min: 1, max: 3 }) });
  const roles = [...new Set(b.roles)];
  const { hashSecret, randomToken } = require("../lib/crypto");
  const invited = await db.withTx(async (c) => {
    const existing = await userByEmail(c, b.email);
    if (existing && accountType(existing) !== "staff") {
      throw conflict("That email already belongs to a customer or organiser account. Staff need their own work email, for example name@ticketroom.co.za.", "not_staff_account", { email: "Use a work email." });
    }
    let id = existing?.id;
    if (existing) {
      // Someone who was taken off the team comes back with their own password.
      await guardOwner(req.user, existing.id, c);
      await c.query("UPDATE users SET status = 'active', updated_at = now() WHERE id = $1", [id]);
    } else {
      ({ rows: [{ id }] } = await c.query("INSERT INTO users (email, full_name, password_hash, account_type) VALUES ($1,$2,$3,'staff') RETURNING id", [b.email, b.fullName, hashSecret(randomToken(24))]));
    }
    const url = existing ? null : await staffResetLink(c, id);
    for (const role of roles) await c.query("INSERT INTO platform_roles (user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, role, req.user.id]);
    const names = roles.map((x) => STAFF_ROLE_NAMES[x]).join(" and ");
    await outbox.enqueue(c, { to: b.email, userId: id, ...templates.teamInvite({ name: existing ? existing.full_name : b.fullName, by: req.user.fullName, roles: names, url }) });
    await audit.record(c, { actor: req.user, action: "staff.added", entityType: "user", entityId: id, details: { roles, newAccount: !existing } });
    return !existing;
  });
  res.status(201).json({ ok: true, invited });
}));
// Set exactly these roles. An empty list takes the person off the team: their
// staff account is switched off until someone adds them again.
router.put("/staff/:id", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { roles: r.array(r.oneOf(Object.keys(STAFF_ROLE_NAMES)), { max: 3 }) });
  if (req.params.id === req.user.id) throw forbidden("You cannot change your own roles. Ask another admin.");
  await staffTarget(req.user, req.params.id);
  const want = [...new Set(b.roles)];
  await db.withTx(async (c) => {
    const have = (await c.query("SELECT role FROM platform_roles WHERE user_id = $1", [req.params.id])).rows.map((x) => x.role);
    for (const role of have.filter((x) => !want.includes(x))) {
      await c.query("DELETE FROM platform_roles WHERE user_id = $1 AND role = $2", [req.params.id, role]);
      await audit.record(c, { actor: req.user, action: "role.revoked", entityType: "user", entityId: req.params.id, details: { role } });
    }
    for (const role of want.filter((x) => !have.includes(x))) {
      await c.query("INSERT INTO platform_roles (user_id, role, granted_by) VALUES ($1,$2,$3)", [req.params.id, role, req.user.id]);
      await audit.record(c, { actor: req.user, action: "role.granted", entityType: "user", entityId: req.params.id, details: { role } });
    }
    if (!want.length) {
      await c.query("UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1", [req.params.id]);
      await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.id]);
    }
    const { rows: left } = await c.query(
      "SELECT 1 FROM platform_roles r JOIN users x ON x.id = r.user_id WHERE r.role = 'admin' AND x.status = 'active' AND x.account_type = 'staff' LIMIT 1");
    if (!left[0]) throw conflict("TicketRoom needs at least one active admin.", "last_admin");
  });
  res.json({ ok: true });
}));
// The owner or an admin sends a staff member a link to choose a new password.
// Staff cannot reset their own password from the sign-in box.
router.post("/staff/:id/reset", ADMIN, limit("staffreset", 20, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const t = await staffTarget(req.user, req.params.id);
  if (t.status !== "active") throw conflict("That staff account is switched off. Add them to the team again first.", "account_inactive");
  await db.withTx(async (c) => {
    await c.query("UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [t.id]);
    const url = await staffResetLink(c, t.id, "24 hours");
    await outbox.enqueue(c, { to: t.email, userId: t.id, ...templates.staffPasswordReset({ name: t.full_name, by: req.user.fullName, url }) });
    await audit.record(c, { actor: req.user, action: "staff.password_reset_sent", entityType: "user", entityId: t.id });
  });
  res.json({ ok: true, message: `A link to choose a new password is on its way to ${t.email}. It works for 24 hours.` });
}));

// ---- orders, tickets, payments ---------------------------------------------------
router.get("/orders", wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/[%_\\]/g, "").slice(0, 80);
  const { rows } = await db.query(
    `SELECT o.id, o.reference, o.status, o.buyer_name, o.buyer_email, o.total_cents, o.refunded_cents, o.created_at, e.title,
            (SELECT json_agg(json_build_object('id', p.id, 'status', p.status, 'provider', p.provider, 'ref', p.provider_reference, 'amount', p.amount_cents)) FROM payments p WHERE p.order_id = o.id) AS payments
       FROM orders o JOIN events e ON e.id = o.event_id
      WHERE $1 = '' OR o.reference ILIKE '%' || $1 || '%' OR o.buyer_email ILIKE '%' || $1 || '%'
      ORDER BY o.created_at DESC LIMIT 100`, [q]);
  res.json({ orders: rows });
}));

router.get("/tickets/:code", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.code, t.status, t.holder_name, t.admitted_at, t.qr_version, t.revoked_reason, e.title, o.reference, u.email AS owner_email
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN orders o ON o.id = t.order_id JOIN users u ON u.id = t.owner_user_id
      WHERE t.code = upper($1)`, [String(req.params.code).replace(/[\s-]/g, "")]);
  if (!rows[0]) throw notFound("Ticket not found.");
  const { rows: log } = await db.query("SELECT outcome, occurred_at, gate FROM admission_log WHERE ticket_id = $1 ORDER BY id DESC LIMIT 20", [rows[0].id]);
  res.json({ ticket: rows[0], admissions: log });
}));

router.post("/tickets/:id/reissue", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const b = check(req.body, { reason: r.str({ min: 3, max: 300 }) });
  res.json(await tickets.reissue(req.user, req.params.id, b.reason));
}));
router.post("/tickets/:id/revoke", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { reason: r.str({ min: 3, max: 300 }) });
  await tickets.revoke(req.user, req.params.id, b.reason);
  res.json({ ok: true });
}));

router.get("/payments", wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const { rows } = await db.query(
    `SELECT p.id, p.purpose, p.provider, p.provider_reference, p.amount_cents, p.refunded_cents, p.status, p.failure_reason, p.created_at, p.confirmed_at, u.email
       FROM payments p JOIN users u ON u.id = p.user_id WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.created_at DESC LIMIT 200`, [status]);
  res.json({ payments: rows });
}));

router.post("/payments/:id/recheck", wrap(async (req, res) => {
  const result = await payments.syncStatus(req.params.id);
  await audit.record(null, { actor: req.user, action: "payment.rechecked", entityType: "payment", entityId: req.params.id, details: { result } });
  res.json({ result });
}));

router.get("/webhooks", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT id, provider, provider_event_id, signature_valid, status, error, attempts, received_at, processed_at FROM webhook_events ORDER BY received_at DESC LIMIT 200");
  res.json({ webhooks: rows });
}));

// ---- refunds (finance) ---------------------------------------------------------
router.get("/refunds", wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const { rows } = await db.query(
    `SELECT r.id, r.reference, r.kind, r.status, r.amount_cents, r.fee_refund_cents, r.reason, r.failure_reason, r.created_at, r.decided_at,
            e.title AS event_title, ru.full_name AS requested_by_name, du.full_name AS decided_by_name, o.reference AS order_reference,
            -- "mine" tells the page to ask for a second person: only when there is one.
            (r.requested_by = $2 AND EXISTS (SELECT 1 FROM platform_roles pr JOIN users x ON x.id = pr.user_id
                                              WHERE pr.role = 'finance' AND x.status = 'active' AND x.id <> $2)) AS mine
       FROM refunds r JOIN events e ON e.id = r.event_id LEFT JOIN users ru ON ru.id = r.requested_by LEFT JOIN users du ON du.id = r.decided_by
       LEFT JOIN orders o ON o.id = r.order_id
      WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 300`, [status, req.user.id]);
  res.json({ refunds: rows });
}));

router.post("/refunds/:id/decide", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { approve: r.bool(), note: r.str({ optional: true, max: 400 }) });
  res.json({ refund: await refunds.decide(req.user, req.params.id, b.approve, b.note) });
}));

router.post("/refunds/:id/complete-manually", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { providerReference: r.str({ min: 3, max: 80 }) });
  res.json({ refund: await refunds.completeManually(req.user, req.params.id, b.providerReference) });
}));

router.post("/refunds/:id/retry", FINANCE, wrap(async (req, res) => res.json({ refund: await refunds.execute(req.user, req.params.id) })));

router.post("/refunds/bulk-approve", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { refundIds: r.array(r.uuid(), { min: 1, max: 200 }), note: r.str({ optional: true, max: 400 }) });
  const results = [];
  for (const id of b.refundIds) {
    try { results.push({ id, status: (await refunds.decide(req.user, id, true, b.note)).status }); } catch (err) { results.push({ id, error: err.message }); }
  }
  res.json({ results });
}));

// ---- payouts (finance) -----------------------------------------------------------
router.get("/payouts", wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT p.*, o.name AS organiser_name, o.bank_name, o.bank_account_holder, o.bank_account_last4, o.bank_branch_code, v.name AS vendor_name,
            ru.full_name AS requested_by_name, au.full_name AS approved_by_name
       FROM payouts p JOIN organisers o ON o.id = p.organiser_id LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN users ru ON ru.id = p.requested_by LEFT JOIN users au ON au.id = p.approved_by
      ORDER BY p.created_at DESC LIMIT 200`);
  res.json({ payouts: rows.map((p) => ({ ...p, mine: p.requested_by === _req.user.id })) });
}));

router.post("/payouts/:id/decide", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { approve: r.bool(), note: r.str({ optional: true, max: 400 }) });
  res.json({ payout: await settlements.decide(req.user, req.params.id, b.approve, b.note) });
}));

router.post("/payouts/:id/mark-paid", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { bankReference: r.str({ min: 3, max: 60 }) });
  res.json({ payout: await settlements.markPaid(req.user, req.params.id, b.bankReference) });
}));

// Full bank account number, revealed to finance only and audited.
router.post("/payouts/:id/reveal-account", FINANCE, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT o.id, o.bank_account_enc FROM payouts p JOIN organisers o ON o.id = p.organiser_id WHERE p.id = $1 AND p.status = 'approved'", [req.params.id]);
  if (!rows[0]?.bank_account_enc) throw notFound("Approved payout with bank details not found.");
  await audit.record(null, { actor: req.user, action: "bank_account.revealed", entityType: "payout", entityId: req.params.id, organiserId: rows[0].id });
  res.json({ accountNumber: require("../lib/crypto").decrypt(rows[0].bank_account_enc) });
}));

// ---- reconciliation & ledger (finance) ----------------------------------------------
router.get("/reconciliation", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT r.*, u.full_name AS created_by_name FROM reconciliation_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 50");
  res.json({ runs: rows, ledger: await reconciliation.ledgerIntegrity() });
}));

router.post("/reconciliation", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { provider: r.oneOf(["simulated"]), from: r.date(), to: r.date(), csv: r.text({ optional: true, max: 2000000 }) });
  res.status(201).json({ run: await reconciliation.run(req.user, b) });
}));

router.get("/reconciliation/:id", wrap(async (req, res) => {
  const { rows: run } = await db.query("SELECT * FROM reconciliation_runs WHERE id = $1", [req.params.id]);
  if (!run[0]) throw notFound("Run not found.");
  const { rows } = await db.query("SELECT * FROM reconciliation_items WHERE run_id = $1 ORDER BY (outcome = 'matched'), id", [req.params.id]);
  res.json({ run: run[0], items: rows });
}));

router.post("/reconciliation/items/:id/resolve", FINANCE, wrap(async (req, res) => {
  const b = check(req.body, { note: r.str({ min: 5, max: 500 }) });
  const { rowCount } = await db.query("UPDATE reconciliation_items SET resolved = true, resolved_by = $2, resolution_note = $3 WHERE id = $1 AND NOT resolved", [req.params.id, req.user.id, b.note]);
  if (!rowCount) throw notFound("Open item not found.");
  await audit.record(null, { actor: req.user, action: "reconciliation.item_resolved", entityType: "reconciliation_item", entityId: req.params.id, details: { note: b.note } });
  res.json({ ok: true });
}));

router.get("/ledger/accounts", wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT a.code, a.kind, a.owner_type, a.name, COALESCE(SUM(e.amount_cents),0)::bigint AS raw_cents, count(e.id)::int AS entries
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.id ORDER BY a.kind, a.code LIMIT 1000`);
  res.json({ accounts: rows.map((a) => ({ ...a, balance_cents: ["asset", "expense"].includes(a.kind) ? a.raw_cents : -a.raw_cents })) });
}));

router.get("/ledger/journals", wrap(async (req, res) => {
  const ref = String(req.query.reference || "").slice(0, 40);
  const { rows } = await db.query(
    `SELECT j.id, j.kind, j.reference, j.memo, j.created_at, j.reverses_journal_id,
            json_agg(json_build_object('account', a.code, 'amount', e.amount_cents) ORDER BY e.id) AS lines
       FROM journals j JOIN ledger_entries e ON e.journal_id = j.id JOIN ledger_accounts a ON a.id = e.account_id
      WHERE $1 = '' OR j.reference = $1 GROUP BY j.id ORDER BY j.created_at DESC LIMIT 100`, [ref]);
  res.json({ journals: rows });
}));

// ---- tags & terminals ----------------------------------------------------------------
router.post("/tag-batches", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, {
    tagType: r.oneOf(["nfc_wristband", "nfc_card", "qr_tag"]), mode: r.oneOf(["generate", "import"]),
    quantity: r.int({ optional: true, min: 1, max: 2000 }), uids: r.array(r.str({ max: 40 }), { optional: true, max: 2000 }),
    eventId: r.uuid({ optional: true }), notes: r.str({ optional: true, max: 200 }),
  });
  if (b.mode === "generate" && !b.quantity) throw bad("Enter a quantity.");
  if (b.mode === "import" && !b.uids?.length) throw bad("Paste at least one chip UID.");
  res.status(201).json(await tags.createBatch(req.user, b));
}));

router.get("/tags", wrap(async (req, res) => {
  const q = String(req.query.q || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const { rows } = await db.query(
    `SELECT t.id, t.tag_type, t.display_code, t.status, t.security_level, t.linked_at, t.last_used_at, t.status_reason, e.title AS event_title, u.email AS owner_email
       FROM tags t LEFT JOIN events e ON e.id = t.event_id LEFT JOIN users u ON u.id = t.user_id
      WHERE $1 = '' OR t.display_code LIKE $1 || '%' ORDER BY t.created_at DESC LIMIT 200`, [q]);
  res.json({ tags: rows.map((t) => ({ ...t, display_code: tags.formatDisplay(t.display_code) })) });
}));

router.get("/tags/:id/history", wrap(async (req, res) => {
  const { rows } = await db.query("SELECT te.action, te.details, te.occurred_at, u.full_name AS actor FROM tag_events te LEFT JOIN users u ON u.id = te.actor_id WHERE te.tag_id = $1 ORDER BY te.id DESC", [req.params.id]);
  res.json({ history: rows });
}));

router.post("/tags/:id/status", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["blocked", "active", "revoked"]), reason: r.str({ min: 3, max: 200 }) });
  await tags.setStatus(req.user, req.params.id, b.status, b.reason);
  res.json({ ok: true });
}));

router.get("/terminals", wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT t.id, t.label, t.status, t.last_seen_at, t.created_at, v.name AS vendor_name, e.title AS event_title
       FROM terminals t JOIN vendors v ON v.id = t.vendor_id JOIN events e ON e.id = t.event_id ORDER BY t.created_at DESC LIMIT 300`);
  res.json({ terminals: rows });
}));

router.post("/terminals/:id/status", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["active", "suspended", "retired"]) });
  await db.query("UPDATE terminals SET status = $2 WHERE id = $1", [req.params.id, b.status]);
  await audit.record(null, { actor: req.user, action: `terminal.${b.status}`, entityType: "terminal", entityId: req.params.id });
  res.json({ ok: true });
}));

// ---- integrations (payments, SMS, TitoPay wallet) ------------------------------
// Provider settings are for admins only.
router.get("/integrations", ADMIN, wrap(async (_req, res) => {
  const config = require("../config");
  const i = config.integrations;
  const testOrders = await countTestOrders();
  const { rows: calls } = await db.query(
    `SELECT integration, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failures, max(occurred_at) AS last_call,
            round(avg(duration_ms))::int AS avg_ms
       FROM integration_calls WHERE occurred_at > now() - interval '24 hours' GROUP BY integration`);
  const { rows: hooks } = await db.query("SELECT provider, max(received_at) AS last_webhook, count(*) FILTER (WHERE status IN ('failed','rejected'))::int AS problems FROM webhook_events WHERE received_at > now() - interval '24 hours' GROUP BY provider");
  const stat = (name) => ({ ...(calls.find((c) => c.integration === name) || {}), ...(hooks.find((h) => h.provider === name) || {}) });
  const set = (v) => (v ? "set" : "missing");
  res.json({
    defaults: { bookingFeeCents: config.fees.ticketFeeFixedCents, bookingFeeBps: config.fees.ticketFeeBps, organiserCommissionBps: config.fees.organiserCommissionBps },
    integrations: [
      { key: "payments", label: "Card payments", provider: config.payments.provider,
        environment: config.payments.provider === "simulated" ? "mock" : config.payments.provider === "sandbox" ? "test" : i[config.payments.provider]?.env,
        endpoint: config.payments.provider === "yoco" ? i.yoco.baseUrl : config.payments.provider === "payfast" ? i.payfast.processUrl : config.payments.provider === "sandbox" ? "TicketRoom practice payment page" : config.payments.provider === "none" ? "not set up" : "built-in simulator",
        webhookUrl: ["none", "sandbox"].includes(config.payments.provider) ? null : `${config.publicBaseUrl}/api/webhooks/${config.payments.provider}`,
        sandbox: paymentMode.current(), testOrders,
        credentials: config.payments.provider === "yoco" ? { secretKey: set(i.yoco.secretKey), webhookSecret: set(i.yoco.webhookSecret) } : config.payments.provider === "payfast" ? { merchantId: set(i.payfast.merchantId), merchantKey: set(i.payfast.merchantKey), passphrase: set(i.payfast.passphrase) } : {},
        ...stat(config.payments.provider) },
      { key: "sms", label: "SMS", provider: config.messaging.smsProvider, environment: config.messaging.smsProvider === "log" ? "mock" : i[config.messaging.smsProvider]?.env,
        endpoint: config.messaging.smsProvider === "bulksms" ? i.bulksms.baseUrl : config.messaging.smsProvider === "clickatell" ? i.clickatell.baseUrl : "log only (not sent)",
        credentials: config.messaging.smsProvider === "bulksms" ? { tokenId: set(i.bulksms.tokenId), tokenSecret: set(i.bulksms.tokenSecret) } : config.messaging.smsProvider === "clickatell" ? { apiKey: set(i.clickatell.apiKey) } : {},
        ...stat(config.messaging.smsProvider) },
      { key: "titopay", label: "TitoPay wallet", provider: i.titopay.enabled ? "titopay" : "disabled", environment: i.titopay.env, endpoint: i.titopay.baseUrl,
        webhookUrl: `${config.publicBaseUrl}/api/webhooks/titopay`,
        credentials: { clientId: set(i.titopay.clientId), clientSecret: set(i.titopay.clientSecret), webhookSecret: set(i.titopay.webhookSecret) }, ...stat("titopay") },
    ],
  });
}));

router.post("/integrations/:key/health", ADMIN, wrap(async (req, res) => {
  const config = require("../config");
  const { getProvider } = require("../modules/payments/providers");
  let result;
  if (req.params.key === "payments") result = await getProvider(config.payments.provider).health();
  else if (req.params.key === "titopay") result = await require("../modules/titopay/client").health();
  else if (req.params.key === "sms") result = await outbox.adapterFor("sms").health();
  else throw notFound("Unknown integration.");
  await audit.record(null, { actor: req.user, action: "integration.health_checked", entityType: "integration", entityId: req.params.key, details: { ok: result.ok } });
  res.json(result);
}));

// ---- test payments: the sandbox --------------------------------------------------
const paymentMode = require("../modules/payments/mode");
const countTestOrders = async (q = db) => (await q.query("SELECT count(*)::int AS n FROM orders WHERE test AND status <> 'cancelled'")).rows[0].n;
async function confirmPassword(user, password) {
  const { verifySecret } = require("../lib/crypto");
  const { rows: [u] } = await db.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!verifySecret(password, u.password_hash)) throw new (require("../lib/errors").AppError)(401, "bad_credentials", "Your password is incorrect.", { currentPassword: "Incorrect." });
}
// Test mode in one click. "ticketroom": TicketRoom's own sandbox, works
// anywhere with no provider account. "payfast": PayFast's shared sandbox
// account (published by PayFast for testing). Needs the admin's password.
router.post("/integrations/payments/sandbox", ADMIN, limit("integsave", 20, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { currentPassword: r.str({ max: 200 }), kind: r.oneOf(["ticketroom", "payfast"], { optional: true }) });
  await confirmPassword(req.user, b.currentPassword);
  const { getProvider } = require("../modules/payments/providers");
  const config = require("../config");
  const live = config.payments.provider !== "none" && (() => { try { return getProvider(config.payments.provider).environment === "live"; } catch { return false; } })();
  if (live) throw conflict("Live payments are switched on. Switch them to test first if you really want a test setup.", "live_mode");
  const kind = b.kind || "ticketroom";
  await db.withTx(async (c) => {
    await paymentMode.useSandbox(c, kind);
    await audit.record(c, { actor: req.user, action: "integration.updated", entityType: "integration", entityId: "payments", ip: req.ip, details: { sandbox: kind } });
  });
  res.json({ ok: true, message: kind === "payfast"
    ? "Test payments are ready: PayFast test mode with PayFast's shared test account. Buy a ticket to try it; no real money moves."
    : "The TicketRoom sandbox is on. Buy a ticket to try it: you choose whether the practice payment goes through. No real money moves." });
}));
// Back to the configured provider (PAYMENT_PROVIDER and its settings).
router.delete("/integrations/payments/sandbox", ADMIN, limit("integsave", 20, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body || {}, { currentPassword: r.str({ max: 200 }) });
  await confirmPassword(req.user, b.currentPassword);
  await db.withTx(async (c) => {
    await paymentMode.clear(c);
    await audit.record(c, { actor: req.user, action: "integration.updated", entityType: "integration", entityId: "payments", ip: req.ip, details: { sandbox: null } });
  });
  res.json({ ok: true, provider: require("../config").payments.provider });
}));
// Before going live: test orders are cancelled, their tickets stop working and
// the places they held go back on sale. Test ledger entries stay, as history.
router.post("/payments/clear-test", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { currentPassword: r.str({ max: 200 }) });
  await confirmPassword(req.user, b.currentPassword);
  const cleared = await db.withTx(async (c) => {
    const { rows: freed } = await c.query(
      `UPDATE ticket_types tt SET quantity_sold = GREATEST(tt.quantity_sold - x.n, 0)
         FROM (SELECT ticket_type_id, count(*)::int AS n FROM tickets WHERE test AND status IN ('valid','used') GROUP BY 1) x
        WHERE tt.id = x.ticket_type_id RETURNING x.n`);
    await c.query("UPDATE tickets SET status = 'revoked', revoked_reason = 'test order cleared', updated_at = now() WHERE test AND status IN ('valid','used')");
    // Unpaid test orders still hold places: let them go.
    const { rows: pending } = await c.query("SELECT * FROM orders WHERE test AND status = 'pending_payment' FOR UPDATE");
    for (const o of pending) {
      await require("../modules/orders/service").releaseHolds(c, o);
      await c.query("UPDATE payments SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('initiated','pending')", [o.id]);
    }
    const { rowCount } = await c.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE test AND status <> 'cancelled'");
    const n = { orders: rowCount, tickets: freed.reduce((s, x) => s + x.n, 0) };
    await audit.record(c, { actor: req.user, action: "payments.test_cleared", entityType: "integration", entityId: "payments", ip: req.ip, details: n });
    return n;
  });
  res.json({ ok: true, cleared, testOrders: await countTestOrders() });
}));

// Sends a test email (to any address, the admin's own by default) or SMS straight away.
router.post("/integrations/:key/test", ADMIN, limit("integtest", 10, 600e3, (q) => q.user.id), wrap(async (req, res) => {
  if (req.params.key === "email") {
    const b = check(req.body || {}, { to: r.email({ optional: true }) });
    const to = b.to || req.user.email;
    const result = await outbox.sendNow(to, "TicketRoom test email", `Hi,\n\nThis is a test from Admin portal → Integrations, sent by ${req.user.fullName}. If you can read it, TicketRoom email works.\n\n-- \nTicketRoom`, null);
    await audit.record(null, { actor: req.user, action: "integration.test_email", entityType: "integration", entityId: "mail", details: { ok: result.ok } });
    return res.json(result);
  }
  if (req.params.key === "sms") {
    const b = check(req.body || {}, { phone: r.phone() });
    try {
      await outbox.adapterFor("sms").send({ channel: "sms", to_address: b.phone, body: "TicketRoom test SMS. If you can read this, SMS works." });
      return res.json({ ok: true, detail: `Sent to ${b.phone}.` });
    } catch (err) { return res.json({ ok: false, detail: String(err.message || err) }); }
  }
  throw notFound("Nothing to test here.");
}));

// ---- site settings: maintenance, banner, hours, support, legal, assistant ----------
const settingsSvc = require("../modules/site/settings");
router.get("/settings", wrap(async (_req, res) => {
  const all = await settingsSvc.all();
  res.json({ settings: all, hoursStatus: settingsSvc.hoursStatus(all.hours), aiConfigured: !!process.env.ANTHROPIC_API_KEY, assistantModel: process.env.CHATBOT_MODEL || "claude-opus-5-5" });
}));
router.put("/settings/:key", ADMIN, wrap(async (req, res) => res.json({ value: await settingsSvc.set(req.user, req.params.key, req.body) })));

// ---- advertising posters --------------------------------------------------------
const images = require("../lib/images");
const config = require("../config");
router.post("/uploads", ADMIN, express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }), wrap(async (req, res) => {
  res.status(201).json({ uploadId: await images.store({ db, config, ownerId: req.user.id, buffer: req.body }) });
}));
const posterShape = (o = {}) => ({
  title: r.str({ min: 2, max: 120, ...o }), subtitle: r.str({ optional: true, max: 200 }), imageUploadId: r.uuid({ optional: true }),
  linkUrl: r.str({ optional: true, max: 300, pattern: /^(\/|https?:\/\/)/, message: "Start with / or https://" }), placement: r.oneOf(["home", "events"], { optional: true, fallback: o.optional ? undefined : "home" }),
  startsAt: r.date({ optional: true }), endsAt: r.date({ optional: true }), active: r.bool({ optional: true, fallback: undefined }), sortOrder: r.int({ optional: true, min: 0, max: 1000 }),
});
const POSTER_COLS = { title: "title", subtitle: "subtitle", imageUploadId: "image_upload_id", linkUrl: "link_url", placement: "placement", startsAt: "starts_at", endsAt: "ends_at", active: "active", sortOrder: "sort_order" };
router.get("/posters", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM ad_posters ORDER BY active DESC, sort_order, created_at DESC");
  res.json({ posters: rows });
}));
router.post("/posters", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, posterShape());
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows } = await db.query(`INSERT INTO ad_posters (created_by, ${keys.map((k) => POSTER_COLS[k]).join(", ")}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING *`, [req.user.id, ...keys.map((k) => b[k])]);
  await audit.record(null, { actor: req.user, action: "poster.created", entityType: "ad_poster", entityId: rows[0].id });
  res.status(201).json({ poster: rows[0] });
}));
router.patch("/posters/:id", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, posterShape({ optional: true }));
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) throw bad("Nothing to change.");
  const { rows } = await db.query(`UPDATE ad_posters SET ${keys.map((k, i) => `${POSTER_COLS[k]} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map((k) => b[k])]);
  if (!rows[0]) throw notFound("Poster not found.");
  await audit.record(null, { actor: req.user, action: "poster.updated", entityType: "ad_poster", entityId: req.params.id, details: { fields: keys } });
  res.json({ poster: rows[0] });
}));
router.delete("/posters/:id", ADMIN, wrap(async (req, res) => {
  await db.query("DELETE FROM ad_posters WHERE id = $1", [req.params.id]);
  await audit.record(null, { actor: req.user, action: "poster.deleted", entityType: "ad_poster", entityId: req.params.id });
  res.json({ ok: true });
}));

// ---- assistant knowledge base and conversations ------------------------------------
const assistant = require("../modules/site/assistant");
router.get("/kb", wrap(async (_req, res) => {
  await assistant.ensureDefaults();
  const { rows } = await db.query("SELECT * FROM kb_articles ORDER BY active DESC, sort_order, question");
  res.json({ articles: rows });
}));
const kbShape = (o = {}) => ({
  question: r.str({ min: 5, max: 200, ...o }), answer: r.text({ max: 2000, ...o }), keywords: r.array(r.str({ max: 40 }), { optional: true, max: 30 }),
  linkUrl: r.str({ optional: true, max: 200, pattern: /^\//, message: "Use a site path like /help" }), active: r.bool({ optional: true, fallback: undefined }), sortOrder: r.int({ optional: true, min: 0, max: 1000 }),
});
router.post("/kb", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const b = check(req.body, kbShape());
  const { rows } = await db.query("INSERT INTO kb_articles (question, answer, keywords, link_url, sort_order, updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [b.question, b.answer, b.keywords || [], b.linkUrl || null, b.sortOrder ?? 100, req.user.id]);
  res.status(201).json({ article: rows[0] });
}));
router.patch("/kb/:id", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const b = check(req.body, kbShape({ optional: true }));
  const { rows } = await db.query(
    `UPDATE kb_articles SET question = COALESCE($2, question), answer = COALESCE($3, answer), keywords = COALESCE($4, keywords), link_url = COALESCE($5, link_url),
            active = COALESCE($6, active), sort_order = COALESCE($7, sort_order), updated_by = $8, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, b.question ?? null, b.answer ?? null, b.keywords ?? null, b.linkUrl ?? null, b.active ?? null, b.sortOrder ?? null, req.user.id]);
  if (!rows[0]) throw notFound("Article not found.");
  res.json({ article: rows[0] });
}));
router.get("/chats", wrap(async (req, res) => {
  const unanswered = req.query.filter === "unanswered";
  const { rows } = await db.query(
    `SELECT c.id, c.question, c.answer, c.source, c.helpful, c.created_at, k.question AS matched
       FROM chat_messages c LEFT JOIN kb_articles k ON k.id = c.article_id
      WHERE ($1::boolean IS FALSE OR c.source = 'fallback' OR c.helpful = false) ORDER BY c.id DESC LIMIT 200`, [unanswered]);
  const { rows: stats } = await db.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE source = 'ai')::int AS ai, count(*) FILTER (WHERE source = 'fallback')::int AS unanswered,
            count(*) FILTER (WHERE helpful)::int AS helpful, count(*) FILTER (WHERE helpful = false)::int AS unhelpful
       FROM chat_messages WHERE created_at > now() - interval '30 days'`);
  res.json({ chats: rows, stats: stats[0] });
}));

// ---- email templates: catalogue, preview, test send ---------------------------------
const catalog = require("../modules/messaging/catalog");
const { toHtml } = require("../modules/messaging/html");
router.get("/emails", wrap(async (_req, res) => {
  res.json({
    emails: catalog.CATALOG.map((x) => ({ key: x.key, name: x.name, audience: x.audience, trigger: x.trigger, setting: x.setting || null, ...x.sample() })),
    settings: await settingsSvc.get("emails"),
    delivery: config.messaging.emailProvider,
  });
}));
router.get("/emails/:key/preview", wrap(async (req, res) => {
  const item = catalog.find(req.params.key);
  if (!item) throw notFound("Unknown email.");
  const m = item.sample();
  // Shown inside the back office only; email HTML needs inline styles.
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.type("html").send(toHtml(m.subject, m.body));
}));
// Sends a sample straight away (not through the queue) to any address the
// admin types, their own by default.
router.post("/emails/:key/test", ADMIN, limit("emailtest", 100, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const item = catalog.find(req.params.key);
  if (!item) throw notFound("Unknown email.");
  const b = check(req.body || {}, { to: r.email({ optional: true }) });
  const to = b.to || req.user.email;
  const m = item.sample();
  res.json({ ...(await outbox.sendNow(to, `[TEST] ${m.subject}`, m.body, null)), to });
}));

// ---- audit, support, outbox -------------------------------------------------------
router.get("/audit", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT a.id, a.occurred_at, a.action, a.entity_type, a.entity_id, a.actor_role, a.details, u.full_name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1 = '' OR a.action LIKE $1 || '%') ORDER BY a.id DESC LIMIT 300`, [String(req.query.action || "").slice(0, 60)]);
  res.json({ entries: rows });
}));

router.get("/audit/verify", wrap(async (_req, res) => res.json(await audit.verifyChain())));

router.get("/support", wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT s.*, u.full_name AS assignee, (s.due_at < now() AND s.status IN ('open','in_progress')) AS overdue, org.name AS organiser_name
       FROM support_cases s LEFT JOIN users u ON u.id = s.assigned_to LEFT JOIN organisers org ON org.id = s.organiser_id
      ORDER BY (s.status IN ('resolved','closed')), s.due_at NULLS LAST, s.created_at DESC LIMIT 300`);
  res.json({ cases: rows });
}));

router.post("/support/:id", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["open", "in_progress", "resolved", "closed"]), resolution: r.text({ optional: true, max: 2000 }) });
  await db.query("UPDATE support_cases SET status = $2, resolution = COALESCE($3, resolution), assigned_to = COALESCE(assigned_to, $4), updated_at = now() WHERE id = $1", [req.params.id, b.status, b.resolution || null, req.user.id]);
  res.json({ ok: true });
}));

// ---- customer care conversations ----------------------------------------------------
const support = require("../modules/support/service");
router.get("/support/:id", wrap(async (req, res) => {
  const c = await support.getCase(req.params.id);
  res.json({ case: c, messages: await support.messages(c.id), suggestions: await support.suggestions(c) });
}));

router.post("/support/:id/reply", ADMIN_OR_SUPPORT, limit("supreply", 120, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { message: r.text({ min: 2, max: 5000 }), resolve: r.bool() });
  const c = await support.getCase(req.params.id);
  await db.withTx(async (q) => {
    await support.note(q, c.id, req.user.id, "ticketroom", b.message, true);
    await outbox.enqueue(q, { to: c.email, userId: c.user_id, ...templates.supportReply({ name: c.full_name, subject: c.subject, reference: c.reference, message: b.message,
      from: `${support.firstName(req.user.fullName)}, TicketRoom customer care` }) });
    await q.query("UPDATE support_cases SET status = $2, assigned_to = COALESCE(assigned_to, $3), updated_at = now() WHERE id = $1", [c.id, b.resolve ? "resolved" : "in_progress", req.user.id]);
    await audit.record(q, { actor: req.user, action: "support.replied", entityType: "support_case", entityId: c.id });
  });
  res.json({ ok: true });
}));

// Pass a question to the organiser it belongs to.
router.post("/support/:id/transfer", ADMIN_OR_SUPPORT, limit("suptransfer", 60, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { organiserId: r.uuid(), eventId: r.uuid({ optional: true }), note: r.text({ optional: true, max: 1000 }), tellCustomer: r.bool({ fallback: true }) });
  const c = await support.getCase(req.params.id);
  const { rows: [org] } = await db.query("SELECT * FROM organisers WHERE id = $1 AND status = 'approved'", [b.organiserId]);
  if (!org) throw notFound("Organiser not found, or not approved.");
  let event = null;
  if (b.eventId) {
    ({ rows: [event] } = await db.query("SELECT id, title FROM events WHERE id = $1 AND organiser_id = $2", [b.eventId, org.id]));
    if (!event) throw bad("That event belongs to another organiser.");
  }
  await db.withTx(async (q) => {
    await q.query(
      `UPDATE support_cases SET organiser_id = $2, event_id = $3, handled_by = 'organiser', transferred_at = now(), status = 'in_progress',
              assigned_to = COALESCE(assigned_to, $4), updated_at = now() WHERE id = $1`, [c.id, org.id, event?.id || null, req.user.id]);
    await support.note(q, c.id, req.user.id, "system", `Passed to ${org.name}${b.note ? `: ${b.note}` : "."}`);
    await outbox.enqueue(q, { to: org.contact_email, ...templates.queryForOrganiser({ organiser: org.name, reference: c.reference, customer: c.full_name || c.email,
      event: event?.title || null, subject: c.subject, body: c.body, note: b.note || null }) });
    if (b.tellCustomer) {
      await outbox.enqueue(q, { to: c.email, userId: c.user_id, ...templates.queryPassedOn({ name: c.full_name, organiser: org.name, reference: c.reference }) });
      await support.note(q, c.id, req.user.id, "ticketroom", `We've passed your question to ${org.name}. They'll reply to you by email.`, true);
    }
    await audit.record(q, { actor: req.user, action: "support.transferred", entityType: "support_case", entityId: c.id, organiserId: org.id });
  });
  res.json({ case: await support.getCase(c.id) });
}));

router.post("/support/:id/take-back", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const c = await support.getCase(req.params.id);
  await db.withTx(async (q) => {
    // Taken back: the organiser no longer sees the case or anything said after.
    await q.query("UPDATE support_cases SET handled_by = 'ticketroom', organiser_id = NULL, event_id = NULL, status = 'in_progress', updated_at = now() WHERE id = $1", [c.id]);
    await support.note(q, c.id, req.user.id, "system", `Taken back by TicketRoom customer care${c.organiser_name ? ` from ${c.organiser_name}` : ""}.`);
    await audit.record(q, { actor: req.user, action: "support.taken_back", entityType: "support_case", entityId: c.id });
  });
  res.json({ case: await support.getCase(c.id) });
}));

// Organisers to pass a question to: approved ones, by name or ID.
router.get("/support-organisers", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 60);
  const like = `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
  const { rows } = await db.query(
    `SELECT id, name, ref, contact_email FROM organisers WHERE status = 'approved' AND ($1 = '' OR ref = upper($1) OR lower(name) LIKE $2)
      ORDER BY name LIMIT 20`, [q, like]);
  res.json({ organisers: rows });
}));

router.get("/outbox", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT id, channel, kind, to_address, subject, status, provider, attempts, last_error, created_at, sent_at FROM message_outbox ORDER BY created_at DESC LIMIT 200");
  res.json({ messages: rows.map((m) => ({ ...m, to_address: outbox.mask(m.to_address) })), adapters: { email: outbox.adapterFor("email").name, sms: outbox.adapterFor("sms").name } });
}));

void ledger;
// ---------------------------------------------------------------- subscribers (TicketRoom updates)
router.get("/subscribers", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  if (req.query.format === "csv") {
    const { rows } = await db.query("SELECT email, status, source, created_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers ORDER BY created_at");
    await audit.record(null, { actor: req.user, action: "subscribers.exported", entityType: "newsletter", details: { rows: rows.length } });
    // A cell starting with = + - @ (or tab/CR) would run as a formula in Excel.
    const esc = (v) => { const t = String(v instanceof Date ? v.toISOString() : v ?? "").replace(/"/g, '""'); return /^[=+\-@\t\r]/.test(t) ? `"'${t}"` : `"${t}"`; };
    res.setHeader("Content-Disposition", 'attachment; filename="ticketroom-subscribers.csv"');
    return res.type("text/csv").send(["email,status,source,signed_up,confirmed,unsubscribed", ...rows.map((x) => [x.email, x.status, x.source, x.created_at, x.confirmed_at, x.unsubscribed_at].map(esc).join(","))].join("\n") + "\n");
  }
  const q = String(req.query.q || "").trim().slice(0, 80).replace(/[%_\\]/g, "");
  const counts = { subscribed: 0, pending: 0, unsubscribed: 0 };
  for (const x of (await db.query("SELECT status, count(*)::int AS n FROM newsletter_subscribers GROUP BY status")).rows) counts[x.status] = x.n;
  const { rows: subscribers } = await db.query("SELECT email, status, source, created_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE ($1 = '' OR email ILIKE $2) ORDER BY created_at DESC LIMIT 200", [q, `%${q}%`]);
  const { rows: issues } = await db.query("SELECT i.subject, i.recipients, i.created_at, u.full_name AS sent_by FROM newsletter_issues i JOIN users u ON u.id = i.sent_by ORDER BY i.created_at DESC LIMIT 20");
  res.json({ counts, subscribers, issues });
}));

// Send an update to every confirmed subscriber, or a test to yourself first.
router.post("/subscribers/send", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { subject: r.str({ min: 3, max: 150 }), message: r.text({ max: 10000 }), test: r.bool() });
  const { signLink } = require("../lib/crypto");
  const B = config.publicBaseUrl;
  if (b.test) {
    await db.withTx((c) => outbox.enqueue(c, { to: req.user.email, userId: req.user.id, kind: "marketing", ...templates.newsletterUpdate({ subject: `[Test] ${b.subject}`, message: b.message, unsubscribeUrl: `${B}/unsubscribe` }) }));
    return res.json({ ok: true, test: true, to: req.user.email });
  }
  const n = await db.withTx(async (c) => {
    const { rows } = await c.query("SELECT id, email FROM newsletter_subscribers WHERE status = 'subscribed'");
    if (!rows.length) throw conflict("There are no confirmed subscribers yet.", "no_subscribers");
    for (const s of rows) await outbox.enqueue(c, { to: s.email, kind: "marketing", ...templates.newsletterUpdate({ subject: b.subject, message: b.message, unsubscribeUrl: `${B}/unsubscribe?t=${signLink({ n: s.id }, 365 * 86400)}` }) });
    const { rows: [issue] } = await c.query("INSERT INTO newsletter_issues (subject, body, recipients, sent_by) VALUES ($1,$2,$3,$4) RETURNING id", [b.subject, b.message, rows.length, req.user.id]);
    await audit.record(c, { actor: req.user, action: "newsletter.sent", entityType: "newsletter", entityId: issue.id, details: { recipients: rows.length, subject: b.subject } });
    return rows.length;
  });
  res.json({ ok: true, recipients: n });
}));

// ---------------------------------------------------------------- QR code maker
router.post("/qr", limit("adminqr", 120, 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { text: r.text({ max: 1200 }), dark: r.str({ optional: true, max: 7 }), light: r.str({ optional: true, max: 7 }), ecc: r.oneOf(["M", "Q", "H"], { optional: true, fallback: "M" }) });
  res.json({ svg: await require("../lib/qr-people").qrForPeople(b.text, b) });
}));

module.exports = router;
