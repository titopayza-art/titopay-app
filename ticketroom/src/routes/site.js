// Public site information, callback requests, the assistant, and
// unsubscribe-by-email. Mounted at /api/site.
const express = require("express");
const config = require("../config");
const db = require("../lib/db");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { reference, signLink, randomToken } = require("../lib/crypto");
const { wrap } = require("../middleware/http");
const settings = require("../modules/site/settings");
const assistant = require("../modules/site/assistant");
const outbox = require("../modules/messaging/outbox");
const templates = require("../modules/messaging/templates");

const router = express.Router();

// Everything the public pages need about the site, in one call.
router.get("/", wrap(async (_req, res) => {
  const s = await settings.all();
  const { rows: posters } = await db.query(
    `SELECT id, title, subtitle, image_upload_id, link_url, placement FROM ad_posters
      WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
      ORDER BY sort_order, created_at DESC LIMIT 12`);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    banner: s.banner.enabled ? { text: s.banner.text, linkText: s.banner.linkText, linkUrl: s.banner.linkUrl } : null,
    maintenance: s.maintenance.enabled ? { message: s.maintenance.message } : null,
    hours: { ...settings.hoursStatus(s.hours), week: s.hours.week, note: s.hours.note, upcomingHolidays: s.hours.holidays.filter((h) => h.date >= new Date().toISOString().slice(0, 10)).slice(0, 5) },
    support: s.support,
    legal: s.legal,
    chatbot: { enabled: s.chatbot.enabled, greeting: s.chatbot.greeting },
    posters,
    cardPaymentsEnabled: config.payments.provider !== "none",
  });
}));

const CATEGORIES = ["tickets", "refund", "tag", "payment", "account", "organiser", "advertising", "callback", "other"];

// Callback request: becomes a support case, notifies hello@, confirms to the customer.
router.post("/callback", limit("callback", 5, 3600e3), wrap(async (req, res) => {
  const b = check(req.body, {
    fullName: r.str({ min: 2, max: 120 }), phone: r.contactPhone(), email: r.email(),
    topic: r.oneOf(CATEGORIES, { optional: true, fallback: "callback" }), message: r.text({ max: 2000 }),
    preferredTime: r.str({ optional: true, max: 60 }), source: r.oneOf(["web", "chat"], { optional: true, fallback: "web" }),
  });
  const s = await settings.all();
  const ref = reference("CB");
  await db.withTx(async (c) => {
    await c.query(
      `INSERT INTO support_cases (reference, user_id, email, category, subject, body, full_name, phone, preferred_time, source, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '48 hours')`,
      [ref, req.user?.id || null, b.email, b.topic, `Callback request: ${b.topic}`, b.message, b.fullName, b.phone, b.preferredTime || null, b.source]);
    await outbox.enqueue(c, {
      to: s.support.email, subject: `[TicketRoom] Callback ${ref} — ${b.topic}`,
      body: `New callback request ${ref}\n\nName: ${b.fullName}\nPhone: ${b.phone}\nEmail: ${b.email}\nTopic: ${b.topic}\nPreferred time: ${b.preferredTime || "any"}\nVia: ${b.source}\n\n${b.message}\n\nRespond within ${s.support.responseTime}. Manage it in Back office → Support.`,
    });
    await outbox.enqueue(c, { to: b.email, userId: req.user?.id, ...templates.callbackReceived({ name: b.fullName, reference: ref, responseTime: s.support.responseTime, email: s.support.email, hoursNote: s.hours.note }) });
  });
  res.status(201).json({ reference: ref, responseTime: s.support.responseTime });
}));

router.post("/chat", limit("chat", 20, 60e3), limit("chatday", 200, 24 * 3600e3), wrap(async (req, res) => {
  const s = await settings.get("chatbot");
  if (!s.enabled) return res.status(503).json({ error: { code: "assistant_off", message: "The assistant is offline. Please request a callback or email us." } });
  const b = check(req.body, {
    message: r.str({ min: 1, max: 500 }), conversation: r.str({ optional: true, max: 40, pattern: /^[A-Za-z0-9_-]+$/ }),
    history: r.array(r.object({ role: r.oneOf(["user", "assistant"]), text: r.str({ max: 2000 }) }), { optional: true, max: 12 }),
  });
  res.json(await assistant.reply({ question: b.message, history: b.history || [], conversation: b.conversation || randomToken(9) }));
}));

router.post("/chat/:id/feedback", limit("chatfb", 30, 60e3), wrap(async (req, res) => {
  const b = check(req.body, { helpful: r.bool() });
  await assistant.feedback(Number(req.params.id) || 0, b.helpful);
  res.json({ ok: true });
}));

router.post("/posters/:id/click", limit("adclick", 60, 60e3), wrap(async (req, res) => {
  if (/^[0-9a-f-]{36}$/.test(req.params.id)) await db.query("UPDATE ad_posters SET clicks = clicks + 1 WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

// Unsubscribe from all marketing by email: always answers the same way, and
// only sends a signed one-click link to the address itself.
router.post("/unsubscribe-request", limit("unsubreq", 5, 3600e3), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email() });
  const { rows } = await db.query("SELECT id, full_name FROM users WHERE lower(email) = $1 AND status = 'active'", [b.email]);
  if (rows[0]) {
    const url = `${config.publicBaseUrl}/unsubscribe?t=${signLink({ u: rows[0].id, all: true }, 7 * 86400)}`;
    await db.withTx((c) => outbox.enqueue(c, { to: b.email, userId: rows[0].id, ...templates.unsubscribeLink({ name: rows[0].full_name, url }) }));
  }
  res.json({ ok: true, message: "If that email has a TicketRoom account, we've sent a link to unsubscribe from all marketing." });
}));

module.exports = router;
