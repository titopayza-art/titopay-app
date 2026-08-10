"use strict";

// Marketing & Sales Command Centre — admin API.
//
// Mounted at /v1/admin/marketing AHEAD of the general admin router. Express
// falls through when a sub-router does not match, so the marketing endpoints
// that already exist there — announcements, sms-campaigns, email-campaigns,
// reviews — keep working untouched. Nothing in this file redefines them.
//
// Every route states its own permission. The existing broad "marketing"
// permission is accepted everywhere a marketer needs to look, but the actions
// that cost money or expose people — creating a promotion, granting one,
// exporting — require their own narrower permission, so a campaign editor
// cannot mint coupons.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum, requireUuid } = require("../lib/validation");
const { writeAuditLog } = require("../services/audit-service");
const marketing = require("../services/marketing-service");
const sales = require("../services/marketing-sales-service");
const analytics = require("../services/marketing-analytics-service");

const router = express.Router();

router.use(requireAuth);
router.use((req, _res, next) => {
  if (req.auth?.userType !== "admin") {
    next(new AppError(403, "Admin access required"));
    return;
  }
  next();
});

// Who did it, for the audit trail. Read from the verified session, never from
// the request body.
function actorFrom(req) {
  return { adminId: req.auth?.userId || null, role: req.auth?.role || null };
}

function auditContext(req) {
  return { ipAddress: req.ip, userAgent: req.get("user-agent") };
}

async function audit(req, action, entityType, entityId, metadata = {}) {
  await writeAuditLog({
    actorType: "admin",
    actorId: req.auth?.userId || null,
    action,
    entityType,
    entityId: entityId || null,
    ...auditContext(req),
    metadata
  }).catch(() => {});
}

const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

/* ------------------------------------------------------------------ overview */

router.get("/overview", requireAdminPermission("marketing"), handle(async (req, res) => {
  const [cards, series] = await Promise.all([
    analytics.overview(req.query),
    analytics.timeseries(req.query)
  ]);
  res.json({ ok: true, ...cards, charts: series });
}));

router.get("/analytics", requireAdminPermission("marketing_analytics"), handle(async (req, res) => {
  const [funnelData, cost] = await Promise.all([
    analytics.funnels(req.query),
    analytics.acquisitionCost(req.query)
  ]);
  res.json({ ok: true, funnels: funnelData, acquisition: cost });
}));

router.get("/roi", requireAdminPermission("marketing_analytics"), handle(async (req, res) => {
  res.json({ ok: true, items: await analytics.roi(req.query) });
}));

/* ----------------------------------------------------------------- campaigns */

router.get("/campaigns", requireAdminPermission("marketing"), handle(async (req, res) => {
  res.json({ ok: true, ...(await marketing.listCampaigns(req.query)) });
}));

router.get("/campaigns/:id", requireAdminPermission("marketing"), handle(async (req, res) => {
  res.json({ ok: true, campaign: await marketing.getCampaign(requireUuid(req.params.id, "Campaign")) });
}));

router.post("/campaigns", requireAdminPermission("marketing_campaigns"), handle(async (req, res) => {
  const input = {
    name: boundedText(req.body?.name, "Campaign name", { min: 3, max: 120 }),
    description: req.body?.description ? boundedText(req.body.description, "Description", { max: 2000 }) : "",
    type: requireEnum(req.body?.type, marketing.CAMPAIGN_TYPES, "Campaign type"),
    objective: req.body?.objective ? boundedText(req.body.objective, "Objective", { max: 500 }) : "",
    audienceId: req.body?.audienceId || null,
    channels: req.body?.channels,
    startsAt: req.body?.startsAt || null,
    endsAt: req.body?.endsAt || null,
    budget: Number(req.body?.budget || 0),
    ownerAdminId: req.body?.ownerAdminId || null
  };
  if (input.budget < 0) throw new AppError(400, "A budget cannot be negative.");
  const campaign = await marketing.createCampaign(actorFrom(req), input);
  await audit(req, "marketing.campaign.created", "marketing_campaign", campaign.id,
    { name: campaign.name, type: campaign.type, budget: campaign.budget.allocated });
  res.status(201).json({ ok: true, campaign });
}));

router.patch("/campaigns/:id", requireAdminPermission("marketing_campaigns"), handle(async (req, res) => {
  const id = requireUuid(req.params.id, "Campaign");
  const { before, after } = await marketing.updateCampaign(actorFrom(req), id, req.body || {});
  await audit(req, "marketing.campaign.updated", "marketing_campaign", id, {
    before: { status: before.status, budget: Number(before.budget_allocated), name: before.name },
    after: { status: after.status, budget: after.budget.allocated, name: after.name },
    reason: req.body?.reason || null
  });
  res.json({ ok: true, campaign: after });
}));

router.post("/campaigns/:id/spend", requireAdminPermission("marketing_campaigns"), handle(async (req, res) => {
  const id = requireUuid(req.params.id, "Campaign");
  const result = await marketing.recordCampaignSpend(actorFrom(req), id, req.body || {});
  await audit(req, "marketing.campaign.spend_recorded", "marketing_campaign", id,
    { amount: Number(req.body?.amount), description: req.body?.description || "" });
  res.status(201).json({ ok: true, ...result });
}));

/* ----------------------------------------------------------------- audiences */

router.get("/audiences", requireAdminPermission("marketing"), handle(async (_req, res) => {
  res.json({ ok: true, items: await marketing.listAudiences(), presets: marketing.audiencePresetList() });
}));

router.post("/audiences", requireAdminPermission("marketing_audiences"), handle(async (req, res) => {
  const audience = await marketing.createAudience(actorFrom(req), {
    name: boundedText(req.body?.name, "Audience name", { min: 3, max: 120 }),
    description: req.body?.description ? boundedText(req.body.description, "Description", { max: 500 }) : "",
    preset: req.body?.preset,
    definition: req.body?.definition,
    isDynamic: req.body?.isDynamic
  });
  await audit(req, "marketing.audience.created", "marketing_audience", audience.id,
    { name: audience.name, preset: audience.preset });
  res.status(201).json({ ok: true, audience });
}));

router.post("/audiences/:id/build", requireAdminPermission("marketing_audiences"), handle(async (req, res) => {
  const id = requireUuid(req.params.id, "Audience");
  const result = await marketing.buildAudience(id);
  await audit(req, "marketing.audience.built", "marketing_audience", id, { size: result.size });
  res.json({ ok: true, ...result });
}));

/* ---------------------------------------------------------------- promotions */

router.get("/promotions", requireAdminPermission("marketing"), handle(async (req, res) => {
  res.json({ ok: true, items: await marketing.listPromotions(req.query) });
}));

router.post("/promotions", requireAdminPermission("marketing_promotions"), handle(async (req, res) => {
  const promotion = await marketing.createPromotion(actorFrom(req), {
    code: req.body?.code,
    name: boundedText(req.body?.name, "Promotion name", { min: 3, max: 120 }),
    description: req.body?.description ? boundedText(req.body.description, "Description", { max: 1000 }) : "",
    campaignId: req.body?.campaignId || null,
    benefitType: req.body?.benefitType,
    benefitValue: req.body?.benefitValue,
    benefitPercentage: req.body?.benefitPercentage,
    maxBenefit: req.body?.maxBenefit,
    minTransaction: req.body?.minTransaction,
    audienceId: req.body?.audienceId || null,
    eligibleServices: req.body?.eligibleServices,
    merchantId: req.body?.merchantId || null,
    startsAt: req.body?.startsAt || null,
    expiresAt: req.body?.expiresAt || null,
    usageLimit: req.body?.usageLimit,
    perUserLimit: req.body?.perUserLimit,
    budgetTotal: req.body?.budgetTotal
  });
  await audit(req, "marketing.promotion.created", "marketing_promotion", promotion.id, {
    code: promotion.code, benefitType: promotion.benefitType,
    benefitValue: promotion.benefitValue, usageLimit: promotion.usageLimit
  });
  res.status(201).json({ ok: true, promotion });
}));

router.patch("/promotions/:id", requireAdminPermission("marketing_promotions"), handle(async (req, res) => {
  const id = requireUuid(req.params.id, "Promotion");
  const status = requireEnum(req.body?.status, marketing.PROMOTION_STATUSES, "Status");
  const promotion = await marketing.updatePromotionStatus(actorFrom(req), id, status);
  await audit(req, "marketing.promotion.status_changed", "marketing_promotion", id,
    { code: promotion.code, after: status, reason: req.body?.reason || null });
  res.json({ ok: true, promotion });
}));

// Grant an entitlement. Separately permissioned because this is the one action
// in the module that decides a customer is owed something.
router.post("/promotions/grant", requireAdminPermission("marketing_promotions"), handle(async (req, res) => {
  const result = await marketing.grantPromotion(actorFrom(req), {
    code: req.body?.code,
    userId: requireUuid(req.body?.userId, "Customer"),
    transactionId: req.body?.transactionId || null,
    transactionAmount: req.body?.transactionAmount,
    idempotencyKey: req.get("idempotency-key") || req.body?.idempotencyKey
  });
  if (!result.replay) {
    await audit(req, "marketing.promotion.granted", "marketing_promo_redemption", result.redemptionId,
      { promotionId: result.promotionId, benefitAmount: result.benefitAmount });
  }
  res.status(result.replay ? 200 : 201).json({ ok: true, ...result });
}));

/* --------------------------------------------------------------- referrals */

router.get("/referrals", requireAdminPermission("marketing"), handle(async (req, res) => {
  res.json({ ok: true, items: await sales.listReferrals(req.query) });
}));

router.post("/referrals/:id/evaluate", requireAdminPermission("marketing_referrals"), handle(async (req, res) => {
  const id = requireUuid(req.params.id, "Referral");
  const result = await sales.evaluateReferral(id);
  await audit(req, "marketing.referral.evaluated", "marketing_referral", id, result);
  res.json({ ok: true, ...result });
}));

router.get("/affiliates", requireAdminPermission("marketing"), handle(async (_req, res) => {
  const { pool } = require("../db/pool");
  const { rows } = await pool.query(
    `SELECT a.*, COALESCE(r.referred, 0) AS referred
       FROM marketing_affiliates a
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS referred FROM marketing_referrals WHERE affiliate_id = a.id
       ) r ON TRUE
      ORDER BY a.created_at DESC LIMIT 200`);
  res.json({
    ok: true,
    items: rows.map((row) => ({
      id: row.id, name: row.name, code: row.code, status: row.status,
      commissionType: row.commission_type, commissionValue: Number(row.commission_value),
      referred: row.referred, createdAt: row.created_at
    }))
  });
}));

/* ------------------------------------------------------------- leads / CRM */

router.get("/leads", requireAdminPermission("marketing_leads"), handle(async (req, res) => {
  res.json({ ok: true, ...(await sales.listLeads(req.query)) });
}));

router.get("/leads/:id", requireAdminPermission("marketing_leads"), handle(async (req, res) => {
  res.json({ ok: true, lead: await sales.getLead(requireUuid(req.params.id, "Lead")) });
}));

router.post("/leads", requireAdminPermission("marketing_leads"), handle(async (req, res) => {
  const lead = await sales.createLead(actorFrom(req), req.body || {});
  await audit(req, "marketing.lead.created", "marketing_lead", lead.id,
    { reference: lead.reference, businessName: lead.businessName, source: lead.source });
  res.status(201).json({ ok: true, lead });
}));

router.patch("/leads/:id", requireAdminPermission("marketing_leads"), handle(async (req, res) => {
  const id = requireUuid(req.params.id, "Lead");
  const { before, after } = await sales.updateLead(actorFrom(req), id, req.body || {});
  await audit(req, "marketing.lead.updated", "marketing_lead", id, {
    before: { status: before.status, assignedAdminId: before.assigned_admin_id },
    after: { status: after.status, assignedAdminId: after.assignedAdminId },
    reason: req.body?.note || req.body?.lostReason || null
  });
  res.json({ ok: true, lead: after });
}));

router.get("/sales-pipeline", requireAdminPermission("marketing_leads"), handle(async (_req, res) => {
  res.json({ ok: true, ...(await sales.salesPipeline()) });
}));

router.get("/sales-team", requireAdminPermission("marketing_sales"), handle(async (_req, res) => {
  res.json({ ok: true, items: await sales.salesTeam() });
}));

/* ------------------------------------------------------------------- links */

router.get("/links", requireAdminPermission("marketing"), handle(async (req, res) => {
  res.json({ ok: true, items: await sales.listLinks(req.query), allowedHosts: sales.allowedLinkHosts() });
}));

router.post("/links", requireAdminPermission("marketing_links"), handle(async (req, res) => {
  const link = await sales.createLink(actorFrom(req), req.body || {});
  await audit(req, "marketing.link.created", "marketing_link", link.id,
    { slug: link.slug, destination: link.destinationUrl, campaignId: link.campaignId });
  res.status(201).json({ ok: true, link });
}));

/* ------------------------------------------------------------- experiments */

router.get("/experiments", requireAdminPermission("marketing"), handle(async (_req, res) => {
  res.json({ ok: true, items: await sales.listExperiments() });
}));

router.post("/experiments", requireAdminPermission("marketing_experiments"), handle(async (req, res) => {
  const experiment = await sales.createExperiment(actorFrom(req), {
    name: boundedText(req.body?.name, "Experiment name", { min: 3, max: 120 }),
    hypothesis: req.body?.hypothesis ? boundedText(req.body.hypothesis, "Hypothesis", { max: 1000 }) : "",
    audienceId: req.body?.audienceId || null,
    successMetric: req.body?.successMetric,
    startsAt: req.body?.startsAt || null,
    endsAt: req.body?.endsAt || null,
    variants: req.body?.variants
  });
  await audit(req, "marketing.experiment.created", "marketing_experiment", experiment.id,
    { name: experiment.name, variants: experiment.variants.length });
  res.status(201).json({ ok: true, experiment });
}));

module.exports = router;
