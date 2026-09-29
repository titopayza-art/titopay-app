"use strict";

// Sandbox provisioning and simulation. Mounted on every deployment but every
// request is refused unless this process IS the sandbox (TITOPAY_ENV=sandbox)
// - the guard is per-request and pinned by a test, so a production deployment
// cannot serve these paths whatever its mount order. All routes authenticate
// with a partner API key.

const express = require("express");
const partners = require("../services/partner-service");
const sandbox = require("../services/sandbox-service");

const router = express.Router();
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};
const meta = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

router.use((_req, _res, next) => {
  try {
    sandbox.assertSandbox();
    next();
  } catch (error) {
    next(error);
  }
});
router.use(partners.requirePartnerKey);

router.post("/merchants", handle(async (req, res) => {
  res.status(201).json({ ok: true, ...(await sandbox.createSandboxMerchant(req.partner, req.body || {}, meta(req))) });
}));

router.post("/terminals", handle(async (req, res) => {
  res.status(201).json({ ok: true, ...(await sandbox.createSandboxTerminal(req.partner, req.body || {}, meta(req))) });
}));

router.post("/payments/:paymentId/simulate", handle(async (req, res) => {
  res.json({ ok: true, ...(await sandbox.simulatePayment(req.partner, String(req.params.paymentId || "").trim(), req.body || {}, meta(req))) });
}));

router.post("/webhooks/generate", handle(async (req, res) => {
  res.json({ ok: true, ...(await sandbox.generateWebhookEvent(req.partner, req.body || {}, meta(req))) });
}));

router.post("/reset", handle(async (req, res) => {
  res.json({ ok: true, ...(await sandbox.resetSandbox(req.partner)) });
}));

module.exports = router;
