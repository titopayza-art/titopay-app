"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireUuid } = require("../lib/validation");
const kids = require("../services/titokids-service");

const router = express.Router();
router.use(requireAuth);

const run = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    next(error);
  }
};

router.get("/", run(async (req, res) => {
  const [children, approvals] = await Promise.all([
    kids.listChildren(req.auth.userId),
    kids.listApprovals(req.auth.userId)
  ]);
  res.json({ ok: true, children, approvals, categories: kids.CATEGORY_LABELS });
}));

router.post("/children", run(async (req, res) => {
  res.status(201).json({ ok: true, child: await kids.addChild(req.auth.userId, req.body || {}) });
}));

// The child's own side — declared before /children/:id so "family" is never
// parsed as an id.
router.get("/family", run(async (req, res) => {
  res.json({ ok: true, items: await kids.myFamily(req.auth.userId), categories: kids.CATEGORY_LABELS });
}));
router.post("/family/:childId/requests", run(async (req, res) => {
  res.status(201).json({ ok: true, request: await kids.createRequest(req.auth.userId, requireUuid(req.params.childId, "Child ID"), req.body || {}) });
}));

router.get("/approvals", run(async (req, res) => {
  res.json({ ok: true, items: await kids.listApprovals(req.auth.userId) });
}));
router.post("/approvals/:id/approve", run(async (req, res) => {
  res.json({ ok: true, ...(await kids.decideRequest(req.auth.userId, requireUuid(req.params.id, "Request ID"), true)) });
}));
router.post("/approvals/:id/decline", run(async (req, res) => {
  res.json({ ok: true, ...(await kids.decideRequest(req.auth.userId, requireUuid(req.params.id, "Request ID"), false)) });
}));

router.get("/children/:id", run(async (req, res) => {
  res.json({ ok: true, child: await kids.getChild(req.auth.userId, requireUuid(req.params.id, "Child ID")) });
}));
router.patch("/children/:id", run(async (req, res) => {
  res.json({ ok: true, child: await kids.updateChild(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {}) });
}));
router.post("/children/:id/fund", run(async (req, res) => {
  res.status(201).json({ ok: true, ...(await kids.fundChild(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {})) });
}));
router.post("/children/:id/pay", run(async (req, res) => {
  res.status(201).json({ ok: true, ...(await kids.payForChild(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {})) });
}));
router.get("/children/:id/limits", run(async (req, res) => {
  await kids.getChild(req.auth.userId, requireUuid(req.params.id, "Child ID"));
  res.json({ ok: true, limits: await kids.childLimits(req.params.id) });
}));
router.patch("/children/:id/limits", run(async (req, res) => {
  res.json({ ok: true, limits: await kids.setLimits(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {}) });
}));
router.post("/children/:id/goals", run(async (req, res) => {
  res.status(201).json({ ok: true, goal: await kids.createGoal(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {}) });
}));

module.exports = router;
