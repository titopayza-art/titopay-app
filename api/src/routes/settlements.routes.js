"use strict";

// Merchant-facing settlement: the statement of record for POS trading
// windows. Same authorisation shape as the webhook routes - the caller's
// merchant record is resolved first, and everything is scoped to it.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { AppError } = require("../lib/errors");
const { requireUuid } = require("../lib/validation");
const { getMerchantForUser } = require("../services/merchant-service");
const settlements = require("../services/settlement-service");

const router = express.Router();
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

async function requireActiveMerchant(req) {
  const merchant = await getMerchantForUser(req.auth.userId);
  if (!merchant) throw new AppError(403, "Settlements require a merchant profile");
  if (merchant.status !== "active") throw new AppError(403, "This merchant profile is not active");
  return merchant;
}

router.get("/", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  res.json({ ok: true, settlements: await settlements.listSettlements(merchant, { status: req.query.status, limit: req.query.limit }) });
}));

router.get("/config", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  res.json({ ok: true, config: await settlements.getSettlementConfig(merchant) });
}));

router.put("/config", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  res.json({ ok: true, config: await settlements.updateSettlementConfig(merchant, req.body || {}) });
}));

// Manual closeout: settle everything up to now (or an explicit upTo). The
// window tiles onto the previous one, so calling twice settles nothing twice.
router.post("/close", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const result = await settlements.closeSettlement(merchant.id, {
    upTo: req.body?.upTo || null,
    actorType: "customer",
    actorId: req.auth.userId,
    requestId: req.id || null
  });
  res.status(result.settled ? 201 : 200).json({ ok: true, ...result });
}));

router.get("/:id", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  res.json({ ok: true, settlement: await settlements.getSettlement(merchant, requireUuid(req.params.id, "Settlement ID")) });
}));

module.exports = router;
