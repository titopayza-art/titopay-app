// Organiser portal API. Every route below /:orgId goes through
// organiserAccess, which enforces tenancy and the member's role.
const express = require("express");
const config = require("../config");
const db = require("../lib/db");
const audit = require("../lib/audit");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { randomCode, encrypt } = require("../lib/crypto");
const { conflict, bad, notFound } = require("../lib/errors");
const { wrap, requireAuth } = require("../middleware/http");
const { organiserAccess, eventAccess } = require("../middleware/access");
const analytics = require("../modules/marketing/analytics");
const marketing = require("../modules/marketing/service");
const settlements = require("../modules/finance/settlements");
const refunds = require("../modules/finance/refunds");
const pos = require("../modules/pos/service");
const images = require("../lib/images");
const outbox = require("../modules/messaging/outbox");
const templates = require("../modules/messaging/templates");

const router = express.Router();
router.use(requireAuth);

const ALL = ["owner", "manager", "marketing", "finance", "viewer"];
const EDIT = ["owner", "manager"];
const MONEY = ["owner", "finance"];
const MKT = ["owner", "manager", "marketing"];

const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "event";

// ---- organiser account -------------------------------------------------------
router.post("/apply", limit("orgapply", 5, 24 * 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { name: r.str({ min: 2, max: 120 }), contactEmail: r.email(), contactPhone: r.phone({ optional: true }), description: r.text({ optional: true, max: 2000 }) });
  const org = await db.withTx(async (c) => {
    const { rows } = await c.query(
      "INSERT INTO organisers (name, slug, contact_email, contact_phone, description) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [b.name, `${slugify(b.name)}-${randomCode(4).toLowerCase()}`, b.contactEmail, b.contactPhone || null, b.description || null]);
    await c.query("INSERT INTO organiser_members (organiser_id, user_id, role) VALUES ($1,$2,'owner')", [rows[0].id, req.user.id]);
    await audit.record(c, { actor: req.user, action: "organiser.applied", entityType: "organiser", entityId: rows[0].id, organiserId: rows[0].id });
    return rows[0];
  });
  res.status(201).json({ organiser: { id: org.id, name: org.name, status: org.status } });
}));

router.get("/orgs", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.id, o.name, o.status, m.role FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = $1 ORDER BY o.name`, [req.user.id]);
  res.json({ organisers: rows });
}));

const orgView = (o, role) => ({
  id: o.id, name: o.name, slug: o.slug, status: o.status, contactEmail: o.contact_email, contactPhone: o.contact_phone, description: o.description,
  payoutHoldDays: o.payout_hold_days, role,
  bank: MONEY.includes(role) || role === "admin" ? { bankName: o.bank_name, accountHolder: o.bank_account_holder, last4: o.bank_account_last4, branchCode: o.bank_branch_code } : null,
});

router.get("/:orgId", wrap(async (req, res) => {
  const { organiser, role } = await organiserAccess(req.user, req.params.orgId, ALL);
  res.json({ organiser: orgView(organiser, role) });
}));

router.patch("/:orgId", wrap(async (req, res) => {
  const { role } = await organiserAccess(req.user, req.params.orgId, EDIT);
  const b = check(req.body, { name: r.str({ min: 2, max: 120 }), contactEmail: r.email(), contactPhone: r.phone({ optional: true }), description: r.text({ optional: true, max: 2000 }) });
  const { rows } = await db.query("UPDATE organisers SET name = $2, contact_email = $3, contact_phone = $4, description = $5 WHERE id = $1 RETURNING *",
    [req.params.orgId, b.name, b.contactEmail, b.contactPhone || null, b.description || null]);
  res.json({ organiser: orgView(rows[0], role) });
}));

router.put("/:orgId/bank", limit("bank", 10, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const { role } = await organiserAccess(req.user, req.params.orgId, MONEY);
  const b = check(req.body, {
    bankName: r.str({ min: 2, max: 80 }), accountHolder: r.str({ min: 2, max: 120 }),
    accountNumber: r.str({ min: 6, max: 16, pattern: /^\d+$/, message: "Digits only." }), branchCode: r.str({ min: 6, max: 6, pattern: /^\d{6}$/, message: "6 digits." }),
  });
  const { rows } = await db.query(
    `UPDATE organisers SET bank_name = $2, bank_account_holder = $3, bank_account_enc = $4, bank_account_last4 = $5, bank_branch_code = $6 WHERE id = $1 RETURNING *`,
    [req.params.orgId, b.bankName, b.accountHolder, encrypt(b.accountNumber), b.accountNumber.slice(-4), b.branchCode]);
  // Changing where money goes is high-risk: audited, and any open payout is held for review.
  await audit.record(null, { actor: req.user, action: "organiser.bank_changed", entityType: "organiser", entityId: req.params.orgId, organiserId: req.params.orgId, details: { last4: b.accountNumber.slice(-4) } });
  res.json({ organiser: orgView(rows[0], role) });
}));

router.get("/:orgId/dashboard", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ALL);
  res.json(await analytics.organiserDashboard(req.params.orgId));
}));

// ---- team --------------------------------------------------------------------
router.get("/:orgId/members", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ALL);
  const { rows } = await db.query("SELECT u.id, u.full_name, u.email, m.role, m.created_at FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = $1 ORDER BY m.created_at", [req.params.orgId]);
  res.json({ members: rows });
}));

router.post("/:orgId/members", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ["owner"]);
  const b = check(req.body, { email: r.email(), role: r.oneOf(["manager", "marketing", "finance", "viewer"]) });
  const { rows } = await db.query("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active'", [b.email]);
  if (!rows[0]) throw notFound("No TicketRoom account uses that email. Ask them to sign up first.");
  await db.query("INSERT INTO organiser_members (organiser_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (organiser_id, user_id) DO UPDATE SET role = EXCLUDED.role", [req.params.orgId, rows[0].id, b.role]);
  await audit.record(null, { actor: req.user, action: "organiser.member_set", entityType: "user", entityId: rows[0].id, organiserId: req.params.orgId, details: { role: b.role } });
  res.status(201).json({ ok: true });
}));

router.delete("/:orgId/members/:userId", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ["owner"]);
  if (req.params.userId === req.user.id) throw bad("You cannot remove yourself.");
  await db.query("DELETE FROM organiser_members WHERE organiser_id = $1 AND user_id = $2 AND role <> 'owner'", [req.params.orgId, req.params.userId]);
  await audit.record(null, { actor: req.user, action: "organiser.member_removed", entityType: "user", entityId: req.params.userId, organiserId: req.params.orgId });
  res.json({ ok: true });
}));

// ---- image uploads -------------------------------------------------------------
// Image type is decided by magic bytes (lib/images.js); SVG is not accepted.
// Files are served from /media with nosniff and a sandbox CSP.
router.post("/:orgId/uploads", limit("upload", 30, 3600e3, (q) => q.user.id),
  express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "2mb" }),
  wrap(async (req, res) => {
    await organiserAccess(req.user, req.params.orgId, EDIT);
    const uploadId = await images.store({ db, config, ownerId: req.user.id, organiserId: req.params.orgId, buffer: req.body });
    res.status(201).json({ uploadId });
  }));

// ---- events ------------------------------------------------------------------
const eventShape = (partial = false) => {
  const o = partial ? { optional: true } : {};
  return {
    title: r.str({ min: 3, max: 140, ...o }), summary: r.str({ optional: true, max: 240 }), description: r.text({ optional: true, max: 8000 }),
    category: r.oneOf(["music", "festival", "comedy", "sport", "arts", "food", "business", "family", "nightlife", "other"], o),
    venueName: r.str({ min: 2, max: 140, ...o }), address: r.str({ optional: true, max: 240 }), city: r.str({ min: 2, max: 80, ...o }),
    province: r.oneOf(["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"], { optional: true }),
    startsAt: r.date(o), endsAt: r.date(o), doorsOpenAt: r.date({ optional: true }), capacity: r.int({ min: 1, max: 200000, ...o }),
    salesStartAt: r.date({ optional: true }), salesEndAt: r.date({ optional: true }),
    refundPolicy: r.text({ optional: true, max: 2000 }), accessibilityInfo: r.text({ optional: true, max: 2000 }), ageRestriction: r.str({ optional: true, max: 60 }),
    transfersEnabled: r.bool({ optional: true, fallback: undefined }), cashlessEnabled: r.bool({ optional: true, fallback: undefined }), imageUploadId: r.uuid({ optional: true }),
    isFree: r.bool({ optional: true, fallback: undefined }),
  };
};
const COLS = { title: "title", summary: "summary", description: "description", category: "category", venueName: "venue_name", address: "address", city: "city", province: "province",
  startsAt: "starts_at", endsAt: "ends_at", doorsOpenAt: "doors_open_at", capacity: "capacity", salesStartAt: "sales_start_at", salesEndAt: "sales_end_at",
  refundPolicy: "refund_policy", accessibilityInfo: "accessibility_info", ageRestriction: "age_restriction", transfersEnabled: "transfers_enabled",
  cashlessEnabled: "cashless_enabled", imageUploadId: "image_upload_id", isFree: "is_free" };

async function assertUpload(orgId, uploadId) {
  if (!uploadId) return;
  const { rows } = await db.query("SELECT 1 FROM uploads WHERE id = $1 AND organiser_id = $2", [uploadId, orgId]);
  if (!rows[0]) throw bad("Image not found.");
}

router.get("/:orgId/events", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ALL);
  res.json((await analytics.organiserDashboard(req.params.orgId)).events);
}));

router.post("/:orgId/events", wrap(async (req, res) => {
  const { organiser } = await organiserAccess(req.user, req.params.orgId, EDIT);
  const b = check(req.body, eventShape());
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw bad("The event must end after it starts.", { endsAt: "Must be after the start." });
  await assertUpload(organiser.id, b.imageUploadId);
  const cols = Object.keys(b).filter((k) => b[k] !== undefined);
  const { rows } = await db.query(
    `INSERT INTO events (organiser_id, slug, created_by, ${cols.map((k) => COLS[k]).join(", ")})
     VALUES ($1,$2,$3, ${cols.map((_, i) => `$${i + 4}`).join(", ")}) RETURNING *`,
    [organiser.id, `${slugify(b.title)}-${randomCode(4).toLowerCase()}`, req.user.id, ...cols.map((k) => b[k])]);
  // A free event starts with one free registration type covering its capacity.
  if (b.isFree) {
    await db.query("INSERT INTO ticket_types (event_id, name, description, price_cents, quantity_total, per_order_limit) VALUES ($1,'Free admission','Free entry. No payment needed.',0,$2,4)", [rows[0].id, b.capacity]);
  }
  await audit.record(null, { actor: req.user, action: "event.created", entityType: "event", entityId: rows[0].id, organiserId: organiser.id, details: { free: !!b.isFree } });
  res.status(201).json({ event: rows[0] });
}));

router.get("/:orgId/events/:eventId", wrap(async (req, res) => {
  const { event, role } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ALL);
  const [types, promos, links] = await Promise.all([
    db.query("SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY sort_order, price_cents", [event.id]),
    db.query("SELECT * FROM promo_codes WHERE event_id = $1 ORDER BY created_at DESC", [event.id]),
    db.query("SELECT * FROM tracking_links WHERE event_id = $1 ORDER BY created_at DESC", [event.id]),
  ]);
  res.json({ event, role, ticketTypes: types.rows, promoCodes: promos.rows, trackingLinks: links.rows.map((l) => ({ ...l, url: `${config.publicBaseUrl}/events/${event.slug}?ref=${l.code}` })) });
}));

router.patch("/:orgId/events/:eventId", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const b = check(req.body, eventShape(true));
  if (["cancelled", "completed"].includes(event.status)) throw conflict("This event can no longer be edited.", "event_locked");
  await assertUpload(event.organiser_id, b.imageUploadId);
  const { rows: sold } = await db.query("SELECT COALESCE(SUM(quantity_sold + quantity_held),0)::int AS n FROM ticket_types WHERE event_id = $1", [event.id]);
  // Material changes after tickets are sold go through TicketRoom support so buyers can be notified and offered refunds (CPA s47).
  const material = ["startsAt", "endsAt", "venueName", "city", "address"].filter((k) => b[k] !== undefined && String(b[k]) !== String(event[COLS[k]] instanceof Date ? event[COLS[k]].toISOString() : event[COLS[k]]));
  if (sold[0].n > 0 && material.length) throw conflict("Tickets have been sold, so date and venue changes must go through TicketRoom support so buyers are told and offered refunds.", "material_change", { fields: material });
  if (b.capacity !== undefined && b.capacity < sold[0].n) throw conflict(`Capacity cannot be below the ${sold[0].n} tickets already sold or held.`, "capacity_below_sold");
  const starts = b.startsAt || event.starts_at.toISOString();
  const ends = b.endsAt || event.ends_at.toISOString();
  if (new Date(ends) <= new Date(starts)) throw bad("The event must end after it starts.");
  if (b.isFree !== undefined && b.isFree !== event.is_free) {
    const { rows: paid } = await db.query("SELECT count(*) FILTER (WHERE price_cents > 0)::int AS paid FROM ticket_types WHERE event_id = $1", [event.id]);
    if (sold[0].n > 0) throw conflict("An event with sales cannot be switched between free and paid.", "free_switch_locked");
    if (b.isFree && paid[0].paid > 0) throw conflict("Remove or set to R0 the paid ticket types before making this a free event.", "free_event");
  }
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({ event });
  const { rows } = await db.query(
    `UPDATE events SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [event.id, ...keys.map((k) => b[k])]);
  await audit.record(null, { actor: req.user, action: "event.updated", entityType: "event", entityId: event.id, organiserId: event.organiser_id, details: { fields: keys } });
  res.json({ event: rows[0] });
}));

router.post("/:orgId/events/:eventId/submit", wrap(async (req, res) => {
  const { event, organiser } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  if (event.status !== "draft") throw conflict("Only drafts can be submitted.", "bad_transition");
  if (organiser.status !== "approved") throw conflict("Your organiser account is awaiting approval. You can submit events once it is approved.", "organiser_not_approved");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM ticket_types WHERE event_id = $1", [event.id]);
  if (!rows[0].n) throw conflict("Add at least one ticket type first.", "no_ticket_types");
  await db.query("UPDATE events SET status = 'pending_approval', updated_at = now() WHERE id = $1", [event.id]);
  await audit.record(null, { actor: req.user, action: "event.submitted", entityType: "event", entityId: event.id, organiserId: event.organiser_id });
  res.json({ status: "pending_approval" });
}));

router.post("/:orgId/events/:eventId/request-cancellation", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ["owner"]);
  const b = check(req.body, { reason: r.text({ max: 2000 }) });
  if (!["published", "pending_approval", "draft", "suspended"].includes(event.status)) throw conflict("This event cannot be cancelled.", "bad_transition");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM orders WHERE event_id = $1 AND status IN ('paid','partially_refunded','pending_payment')", [event.id]);
  if (!rows[0].n && event.status !== "published") {
    await db.query("UPDATE events SET status = 'cancelled', status_reason = $2, updated_at = now() WHERE id = $1", [event.id, b.reason]);
    await audit.record(null, { actor: req.user, action: "event.cancelled", entityType: "event", entityId: event.id, organiserId: event.organiser_id, details: { reason: b.reason } });
    return res.json({ status: "cancelled" });
  }
  await db.query("UPDATE events SET cancellation_requested_at = now(), cancellation_reason = $2 WHERE id = $1", [event.id, b.reason]);
  await audit.record(null, { actor: req.user, action: "event.cancellation_requested", entityType: "event", entityId: event.id, organiserId: event.organiser_id, details: { reason: b.reason } });
  res.json({ status: "cancellation_requested" });
}));

// ---- ticket types, promo codes, tracking links -------------------------------
const ttShape = (o = {}) => ({
  name: r.str({ min: 1, max: 80, ...o }), description: r.str({ optional: true, max: 240 }), priceCents: r.int({ min: 0, max: 10000000, ...o }),
  quantityTotal: r.int({ min: 0, max: 200000, ...o }), perOrderLimit: r.int({ min: 1, max: 50, optional: true }),
  salesStartAt: r.date({ optional: true }), salesEndAt: r.date({ optional: true }), status: r.oneOf(["on_sale", "paused", "hidden"], { optional: true }), sortOrder: r.int({ optional: true, min: 0, max: 1000 }),
});
const TT_COLS = { name: "name", description: "description", priceCents: "price_cents", quantityTotal: "quantity_total", perOrderLimit: "per_order_limit", salesStartAt: "sales_start_at", salesEndAt: "sales_end_at", status: "status", sortOrder: "sort_order" };

router.post("/:orgId/events/:eventId/ticket-types", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const b = check(req.body, ttShape());
  if (event.is_free && b.priceCents > 0) throw conflict("This is a free event, so every ticket type costs R0.", "free_event");
  if (b.priceCents > 0 && b.priceCents < 1000) throw bad("Paid tickets must cost at least R10.", { priceCents: "Minimum R10, or R0 for free." });
  const keys = Object.keys(b);
  const { rows } = await db.query(`INSERT INTO ticket_types (event_id, ${keys.map((k) => TT_COLS[k]).join(", ")}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING *`, [event.id, ...keys.map((k) => b[k])]);
  await audit.record(null, { actor: req.user, action: "ticket_type.created", entityType: "ticket_type", entityId: rows[0].id, organiserId: event.organiser_id, details: { price: b.priceCents, qty: b.quantityTotal } });
  res.status(201).json({ ticketType: rows[0] });
}));

router.patch("/:orgId/events/:eventId/ticket-types/:ttId", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const b = check(req.body, ttShape({ optional: true }));
  const { rows: cur } = await db.query("SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2", [req.params.ttId, event.id]);
  if (!cur[0]) throw notFound("Ticket type not found.");
  if (event.is_free && b.priceCents > 0) throw conflict("This is a free event, so every ticket type costs R0.", "free_event");
  if (b.priceCents > 0 && b.priceCents < 1000) throw bad("Paid tickets must cost at least R10.", { priceCents: "Minimum R10, or R0 for free." });
  if (b.priceCents !== undefined && b.priceCents !== cur[0].price_cents && cur[0].quantity_sold + cur[0].quantity_held > 0) throw conflict("Price cannot change after tickets of this type are sold. Create a new ticket type (e.g. a new release) instead.", "price_locked");
  if (b.quantityTotal !== undefined && b.quantityTotal < cur[0].quantity_sold + cur[0].quantity_held) throw conflict(`Quantity cannot go below ${cur[0].quantity_sold + cur[0].quantity_held} (sold + reserved).`, "quantity_below_sold");
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) return res.json({ ticketType: cur[0] });
  const { rows } = await db.query(`UPDATE ticket_types SET ${keys.map((k, i) => `${TT_COLS[k]} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING *`, [cur[0].id, ...keys.map((k) => b[k])]);
  await audit.record(null, { actor: req.user, action: "ticket_type.updated", entityType: "ticket_type", entityId: cur[0].id, organiserId: event.organiser_id, details: { fields: keys } });
  res.json({ ticketType: rows[0] });
}));

router.post("/:orgId/events/:eventId/promo-codes", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, MKT);
  const b = check(req.body, {
    code: r.str({ min: 3, max: 30, pattern: /^[A-Za-z0-9_-]+$/, message: "Letters, digits, - and _ only." }), kind: r.oneOf(["percent", "fixed"]),
    value: r.int({ min: 1, max: 10000000 }), maxUses: r.int({ optional: true, min: 1, max: 100000 }), validFrom: r.date({ optional: true }), validTo: r.date({ optional: true }),
  });
  if (b.kind === "percent" && b.value > 100) throw bad("A percentage cannot exceed 100.", { value: "Max 100." });
  const { rows } = await db.query(
    "INSERT INTO promo_codes (event_id, code, kind, value, max_uses, valid_from, valid_to) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [event.id, b.code.toUpperCase(), b.kind, b.value, b.maxUses || null, b.validFrom || null, b.validTo || null]);
  await audit.record(null, { actor: req.user, action: "promo.created", entityType: "promo_code", entityId: rows[0].id, organiserId: event.organiser_id, details: { code: rows[0].code, kind: b.kind, value: b.value } });
  res.status(201).json({ promoCode: rows[0] });
}));

router.patch("/:orgId/events/:eventId/promo-codes/:id", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, MKT);
  const b = check(req.body, { active: r.bool() });
  const { rows } = await db.query("UPDATE promo_codes SET active = $3 WHERE id = $1 AND event_id = $2 RETURNING *", [req.params.id, event.id, b.active]);
  if (!rows[0]) throw notFound("Promo code not found.");
  res.json({ promoCode: rows[0] });
}));

router.post("/:orgId/events/:eventId/tracking-links", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, MKT);
  const b = check(req.body, { label: r.str({ min: 2, max: 80 }), code: r.str({ optional: true, min: 2, max: 30, pattern: /^[A-Za-z0-9_-]+$/ }) });
  const code = (b.code || slugify(b.label).slice(0, 24) || randomCode(6)).toUpperCase();
  const { rows } = await db.query("INSERT INTO tracking_links (event_id, code, label) VALUES ($1,$2,$3) RETURNING *", [event.id, code, b.label]);
  res.status(201).json({ trackingLink: { ...rows[0], url: `${config.publicBaseUrl}/events/${event.slug}?ref=${code}` } });
}));

// ---- analytics, orders, attendees ---------------------------------------------
router.get("/:orgId/events/:eventId/analytics", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ALL);
  res.json(await analytics.eventAnalytics(event));
}));

router.get("/:orgId/events/:eventId/orders", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ["owner", "manager", "finance", "viewer"]);
  const q = String(req.query.q || "").slice(0, 80);
  const { rows } = await db.query(
    `SELECT o.id, o.reference, o.status, o.buyer_name, o.buyer_email, o.total_cents, o.refunded_cents, o.discount_cents, o.fee_cents, o.created_at, o.paid_at,
            (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id)::int AS tickets,
            (SELECT status FROM refunds r WHERE r.order_id = o.id ORDER BY created_at DESC LIMIT 1) AS refund_status
       FROM orders o WHERE o.event_id = $1 AND o.status <> 'expired'
        AND ($2 = '' OR o.reference ILIKE '%' || $2 || '%' OR o.buyer_email ILIKE '%' || $2 || '%' OR o.buyer_name ILIKE '%' || $2 || '%')
      ORDER BY o.created_at DESC LIMIT 200`, [event.id, q.replace(/[%_\\]/g, "")]);
  res.json({ orders: rows });
}));

router.get("/:orgId/events/:eventId/attendees", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ["owner", "manager", "viewer"]);
  const { rows } = await db.query(
    `SELECT t.code, t.status, t.holder_name, t.admitted_at, tt.name AS ticket_type, o.reference, o.buyer_email
       FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id
      WHERE t.event_id = $1 ORDER BY t.holder_name NULLS LAST, t.created_at LIMIT 5000`, [event.id]);
  if (req.query.format === "csv") {
    await audit.record(null, { actor: req.user, action: "attendees.exported", entityType: "event", entityId: event.id, organiserId: event.organiser_id, details: { rows: rows.length } });
    const esc = (v) => { const s = String(v ?? ""); return /^[=+\-@]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : `"${s.replace(/"/g, '""')}"`; };
    const csv = ["code,status,holder_name,ticket_type,order_reference,buyer_email,admitted_at", ...rows.map((x) => [x.code, x.status, x.holder_name, x.ticket_type, x.reference, x.buyer_email, x.admitted_at?.toISOString?.() || ""].map(esc).join(","))].join("\n");
    res.setHeader("Content-Disposition", `attachment; filename="attendees-${event.slug}.csv"`);
    return res.type("text/csv").send(csv);
  }
  res.json({ attendees: rows });
}));

router.post("/:orgId/events/:eventId/orders/:orderId/refund", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ["owner", "finance"]);
  const b = check(req.body, { reason: r.str({ min: 3, max: 400 }), ticketIds: r.array(r.uuid(), { optional: true, max: 50 }), includeFees: r.bool() });
  const { rows } = await db.query("SELECT id FROM orders WHERE id = $1 AND event_id = $2", [req.params.orderId, event.id]);
  if (!rows[0]) throw notFound("Order not found.");
  const rf = await refunds.requestOrderRefund(req.user, { orderId: rows[0].id, ...b });
  res.status(201).json({ refund: { reference: rf.reference, status: rf.status, amountCents: rf.amount_cents + rf.fee_refund_cents } });
}));

router.get("/:orgId/refunds", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ["owner", "manager", "finance"]);
  const { rows } = await db.query(
    `SELECT r.id, r.reference, r.kind, r.status, r.amount_cents, r.fee_refund_cents, r.reason, r.created_at, r.decided_at, e.title AS event_title,
            ru.full_name AS requested_by_name, (r.requested_by = $2) AS mine, v.name AS vendor_name
       FROM refunds r JOIN events e ON e.id = r.event_id LEFT JOIN users ru ON ru.id = r.requested_by
       LEFT JOIN pos_sales s ON s.id = r.pos_sale_id LEFT JOIN vendors v ON v.id = s.vendor_id
      WHERE e.organiser_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [req.params.orgId, req.user.id]);
  res.json({ refunds: rows });
}));

// Organisers may decide POS sale refunds for their own events (not ticket refunds).
router.post("/:orgId/refunds/:refundId/decide", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ["owner", "manager"]);
  const b = check(req.body, { approve: r.bool(), note: r.str({ optional: true, max: 400 }) });
  const { rows } = await db.query("SELECT r.id FROM refunds r JOIN events e ON e.id = r.event_id WHERE r.id = $1 AND e.organiser_id = $2 AND r.kind = 'pos_sale'", [req.params.refundId, req.params.orgId]);
  if (!rows[0]) throw notFound("Refund not found.");
  res.json({ refund: await refunds.decide(req.user, rows[0].id, b.approve, b.note) });
}));

// ---- event staff ---------------------------------------------------------------
router.get("/:orgId/events/:eventId/staff", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ALL);
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, s.can_scan, s.can_manage_tags, s.created_at,
            (SELECT count(*) FROM admission_log a WHERE a.scanned_by = u.id AND a.event_id = s.event_id AND a.outcome = 'admitted')::int AS admitted
       FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = $1 ORDER BY s.created_at`, [event.id]);
  res.json({ staff: rows });
}));

// Add a scanner / desk staff member. Someone without an account is created and
// emailed an invite to set their password (link valid 7 days).
router.post("/:orgId/events/:eventId/staff", limit("staffadd", 60, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const { event, organiser } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const b = check(req.body, { email: r.email(), fullName: r.str({ optional: true, min: 2, max: 120 }), canScan: r.bool({ fallback: true }), canManageTags: r.bool() });
  let { rows } = await db.query("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active'", [b.email]);
  let invited = false;
  if (!rows[0]) {
    const { hashSecret, randomToken, sha256 } = require("../lib/crypto");
    const token = randomToken(32);
    const name = b.fullName || b.email.split("@")[0];
    rows = await db.withTx(async (c) => {
      const u = await c.query("INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id", [b.email, name, hashSecret(randomToken(24))]);
      await c.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '7 days')", [sha256(token), u.rows[0].id]);
      await outbox.enqueue(c, { to: b.email, userId: u.rows[0].id, ...templates.staffInvite({ name, organiser: organiser.name, event: event.title, url: `${config.publicBaseUrl}/account#/reset/${token}` }) });
      await audit.record(c, { actor: req.user, action: "staff.invited", entityType: "user", entityId: u.rows[0].id, organiserId: event.organiser_id, details: { eventId: event.id } });
      return u.rows;
    });
    invited = true;
  }
  await db.query(
    `INSERT INTO event_staff (event_id, user_id, can_scan, can_manage_tags, added_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id, user_id) DO UPDATE SET can_scan = EXCLUDED.can_scan, can_manage_tags = EXCLUDED.can_manage_tags`,
    [event.id, rows[0].id, b.canScan, b.canManageTags, req.user.id]);
  await audit.record(null, { actor: req.user, action: "event.staff_set", entityType: "user", entityId: rows[0].id, organiserId: event.organiser_id, details: { eventId: event.id, canScan: b.canScan, canManageTags: b.canManageTags } });
  res.status(201).json({ ok: true, invited });
}));

// Live check-in view for the organiser (polled every few seconds).
router.get("/:orgId/events/:eventId/checkins/live", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ALL);
  const [tot, scanners, recent, rate] = await Promise.all([
    db.query("SELECT count(*) FILTER (WHERE status = 'used')::int AS admitted, count(*) FILTER (WHERE status IN ('valid','used'))::int AS issued FROM tickets WHERE event_id = $1", [event.id]),
    db.query(
      `SELECT u.full_name, count(*) FILTER (WHERE a.outcome = 'admitted')::int AS admitted, count(*) FILTER (WHERE a.outcome <> 'admitted')::int AS refused, max(a.occurred_at) AS last_scan
         FROM admission_log a JOIN users u ON u.id = a.scanned_by WHERE a.event_id = $1 GROUP BY u.id ORDER BY admitted DESC`, [event.id]),
    db.query(
      `SELECT a.outcome, a.occurred_at, a.gate, t.holder_name, u.full_name AS scanner
         FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id JOIN users u ON u.id = a.scanned_by WHERE a.event_id = $1 ORDER BY a.id DESC LIMIT 20`, [event.id]),
    db.query("SELECT count(*)::int AS n FROM admission_log WHERE event_id = $1 AND outcome = 'admitted' AND occurred_at > now() - interval '15 minutes'", [event.id]),
  ]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...tot.rows[0], last15min: rate.rows[0].n, scanners: scanners.rows, recent: recent.rows, at: new Date().toISOString() });
}));

router.delete("/:orgId/events/:eventId/staff/:userId", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  await db.query("DELETE FROM event_staff WHERE event_id = $1 AND user_id = $2", [event.id, req.params.userId]);
  await audit.record(null, { actor: req.user, action: "event.staff_removed", entityType: "user", entityId: req.params.userId, organiserId: event.organiser_id });
  res.json({ ok: true });
}));

// ---- vendors & terminals ---------------------------------------------------------
async function eventVendor(event, vendorId) {
  const { rows } = await db.query("SELECT * FROM vendors WHERE id = $1 AND event_id = $2", [vendorId, event.id]);
  if (!rows[0]) throw notFound("Vendor not found.");
  return rows[0];
}

router.get("/:orgId/events/:eventId/vendors", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, ALL);
  const { rows } = await db.query(
    `SELECT v.*, COALESCE((SELECT json_agg(json_build_object('id', t.id, 'label', t.label, 'status', t.status, 'lastSeenAt', t.last_seen_at)) FROM terminals t WHERE t.vendor_id = v.id), '[]') AS terminals,
            COALESCE((SELECT json_agg(json_build_object('userId', u.id, 'name', u.full_name, 'email', u.email, 'role', vm.role)) FROM vendor_members vm JOIN users u ON u.id = vm.user_id WHERE vm.vendor_id = v.id), '[]') AS members,
            (SELECT COALESCE(SUM(total_cents),0) FROM pos_sales s WHERE s.vendor_id = v.id AND s.status = 'confirmed')::bigint AS gross_cents
       FROM vendors v WHERE v.event_id = $1 ORDER BY v.created_at`, [event.id]);
  res.json({ vendors: rows });
}));

router.post("/:orgId/events/:eventId/vendors", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const b = check(req.body, { name: r.str({ min: 2, max: 100 }), description: r.str({ optional: true, max: 240 }), commissionBps: r.int({ min: 0, max: 5000, optional: true, fallback: 0 }) });
  const { rows } = await db.query("INSERT INTO vendors (event_id, organiser_id, name, description, commission_bps) VALUES ($1,$2,$3,$4,$5) RETURNING *", [event.id, event.organiser_id, b.name, b.description || null, b.commissionBps]);
  await audit.record(null, { actor: req.user, action: "vendor.created", entityType: "vendor", entityId: rows[0].id, organiserId: event.organiser_id });
  res.status(201).json({ vendor: rows[0] });
}));

router.patch("/:orgId/events/:eventId/vendors/:vendorId", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const v = await eventVendor(event, req.params.vendorId);
  const b = check(req.body, { status: r.oneOf(["active", "suspended"]) });
  await db.query("UPDATE vendors SET status = $2 WHERE id = $1", [v.id, b.status]);
  await audit.record(null, { actor: req.user, action: `vendor.${b.status}`, entityType: "vendor", entityId: v.id, organiserId: event.organiser_id });
  res.json({ ok: true });
}));

router.post("/:orgId/events/:eventId/vendors/:vendorId/members", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const v = await eventVendor(event, req.params.vendorId);
  const b = check(req.body, { email: r.email(), role: r.oneOf(["manager", "cashier"]) });
  const { rows } = await db.query("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active'", [b.email]);
  if (!rows[0]) throw notFound("No TicketRoom account uses that email. Ask them to sign up first.");
  await db.query("INSERT INTO vendor_members (vendor_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (vendor_id, user_id) DO UPDATE SET role = EXCLUDED.role", [v.id, rows[0].id, b.role]);
  await audit.record(null, { actor: req.user, action: "vendor.member_set", entityType: "user", entityId: rows[0].id, organiserId: event.organiser_id, details: { vendorId: v.id, role: b.role } });
  res.status(201).json({ ok: true });
}));

router.post("/:orgId/events/:eventId/vendors/:vendorId/terminals", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const v = await eventVendor(event, req.params.vendorId);
  const b = check(req.body, { label: r.str({ min: 1, max: 60 }) });
  res.status(201).json({ terminal: await pos.registerTerminal(req.user, v, b.label) });
}));

router.patch("/:orgId/events/:eventId/terminals/:terminalId", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, EDIT);
  const b = check(req.body, { status: r.oneOf(["active", "suspended", "retired"]) });
  const { rowCount } = await db.query("UPDATE terminals SET status = $3 WHERE id = $1 AND event_id = $2 AND status <> 'retired'", [req.params.terminalId, event.id, b.status]);
  if (!rowCount) throw notFound("Terminal not found.");
  await audit.record(null, { actor: req.user, action: `terminal.${b.status}`, entityType: "terminal", entityId: req.params.terminalId, organiserId: event.organiser_id });
  res.json({ ok: true });
}));

router.post("/:orgId/events/:eventId/vendors/:vendorId/payout", wrap(async (req, res) => {
  const { event } = await eventAccess(req.user, req.params.orgId, req.params.eventId, MONEY);
  const v = await eventVendor(event, req.params.vendorId);
  res.status(201).json({ payout: await settlements.requestVendorPayout(req.user, v) });
}));

// ---- finance -------------------------------------------------------------------
router.get("/:orgId/finance", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ["owner", "finance", "manager"]);
  const balances = await settlements.organiserBalances(req.params.orgId);
  const { rows: payouts } = await db.query(
    `SELECT p.reference, p.beneficiary_type, p.amount_cents, p.status, p.created_at, p.approved_at, p.paid_at, p.bank_reference, v.name AS vendor_name
       FROM payouts p LEFT JOIN vendors v ON v.id = p.vendor_id WHERE p.organiser_id = $1 ORDER BY p.created_at DESC LIMIT 100`, [req.params.orgId]);
  res.json({ ...balances, payouts });
}));

router.post("/:orgId/payouts", limit("payout", 10, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MONEY);
  const b = check(req.body, { amountCents: r.int({ min: 10000, max: 10000000000 }) });
  res.status(201).json({ payout: await settlements.requestPayout(req.user, req.params.orgId, b.amountCents) });
}));

// ---- marketing -------------------------------------------------------------------
router.get("/:orgId/marketing/audience", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MKT);
  const ids = String(req.query.eventIds || "").split(",").filter((x) => /^[0-9a-f-]{36}$/.test(x));
  res.json(await marketing.audienceSummary(req.params.orgId, ids));
}));

router.get("/:orgId/campaigns", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MKT);
  const { rows } = await db.query("SELECT * FROM campaigns WHERE organiser_id = $1 ORDER BY created_at DESC LIMIT 100", [req.params.orgId]);
  res.json({ campaigns: rows });
}));

const campaignShape = (o = {}) => ({
  channel: r.oneOf(["email", "sms"], o), name: r.str({ min: 2, max: 100, ...o }), subject: r.str({ optional: true, max: 150 }),
  body: r.text({ max: 5000, ...o }), eventIds: r.array(r.uuid(), { optional: true, max: 50 }),
});

async function validateCampaign(orgId, b) {
  if (b.channel === "email" && !b.subject) throw bad("Email campaigns need a subject.", { subject: "Required for email." });
  if (b.channel === "sms" && b.body && b.body.length > 300) throw bad("Keep SMS messages under 300 characters (the opt-out link is added for you).", { body: "Too long for SMS." });
  if (b.eventIds?.length) {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM events WHERE organiser_id = $1 AND id = ANY($2::uuid[])", [orgId, b.eventIds]);
    if (rows[0].n !== b.eventIds.length) throw bad("Audience includes events that are not yours.");
  }
}

router.post("/:orgId/campaigns", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MKT);
  const b = check(req.body, campaignShape());
  await validateCampaign(req.params.orgId, b);
  const { rows } = await db.query(
    "INSERT INTO campaigns (organiser_id, channel, name, subject, body, audience, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [req.params.orgId, b.channel, b.name, b.channel === "email" ? b.subject : null, b.body, { eventIds: b.eventIds || [] }, req.user.id]);
  res.status(201).json({ campaign: rows[0] });
}));

router.patch("/:orgId/campaigns/:id", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MKT);
  const camp = await marketing.getCampaign(req.params.orgId, req.params.id);
  if (camp.status !== "draft") throw conflict("Only drafts can be edited.", "bad_transition");
  const b = { channel: camp.channel, ...check(req.body, campaignShape({ optional: true })) };
  await validateCampaign(req.params.orgId, { ...b, subject: b.subject ?? camp.subject });
  const { rows } = await db.query(
    "UPDATE campaigns SET name = COALESCE($2, name), subject = COALESCE($3, subject), body = COALESCE($4, body), audience = COALESCE($5, audience), updated_at = now() WHERE id = $1 RETURNING *",
    [camp.id, b.name || null, b.subject || null, b.body || null, b.eventIds ? { eventIds: b.eventIds } : null]);
  res.json({ campaign: rows[0] });
}));

router.get("/:orgId/campaigns/:id/preview", wrap(async (req, res) => {
  const { organiser } = await organiserAccess(req.user, req.params.orgId, MKT);
  const camp = await marketing.getCampaign(req.params.orgId, req.params.id);
  const recipients = (await marketing.audience(req.params.orgId, camp.channel, camp.audience?.eventIds)).length;
  const sample = marketing.render(camp, organiser, { user_id: req.user.id, full_name: req.user.fullName });
  res.json({ preview: sample, recipients, segments: camp.channel === "sms" ? marketing.smsSegments(sample.body) : null, estimatedCostCents: marketing.estimate(camp, recipients) });
}));

router.post("/:orgId/campaigns/:id/test", limit("camptest", 10, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MKT);
  res.json(await marketing.sendTest(req.user, req.params.orgId, req.params.id));
}));

router.post("/:orgId/campaigns/:id/send", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, ["owner", "manager", "marketing"]);
  const b = check(req.body, { scheduledAt: r.date({ optional: true }) });
  if (b.scheduledAt && new Date(b.scheduledAt) > new Date(Date.now() + 60e3)) {
    const camp = await marketing.getCampaign(req.params.orgId, req.params.id);
    if (camp.status !== "draft") throw conflict("Only drafts can be scheduled.", "bad_transition");
    const { rows } = await db.query("UPDATE campaigns SET status = 'scheduled', scheduled_at = $2, updated_at = now() WHERE id = $1 RETURNING *", [camp.id, b.scheduledAt]);
    await audit.record(null, { actor: req.user, action: "campaign.scheduled", entityType: "campaign", entityId: camp.id, organiserId: req.params.orgId, details: { at: b.scheduledAt } });
    return res.json({ campaign: rows[0] });
  }
  res.json({ campaign: await marketing.send(req.user, req.params.orgId, req.params.id) });
}));

router.post("/:orgId/campaigns/:id/cancel", wrap(async (req, res) => {
  await organiserAccess(req.user, req.params.orgId, MKT);
  const { rows } = await db.query("UPDATE campaigns SET status = 'cancelled', updated_at = now() WHERE id = $1 AND organiser_id = $2 AND status IN ('draft','scheduled') RETURNING *", [req.params.id, req.params.orgId]);
  if (!rows[0]) throw conflict("Only drafts or scheduled campaigns can be cancelled.", "bad_transition");
  res.json({ campaign: rows[0] });
}));

module.exports = router;
