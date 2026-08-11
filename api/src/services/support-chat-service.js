"use strict";

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { generateUniqueTicketRef } = require("../lib/ticket-id");
const { getAdminRolePermissions, isRootAdminRole } = require("./auth-service");
const { writeAuditLog } = require("./audit-service");
const { publishSupportEvent } = require("../realtime/chat-hub");

const OPEN_CUSTOMER_STATES = new Set(["BOT_ACTIVE", "ESCALATED", "WAITING_FOR_AGENT", "AGENT_ACTIVE", "REOPENED"]);
const BOT_STATES = new Set(["BOT_ACTIVE"]);
const AGENT_MESSAGE_STATES = new Set(["AGENT_ACTIVE", "REOPENED"]);

async function safeAudit(entry) {
  try {
    await writeAuditLog(entry);
  } catch (error) {
    console.error({
      event: "support_chat_audit_failed",
      action: entry.action,
      conversationId: entry.entityId,
      error: error.message
    });
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function canSupport(role) {
  return isRootAdminRole(role) || getAdminRolePermissions(role).includes("*") ||
    getAdminRolePermissions(role).includes("support");
}

function publicMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderId: row.sender_user_id || row.sender_admin_id || null,
    senderName: row.sender_name || null,
    body: row.body,
    message: row.body,
    type: row.message_type,
    status: row.status,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at
  };
}

function publicConversation(row) {
  const customer = {
    id: row.customer_id,
    name: row.customer_name || row.customer_username || "TitoPay customer",
    full_name: row.customer_name,
    username: row.customer_username,
    accountIdentifier: row.customer_wallet_number || row.customer_username || row.customer_id,
    account_type: row.customer_account_type,
    accountType: row.customer_account_type
  };
  const assignedAgent = row.assigned_agent_id ? {
    id: row.assigned_agent_id,
    name: row.agent_name || row.agent_username || row.agent_email || "Support agent",
    full_name: row.agent_name,
    username: row.agent_username,
    email: row.agent_email
  } : null;
  return {
    id: row.id,
    client_thread_id: null,
    thread_type: "support",
    created_by: row.customer_id,
    ticketId: row.ticket_id,
    ticketRef: row.ticket_ref || null,
    status: row.status,
    escalationReason: row.escalation_reason,
    customer,
    participant_a: customer,
    participant_b: assignedAgent,
    assignedAgent,
    assignedAt: row.assigned_at,
    takenOverAt: row.taken_over_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    reopenedAt: row.reopened_at,
    lastMessageAt: row.last_message_at,
    last_message: row.latest_message_body || null,
    last_message_status: row.latest_message_status || null,
    last_message_sender_type: row.latest_message_sender_type || null,
    last_message_at: row.latest_message_at || row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    waitingSeconds: ["ESCALATED", "WAITING_FOR_AGENT"].includes(row.status)
      ? Math.max(0, Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 1000))
      : 0,
    metadata: row.metadata || {}
  };
}

const CONVERSATION_SELECT = `
  SELECT c.*, t.ticket_ref,
         u.full_name AS customer_name, u.username AS customer_username,
         u.account_type AS customer_account_type, w.wallet_number AS customer_wallet_number,
         a.full_name AS agent_name, a.username AS agent_username, a.email AS agent_email,
         latest.body AS latest_message_body, latest.sender_type AS latest_message_sender_type,
         latest.status AS latest_message_status, latest.created_at AS latest_message_at
    FROM support_conversations c
    JOIN users u ON u.id = c.customer_id
    LEFT JOIN support_tickets t ON t.id = c.ticket_id
    LEFT JOIN admin_users a ON a.id = c.assigned_agent_id
    LEFT JOIN LATERAL (
      SELECT wallet_number FROM wallets WHERE user_id = u.id ORDER BY created_at ASC LIMIT 1
    ) w ON TRUE
    LEFT JOIN LATERAL (
      SELECT body,sender_type,status,created_at
      FROM support_conversation_messages
      WHERE conversation_id=c.id
      ORDER BY created_at DESC,id DESC
      LIMIT 1
    ) latest ON TRUE`;

async function loadConversation(queryable, id, { forUpdate = false } = {}) {
  if (!isUuid(id)) throw new AppError(400, "Conversation ID is invalid");
  const { rows } = await queryable.query(
    `${CONVERSATION_SELECT} WHERE c.id = $1${forUpdate ? " FOR UPDATE OF c" : ""}`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, "Support conversation not found");
  return rows[0];
}

async function addEvent(client, conversationId, eventType, previousStatus, newStatus, actor, metadata = {}) {
  await client.query(
    `INSERT INTO support_conversation_events
       (conversation_id,event_type,previous_status,new_status,actor_type,actor_id,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB)`,
    [conversationId, eventType, previousStatus, newStatus, actor?.userType || "system", actor?.userId || null, JSON.stringify(metadata)]
  );
}

async function notifyCustomer(client, customerId, type, title, body, metadata = {}) {
  await client.query(
    `INSERT INTO notifications
       (id,user_id,channel,notification_type,title,body,status,provider,metadata,sent_at)
     VALUES ($1,$2,'in_app',$3,$4,$5,'sent','titopay',$6::JSONB,NOW())`,
    [uuidv4(), customerId, type, title, body, JSON.stringify(metadata)]
  );
}

async function appendMessage(client, {
  conversationId, senderType, senderUserId = null, senderAdminId = null,
  body, clientMessageId = null, messageType = "text", metadata = {}
}) {
  const text = boundedText(body, "Message", { min: 1, max: 4000 });
  const safeClientId = boundedText(clientMessageId || "", "Client message ID", { min: 0, max: 160 }) || null;
  const { rows } = await client.query(
    `INSERT INTO support_conversation_messages
       (conversation_id,sender_type,sender_user_id,sender_admin_id,body,message_type,status,client_message_id,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,'sent',$7,$8::JSONB)
     ON CONFLICT (conversation_id,sender_type,client_message_id)
       WHERE client_message_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [conversationId, senderType, senderUserId, senderAdminId, text, messageType, safeClientId, JSON.stringify(metadata)]
  );
  let row = rows[0];
  if (!row && safeClientId) {
    const existing = await client.query(
      `SELECT * FROM support_conversation_messages
       WHERE conversation_id=$1 AND sender_type=$2 AND client_message_id=$3 LIMIT 1`,
      [conversationId, senderType, safeClientId]
    );
    row = existing.rows[0];
  }
  if (!row) throw new AppError(409, "Unable to persist support message");
  await client.query(
    "UPDATE support_conversations SET last_message_at=$2, updated_at=$2 WHERE id=$1",
    [conversationId, row.created_at]
  );
  return publicMessage(row);
}

async function startBotSession(actor, requestedId = null, metadata = {}) {
  if (actor.userType !== "customer") throw new AppError(403, "Customer support access required");
  if (requestedId) {
    const existing = await loadConversation(pool, requestedId);
    if (existing.customer_id !== actor.userId) throw new AppError(403, "Conversation access denied");
    return existing;
  }
  const { rows } = await pool.query(
    `INSERT INTO support_conversations (customer_id,status,metadata)
     VALUES ($1,'BOT_ACTIVE',$2::JSONB)
     RETURNING *`,
    [actor.userId, JSON.stringify(metadata)]
  );
  await pool.query(
    `INSERT INTO support_conversation_events
       (conversation_id,event_type,previous_status,new_status,actor_type,actor_id)
     VALUES ($1,'bot_session_started',NULL,'BOT_ACTIVE','customer',$2)`,
    [rows[0].id, actor.userId]
  );
  return rows[0];
}

async function processBotExchange(actor, payload, answer) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let conversation;
    if (payload.conversationId) {
      conversation = await loadConversation(client, payload.conversationId, { forUpdate: true });
      if (conversation.customer_id !== actor.userId) throw new AppError(403, "Conversation access denied");
    } else {
      const created = await client.query(
        `INSERT INTO support_conversations (customer_id,status,metadata)
         VALUES ($1,'BOT_ACTIVE',$2::JSONB) RETURNING *`,
        [actor.userId, JSON.stringify({ channelProvider: payload.channelProvider || "web" })]
      );
      conversation = created.rows[0];
      await addEvent(client, conversation.id, "bot_session_started", null, "BOT_ACTIVE", actor);
    }
    if (!BOT_STATES.has(conversation.status)) {
      throw new AppError(409, conversation.status === "AGENT_ACTIVE"
        ? "A human support agent is handling this conversation"
        : "This chatbot conversation is no longer active");
    }
    const customerMessage = await appendMessage(client, {
      conversationId: conversation.id,
      senderType: "CUSTOMER",
      senderUserId: actor.userId,
      body: payload.message,
      clientMessageId: payload.clientMessageId
    });
    const botMessage = await appendMessage(client, {
      conversationId: conversation.id,
      senderType: "BOT",
      body: answer,
      clientMessageId: payload.botMessageId,
      metadata: { needsEscalation: Boolean(payload.needsEscalation) }
    });
    await client.query("COMMIT");
    const event = { type: "support:messages", conversationId: conversation.id, messages: [customerMessage, botMessage], status: "BOT_ACTIVE" };
    publishSupportEvent(actor.userId, event);
    return { conversationId: conversation.id, customerMessage, botMessage, status: "BOT_ACTIVE" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function escalateConversation(actor, payload = {}) {
  if (actor.userType !== "customer") throw new AppError(403, "Customer support access required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let conversation;
    if (payload.conversationId) {
      conversation = await loadConversation(client, payload.conversationId, { forUpdate: true });
      if (conversation.customer_id !== actor.userId) throw new AppError(403, "Conversation access denied");
      if (!["BOT_ACTIVE", "ESCALATED", "WAITING_FOR_AGENT"].includes(conversation.status)) {
        throw new AppError(409, "This conversation cannot be escalated");
      }
      if (conversation.status === "WAITING_FOR_AGENT") {
        await client.query("COMMIT");
        return { conversation: publicConversation(conversation), duplicate: true };
      }
    } else {
      const created = await client.query(
        "INSERT INTO support_conversations (customer_id,status,metadata) VALUES ($1,'BOT_ACTIVE',$2::JSONB) RETURNING *",
        [actor.userId, JSON.stringify({ channelProvider: payload.channelProvider || "web" })]
      );
      conversation = created.rows[0];
      if (payload.message) {
        await appendMessage(client, {
          conversationId: conversation.id,
          senderType: "CUSTOMER",
          senderUserId: actor.userId,
          body: payload.message,
          clientMessageId: payload.clientMessageId
        });
      }
    }
    const reason = boundedText(payload.reason || payload.message || "Customer requested a human support agent", "Escalation reason", { min: 2, max: 1000 });
    const ticketId = uuidv4();
    const ticketRef = await generateUniqueTicketRef(client, "TC");
    await client.query(
      `INSERT INTO support_tickets (id,ticket_ref,user_id,category,subject,message,status,assigned_to)
       VALUES ($1,$2,$3,'chatbot_escalation','Chatbot escalation: Live Chat',$4,'pending','Customer Care Queue')`,
      [ticketId, ticketRef, actor.userId, reason]
    );
    await client.query(
      `UPDATE support_conversations
       SET ticket_id=$2,status='ESCALATED',escalation_reason=$3,updated_at=NOW()
       WHERE id=$1`,
      [conversation.id, ticketId, reason]
    );
    await addEvent(client, conversation.id, "chatbot_escalated", conversation.status, "ESCALATED", actor, { ticketRef });
    await client.query(
      "UPDATE support_conversations SET status='WAITING_FOR_AGENT',updated_at=NOW() WHERE id=$1",
      [conversation.id]
    );
    await addEvent(client, conversation.id, "waiting_for_agent", "ESCALATED", "WAITING_FOR_AGENT", actor);
    const systemMessage = await appendMessage(client, {
      conversationId: conversation.id,
      senderType: "SYSTEM",
      messageType: "system",
      body: `Your conversation has been escalated to TitoPay Customer Care. Reference ${ticketRef}.`
    });
    const current = await loadConversation(client, conversation.id);
    await client.query("COMMIT");
    await safeAudit({
      actorType: actor.userType,
      actorId: actor.userId,
      action: "chatbot_escalated_to_support",
      entityType: "support_conversation",
      entityId: conversation.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { ticketId, ticketRef }
    });
    const item = publicConversation(current);
    publishSupportEvent(actor.userId, { type: "support:escalated", conversation: item, message: systemMessage }, { broadcastAgents: true });
    return { conversation: item, ticketRef, systemMessage, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function listConversations(actor, filters = {}) {
  const params = [];
  const where = [];
  if (actor.userType === "customer") {
    params.push(actor.userId);
    where.push(`c.customer_id = $${params.length}`);
  } else {
    if (!canSupport(actor.role)) throw new AppError(403, "Support permission required");
    const requested = String(filters.status || "").trim().toUpperCase();
    const aliases = {
      WAITING: ["ESCALATED", "WAITING_FOR_AGENT"],
      ACTIVE: ["AGENT_ACTIVE", "REOPENED"],
      RESOLVED: ["RESOLVED"],
      CLOSED: ["CLOSED"]
    };
    if (requested && aliases[requested]) {
      params.push(aliases[requested]);
      where.push(`c.status = ANY($${params.length}::TEXT[])`);
    }
    if (String(filters.mine) === "true") {
      params.push(actor.userId);
      where.push(`c.assigned_agent_id = $${params.length}`);
    }
    if (String(filters.unassigned) === "true") where.push("c.assigned_agent_id IS NULL");
  }
  const { rows } = await pool.query(
    `${CONVERSATION_SELECT}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY
       CASE WHEN c.status IN ('ESCALATED','WAITING_FOR_AGENT') THEN 0 ELSE 1 END,
       c.updated_at DESC
     LIMIT 250`,
    params
  );
  const items = rows.map(publicConversation);
  let counts = {
    waiting: items.filter((item) => ["ESCALATED", "WAITING_FOR_AGENT"].includes(item.status)).length,
    active: items.filter((item) => ["AGENT_ACTIVE", "REOPENED"].includes(item.status)).length,
    mine: actor.userType === "admin" ? items.filter((item) => item.assignedAgent?.id === actor.userId).length : 0,
    unassigned: items.filter((item) => !item.assignedAgent).length,
    resolved: items.filter((item) => item.status === "RESOLVED").length,
    closed: items.filter((item) => item.status === "CLOSED").length
  };
  if (actor.userType === "admin") {
    const summary = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('ESCALATED','WAITING_FOR_AGENT'))::INTEGER AS waiting,
         COUNT(*) FILTER (WHERE status IN ('AGENT_ACTIVE','REOPENED'))::INTEGER AS active,
         COUNT(*) FILTER (WHERE assigned_agent_id=$1)::INTEGER AS mine,
         COUNT(*) FILTER (WHERE assigned_agent_id IS NULL)::INTEGER AS unassigned,
         COUNT(*) FILTER (WHERE status='RESOLVED')::INTEGER AS resolved,
         COUNT(*) FILTER (WHERE status='CLOSED')::INTEGER AS closed
       FROM support_conversations`,
      [actor.userId]
    );
    counts = summary.rows[0] || counts;
  }
  return { items, counts };
}

async function getConversation(actor, id) {
  const row = await loadConversation(pool, id);
  if (actor.userType === "customer" && row.customer_id !== actor.userId) throw new AppError(403, "Conversation access denied");
  if (actor.userType === "admin" && !canSupport(actor.role)) throw new AppError(403, "Support permission required");
  return publicConversation(row);
}

async function listMessages(actor, id) {
  await getConversation(actor, id);
  const { rows } = await pool.query(
    `SELECT m.*,
            COALESCE(u.full_name,u.username,a.full_name,a.username,
              CASE m.sender_type WHEN 'BOT' THEN 'TitoPay Assistant' WHEN 'SYSTEM' THEN 'TitoPay' END) AS sender_name
       FROM support_conversation_messages m
       LEFT JOIN users u ON u.id=m.sender_user_id
       LEFT JOIN admin_users a ON a.id=m.sender_admin_id
      WHERE m.conversation_id=$1
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 500`,
    [id]
  );
  return rows.map(publicMessage);
}

async function markRead(actor, id) {
  const conversation = await loadConversation(pool, id);
  let senderTypes;
  if (actor.userType === "customer") {
    if (conversation.customer_id !== actor.userId) throw new AppError(403, "Conversation access denied");
    senderTypes = ["BOT", "AGENT", "SYSTEM"];
  } else {
    if (!canSupport(actor.role)) throw new AppError(403, "Support permission required");
    senderTypes = ["CUSTOMER"];
  }
  const { rows } = await pool.query(
    `UPDATE support_conversation_messages
     SET status='read',delivered_at=COALESCE(delivered_at,NOW()),read_at=COALESCE(read_at,NOW())
     WHERE conversation_id=$1 AND sender_type=ANY($2::TEXT[]) AND read_at IS NULL
     RETURNING id,conversation_id,sender_type,status,delivered_at,read_at`,
    [id, senderTypes]
  );
  if (rows.length) {
    publishSupportEvent(conversation.customer_id, {
      type: "support:read",
      conversationId: id,
      messageIds: rows.map((row) => row.id),
      readAt: rows[0].read_at
    }, { broadcastAgents: true });
  }
  return rows.length;
}

async function takeover(actor, id) {
  if (actor.userType !== "admin" || !canSupport(actor.role)) throw new AppError(403, "Support permission required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await loadConversation(client, id, { forUpdate: true });
    if (conversation.status === "AGENT_ACTIVE" && conversation.assigned_agent_id !== actor.userId) {
      throw new AppError(409, "This conversation has already been assigned to another support agent.");
    }
    if (!["ESCALATED", "WAITING_FOR_AGENT"].includes(conversation.status)) {
      if (conversation.status === "AGENT_ACTIVE" && conversation.assigned_agent_id === actor.userId) {
        await client.query("COMMIT");
        return publicConversation(conversation);
      }
      throw new AppError(409, `Conversation cannot be taken over from ${conversation.status}`);
    }
    const { rows } = await client.query(
      `UPDATE support_conversations
       SET status='AGENT_ACTIVE',assigned_agent_id=$2,assigned_at=COALESCE(assigned_at,NOW()),
           taken_over_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND status IN ('ESCALATED','WAITING_FOR_AGENT') AND assigned_agent_id IS NULL
       RETURNING *`,
      [id, actor.userId]
    );
    if (!rows[0]) throw new AppError(409, "This conversation has already been assigned to another support agent.");
    if (conversation.ticket_id) {
      await client.query(
        "UPDATE support_tickets SET status='in_progress',assigned_to=$2,updated_at=NOW() WHERE id=$1",
        [conversation.ticket_id, actor.email || actor.username || actor.userId]
      );
    }
    await addEvent(client, id, "agent_takeover", conversation.status, "AGENT_ACTIVE", actor);
    const message = await appendMessage(client, {
      conversationId: id,
      senderType: "SYSTEM",
      messageType: "system",
      body: `${actor.fullName || actor.username || "A TitoPay support agent"} has joined the conversation.`
    });
    await notifyCustomer(
      client,
      conversation.customer_id,
      "support_agent_joined",
      "A support agent joined",
      "A TitoPay support agent has joined your conversation.",
      { conversationId: id }
    );
    const current = await loadConversation(client, id);
    await client.query("COMMIT");
    await safeAudit({
      actorType: actor.userType, actorId: actor.userId, action: "support_chat_takeover",
      entityType: "support_conversation", entityId: id,
      ipAddress: actor.ipAddress, userAgent: actor.userAgent
    });
    const item = publicConversation(current);
    publishSupportEvent(item.customer.id, { type: "support:takeover", conversation: item, message }, { broadcastAgents: true });
    return item;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function sendMessage(actor, id, payload = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await loadConversation(client, id, { forUpdate: true });
    let senderType;
    if (actor.userType === "customer") {
      if (conversation.customer_id !== actor.userId) throw new AppError(403, "Conversation access denied");
      if (!OPEN_CUSTOMER_STATES.has(conversation.status)) throw new AppError(409, "This support conversation is not open");
      senderType = "CUSTOMER";
    } else {
      if (!canSupport(actor.role)) throw new AppError(403, "Support permission required");
      if (!AGENT_MESSAGE_STATES.has(conversation.status)) throw new AppError(409, "Take over this conversation before replying");
      if (conversation.assigned_agent_id !== actor.userId) throw new AppError(403, "This conversation is assigned to another support agent");
      senderType = "AGENT";
    }
    const message = await appendMessage(client, {
      conversationId: id,
      senderType,
      senderUserId: senderType === "CUSTOMER" ? actor.userId : null,
      senderAdminId: senderType === "AGENT" ? actor.userId : null,
      body: payload.message || payload.body,
      clientMessageId: payload.clientMessageId
    });
    if (senderType === "AGENT") {
      await notifyCustomer(
        client,
        conversation.customer_id,
        "support_message",
        "New Customer Care message",
        "A TitoPay support agent replied to your conversation.",
        { conversationId: id, messageId: message.id }
      );
    }
    await client.query("COMMIT");
    if (senderType === "AGENT") {
      await safeAudit({
        actorType: actor.userType, actorId: actor.userId, action: "support_agent_message_sent",
        entityType: "support_conversation", entityId: id,
        ipAddress: actor.ipAddress, userAgent: actor.userAgent,
        metadata: { messageId: message.id }
      });
    }
    const delivery = publishSupportEvent(
      conversation.customer_id,
      { type: "support:message", conversationId: id, message },
      { broadcastAgents: true }
    );
    const delivered = senderType === "AGENT" ? delivery.customer > 0 : delivery.agents > 0;
    if (delivered) {
      const updated = await pool.query(
        `UPDATE support_conversation_messages
         SET status='delivered',delivered_at=COALESCE(delivered_at,NOW())
         WHERE id=$1 AND status='sent'
         RETURNING delivered_at`,
        [message.id]
      );
      if (updated.rows[0]) {
        message.status = "delivered";
        message.deliveredAt = updated.rows[0].delivered_at;
        publishSupportEvent(conversation.customer_id, {
          type: "support:status", conversationId: id, message
        }, { broadcastAgents: true });
      }
    }
    return message;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assign(actor, id, targetAgentId, action = "assign") {
  if (actor.userType !== "admin" || !canSupport(actor.role)) throw new AppError(403, "Support permission required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await loadConversation(client, id, { forUpdate: true });
    if (
      conversation.assigned_agent_id &&
      conversation.assigned_agent_id !== actor.userId &&
      !isRootAdminRole(actor.role)
    ) {
      throw new AppError(403, "This conversation is assigned to another support agent");
    }
    if (action === "transferred" && !targetAgentId) {
      throw new AppError(400, "Target agent is required");
    }
    let target = null;
    if (targetAgentId) {
      const result = await client.query(
        "SELECT id,role,status,full_name,username,email FROM admin_users WHERE id=$1 LIMIT 1",
        [targetAgentId]
      );
      target = result.rows[0];
      if (!target || target.status !== "active" || !canSupport(target.role)) {
        throw new AppError(400, "Target agent is not authorised for support");
      }
    }
    const nextStatus = target
      ? (["ESCALATED", "WAITING_FOR_AGENT"].includes(conversation.status) ? "AGENT_ACTIVE" : conversation.status)
      : (["AGENT_ACTIVE", "REOPENED"].includes(conversation.status) ? "WAITING_FOR_AGENT" : conversation.status);
    const { rows } = await client.query(
      `UPDATE support_conversations
       SET assigned_agent_id=$2,
           assigned_at=CASE WHEN $2::UUID IS NULL THEN NULL ELSE NOW() END,
           taken_over_at=CASE WHEN $2::UUID IS NULL THEN taken_over_at ELSE COALESCE(taken_over_at,NOW()) END,
           status=$3,updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, target?.id || null, nextStatus]
    );
    if (conversation.ticket_id) {
      await client.query(
        "UPDATE support_tickets SET status=$2,assigned_to=$3,updated_at=NOW() WHERE id=$1",
        [conversation.ticket_id, target ? "in_progress" : "pending", target?.email || target?.username || "Customer Care Queue"]
      );
    }
    await addEvent(client, id, `agent_${action}`, conversation.status, nextStatus, actor, {
      previousAgentId: conversation.assigned_agent_id, assignedAgentId: target?.id || null
    });
    const current = await loadConversation(client, id);
    await client.query("COMMIT");
    await safeAudit({
      actorType: actor.userType, actorId: actor.userId, action: `support_chat_${action}`,
      entityType: "support_conversation", entityId: id,
      ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      metadata: { previousAgentId: conversation.assigned_agent_id, assignedAgentId: target?.id || null }
    });
    const item = publicConversation(current);
    publishSupportEvent(item.customer.id, { type: `support:${action}`, conversation: item }, { broadcastAgents: true });
    return item;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function transition(actor, id, action) {
  if (actor.userType !== "admin" || !canSupport(actor.role)) throw new AppError(403, "Support permission required");
  const rules = {
    resolve: { from: ["AGENT_ACTIVE", "REOPENED"], to: "RESOLVED", column: "resolved_at" },
    close: { from: ["RESOLVED", "AGENT_ACTIVE", "REOPENED"], to: "CLOSED", column: "closed_at" },
    reopen: { from: ["RESOLVED", "CLOSED"], to: "REOPENED", column: "reopened_at" }
  };
  const rule = rules[action];
  if (!rule) throw new AppError(400, "Unsupported support action");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await loadConversation(client, id, { forUpdate: true });
    if (!rule.from.includes(conversation.status)) throw new AppError(409, `Conversation cannot be ${action}d from ${conversation.status}`);
    if (action !== "reopen" && conversation.assigned_agent_id && conversation.assigned_agent_id !== actor.userId && !isRootAdminRole(actor.role)) {
      throw new AppError(403, "This conversation is assigned to another support agent");
    }
    const { rows } = await client.query(
      `UPDATE support_conversations SET status=$2,${rule.column}=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, rule.to]
    );
    if (conversation.ticket_id) {
      await client.query(
        "UPDATE support_tickets SET status=$2,updated_at=NOW() WHERE id=$1",
        [conversation.ticket_id, action === "reopen" ? "in_progress" : action === "resolve" ? "resolved" : "closed"]
      );
    }
    await addEvent(client, id, `conversation_${action}d`, conversation.status, rule.to, actor);
    const systemMessage = await appendMessage(client, {
      conversationId: id, senderType: "SYSTEM", messageType: "system",
      body: `This support conversation has been ${action === "reopen" ? "reopened" : `${action}d`}.`
    });
    await notifyCustomer(
      client,
      conversation.customer_id,
      `support_${action}d`,
      `Support conversation ${action === "reopen" ? "reopened" : `${action}d`}`,
      `Your TitoPay support conversation has been ${action === "reopen" ? "reopened" : `${action}d`}.`,
      { conversationId: id }
    );
    const current = await loadConversation(client, id);
    await client.query("COMMIT");
    await safeAudit({
      actorType: actor.userType, actorId: actor.userId, action: `support_chat_${action}d`,
      entityType: "support_conversation", entityId: id,
      ipAddress: actor.ipAddress, userAgent: actor.userAgent
    });
    const item = publicConversation(current);
    publishSupportEvent(item.customer.id, { type: `support:${action}d`, conversation: item, message: systemMessage }, { broadcastAgents: true });
    return item;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  canSupport,
  startBotSession,
  processBotExchange,
  escalateConversation,
  listConversations,
  getConversation,
  listMessages,
  markRead,
  takeover,
  sendMessage,
  assign,
  transition
};
