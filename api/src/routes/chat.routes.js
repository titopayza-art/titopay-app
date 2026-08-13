"use strict";

const express = require("express");
const { config } = require("../config/env");
const { AppError } = require("../lib/errors");
const { requireAuth } = require("../middleware/auth");
const {
  createMessage,
  listThreads,
  listThreadMessages,
  markMessageDelivered,
  markThreadRead,
  setThreadMuted,
  openThread
} = require("../services/chat-service");
const { resolveTitoPayUser } = require("../services/security-service");
const { publishChatMessage, publishChatStatus } = require("../realtime/chat-hub");

const router = express.Router();

router.use(requireAuth);

async function resolveChatRecipient(req, res, next) {
  try {
    const result = await resolveTitoPayUser(req.auth, {
      ...req.body,
      identifier: req.body?.identifier || req.body?.query || req.body?.value || req.query.identifier || req.query.q,
      recipient: req.body?.recipient || req.body?.identifier || req.body?.query || req.body?.value || req.query.recipient || req.query.identifier || req.query.q,
      purpose: "titopay_chat"
    });
    if (!result.registered) {
      res.status(404).json({
        ok: false,
        error: "This person is not on TitoPay yet.",
        code: "RECIPIENT_NOT_REGISTERED",
        ...result
      });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}

router.get("/config", (_req, res) => {
  res.json({ ok: true, iceServers: config.chatIceServers });
});

router.get("/notifications", async (req, res, next) => {
  try {
    const { pool } = require("../db/pool");
    await require("../services/notification-service").ensureNotificationClears();
    const { rows } = await pool.query(
      `UPDATE notifications
       SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END,
           delivered_at = COALESCE(delivered_at, NOW()),
           updated_at = NOW()
       WHERE user_id = $1
         AND (
           notification_type = 'titopay_chat'
           OR notification_type = 'account_welcome'
           OR notification_type = 'login_notification'
           OR notification_type LIKE 'support_%'
           OR notification_type LIKE '%_announcement'
           OR notification_type LIKE 'payment_request%'
           OR notification_type = 'stockvel_invite'
           OR notification_type = 'gift_received'
           OR notification_type = 'compliance_edd'
         )
         -- Cleared means cleared, on every device. Only notifications from
         -- after the user's last clear-all are ever served again.
         AND created_at > COALESCE(
           (SELECT cleared_at FROM notification_clears WHERE user_id = $1),
           'epoch'::TIMESTAMPTZ)
       RETURNING id, notification_type, title, body, status, metadata, created_at`,
      [req.auth.userId]
    );
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const announcementResult = await pool.query(
      `SELECT c.id, c.category || '_announcement' AS notification_type,
              c.title, c.body,
              CASE WHEN ar.user_id IS NULL THEN 'delivered' ELSE 'read' END AS status,
              JSONB_BUILD_OBJECT(
                'campaignId', c.id::TEXT,
                'category', c.category,
                'clientNotificationId', 'announcement-' || c.id::TEXT
              ) AS metadata,
              c.sent_at AS created_at
         FROM announcement_campaigns c
         JOIN users u ON u.id = $1
         LEFT JOIN announcement_reads ar
           ON ar.campaign_id = c.id AND ar.user_id = u.id
        WHERE c.status = 'sent'
          AND (
            c.audience = 'both'
            OR c.audience = u.account_type
            OR (c.audience = 'specific' AND c.target_user_id = u.id)
          )
        ORDER BY c.sent_at DESC
        LIMIT 80`,
      [req.auth.userId]
    );
    const deliveredMessages = await Promise.all(
      rows.map((item) => item.metadata?.messageId).filter(Boolean).map(markMessageDelivered)
    );
    deliveredMessages.filter(Boolean).forEach(publishChatStatus);
    const notifications = [...rows, ...announcementResult.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 80);
    res.json({ ok: true, notifications });
  } catch (error) {
    next(error);
  }
});

router.post("/notifications/read", async (req, res, next) => {
  try {
    const { pool } = require("../db/pool");
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => /^[0-9a-f-]{36}$/i.test(String(id))) : [];
    // An empty ids list is "clear everything" - the app sends it from the
    // Clear inbox button. Stamp the durable marker so the feed never serves
    // today's history to tomorrow's device.
    if (!ids.length) {
      await require("../services/notification-service").markNotificationsCleared(req.auth.userId);
    }
    const { rowCount } = await pool.query(
      `UPDATE notifications
       SET status = 'read', read_at = COALESCE(read_at, NOW()), updated_at = NOW()
       WHERE user_id = $1
         AND (
           notification_type = 'titopay_chat'
           OR notification_type = 'account_welcome'
           OR notification_type = 'login_notification'
           OR notification_type LIKE 'support_%'
           OR notification_type LIKE '%_announcement'
           OR notification_type LIKE 'payment_request%'
           OR notification_type = 'stockvel_invite'
           OR notification_type = 'gift_received'
           OR notification_type = 'compliance_edd'
         )
         AND ($2::UUID[] = '{}'::UUID[] OR id = ANY($2::UUID[]))`,
      [req.auth.userId, ids]
    );
    const announcementRead = await pool.query(
      `INSERT INTO announcement_reads (campaign_id, user_id)
       SELECT c.id, u.id
         FROM announcement_campaigns c
         JOIN users u ON u.id = $1
        WHERE c.status = 'sent'
          AND (
            c.audience = 'both'
            OR c.audience = u.account_type
            OR (c.audience = 'specific' AND c.target_user_id = u.id)
          )
          AND ($2::UUID[] = '{}'::UUID[] OR c.id = ANY($2::UUID[]))
       ON CONFLICT (campaign_id, user_id) DO NOTHING`,
      [req.auth.userId, ids]
    );
    res.json({ ok: true, read: rowCount + announcementRead.rowCount });
  } catch (error) {
    next(error);
  }
});

async function publishMessage(message) {
  const delivery = publishChatMessage(message);
  if (!delivery.recipient) return message;
  const delivered = await markMessageDelivered(message.id);
  if (delivered) publishChatStatus(delivered);
  return delivered || message;
}

router.get("/threads", async (req, res, next) => {
  try {
    res.json({ ok: true, threads: await listThreads(req.auth) });
  } catch (error) {
    next(error);
  }
});

router.post("/threads", async (req, res, next) => {
  try {
    const thread = await openThread(req.auth, req.body);
    res.status(200).json({ ok: true, thread });
  } catch (error) {
    next(error);
  }
});

router.post("/start", async (req, res, next) => {
  try {
    const thread = await openThread(req.auth, req.body);
    res.status(200).json({ ok: true, thread });
  } catch (error) {
    next(error);
  }
});

router.get("/users/lookup", resolveChatRecipient);
router.post("/users/lookup", resolveChatRecipient);
router.get("/users/resolve", resolveChatRecipient);
router.post("/users/resolve", resolveChatRecipient);

router.get("/messages", async (req, res, next) => {
  try {
    const messages = await listThreadMessages(req.auth, {
      threadId: req.query.threadId,
      participantId: req.query.participantId,
      identifier: req.query.identifier,
      recipient: req.query.recipient,
      mode: req.query.mode
    });
    messages.filter((item) => item.recipientId === req.auth.userId && item.read).forEach(publishChatStatus);
    res.json({ ok: true, messages });
  } catch (error) {
    next(error);
  }
});

router.get("/threads/:threadId/messages", async (req, res, next) => {
  try {
    const messages = await listThreadMessages(req.auth, {
      threadId: req.params.threadId,
      participantId: req.query.participantId,
      identifier: req.query.identifier,
      recipient: req.query.recipient,
      mode: req.query.mode
    });
    messages.filter((item) => item.recipientId === req.auth.userId && item.read).forEach(publishChatStatus);
    res.json({ ok: true, messages });
  } catch (error) {
    next(error);
  }
});

router.post("/messages", async (req, res, next) => {
  try {
    const message = await publishMessage(await createMessage(req.auth, req.body));
    res.status(201).json({ ok: true, message, delivered: message.status !== "sent" });
  } catch (error) {
    next(error);
  }
});

router.post("/threads/:threadId/messages", async (req, res, next) => {
  try {
    const message = await publishMessage(await createMessage(req.auth, { ...req.body, threadId: req.params.threadId }));
    res.status(201).json({ ok: true, message, delivered: message.status !== "sent" });
  } catch (error) {
    next(error);
  }
});

router.post("/threads/:threadId/read", async (req, res, next) => {
  try {
    const messages = await markThreadRead(req.auth, { threadId: req.params.threadId });
    messages.forEach(publishChatStatus);
    res.json({ ok: true, read: messages.length });
  } catch (error) {
    next(error);
  }
});

router.post("/threads/:threadId/mute", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await setThreadMuted(req.auth, req.params.threadId, true)) });
  } catch (error) {
    next(error);
  }
});

router.post("/threads/:threadId/unmute", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await setThreadMuted(req.auth, req.params.threadId, false)) });
  } catch (error) {
    next(error);
  }
});

router.post("/calls", async (req, res, next) => {
  try {
    throw new AppError(403, "Voice calls are available only through TitoPay Customer Care.");
  } catch (error) {
    next(error);
  }
});

router.get("/calls", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      calls: [],
      message: "Voice calls are available only through TitoPay Customer Care."
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/calls/:callId/end", async (req, res, next) => {
  try {
    throw new AppError(403, "Voice calls are available only through TitoPay Customer Care.");
  } catch (error) {
    next(error);
  }
});

router.post("/calls/:callId/end", async (req, res, next) => {
  try {
    throw new AppError(403, "Voice calls are available only through TitoPay Customer Care.");
  } catch (error) {
    next(error);
  }
});

module.exports = router;
