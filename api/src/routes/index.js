const express = require("express");
const healthRoutes = require("./health.routes");
const authRoutes = require("./auth.routes");
const walletRoutes = require("./wallet.routes");
const qrRoutes = require("./qr.routes");
const adminRoutes = require("./admin.routes");
const adminSupportRoutes = require("./admin-support.routes");
const marketingRoutes = require("./marketing.routes");
const pricingRoutes = require("./pricing.routes");
const integrationsRoutes = require("./integrations.routes");
const transactionRoutes = require("./transaction.routes");
const merchantRoutes = require("./merchant.routes");
const paymentsRoutes = require("./payments.routes");
const payoutsRoutes = require("./payouts.routes");
const usersRoutes = require("./users.routes");
const lookupRoutes = require("./lookup.routes");
const servicesRoutes = require("./services.routes");
const beneficiariesRoutes = require("./beneficiaries.routes");
const securityRoutes = require("./security.routes");
const kycRoutes = require("./kyc.routes");
const chatbotRoutes = require("./chatbot.routes");
const chatRoutes = require("./chat.routes");
const supportRoutes = require("./support.routes");
const hrRoutes = require("./hr.routes");
const ticketingRoutes = require("./ticketing.routes");
const enterpriseDistributionRoutes = require("./enterprise-distribution.routes");
const posRoutes = require("../pos/routes");
const emailCentreRoutes = require("./email-centre.routes");
const emailOtpAdminRoutes = require("./email-otp-admin.routes");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { feePreview } = require("../services/transaction-service");

const router = express.Router();
const { healthStatus } = healthRoutes;

async function hrHealthStatus(_req, res, next) {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      service: "titopay-hr",
      status: "ready",
      database: "ok",
      basePath: "/api/v1/hr"
    });
  } catch (error) {
    next(error);
  }
}

async function versionStatus(_req, res, next) {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      status: "ok",
      database: "ok",
      basePath: "/v1"
    });
  } catch (error) {
    next(error);
  }
}

router.get("/v1", versionStatus);
router.get("/api", versionStatus);
router.get("/v1/health", healthStatus);
router.get("/api/health", healthStatus);
router.get("/api/v1/health", healthStatus);
router.get("/api/v1/hr/health", hrHealthStatus);
router.get("/v1/hr/health", hrHealthStatus);
router.get("/api/hr/health", hrHealthStatus);

// HR must be mounted before any generic /api or /v1 route.
// The HR login/reset/public application endpoints do not use the customer
// bearer-token middleware; if a generic route sees them first the portal shows
// "Bearer token required" and the whole HR workspace appears broken.
router.use("/api/v1/hr", hrRoutes);
router.use("/v1/hr", hrRoutes);
router.use("/api/hr", hrRoutes);
router.use("/hr", hrRoutes);

router.use("/", healthRoutes);

router.get("/v1/webhooks/pos-provider", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ ok: false, error: "Method Not Allowed" });
});
router.post("/v1/webhooks/pos-provider", posRoutes.handleProviderWebhook);

function mountVersionedRoutes(prefix) {
  router.use(`${prefix}/hr`, hrRoutes);
  router.use(`${prefix}/auth`, authRoutes);
  router.use(`${prefix}/auth/admin`, adminRoutes);
  router.use(`${prefix}/wallets`, walletRoutes);
  router.use(`${prefix}/qr`, qrRoutes);
  router.use(`${prefix}/admin/support`, adminSupportRoutes);
  router.use(`${prefix}/admin/email-otp`, emailOtpAdminRoutes);
  router.use(`${prefix}/admin/email`, emailCentreRoutes);
  // Ahead of the general admin router on purpose. Express falls through when a
  // sub-router does not match, so the marketing endpoints that already live in
  // admin.routes.js — announcements, sms-campaigns, email-campaigns, reviews —
  // are still reached exactly as before. This router only adds new paths.
  router.use(`${prefix}/admin/marketing`, marketingRoutes);
  router.use(`${prefix}/admin`, adminRoutes);
  router.use(`${prefix}/pricing`, pricingRoutes);
  router.use(`${prefix}/integrations`, integrationsRoutes);
  router.use(`${prefix}/transactions`, transactionRoutes);
  router.use(`${prefix}/merchants`, merchantRoutes);
  router.use(`${prefix}/payments`, paymentsRoutes);
  router.use(`${prefix}/payouts`, payoutsRoutes);
  router.use(`${prefix}/users`, usersRoutes);
  router.use(`${prefix}/services`, servicesRoutes);
  router.use(`${prefix}/beneficiaries`, beneficiariesRoutes);
  router.use(`${prefix}/security`, securityRoutes);
  router.use(`${prefix}/kyc`, kycRoutes);
  router.use(`${prefix}/chat`, chatRoutes);
  router.use(`${prefix}/chatbot`, chatbotRoutes);
  router.use(`${prefix}/support`, supportRoutes);
  router.use(`${prefix}/ticketing`, ticketingRoutes);
  router.use(`${prefix}/enterprise-distribution`, enterpriseDistributionRoutes);
  router.use(`${prefix}/pos`, posRoutes);
  router.use(`${prefix}`, lookupRoutes);

  router.post(`${prefix}/fee-preview`, requireAuth, async (req, res, next) => {
    try {
      res.json({ ok: true, preview: await feePreview({ ...req.body, actor: req.auth }) });
    } catch (error) {
      next(error);
    }
  });
}

mountVersionedRoutes("/v1");
mountVersionedRoutes("/api");

module.exports = router;
