"use strict";

// Merchant-facing webhook subscription management. Every route resolves the
// caller's merchant record first - a customer without a merchant profile, or
// an inactive merchant, gets a clean refusal rather than an empty list. The
// inbound POS provider webhook lives elsewhere (/v1/webhooks/pos-provider,
// mounted ahead of this router); everything here is subpathed clear of it.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { AppError } = require("../lib/errors");
const { requireUuid } = require("../lib/validation");
const { getMerchantForUser } = require("../services/merchant-service");
const webhooks = require("../services/webhook-service");

const router = express.Router();
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

async function requireActiveMerchant(req) {
  const merchant = await getMerchantForUser(req.auth.userId);
  if (!merchant) throw new AppError(403, "Webhook subscriptions require a merchant profile");
  if (merchant.status !== "active") throw new AppError(403, "This merchant profile is not active");
  return merchant;
}

const meta = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

router.get("/events", requireAuth, handle(async (_req, res) => {
  res.json({ ok: true, events: webhooks.EVENT_TYPES });
}));

router.post("/subscriptions", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const result = await webhooks.createSubscription(merchant, req.body || {}, req.auth, meta(req));
  res.status(201).json({ ok: true, ...result });
}));

router.get("/subscriptions", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  res.json({ ok: true, subscriptions: await webhooks.listSubscriptions(merchant) });
}));

router.put("/subscriptions/:id", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const subscription = await webhooks.updateSubscription(
    merchant, requireUuid(req.params.id, "Subscription ID"), req.body || {}, req.auth, meta(req));
  res.json({ ok: true, subscription });
}));

router.delete("/subscriptions/:id", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  res.json({ ok: true, ...(await webhooks.deleteSubscription(
    merchant, requireUuid(req.params.id, "Subscription ID"), req.auth, meta(req))) });
}));

router.post("/subscriptions/:id/rotate-secret", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const result = await webhooks.rotateSecret(
    merchant, requireUuid(req.params.id, "Subscription ID"), req.auth, meta(req));
  res.json({ ok: true, ...result });
}));

router.get("/subscriptions/:id/deliveries", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const deliveries = await webhooks.listDeliveries(
    merchant, requireUuid(req.params.id, "Subscription ID"),
    { status: req.query.status, limit: req.query.limit });
  res.json({ ok: true, deliveries });
}));

router.post("/subscriptions/:id/deliveries/:deliveryId/replay", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const replayed = await webhooks.replayDelivery(
    merchant, requireUuid(req.params.id, "Subscription ID"),
    requireUuid(req.params.deliveryId, "Delivery ID"), req.auth, meta(req));
  res.status(202).json({ ok: true, delivery: replayed });
}));

router.post("/subscriptions/:id/test", requireAuth, handle(async (req, res) => {
  const merchant = await requireActiveMerchant(req);
  const result = await webhooks.sendTestEvent(merchant, requireUuid(req.params.id, "Subscription ID"));
  res.json({ ok: true, ...result });
}));

module.exports = router;
