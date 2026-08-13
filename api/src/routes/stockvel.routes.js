"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireUuid } = require("../lib/validation");
const { AppError } = require("../lib/errors");
const svc = require("../services/stockvel-service");

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
  const items = await svc.listGroups(req.auth.userId);
  res.json({ ok: true, items, groups: items });
}));

router.post("/", run(async (req, res) => {
  res.status(201).json({ ok: true, group: await svc.createGroup(req.auth.userId, req.body || {}) });
}));

router.post("/join", run(async (req, res) => {
  res.json({ ok: true, group: await svc.joinByCode(req.auth.userId, req.body?.inviteCode || req.body?.code) });
}));

// The invitations screen: invite codes are the mechanism, so the inbox is
// empty by design and per-group invitations simply return the group's code.
router.get("/invitations", run(async (_req, res) => {
  res.json({ ok: true, items: [] });
}));
router.post("/invitations/:id/accept", run(async (req, res) => {
  res.json({ ok: true, group: await svc.joinByCode(req.auth.userId, req.params.id) });
}));
router.post("/invitations/:id/decline", run(async (_req, res) => {
  res.json({ ok: true });
}));

router.get("/:id", run(async (req, res) => {
  const groupId = requireUuid(req.params.id, "Group ID");
  res.json({ ok: true, group: await svc.getGroup(req.auth.userId, groupId) });
}));

router.put("/:id", run(async (req, res) => {
  const groupId = requireUuid(req.params.id, "Group ID");
  res.json({ ok: true, group: await svc.updateGroup(req.auth.userId, groupId, req.body || {}) });
}));

router.delete("/:id", run(async (req, res) => {
  const groupId = requireUuid(req.params.id, "Group ID");
  res.json({ ok: true, ...(await svc.deleteGroup(req.auth.userId, groupId)) });
}));

router.post("/:id/invitations", run(async (req, res) => {
  const groupId = requireUuid(req.params.id, "Group ID");
  const identifiers = Array.isArray(req.body?.identifiers) ? req.body.identifiers : [];
  if (identifiers.length) {
    res.status(201).json({ ok: true, ...(await svc.inviteMembers(req.auth.userId, groupId, identifiers)) });
    return;
  }
  const group = await svc.getGroup(req.auth.userId, groupId);
  res.status(201).json({ ok: true, inviteCode: group.invite_code, message: `Share the invite code ${group.invite_code} — joining happens under Join with a code.` });
}));

// Contributions: a member's transfer to the group's treasurer on the normal
// transaction rails, counted on the group register via its metadata.
router.get("/:id/contributions/preview", run(async (req, res) => {
  const groupId = requireUuid(req.params.id, "Group ID");
  res.json({ ok: true, ...(await svc.previewContribution(req.auth.userId, groupId, req.query.amount)) });
}));

router.post("/:id/contributions", run(async (req, res) => {
  if (req.auth.profileLocked) throw new AppError(423, "Profile is locked. Financial transactions are disabled.");
  const groupId = requireUuid(req.params.id, "Group ID");
  res.status(201).json({ ok: true, ...(await svc.contribute(req.auth, groupId, req.body || {})) });
}));

router.post("/:id/members/:memberId/promote", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.changeMemberRole(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.memberId, "Member ID"), "promote")) });
}));
router.post("/:id/members/:memberId/demote", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.changeMemberRole(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.memberId, "Member ID"), "demote")) });
}));
router.delete("/:id/members/me", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.leaveGroup(req.auth.userId, requireUuid(req.params.id, "Group ID"))) });
}));
router.delete("/:id/members/:memberId", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.removeMember(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.memberId, "Member ID"))) });
}));

router.post("/:id/withdrawals", run(async (req, res) => {
  res.status(201).json({ ok: true, withdrawal: await svc.requestWithdrawal(req.auth.userId, requireUuid(req.params.id, "Group ID"), req.body || {}) });
}));
router.post("/:id/withdrawals/:withdrawalId/approve", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.decideWithdrawal(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.withdrawalId, "Withdrawal ID"), true)) });
}));
router.post("/:id/withdrawals/:withdrawalId/decline", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.decideWithdrawal(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.withdrawalId, "Withdrawal ID"), false)) });
}));

// Group chat and meetings.
router.get("/:id/messages", run(async (req, res) => {
  res.json({ ok: true, items: await svc.listMessages(req.auth.userId, requireUuid(req.params.id, "Group ID"), { limit: req.query.limit }) });
}));
router.post("/:id/messages", run(async (req, res) => {
  res.status(201).json({ ok: true, ...(await svc.postMessage(req.auth.userId, requireUuid(req.params.id, "Group ID"), req.body || {})) });
}));
router.post("/:id/messages/:messageId/decision", run(async (req, res) => {
  res.json({ ok: true, ...(await svc.markDecision(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.messageId, "Message ID"), req.body?.isDecision)) });
}));
router.post("/:id/meetings", run(async (req, res) => {
  res.status(201).json({ ok: true, meeting: await svc.openMeeting(req.auth.userId, requireUuid(req.params.id, "Group ID"), req.body || {}) });
}));
router.post("/:id/meetings/:meetingId/close", run(async (req, res) => {
  res.json({ ok: true, meeting: await svc.closeMeeting(req.auth.userId, requireUuid(req.params.id, "Group ID"), requireUuid(req.params.meetingId, "Meeting ID")) });
}));

module.exports = router;
