// Attendee portal API: tickets, transfers, tags, cashless wallets, refunds.
const express = require("express");
const db = require("../lib/db");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { wrap, requireAuth } = require("../middleware/http");
const tickets = require("../modules/tickets/service");
const qr = require("../modules/tickets/qr");
const tags = require("../modules/tags/service");
const cashless = require("../modules/cashless/service");
const refunds = require("../modules/finance/refunds");

const router = express.Router();
router.use(requireAuth);

router.get("/tickets", wrap(async (req, res) => {
  const list = await tickets.listForUser(req.user.id);
  res.json({ tickets: list.map((t) => ({ ...t, qrPayload: t.status === "valid" ? qr.payloadFor(t) : null, qr_version: undefined })) });
}));

router.get("/tickets/:id/qr.svg", wrap(async (req, res) => {
  const t = await tickets.ownedTicket(req.user.id, req.params.id);
  res.setHeader("Cache-Control", "no-store");
  res.type("image/svg+xml").send(await tickets.qrSvg(t));
}));

router.patch("/tickets/:id", wrap(async (req, res) => {
  const b = check(req.body, { holderName: r.str({ min: 2, max: 120 }) });
  const t = await tickets.ownedTicket(req.user.id, req.params.id);
  if (t.status !== "valid") throw require("../lib/errors").conflict("Only valid tickets can be renamed.");
  await db.query("UPDATE tickets SET holder_name = $2, updated_at = now() WHERE id = $1", [t.id, b.holderName]);
  res.json({ ok: true });
}));

router.post("/tickets/:id/transfer", limit("transfer", 20, 60 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { toEmail: r.email() });
  res.status(201).json({ transfer: await tickets.startTransfer(req.user, req.params.id, b.toEmail) });
}));

router.get("/transfers", wrap(async (req, res) => {
  const { rows: outgoing } = await db.query(
    `SELECT tr.id, tr.to_email, tr.status, tr.created_at, tr.expires_at, tr.completed_at, e.title FROM ticket_transfers tr
       JOIN tickets t ON t.id = tr.ticket_id JOIN events e ON e.id = t.event_id WHERE tr.from_user_id = $1 ORDER BY tr.created_at DESC LIMIT 50`, [req.user.id]);
  // Incoming offers are shown in-app only once the recipient's email is verified.
  const { rows: incoming } = req.user.emailVerified ? await db.query(
    `SELECT tr.id, tr.status, tr.created_at, tr.expires_at, e.title, u.full_name AS from_name FROM ticket_transfers tr
       JOIN tickets t ON t.id = tr.ticket_id JOIN events e ON e.id = t.event_id JOIN users u ON u.id = tr.from_user_id
      WHERE lower(tr.to_email) = lower($1) AND tr.status = 'pending' AND tr.expires_at > now()`, [req.user.email]) : { rows: [] };
  res.json({ outgoing, incoming, emailVerified: req.user.emailVerified });
}));

router.post("/transfers/:id/cancel", wrap(async (req, res) => { await tickets.cancelTransfer(req.user, req.params.id); res.json({ ok: true }); }));

router.post("/transfers/claim", limit("claim", 20, 60 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { token: r.str({ optional: true, max: 100 }), transferId: r.uuid({ optional: true }) });
  if (b.transferId) {
    await db.query("UPDATE ticket_transfers SET to_user_id = $2 WHERE id = $1 AND lower(to_email) = lower($3) AND status = 'pending'", [b.transferId, req.user.id, req.user.email]);
  }
  res.json(await tickets.claimTransfer(req.user, b));
}));

router.get("/orders", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.reference, o.status, o.total_cents, o.refunded_cents, o.created_at, o.paid_at, e.title, e.slug, e.starts_at
       FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]);
  res.json({ orders: rows });
}));

// --- payment methods: TitoPay wallet linkage
const wallets = require("../modules/wallets/service");
router.get("/payment-methods", wrap(async (req, res) => {
  const config = require("../config");
  res.json({ links: await wallets.list(req.user.id), titopayAvailable: config.integrations.titopay.enabled, titopayEnvironment: config.integrations.titopay.env });
}));

router.post("/payment-methods/titopay/link", limit("walletlink", 5, 15 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { phone: r.phone() });
  res.status(201).json(await wallets.startLink(req.user, b.phone));
}));

router.post("/payment-methods/titopay/confirm", limit("walletotp", 10, 15 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { linkRequestId: r.uuid(), otp: r.str({ min: 4, max: 8, pattern: /^\d+$/, message: "Enter the code from TitoPay." }) });
  res.status(201).json({ link: await wallets.confirmLink(req.user, b.linkRequestId, b.otp) });
}));

router.delete("/payment-methods/:id", wrap(async (req, res) => res.json(await wallets.unlink(req.user, req.params.id))));

// --- tags
router.get("/tags", wrap(async (req, res) => res.json({ tags: await tags.listForUser(req.user.id) })));

router.post("/tags/link", limit("taglink", 10, 15 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, {
    displayCode: r.str({ min: 8, max: 12, pattern: /^[A-Za-z0-9 -]+$/ }), activationCode: r.str({ min: 6, max: 6, pattern: /^[A-Za-z0-9]+$/ }), eventId: r.uuid(),
  });
  res.status(201).json(await tags.linkByAttendee(req.user, b));
}));

router.post("/tags/:id/lost", wrap(async (req, res) => { await tags.reportLost(req.user, req.params.id); res.json({ ok: true }); }));

// --- cashless wallets
router.get("/wallets", wrap(async (req, res) => res.json({ wallets: await cashless.walletsFor(req.user.id) })));

router.get("/wallets/:eventId", wrap(async (req, res) => {
  const ev = await cashless.cashlessEvent(db, req.params.eventId);
  res.json({
    event: { id: ev.id, title: ev.title, startsAt: ev.starts_at, endsAt: ev.ends_at, status: ev.status },
    balanceCents: await cashless.balance(db, req.user.id, ev.id),
    history: await cashless.history(req.user.id, ev.id),
    limits: require("../config").cashless,
  });
}));

router.post("/wallets/:eventId/topups", limit("topup", 10, 15 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { amountCents: r.int({ min: 1, max: 100000000 }), idempotencyKey: r.idemKey(), paymentMethod: r.oneOf(["card", "titopay_wallet"], { optional: true, fallback: "card" }) });
  const out = await cashless.startTopup(req.user, req.params.eventId, b.amountCents, b.idempotencyKey, b.paymentMethod);
  res.status(out.replay ? 200 : 201).json({ topup: { reference: out.topup.reference, status: out.topup.status }, payment: { status: out.payment?.status, method: out.payment?.method, redirectUrl: out.payment?.redirectUrl || null, awaitingApproval: !!out.payment?.awaitingApproval } });
}));

router.post("/wallets/:eventId/refund", wrap(async (req, res) => {
  await cashless.cashlessEvent(db, req.params.eventId);
  const rf = await refunds.requestWalletRefund(req.user, req.params.eventId);
  res.status(201).json({ refund: { reference: rf.reference, status: rf.status, amountCents: rf.amount_cents } });
}));

router.get("/refunds", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.reference, r.kind, r.amount_cents + r.fee_refund_cents AS amount_cents, r.status, r.reason, r.created_at, e.title
       FROM refunds r JOIN events e ON e.id = r.event_id WHERE r.user_id = $1 ORDER BY r.created_at DESC`, [req.user.id]);
  res.json({ refunds: rows });
}));

router.get("/support", wrap(async (req, res) => {
  const { rows } = await db.query("SELECT reference, category, subject, status, resolution, created_at, updated_at FROM support_cases WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json({ cases: rows });
}));

router.get("/likes", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT ${require("./public").PUBLIC_EVENT} FROM event_likes l JOIN events e ON e.id = l.event_id JOIN organisers o ON o.id = e.organiser_id
      WHERE l.user_id = $1 AND e.status IN ('published','completed') ORDER BY (e.ends_at < now()), e.starts_at LIMIT 200`, [req.user.id]);
  res.json({ events: rows });
}));

module.exports = router;
