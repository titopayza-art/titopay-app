"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { pool } = require("../db/pool");
const { boundedText } = require("../lib/validation");
const { writeAuditLog } = require("../services/audit-service");
const {
  listConversations,
  getConversation,
  listMessages,
  markRead,
  takeover,
  sendMessage,
  assign,
  transition
} = require("../services/support-chat-service");

const router = express.Router();
router.use(requireAuth);
router.use(requireAdminPermission("support"));

router.get("/conversations", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await listConversations(req.auth, req.query)) });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id", async (req, res, next) => {
  try {
    const [conversation, messages] = await Promise.all([
      getConversation(req.auth, req.params.id),
      listMessages(req.auth, req.params.id)
    ]);
    res.json({ ok: true, conversation, messages });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const messages = await listMessages(req.auth, req.params.id);
    await markRead(req.auth, req.params.id);
    res.json({ ok: true, messages, items: messages });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id/context", async (req, res, next) => {
  try {
    const [conversation, messages] = await Promise.all([
      getConversation(req.auth, req.params.id),
      listMessages(req.auth, req.params.id)
    ]);
    await markRead(req.auth, req.params.id);
    res.json({
      ok: true,
      conversation,
      messages,
      calls: [],
      internalNotes: Array.isArray(conversation.metadata?.internal_notes)
        ? conversation.metadata.internal_notes
        : []
    });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/notes", async (req, res, next) => {
  try {
    await getConversation(req.auth, req.params.id);
    const note = {
      id: require("crypto").randomUUID(),
      note: boundedText(req.body?.note, "Internal note", { min: 2, max: 1000 }),
      createdAt: new Date().toISOString(),
      createdBy: req.auth.userId,
      createdByLabel: req.auth.email || req.auth.username || "Admin"
    };
    const { rows } = await pool.query(
      `UPDATE support_conversations
       SET metadata=jsonb_set(
         COALESCE(metadata,'{}'::JSONB),'{internal_notes}',
         COALESCE(metadata->'internal_notes','[]'::JSONB) || $2::JSONB,TRUE
       ),updated_at=NOW()
       WHERE id=$1 RETURNING id`,
      [req.params.id, JSON.stringify([note])]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Conversation not found" });
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_internal_note_added",
      entityType: "support_conversation",
      entityId: req.params.id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { noteId: note.id }
    });
    res.status(201).json({ ok: true, note });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/takeover", async (req, res, next) => {
  try {
    res.json({ ok: true, conversation: await takeover(req.auth, req.params.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    const message = await sendMessage(req.auth, req.params.id, req.body || {});
    res.status(201).json({ ok: true, message });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/assign", async (req, res, next) => {
  try {
    const targetAgentId = req.body?.agentId || req.auth.userId;
    res.json({ ok: true, conversation: await assign(req.auth, req.params.id, targetAgentId, "assigned") });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/unassign", async (req, res, next) => {
  try {
    res.json({ ok: true, conversation: await assign(req.auth, req.params.id, null, "unassigned") });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/transfer", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      conversation: await assign(req.auth, req.params.id, req.body?.agentId, "transferred")
    });
  } catch (error) {
    next(error);
  }
});

for (const action of ["resolve", "close", "reopen"]) {
  router.post(`/conversations/:id/${action}`, async (req, res, next) => {
    try {
      res.json({ ok: true, conversation: await transition(req.auth, req.params.id, action) });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = router;
