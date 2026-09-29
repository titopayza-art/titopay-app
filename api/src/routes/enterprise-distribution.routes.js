"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const {
  DISTRIBUTION_TYPES,
  getEligibility,
  submitApplication,
  listApplications,
  listOrganisations,
  transitionApplication,
  listBeneficiaries,
  upsertBeneficiary,
  createBatch,
  lockBatchFunding,
  releaseBatch,
  listBatches,
  listAllBatches,
  listPayouts,
  listAuditLogs,
  adminReport,
  adminOverview
} = require("../services/enterprise-distribution-service");

const router = express.Router();

function meta(req) {
  return { ipAddress: req.ip, userAgent: req.get("user-agent") };
}

router.get("/types", (_req, res) => {
  res.json({ ok: true, items: DISTRIBUTION_TYPES });
});

router.get("/eligibility", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, eligibility: await getEligibility(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/applications", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, application: await submitApplication(req.auth.userId, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/beneficiaries", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await listBeneficiaries(req.auth.userId, req.query.search || "")) });
  } catch (error) {
    next(error);
  }
});

router.post("/beneficiaries", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, beneficiary: await upsertBeneficiary(req.auth.userId, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/batches", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await listBatches(req.auth.userId)) });
  } catch (error) {
    next(error);
  }
});

router.post("/batches", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, ...(await createBatch(req.auth.userId, req.body, meta(req))) });
  } catch (error) {
    next(error);
  }
});

router.post("/batches/:id/fund", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, batch: await lockBatchFunding(req.auth.userId, req.params.id, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/overview", requireAuth, requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, overview: await adminOverview() });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/applications", requireAuth, requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listApplications(req.query.status || "") });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/applications/:id/action", requireAuth, requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await transitionApplication(req.params.id, req.body, req.auth, meta(req))) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/organisations", requireAuth, requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listOrganisations() });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/batches", requireAuth, requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listAllBatches() });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/batches/:id/release", requireAuth, requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, batch: await releaseBatch(req.params.id, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/payouts", requireAuth, requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listPayouts(req.query.status || "") });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/audit-logs", requireAuth, requireAdminPermission("enterprise_distribution"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listAuditLogs(req.query.limit || 250) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/report", requireAuth, requireAdminPermission("enterprise_distribution"), async (_req, res, next) => {
  try {
    res.json({ ok: true, report: await adminReport() });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
