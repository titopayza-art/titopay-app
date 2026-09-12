"use strict";

const { pool } = require("../db/pool");
const { v4: uuidv4 } = require("uuid");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { isVerifiedTitoPayUser } = require("../lib/chat-policy");
const { recipientLookupValues, recipientPhoneLookupValues } = require("./security-service");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function normalizeThreadMode(mode = "direct") {
  return String(mode || "").includes("business") ? "business_to_customer" : "direct";
}

function orderedParticipantIds(currentUserId, otherUserId) {
  return [currentUserId, otherUserId].sort();
}

async function requireVerifiedChatActor(actor) {
  if (!actor || actor.userType !== "customer") {
    throw new AppError(403, "TitoPay Chat is available to verified customers only");
  }
  const { rows } = await pool.query(
    `SELECT users.id, users.status, users.fica_status, w.wallet_number AS wallet_id
       FROM users
       LEFT JOIN LATERAL (
         SELECT wallet_number
         FROM wallets
         WHERE user_id = users.id
         ORDER BY created_at ASC
         LIMIT 1
       ) w ON TRUE
      WHERE users.id = $1
      LIMIT 1`,
    [actor.userId]
  );
  if (!isVerifiedTitoPayUser(rows[0])) {
    throw new AppError(403, "Complete TitoPay verification to use Chat");
  }
}

async function findUserByIdentifier(payload = {}) {
  const lookupValues = recipientLookupValues(payload).map((value) => String(value).toLowerCase());
  const phoneLookupValues = recipientPhoneLookupValues(payload);
  if (!lookupValues.length && !phoneLookupValues.length) return null;

  const { rows } = await pool.query(
    `SELECT id, username, email, phone, account_type, full_name, status, fica_status,
            profile_photo_url, business_logo_url, w.wallet_number AS wallet_id
     FROM users
     LEFT JOIN LATERAL (
       SELECT wallet_number
       FROM wallets
       WHERE user_id = users.id
       ORDER BY created_at ASC
       LIMIT 1
     ) w ON TRUE
     WHERE LOWER(username) = ANY($1::TEXT[])
        OR LOWER(email) = ANY($1::TEXT[])
        OR LOWER(phone) = ANY($1::TEXT[])
        OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = ANY($2::TEXT[])
     LIMIT 1`,
    [lookupValues, phoneLookupValues]
  );
  return rows[0] || null;
}

async function resolveParticipant(actor, payload = {}) {
  const recipientObject = payload.recipient && typeof payload.recipient === "object" ? payload.recipient : null;
  const directId = payload.participantId || payload.participant_id || payload.recipientId || payload.recipient_id ||
    recipientObject?.id || recipientObject?.userId || recipientObject?.user_id;

  if (isUuid(directId)) {
    const { rows } = await pool.query(
      `SELECT id, username, email, phone, account_type, full_name, status, fica_status,
              profile_photo_url, business_logo_url, w.wallet_number AS wallet_id
       FROM users
       LEFT JOIN LATERAL (
         SELECT wallet_number
         FROM wallets
         WHERE user_id = users.id
         ORDER BY created_at ASC
         LIMIT 1
       ) w ON TRUE
       WHERE id = $1
       LIMIT 1`,
      [directId]
    );
    const user = rows[0];
    if (user) return user;
  }

  const identifier = payload.identifier || payload.recipientIdentifier ||
    recipientObject?.username || recipientObject?.phone || recipientObject?.mobile || recipientObject?.msisdn || recipientObject?.email ||
    (typeof payload.recipient === "string" ? payload.recipient : "") ||
    payload.q;
  const user = await findUserByIdentifier({ ...payload, identifier, recipient: identifier });
  if (user) return user;
  return null;
}

async function getThreadByClientId(actor, clientThreadId) {
  if (!clientThreadId) return null;
  const { rows } = await pool.query(
    `SELECT *
     FROM chat_threads
     WHERE client_thread_id = $1
       AND ($2::UUID IN (participant_a, participant_b))
     LIMIT 1`,
    [clientThreadId, actor.userId]
  );
  return rows[0] || null;
}

async function getThreadByIdOrClientId(actor, threadRef) {
  if (!threadRef) return null;
  const { rows } = await pool.query(
    `SELECT *
     FROM chat_threads
     WHERE (id::TEXT = $1 OR client_thread_id = $1)
       AND ($2::UUID IN (participant_a, participant_b))
     LIMIT 1`,
    [String(threadRef), actor.userId]
  );
  return rows[0] || null;
}

async function getOrCreateThread(actor, payload = {}) {
  await requireVerifiedChatActor(actor);
  const mode = normalizeThreadMode(payload.mode);
  const clientThreadId = boundedText(payload.threadId || payload.clientThreadId || "", "Thread ID", { min: 0, max: 160 }) || null;
  const existing = await getThreadByIdOrClientId(actor, clientThreadId);
  if (existing) {
    if (existing.status !== "active") throw new AppError(403, "This conversation is not available");
    return existing;
  }

  const participant = await resolveParticipant(actor, payload);
  if (!isVerifiedTitoPayUser(participant)) {
    throw new AppError(404, "Verified TitoPay user not found");
  }
  if (participant.id === actor.userId) {
    throw new AppError(400, "You cannot start a chat with yourself");
  }

  const [participantA, participantB] = orderedParticipantIds(actor.userId, participant.id);
  const metadata = {
    title: payload.title || payload.recipient?.fullName || payload.recipient?.username || participant.full_name || participant.username,
    clientThreadIds: clientThreadId ? [clientThreadId] : []
  };

  const { rows } = await pool.query(
    `INSERT INTO chat_threads
       (client_thread_id, participant_a, participant_b, thread_type, created_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (participant_a, participant_b, thread_type)
     DO UPDATE SET
       client_thread_id = COALESCE(chat_threads.client_thread_id, EXCLUDED.client_thread_id),
       metadata = chat_threads.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [clientThreadId, participantA, participantB, mode, actor.userId, JSON.stringify(metadata)]
  );

  return rows[0];
}

function publicMessage(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: row.id,
    clientMessageId: row.client_message_id || metadata.clientMessageId || null,
    threadId: row.thread_id,
    senderId: row.sender_user_id,
    recipientId: row.recipient_user_id,
    text: row.body,
    message: row.body,
    type: row.message_type,
    status: row.status,
    delivered: Boolean(row.delivered_at),
    read: Boolean(row.read_at),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at
  };
}

function publicThread(row) {
  const participant = {
    id: row.participant_id,
    userId: row.participant_id,
    username: row.participant_username,
    email: row.participant_email,
    phone: row.participant_phone,
    accountType: row.participant_account_type,
    fullName: row.participant_full_name,
    profilePhotoUrl: row.participant_account_type === "business"
      ? row.participant_business_logo_url
      : row.participant_profile_photo_url,
    verificationStatus: row.participant_fica_status,
    verified: isVerifiedTitoPayUser({
      status: row.participant_status,
      fica_status: row.participant_fica_status
    }),
    name: row.participant_full_name || row.participant_username || row.participant_phone || row.participant_email || "TitoPay user"
  };
  return {
    id: row.id,
    threadId: row.id,
    clientThreadId: row.client_thread_id,
    mode: row.thread_type,
    status: row.status,
    participant,
    title: participant.name,
    subtitle: participant.username ? `@${String(participant.username).replace(/^@/, "")}` : participant.phone || participant.email || "TitoPay user",
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    unreadCount: Number(row.unread_count || 0),
    muted: Boolean(row.muted),
    lastMessage: row.last_message_body ? {
      id: row.last_message_id,
      senderId: row.last_message_sender_id,
      recipientId: row.last_message_recipient_id,
      text: row.last_message_body,
      message: row.last_message_body,
      status: row.last_message_status,
      createdAt: row.last_message_created_at
    } : null
  };
}

async function listThreads(actor) {
  await requireVerifiedChatActor(actor);
  const { rows } = await pool.query(
    `SELECT
       t.*,
       u.id AS participant_id,
       u.username AS participant_username,
       u.email AS participant_email,
       u.phone AS participant_phone,
       u.account_type AS participant_account_type,
       u.full_name AS participant_full_name,
       u.status AS participant_status,
       u.fica_status AS participant_fica_status,
       u.profile_photo_url AS participant_profile_photo_url,
       u.business_logo_url AS participant_business_logo_url,
       lm.id AS last_message_id,
       lm.sender_user_id AS last_message_sender_id,
       lm.recipient_user_id AS last_message_recipient_id,
       lm.body AS last_message_body,
       lm.status AS last_message_status,
       lm.created_at AS last_message_created_at,
       COALESCE(unread.unread_count, 0) AS unread_count,
       COALESCE(settings.muted, FALSE) AS muted
     FROM chat_threads t
     JOIN users u
       ON u.id = CASE WHEN t.participant_a = $1 THEN t.participant_b ELSE t.participant_a END
     LEFT JOIN LATERAL (
       SELECT *
       FROM chat_messages m
       WHERE m.thread_id = t.id
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::INTEGER AS unread_count
       FROM chat_messages unread_message
       WHERE unread_message.thread_id = t.id
         AND unread_message.recipient_user_id = $1
         AND unread_message.read_at IS NULL
     ) unread ON TRUE
     LEFT JOIN chat_thread_participant_settings settings
       ON settings.thread_id=t.id AND settings.user_id=$1
     WHERE $1::UUID IN (t.participant_a, t.participant_b)
     ORDER BY t.updated_at DESC
     LIMIT 100`,
    [actor.userId]
  );
  return rows.map(publicThread);
}

async function listThreadMessages(actor, payload = {}) {
  await requireVerifiedChatActor(actor);
  let thread = await getThreadByIdOrClientId(actor, payload.threadId || payload.clientThreadId);
  if (!thread && (payload.participantId || payload.identifier || payload.recipient)) {
    thread = await getOrCreateThread(actor, payload);
  }
  if (!thread) return [];
  if (thread.status !== "active") throw new AppError(403, "This conversation is not available");

  await markThreadRead(actor, { threadId: thread.id });

  const { rows } = await pool.query(
    `SELECT *
     FROM chat_messages
     WHERE thread_id = $1
     ORDER BY created_at ASC
     LIMIT 200`,
    [thread.id]
  );
  return rows.map(publicMessage);
}

async function openThread(actor, payload = {}) {
  const thread = await getOrCreateThread(actor, payload);
  const threads = await listThreads(actor);
  return threads.find((item) => item.id === thread.id) || {
    id: thread.id,
    threadId: thread.id,
    clientThreadId: thread.client_thread_id,
    mode: thread.thread_type,
    status: thread.status,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at
  };
}

async function createMessage(actor, payload = {}) {
  const body = boundedText(payload.message || payload.text || payload.body, "Message", { min: 1, max: 4000 });
  const thread = await getOrCreateThread(actor, payload);
  const recipientId = thread.participant_a === actor.userId ? thread.participant_b : thread.participant_a;
  const clientMessageId = boundedText(
    payload.localMessageId || payload.clientMessageId || payload.messageId || "",
    "Client message ID",
    { min: 0, max: 160 }
  ) || null;

  const { rows } = await pool.query(
    `INSERT INTO chat_messages
       (thread_id, sender_user_id, recipient_user_id, body, message_type, status, client_message_id, metadata)
     VALUES ($1,$2,$3,$4,'text','sent',$5,$6)
     ON CONFLICT (sender_user_id, client_message_id)
       WHERE client_message_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [thread.id, actor.userId, recipientId, body, clientMessageId, JSON.stringify({ clientMessageId })]
  );
  if (!rows[0]) {
    const existing = await pool.query(
      "SELECT * FROM chat_messages WHERE sender_user_id = $1 AND client_message_id = $2 LIMIT 1",
      [actor.userId, clientMessageId]
    );
    return publicMessage(existing.rows[0]);
  }

  await pool.query("UPDATE chat_threads SET updated_at = NOW() WHERE id = $1", [thread.id]);
  const settings = await pool.query(
    `SELECT muted FROM chat_thread_participant_settings
     WHERE thread_id=$1 AND user_id=$2 LIMIT 1`,
    [thread.id, recipientId]
  );
  if (!settings.rows[0]?.muted) await pool.query(
    `INSERT INTO notifications
       (id, user_id, channel, notification_type, title, body, status, provider, metadata, sent_at, delivered_at)
     VALUES ($4,$1,'in_app','titopay_chat','New TitoPay Chat message',$2,'sent','titopay',$3,NOW(),NULL)`,
    [
      recipientId,
      body.length > 140 ? `${body.slice(0, 137)}...` : body,
      JSON.stringify({
        threadId: thread.id,
        senderId: actor.userId,
        messageId: rows[0].id,
        clientMessageId
      }),
      uuidv4()
    ]
  ).catch((error) => {
    console.error({ event: "chat_notification_persist_failed", messageId: rows[0].id, error: error.message });
  });
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "titopay_chat_message_sent",
    entityType: "chat_thread",
    entityId: thread.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { recipientId }
  });

  return publicMessage(rows[0]);
}

async function setThreadMuted(actor, threadRef, muted) {
  await requireVerifiedChatActor(actor);
  const thread = await getThreadByIdOrClientId(actor, threadRef);
  if (!thread) throw new AppError(404, "Conversation not found");
  await pool.query(
    `INSERT INTO chat_thread_participant_settings (thread_id,user_id,muted,updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (thread_id,user_id)
     DO UPDATE SET muted=EXCLUDED.muted,updated_at=NOW()`,
    [thread.id, actor.userId, Boolean(muted)]
  );
  return { threadId: thread.id, muted: Boolean(muted) };
}

async function markMessageDelivered(messageId) {
  if (!isUuid(messageId)) return null;
  const { rows } = await pool.query(
    `UPDATE chat_messages
     SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END,
         delivered_at = COALESCE(delivered_at, NOW())
     WHERE id = $1
     RETURNING *`,
    [messageId]
  );
  if (rows[0]) {
    await pool.query(
      `UPDATE notifications
       SET status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END,
           delivered_at = COALESCE(delivered_at, NOW()),
           updated_at = NOW()
       WHERE notification_type = 'titopay_chat'
         AND metadata->>'messageId' = $1`,
      [messageId]
    );
  }
  return rows[0] ? publicMessage(rows[0]) : null;
}

async function markThreadRead(actor, payload = {}) {
  await requireVerifiedChatActor(actor);
  const thread = await getThreadByIdOrClientId(actor, payload.threadId || payload.clientThreadId);
  if (!thread) return [];
  if (thread.status !== "active") throw new AppError(403, "This conversation is not available");
  const { rows } = await pool.query(
    `UPDATE chat_messages
     SET status = 'read',
         delivered_at = COALESCE(delivered_at, NOW()),
         read_at = COALESCE(read_at, NOW())
     WHERE thread_id = $1
       AND recipient_user_id = $2
       AND read_at IS NULL
     RETURNING *`,
    [thread.id, actor.userId]
  );
  return rows.map(publicMessage);
}

async function resolveChatTarget(actor, payload = {}) {
  const thread = await getOrCreateThread(actor, payload);
  const recipientId = thread.participant_a === actor.userId ? thread.participant_b : thread.participant_a;
  return { thread, recipientId };
}

async function createCallLog(actor, payload = {}) {
  const thread = await getOrCreateThread(actor, payload);
  const recipientId = thread.participant_a === actor.userId ? thread.participant_b : thread.participant_a;
  const { rows } = await pool.query(
    `INSERT INTO chat_call_logs
       (thread_id, caller_user_id, recipient_user_id, call_type, status, metadata)
     VALUES ($1,$2,$3,'voice','initiated',$4)
     RETURNING *`,
    [thread.id, actor.userId, recipientId, JSON.stringify({ media: "audio_only", encryption: payload.encryption || "webrtc_dtls_srtp" })]
  );

  await writeSecurityLog({
    actorType: actor.userType,
    actorId: actor.userId,
    eventType: "titopay_chat_voice_call_initiated",
    severity: "info",
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    success: true,
    metadata: { recipientId, threadId: thread.id }
  });

  return {
    id: rows[0].id,
    threadId: rows[0].thread_id,
    status: rows[0].status,
    callType: rows[0].call_type,
    startedAt: rows[0].started_at
  };
}

async function listCallLogs(actor, payload = {}) {
  await requireVerifiedChatActor(actor);
  let thread = null;
  if (payload.threadId || payload.clientThreadId) {
    thread = await getThreadByIdOrClientId(actor, payload.threadId || payload.clientThreadId);
  }

  const params = [actor.userId];
  let where = "$1::UUID IN (caller_user_id, recipient_user_id)";
  if (thread) {
    params.push(thread.id);
    where += ` AND thread_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM chat_call_logs
     WHERE ${where}
     ORDER BY started_at DESC
     LIMIT 50`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    callerId: row.caller_user_id,
    recipientId: row.recipient_user_id,
    callType: row.call_type,
    direction: row.caller_user_id === actor.userId ? "outgoing" : "incoming",
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds
  }));
}

async function endCallLog(actor, payload = {}) {
  await requireVerifiedChatActor(actor);
  const callId = payload.callId || payload.id;
  let where = "id = $1 AND $2::UUID IN (caller_user_id, recipient_user_id)";
  let params = [callId, actor.userId];
  if (!isUuid(callId)) {
    const target = await resolveChatTarget(actor, payload);
    where = `id = (
      SELECT id FROM chat_call_logs
      WHERE thread_id = $1
        AND $2::UUID IN (caller_user_id, recipient_user_id)
        AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    )`;
    params = [target.thread.id, actor.userId];
  }
  const { rows } = await pool.query(
    `UPDATE chat_call_logs
     SET status = 'ended',
         ended_at = COALESCE(ended_at, NOW()),
         duration_seconds = COALESCE(duration_seconds, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER))
     WHERE ${where}
     RETURNING *`,
    params
  );
  if (!rows[0]) throw new AppError(404, "Call not found");
  return {
    id: rows[0].id,
    threadId: rows[0].thread_id,
    status: rows[0].status,
    callType: rows[0].call_type,
    startedAt: rows[0].started_at,
    endedAt: rows[0].ended_at,
    durationSeconds: rows[0].duration_seconds
  };
}

module.exports = {
  createCallLog,
  createMessage,
  endCallLog,
  listCallLogs,
  listThreads,
  listThreadMessages,
  markMessageDelivered,
  markThreadRead,
  setThreadMuted,
  openThread,
  requireVerifiedChatActor,
  resolveChatTarget
};
