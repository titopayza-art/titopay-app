// Event staff: gate scanning and the tag registration desk.
const express = require("express");
const db = require("../lib/db");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { wrap, requireAuth } = require("../middleware/http");
const { eventStaffAccess, isStaffRole } = require("../middleware/access");
const tickets = require("../modules/tickets/service");
const tags = require("../modules/tags/service");

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
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'used')::int AS admitted, COUNT(*) FILTER (WHERE status IN ('valid','used'))::int AS issued FROM tickets WHERE event_id = $1`, [req.params.eventId]);
  const { rows: mine } = await db.query("SELECT count(*)::int AS n FROM admission_log WHERE event_id = $1 AND scanned_by = $2 AND outcome = 'admitted'", [req.params.eventId, req.user.id]);
  const { rows: recent } = await db.query(
    `SELECT a.outcome, a.occurred_at, a.gate, t.holder_name FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id
      WHERE a.event_id = $1 AND a.scanned_by = $2 ORDER BY a.id DESC LIMIT 15`, [req.params.eventId, req.user.id]);
  res.json({ ...rows[0], mine: mine[0].n, recent });
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
