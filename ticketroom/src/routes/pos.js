// Vendor POS API. Sale endpoints require BOTH a cashier session and the
// terminal key header. The client is never trusted for prices or outcomes.
const express = require("express");
const db = require("../lib/db");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { wrap, requireAuth } = require("../middleware/http");
const { vendorAccess } = require("../middleware/access");
const { conflict, notFound } = require("../lib/errors");
const pos = require("../modules/pos/service");
const refunds = require("../modules/finance/refunds");

const router = express.Router();
router.use(requireAuth);

const terminal = (req) => pos.terminalContext(req.user, req.headers["x-terminal-key"]);

router.get("/vendors", wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT v.id, v.name, v.status, vm.role, e.id AS event_id, e.title AS event_title, e.starts_at, e.cashless_enabled
       FROM vendor_members vm JOIN vendors v ON v.id = vm.vendor_id JOIN events e ON e.id = v.event_id
      WHERE vm.user_id = $1 ORDER BY e.starts_at DESC`, [req.user.id]);
  res.json({ vendors: rows });
}));

router.get("/context", wrap(async (req, res) => {
  const t = await terminal(req);
  const { rows } = await db.query("SELECT id, name, price_cents FROM products WHERE vendor_id = $1 AND active ORDER BY sort_order, name", [t.vendor_id]);
  res.json({
    terminal: { id: t.id, label: t.label }, vendor: { id: t.vendor_id, name: t.vendor_name, role: t.member_role || "organiser" },
    event: { id: t.event_id, title: t.event_title, cashlessOpen: t.cashless_enabled && t.event_status === "published" },
    products: rows, serverTime: new Date().toISOString(), limits: { pinThresholdCents: require("../config").cashless.pinThresholdCents },
  });
}));

router.post("/sales", limit("possale", 120, 60e3, (q) => q.headers["x-terminal-key"] || q.user.id), wrap(async (req, res) => {
  const t = await terminal(req);
  const b = check(req.body, {
    items: r.array(r.object({ productId: r.uuid(), quantity: r.int({ min: 1, max: 99 }) }), { min: 1, max: 30 }),
    tagInput: r.str({ max: 120 }), pin: r.str({ optional: true, max: 6, pattern: /^\d{4,6}$/ }), idempotencyKey: r.idemKey(),
  });
  try {
    res.json(await pos.charge(req.user, t, b));
  } catch (err) {
    // A concurrent duplicate of the same request lost the race: return the winner.
    if (err.code === "23505") return res.json({ ...(await pos.saleByKey(t, b.idempotencyKey)), replay: true });
    throw err;
  }
}));

// Resolves an uncertain outcome (timeout, dropped connection) without charging again.
router.get("/sales/by-key/:key", wrap(async (req, res) => {
  const t = await terminal(req);
  res.json(await pos.saleByKey(t, String(req.params.key).slice(0, 80)));
}));

router.get("/sales", wrap(async (req, res) => {
  const t = await terminal(req);
  res.json({ sales: await pos.vendorSales(t.vendor_id, 100) });
}));

router.get("/summary", wrap(async (req, res) => {
  const t = await terminal(req);
  res.json(await pos.vendorSummary(t.vendor_id));
}));

router.post("/sales/:saleId/refund", wrap(async (req, res) => {
  const t = await terminal(req);
  const b = check(req.body, { reason: r.str({ min: 3, max: 300 }) });
  const { rows } = await db.query("SELECT id FROM pos_sales WHERE id = $1 AND vendor_id = $2", [req.params.saleId, t.vendor_id]);
  if (!rows[0]) throw notFound("Sale not found.");
  const rf = await refunds.requestPosRefund(req.user, rows[0].id, b.reason);
  res.status(201).json({ refund: { reference: rf.reference, status: rf.status } });
}));

// --- product catalogue (vendor managers and organiser managers)
router.get("/vendors/:vendorId/products", wrap(async (req, res) => {
  await vendorAccess(req.user, req.params.vendorId, ["manager", "cashier"]);
  const { rows } = await db.query("SELECT * FROM products WHERE vendor_id = $1 ORDER BY sort_order, name", [req.params.vendorId]);
  res.json({ products: rows });
}));

router.post("/vendors/:vendorId/products", wrap(async (req, res) => {
  await vendorAccess(req.user, req.params.vendorId, ["manager"]);
  const b = check(req.body, { name: r.str({ min: 1, max: 60 }), priceCents: r.int({ min: 100, max: 1000000 }), sortOrder: r.int({ optional: true, min: 0, max: 1000, fallback: 0 }) });
  const { rows } = await db.query("INSERT INTO products (vendor_id, name, price_cents, sort_order) VALUES ($1,$2,$3,$4) RETURNING *", [req.params.vendorId, b.name, b.priceCents, b.sortOrder]);
  res.status(201).json({ product: rows[0] });
}));

router.patch("/vendors/:vendorId/products/:productId", wrap(async (req, res) => {
  await vendorAccess(req.user, req.params.vendorId, ["manager"]);
  const b = check(req.body, { name: r.str({ optional: true, min: 1, max: 60 }), priceCents: r.int({ optional: true, min: 100, max: 1000000 }), active: r.bool({ optional: true, fallback: undefined }) });
  const { rows } = await db.query(
    "UPDATE products SET name = COALESCE($3, name), price_cents = COALESCE($4, price_cents), active = COALESCE($5, active) WHERE id = $1 AND vendor_id = $2 RETURNING *",
    [req.params.productId, req.params.vendorId, b.name ?? null, b.priceCents ?? null, b.active ?? null]);
  if (!rows[0]) throw notFound("Product not found.");
  res.json({ product: rows[0] });
}));

router.post("/vendors/:vendorId/terminals", wrap(async (req, res) => {
  const { vendor } = await vendorAccess(req.user, req.params.vendorId, ["manager"]);
  if (vendor.status !== "active") throw conflict("This vendor is suspended.", "vendor_suspended");
  const b = check(req.body, { label: r.str({ min: 1, max: 60 }) });
  res.status(201).json({ terminal: await pos.registerTerminal(req.user, vendor, b.label) });
}));

module.exports = router;
