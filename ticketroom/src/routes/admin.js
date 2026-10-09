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
           FROM orders WHERE status IN ('paid','partially_refunded','refunded','paid_unfulfilled')`),
    one(`SELECT (SELECT count(*) FROM refunds WHERE status = 'requested')::int AS refunds_pending,
                (SELECT count(*) FROM refunds WHERE status = 'failed')::int AS refunds_failed,
                (SELECT count(*) FROM payouts WHERE status IN ('requested','approved'))::int AS payouts_open,
                (SELECT count(*) FROM webhook_events WHERE status IN ('failed','rejected') AND received_at > now() - interval '1 day')::int AS webhook_problems,
                (SELECT count(*) FROM reconciliation_items WHERE NOT resolved)::int AS recon_exceptions,
                (SELECT count(*) FROM support_cases WHERE status IN ('open','in_progress'))::int AS support_open,
                (SELECT count(*) FROM orders WHERE status = 'paid_unfulfilled')::int AS unfulfilled,
                (SELECT count(*) FROM message_outbox WHERE status = 'failed')::int AS messages_failed,
                (SELECT count(*) FROM payments WHERE status = 'pending' AND created_at < now() - interval '30 minutes')::int AS stale_payments`),
  ]);
  res.json({ users, organisers: orgs, events, sales, ops, ledger: await reconciliation.ledgerIntegrity() });
}));

// ---- organisers ------------------------------------------------------------
router.get("/organisers", wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.status, o.contact_email, o.contact_phone, o.created_at, o.bank_account_last4,
            (SELECT count(*) FROM events WHERE organiser_id = o.id)::int AS events,
            o.commission_bps,
            (SELECT u.full_name FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_name
       FROM organisers o WHERE ($1::text IS NULL OR o.status = $1) ORDER BY o.created_at DESC LIMIT 200`, [status]);
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
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.slug, e.status, e.starts_at, e.city, e.capacity, e.featured, e.cashless_enabled, e.cancellation_requested_at, e.cancellation_reason, e.status_reason,
            o.name AS organiser_name, o.id AS organiser_id,
            (SELECT COALESCE(SUM(quantity_sold),0) FROM ticket_types WHERE event_id = e.id)::int AS sold
       FROM events e JOIN organisers o ON o.id = e.organiser_id
      WHERE ($1::text IS NULL OR e.status = $1 OR ($1 = 'cancel_requests' AND e.cancellation_requested_at IS NOT NULL AND e.status <> 'cancelled'))
      ORDER BY e.starts_at DESC LIMIT 300`, [status]);
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
router.get("/users", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/[%_\\]/g, "").slice(0, 80);
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.status, u.created_at, u.email_verified_at,
            COALESCE((SELECT array_agg(role) FROM platform_roles WHERE user_id = u.id), '{}') AS roles
       FROM users u WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%'
      ORDER BY u.created_at DESC LIMIT 100`, [q]);
  res.json({ users: rows });
}));

router.get("/users/:id", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT id, email, full_name, phone, status, created_at, email_verified_at, (spending_pin_hash IS NOT NULL) AS has_pin FROM users WHERE id = $1", [req.params.id]);
  if (!rows[0]) throw notFound("User not found.");
  const q = (sql) => db.query(sql, [req.params.id]).then((x) => x.rows);
  res.json({
    user: rows[0],
    roles: (await q("SELECT role, granted_at FROM platform_roles WHERE user_id = $1")),
    orders: await q("SELECT o.id, o.reference, o.status, o.total_cents, o.created_at, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 50"),
    tickets: await q("SELECT t.id, t.code, t.status, e.title, t.admitted_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.owner_user_id = $1 ORDER BY t.created_at DESC LIMIT 100"),
    tags: (await q("SELECT t.id, t.display_code, t.tag_type, t.status, e.title FROM tags t LEFT JOIN events e ON e.id = t.event_id WHERE t.user_id = $1")).map((t) => ({ ...t, display_code: tags.formatDisplay(t.display_code) })),
  });
}));

router.post("/users/:id/status", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["active", "suspended"]), reason: r.str({ min: 3, max: 400 }) });
  if (req.params.id === req.user.id) throw bad("You cannot change your own status.");
  const { rowCount } = await db.query("UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted'", [req.params.id, b.status]);
  if (!rowCount) throw notFound("User not found.");
  if (b.status === "suspended") await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.id]);
  await audit.record(null, { actor: req.user, action: `user.${b.status}`, entityType: "user", entityId: req.params.id, details: { reason: b.reason } });
  res.json({ ok: true });
}));

router.post("/users/:id/roles", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { role: r.oneOf(["admin", "finance", "support"]), grant: r.bool() });
  if (req.params.id === req.user.id) throw forbidden("You cannot change your own platform roles.");
  if (b.grant) await db.query("INSERT INTO platform_roles (user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [req.params.id, b.role, req.user.id]);
  else await db.query("DELETE FROM platform_roles WHERE user_id = $1 AND role = $2", [req.params.id, b.role]);
  await audit.record(null, { actor: req.user, action: b.grant ? "role.granted" : "role.revoked", entityType: "user", entityId: req.params.id, details: { role: b.role } });
  res.json({ ok: true });
}));

// ---- TicketRoom staff (admin portal team) ------------------------------------------
const STAFF_ROLE_NAMES = { admin: "Admin", finance: "Finance", support: "Support" };
router.get("/staff", wrap(async (_req, res) => {
  const { rows } = await db.query(`SELECT u.id, u.full_name, u.email, u.status, u.created_at, array_agg(r.role ORDER BY r.role) AS roles
     FROM users u JOIN platform_roles r ON r.user_id = u.id GROUP BY u.id ORDER BY u.full_name`);
  res.json({ staff: rows });
}));
// Add someone to the team. A new address gets an account and an email to set a password.
router.post("/staff", ADMIN, limit("staffteam", 30, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email(), fullName: r.str({ min: 2, max: 120 }), roles: r.arr(r.oneOf(Object.keys(STAFF_ROLE_NAMES)), { min: 1, max: 3 }) });
  const roles = [...new Set(b.roles)];
  const { hashSecret, randomToken, sha256 } = require("../lib/crypto");
  const invited = await db.withTx(async (c) => {
    const { rows: [existing] } = await c.query("SELECT id, status FROM users WHERE lower(email) = $1", [b.email]);
    if (existing && existing.status !== "active") throw conflict("That account is suspended or closed. Restore it under All users first.", "account_inactive");
    let id = existing?.id, url = null;
    if (!existing) {
      const token = randomToken(32);
      ({ rows: [{ id }] } = await c.query("INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id", [b.email, b.fullName, hashSecret(randomToken(24))]));
      await c.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '7 days')", [sha256(token), id]);
      url = `${config.publicBaseUrl}/account#/reset/${token}`;
    }
    for (const role of roles) await c.query("INSERT INTO platform_roles (user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, role, req.user.id]);
    const names = roles.map((x) => STAFF_ROLE_NAMES[x]).join(" and ");
    await outbox.enqueue(c, { to: b.email, userId: id, ...templates.teamInvite({ name: existing ? null : b.fullName, by: req.user.fullName, roles: names, url }) });
    await audit.record(c, { actor: req.user, action: "staff.added", entityType: "user", entityId: id, details: { roles, newAccount: !existing } });
    return !existing;
  });
  res.status(201).json({ ok: true, invited });
}));
// Set exactly these roles; an empty list removes the person from the team.
router.put("/staff/:id", ADMIN, wrap(async (req, res) => {
  const b = check(req.body, { roles: r.arr(r.oneOf(Object.keys(STAFF_ROLE_NAMES)), { max: 3 }) });
  if (req.params.id === req.user.id) throw forbidden("You cannot change your own roles. Ask another admin.");
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound("Staff member not found.");
  const want = [...new Set(b.roles)];
  await db.withTx(async (c) => {
    const { rows: found } = await c.query("SELECT 1 FROM users WHERE id = $1", [req.params.id]);
    if (!found.length) throw notFound("Staff member not found.");
    const have = (await c.query("SELECT role FROM platform_roles WHERE user_id = $1", [req.params.id])).rows.map((x) => x.role);
    for (const role of have.filter((x) => !want.includes(x))) {
      await c.query("DELETE FROM platform_roles WHERE user_id = $1 AND role = $2", [req.params.id, role]);
      await audit.record(c, { actor: req.user, action: "role.revoked", entityType: "user", entityId: req.params.id, details: { role } });
    }
    for (const role of want.filter((x) => !have.includes(x))) {
      await c.query("INSERT INTO platform_roles (user_id, role, granted_by) VALUES ($1,$2,$3)", [req.params.id, role, req.user.id]);
      await audit.record(c, { actor: req.user, action: "role.granted", entityType: "user", entityId: req.params.id, details: { role } });
    }
    if (!want.length) await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [req.params.id]);
  });
  res.json({ ok: true });
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
            e.title AS event_title, ru.full_name AS requested_by_name, du.full_name AS decided_by_name, (r.requested_by = $2) AS mine, o.reference AS order_reference
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
router.get("/integrations", wrap(async (_req, res) => {
  const config = require("../config");
  const i = config.integrations;
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
      { key: "payments", label: "Card payments", provider: config.payments.provider, environment: config.payments.provider === "simulated" ? "mock" : i[config.payments.provider]?.env,
        endpoint: config.payments.provider === "yoco" ? i.yoco.baseUrl : config.payments.provider === "payfast" ? i.payfast.processUrl : "built-in simulator",
        webhookUrl: `${config.publicBaseUrl}/api/webhooks/${config.payments.provider}`,
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
router.post("/emails/:key/test", ADMIN, limit("emailtest", 20, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const item = catalog.find(req.params.key);
  if (!item) throw notFound("Unknown email.");
  const m = item.sample();
  await db.withTx((c) => outbox.enqueue(c, { to: req.user.email, userId: req.user.id, subject: `[TEST] ${m.subject}`, body: m.body }));
  res.json({ ok: true, to: req.user.email });
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
    `SELECT s.*, u.full_name AS assignee, (s.due_at < now() AND s.status IN ('open','in_progress')) AS overdue
       FROM support_cases s LEFT JOIN users u ON u.id = s.assigned_to
      ORDER BY (s.status IN ('resolved','closed')), s.due_at NULLS LAST, s.created_at DESC LIMIT 300`);
  res.json({ cases: rows });
}));

router.post("/support/:id", ADMIN_OR_SUPPORT, wrap(async (req, res) => {
  const b = check(req.body, { status: r.oneOf(["open", "in_progress", "resolved", "closed"]), resolution: r.text({ optional: true, max: 2000 }) });
  await db.query("UPDATE support_cases SET status = $2, resolution = COALESCE($3, resolution), assigned_to = COALESCE(assigned_to, $4), updated_at = now() WHERE id = $1", [req.params.id, b.status, b.resolution || null, req.user.id]);
  res.json({ ok: true });
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
    const esc = (v) => `"${String(v instanceof Date ? v.toISOString() : v ?? "").replace(/"/g, '""')}"`;
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
