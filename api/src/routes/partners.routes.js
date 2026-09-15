"use strict";

// Partner-facing credential and dashboard APIs. Registration is public (rate
// limited); everything else authenticates with a partner API key
// (X-TitoPay-Api-Key or Authorization: Bearer tpk_...). Merchant-scoped
// resources (webhook subscriptions, POS payments) keep their own principals -
// a partner key never impersonates a merchant or a terminal.

const express = require("express");
const { registrationLimiter } = require("../middleware/rate-limits");
const { requireUuid } = require("../lib/validation");
const partners = require("../services/partner-service");

const router = express.Router();
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};
const meta = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

// Self-service onboarding: company details in, partner record + first sandbox
// key out. Status starts 'pending' - the sandbox works immediately;
// production keys wait for an admin's approval.
router.post("/register", registrationLimiter, handle(async (req, res) => {
  const result = await partners.registerPartner(req.body || {}, meta(req));
  res.status(201).json({ ok: true, ...result });
}));

router.get("/me", partners.requirePartnerKey, handle(async (req, res) => {
  const partner = await partners.requirePartner(req.partner.id);
  res.json({
    ok: true,
    partner: {
      id: partner.id, companyName: partner.company_name, contactName: partner.contact_name || "",
      email: partner.email, status: partner.status, createdAt: partner.created_at
    },
    environment: partners.runtimeEnvironment()
  });
}));

router.get("/keys", partners.requirePartnerKey, handle(async (req, res) => {
  res.json({ ok: true, keys: await partners.listKeys(req.partner.id) });
}));

router.post("/keys", partners.requirePartnerKey, handle(async (req, res) => {
  const environment = String(req.body?.environment || "sandbox").trim();
  const result = await partners.createKey(req.partner.id, environment, "partner_api", meta(req));
  res.status(201).json({ ok: true, ...result });
}));

router.post("/keys/:id/rotate", partners.requirePartnerKey, handle(async (req, res) => {
  const result = await partners.rotateKey(req.partner.id, requireUuid(req.params.id, "Key ID"), "partner_api", meta(req));
  res.json({ ok: true, ...result });
}));

router.post("/keys/:id/revoke", partners.requirePartnerKey, handle(async (req, res) => {
  const key = await partners.revokeKey(req.partner.id, requireUuid(req.params.id, "Key ID"), "partner_api", meta(req));
  res.json({ ok: true, key });
}));

router.get("/usage", partners.requirePartnerKey, handle(async (req, res) => {
  res.json({ ok: true, usage: await partners.usageSeries(req.partner.id, req.query.days) });
}));

router.get("/overview", partners.requirePartnerKey, handle(async (req, res) => {
  res.json({ ok: true, overview: await partners.partnerOverview(req.partner.id) });
}));

module.exports = router;
