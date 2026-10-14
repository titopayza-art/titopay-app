// Event staff: gate scanning and the tag registration desk.
const express = require("express");
const db = require("../lib/db");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { wrap, requireAuth } = require("../middleware/http");
const { eventStaffAccess, isStaffRole } = require("../middleware/access");
const tickets = require("../modules/tickets/service");
const tags = require("../modules/tags/service");
const passes = require("../modules/tickets/passes");
const audit = require("../lib/audit");
const { gateLabel } = require("../modules/tickets/kinds");

const router = express.Router();
router.use(requireAuth);

router.get("/events", wrap(async (req, res) => {
  const all = isStaffRole(req.user, "admin", "support");
  const { rows } = await db.query(
    `SELECT DISTINCT e.id, e.title, e.venue_name, e.city, e.starts_at, e.ends_at, e.status, e.cashless_enabled,
            COALESCE(s.can_scan, m.role IN ('owner','manager'), $2) AS can_scan,
            COALESCE(s.can_manage_tags, m.role IN ('owner','manager'), $2) AS can_manage_tags
       FROM events e
       LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = $1
       LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = $1 AND m.role IN ('owner','manager')
      WHERE e.status = 'published' AND e.ends_at > now() - interval '1 day'
        AND ($2 OR s.user_id IS NOT NULL OR m.user_id IS NOT NULL)
      ORDER BY e.starts_at`, [req.user.id, all]);
  res.json({ events: rows });
}));

router.post("/scan", limit("scan", 240, 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, {
    eventId: r.uuid(), payload: r.str({ optional: true, max: 120 }), tagInput: r.str({ optional: true, max: 120 }), gate: r.str({ optional: true, max: 40 }),
  });
  if (!b.payload && !b.tagInput) throw require("../lib/errors").bad("Scan a ticket or tag.");
  await eventStaffAccess(req.user, b.eventId, "can_scan");
  res.json(await tickets.admit(req.user, b));
}));

router.get("/events/:eventId/stats", wrap(async (req, res) => {
  await eventStaffAccess(req.user, req.params.eventId, "can_scan");
  // People, not tickets: a couple ticket lets two in.
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(tt.admits) FILTER (WHERE t.status = 'used'),0)::int AS admitted, COALESCE(SUM(tt.admits) FILTER (WHERE t.status IN ('valid','used')),0)::int AS issued
       FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.event_id = $1`, [req.params.eventId]);
  const { rows: mine } = await db.query("SELECT count(*)::int AS n FROM admission_log WHERE event_id = $1 AND scanned_by = $2 AND outcome = 'admitted'", [req.params.eventId, req.user.id]);
  const { rows: recent } = await db.query(
    `SELECT a.outcome, a.occurred_at, a.gate, COALESCE(t.holder_name, g.holder_name) AS holder_name
       FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id LEFT JOIN gate_passes g ON g.id = a.pass_id
      WHERE a.event_id = $1 AND a.scanned_by = $2 ORDER BY a.id DESC LIMIT 15`, [req.params.eventId, req.user.id]);
  res.json({ ...rows[0], mine: mine[0].n, recent });
}));

// Offline scanning. Before the gates open, each scanner phone downloads the
// event's ticket list (code, QR version, status 1 valid / 2 used / 0 void,
// holder first name, type) so it can keep checking tickets if the venue's
// mobile data fails. With ?since= it only returns what changed.
router.get("/events/:eventId/offline-pack", limit("offlinepack", 60, 3600e3, (q) => q.user.id), wrap(async (req, res) => {
  const ev = await eventStaffAccess(req.user, req.params.eventId, "can_scan");
  const sinceDate = req.query.since ? new Date(String(req.query.since)) : null;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate.toISOString() : null;
  const { rows: types } = await db.query("SELECT id, name, kind, admits FROM ticket_types WHERE event_id = $1", [ev.id]);
  const label = Object.fromEntries(types.map((t) => [t.id, gateLabel(t)]));
  const generatedAt = new Date().toISOString();
  const { rows: tks } = await db.query(
    `SELECT code, qr_version, status, holder_name, ticket_type_id FROM tickets WHERE event_id = $1 ${since ? "AND updated_at >= $2" : ""}`, since ? [ev.id, since] : [ev.id]);
  // "Lerato Mokoena" travels as "Lerato M.".
  const short = (name) => { const [f, ...rest] = String(name || "").trim().split(/\s+/); return f ? (rest.length ? `${f} ${rest.join(" ").slice(0, 1)}.` : f) : ""; };
  const list = tks.map((t) => [t.code, t.qr_version, t.status === "valid" ? 1 : t.status === "used" ? 2 : 0, short(t.holder_name), label[t.ticket_type_id] || ""]);
  // Gate passes ride along; the sixth field marks a re-entry pass.
  const { rows: gps } = await db.query(
    `SELECT code, qr_version, status, holder_name, role, access_note, reentry, scans FROM gate_passes WHERE event_id = $1 ${since ? "AND updated_at >= $2" : ""}`, since ? [ev.id, since] : [ev.id]);
  for (const g of gps) list.push([g.code, g.qr_version, g.status !== "active" ? 0 : !g.reentry && g.scans > 0 ? 2 : 1, short(g.holder_name), passes.passLabel(g), g.reentry ? 1 : 0]);
  await audit.record(null, { actor: req.user, action: "scan.offline_pack", entityType: "event", entityId: ev.id, organiserId: ev.organiser_id, details: { tickets: list.length, incremental: !!since } });
  res.json({ event: { id: ev.id, title: ev.title, starts_at: ev.starts_at, ends_at: ev.ends_at }, generatedAt, full: !since, tickets: list });
}));

// --- tag desk
router.post("/tags/link", limit("desk", 120, 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { eventId: r.uuid(), tagInput: r.str({ max: 120 }), ticketPayload: r.str({ max: 120 }) });
  await eventStaffAccess(req.user, b.eventId, "can_manage_tags");
  res.status(201).json(await tags.linkByStaff(req.user, b));
}));

router.post("/tags/lookup", limit("desk", 120, 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { eventId: r.uuid(), tagInput: r.str({ max: 120 }) });
  await eventStaffAccess(req.user, b.eventId, "can_manage_tags");
  const tag = await tags.resolve(db, b.tagInput);
  if (!tag || (tag.event_id && tag.event_id !== b.eventId)) return res.json({ found: false });
  const { rows } = tag.user_id ? await db.query("SELECT full_name FROM users WHERE id = $1", [tag.user_id]) : { rows: [] };
  res.json({ found: true, tag: { id: tag.id, status: tag.status, type: tag.tag_type, displayCode: tags.formatDisplay(tag.display_code), holder: rows[0]?.full_name || null, securityLevel: tag.security_level } });
}));

router.post("/tags/replace", wrap(async (req, res) => {
  const b = check(req.body, { eventId: r.uuid(), oldTagId: r.uuid(), newTagInput: r.str({ max: 120 }) });
  await eventStaffAccess(req.user, b.eventId, "can_manage_tags");
  res.json(await tags.replace(req.user, b));
}));

router.post("/tags/:tagId/block", wrap(async (req, res) => {
  const b = check(req.body, { eventId: r.uuid(), reason: r.str({ min: 3, max: 200 }) });
  await eventStaffAccess(req.user, b.eventId, "can_manage_tags");
  const { rows } = await db.query("SELECT id FROM tags WHERE id = $1 AND event_id = $2", [req.params.tagId, b.eventId]);
  if (!rows[0]) throw require("../lib/errors").notFound("Tag not found.");
  await tags.setStatus(req.user, rows[0].id, "blocked", b.reason);
  res.json({ ok: true });
}));

module.exports = router;
