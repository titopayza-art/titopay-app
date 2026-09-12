const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireSuperAdmin } = require("../middleware/super-admin");
const { requireUuid } = require("../lib/validation");
const { listPricingRules, updatePricingRule, getPricingRuleById } = require("../services/pricing-service");

const router = express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.info("[pricing-api]", {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      requestId: req.requestId,
      adminId: req.auth?.userId || null,
      role: req.auth?.role || null
    });
  });
  next();
});

router.get("/", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listPricingRules() });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", requireSuperAdmin, async (req, res, next) => {
  try {
    const pricingRuleId = requireUuid(req.params.id, "Pricing rule ID");
    // The settlement fee is skimmed from every merchant payout, so re-pricing
    // it requires a second admin - the same control that guards large
    // reversals and limit changes. Every other pricing rule keeps its
    // existing single-super-admin path (requiresPricingChangeDualAuth returns
    // false for them), so this adds a gate for exactly one rule and changes
    // nothing else.
    const dualAuth = require("../services/dual-auth-service");
    const rule = await getPricingRuleById(pricingRuleId);
    if (rule && await dualAuth.requiresPricingChangeDualAuth(rule.service_code)) {
      const request = await dualAuth.createRequest({
        actionType: "pricing_change",
        payload: { pricingRuleId, pricingPayload: req.body || {}, serviceCode: rule.service_code },
        summary: `Settlement fee change (${rule.service_code}) requested`,
        adminId: req.auth.userId,
        meta: { ipAddress: req.ip, userAgent: req.get("user-agent") }
      });
      res.status(202).json({ ok: true, pendingApproval: true, request });
      return;
    }
    res.json({ ok: true, item: await updatePricingRule(pricingRuleId, req.body, req.auth) });
  } catch (error) {
    next(error);
  }
});

router.use((error, req, _res, next) => {
  console.error("[pricing-api-error]", {
    method: req.method,
    path: req.originalUrl || req.url,
    requestId: req.requestId,
    adminId: req.auth?.userId || null,
    role: req.auth?.role || null,
    status: error?.statusCode || error?.status || 500,
    code: error?.code,
    name: error?.name || "Error",
    message: error?.message || "Unexpected Pricing API error",
    stack: error?.stack
  });
  next(error);
});

module.exports = router;
