"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireUuid } = require("../lib/validation");
const {
  listStaff,
  addStaff,
  removeStaff,
  listMyWorkplaces,
  workplaceProducts,
  staffSale
} = require("../services/business-staff-service");

// Owner side — mounted at /v1/business/staff, the contract the PWA's Staff
// register has been calling since the preview shipped.
const ownerRouter = express.Router();
ownerRouter.use(requireAuth);

ownerRouter.get("/", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listStaff(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

ownerRouter.post("/", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, ...(await addStaff(req.auth.userId, req.body || {})) });
  } catch (error) {
    next(error);
  }
});

ownerRouter.delete("/:id", async (req, res, next) => {
  try {
    const memberId = requireUuid(req.params.id, "Staff member ID");
    res.json({ ok: true, member: await removeStaff(req.auth.userId, memberId) });
  } catch (error) {
    next(error);
  }
});

// Staff side — mounted at /v1/staff-workspace: where I work, what the
// business sells, and taking a sale whose payment QR pays the business.
const staffRouter = express.Router();
staffRouter.use(requireAuth);

staffRouter.get("/workplaces", async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listMyWorkplaces(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

staffRouter.get("/workplaces/:businessId/products", async (req, res, next) => {
  try {
    const businessId = requireUuid(req.params.businessId, "Business ID");
    res.json({ ok: true, items: await workplaceProducts(req.auth.userId, businessId) });
  } catch (error) {
    next(error);
  }
});

staffRouter.post("/workplaces/:businessId/sale", async (req, res, next) => {
  try {
    const businessId = requireUuid(req.params.businessId, "Business ID");
    res.status(201).json({ ok: true, sale: await staffSale(req.auth.userId, businessId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

module.exports = { ownerRouter, staffRouter };
