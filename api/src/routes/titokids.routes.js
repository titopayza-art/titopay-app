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

// Co-parents. Declared before /children/:id for the same reason "family" is.
router.get("/invitations", run(async (req, res) => {
  res.json({ ok: true, items: await kids.listGuardianInvites(req.auth.userId) });
}));
router.post("/invitations/:id/accept", run(async (req, res) => {
  res.json({ ok: true, ...(await kids.respondToGuardianInvite(req.auth.userId, requireUuid(req.params.id, "Invitation ID"), true)) });
}));
router.post("/invitations/:id/decline", run(async (req, res) => {
  res.json({ ok: true, ...(await kids.respondToGuardianInvite(req.auth.userId, requireUuid(req.params.id, "Invitation ID"), false)) });
}));
router.delete("/managers/:id", run(async (req, res) => {
  res.json({ ok: true, ...(await kids.removeGuardian(req.auth.userId, requireUuid(req.params.id, "Manager ID"))) });
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
// The way back out. fund moves money in, return moves it back to the account
// holder's own wallet — without one, a balance left in a child wallet could
// only ever be spent, and removing a child was impossible while it sat there.
router.post("/children/:id/return", run(async (req, res) => {
  res.status(201).json({ ok: true, ...(await kids.returnFromChild(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {})) });
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
router.get("/children/:id/managers", run(async (req, res) => {
  res.json({ ok: true, ...(await kids.listGuardians(req.auth.userId, requireUuid(req.params.id, "Child ID"))) });
}));
router.post("/children/:id/managers", run(async (req, res) => {
  res.status(201).json({ ok: true, ...(await kids.inviteGuardian(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {})) });
}));
router.post("/children/:id/goals", run(async (req, res) => {
  res.status(201).json({ ok: true, goal: await kids.createGoal(req.auth.userId, requireUuid(req.params.id, "Child ID"), req.body || {}) });
}));

module.exports = router;
