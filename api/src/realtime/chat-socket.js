"use strict";

const { WebSocketServer } = require("ws");
const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { verifyAccessToken } = require("../lib/jwt");
const {
  createMessage,
  markMessageDelivered,
  markThreadRead,
  resolveChatTarget
} = require("../services/chat-service");
const {
  publishChatMessage,
  publishChatSignal,
  publishChatStatus,
  registerChatClient,
  registerSupportAgent
} = require("./chat-hub");
const { isVerifiedTitoPayUser } = require("../lib/chat-policy");
const { writeSecurityLog } = require("../services/audit-service");
const { canSupport, sendMessage: sendSupportMessage } = require("../services/support-chat-service");

async function authenticateSocket(request) {
  const host = request.headers.host || "api.titopay.co.za";
  const url = new URL(request.url, `https://${host}`);
  const protocols = String(request.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim());
  const bearerProtocol = protocols.find((value) => value.startsWith("bearer."));
  const token = bearerProtocol ? bearerProtocol.slice(7) : url.searchParams.get("token");
  if (!token) throw new Error("Missing token");

  const decoded = verifyAccessToken(token);
  const { rows: sessionRows } = await pool.query(
    `SELECT *
     FROM sessions
     WHERE id = $1
       AND access_jti = $2
       AND revoked_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [decoded.sid, decoded.jti]
  );
  const session = sessionRows[0];
  if (!session || !["customer", "admin"].includes(session.user_type)) throw new Error("Invalid chat session");
  if (decoded.sub !== session.user_id || decoded.typ !== session.user_type) throw new Error("Invalid chat token");
  if (new Date(session.last_activity_at).getTime() < Date.now() - (config.sessionIdleTimeoutSeconds * 1000)) {
    throw new Error("Expired chat session");
  }

  const accountTable = session.user_type === "admin" ? "admin_users" : "users";
  const { rows: userRows } = await pool.query(
    `SELECT * FROM ${accountTable} WHERE id = $1 LIMIT 1`,
    [session.user_id]
  );
  const user = userRows[0];
  if (!user || user.status !== "active") throw new Error("Inactive chat user");
  if (session.user_type === "customer" && !isVerifiedTitoPayUser(user)) throw new Error("Unverified chat user");
  if (session.user_type === "admin" && !canSupport(user.role)) throw new Error("Support permission required");
  await pool.query("UPDATE sessions SET last_activity_at = NOW() WHERE id = $1", [session.id]);

  return {
    sessionId: session.id,
    userId: user.id,
    userType: session.user_type,
    accountType: user.account_type,
    role: session.user_type === "admin" ? user.role : "customer",
    fullName: user.full_name || null,
    email: user.email,
    username: user.username,
    ipAddress: request.socket.remoteAddress,
    userAgent: request.headers["user-agent"] || ""
  };
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function socketFailureReason(error) {
  const value = String(error?.message || "").toLowerCase();
  if (value.includes("origin")) return "origin_not_allowed";
  if (value.includes("missing token")) return "missing_token";
  if (value.includes("expired")) return "session_expired";
  if (value.includes("unverified")) return "user_not_verified";
  if (value.includes("inactive")) return "user_inactive";
  return "authentication_failed";
}

function attachChatSocketServer(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols(protocols) {
      return protocols.has("titopay-chat") ? "titopay-chat" : false;
    }
  });

  server.on("upgrade", async (request, socket, head) => {
    const pathname = new URL(request.url, `https://${request.headers.host || "api.titopay.co.za"}`).pathname;
    if (pathname !== "/v1/chat/socket" && pathname !== "/api/chat/socket") return;
    try {
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) throw new Error("Origin not allowed");
      request.chatAuth = await authenticateSocket(request);
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } catch (error) {
      writeSecurityLog({
        actorType: "unknown",
        eventType: "titopay_chat_socket_connection_failed",
        severity: "warning",
        ipAddress: request.socket.remoteAddress,
        userAgent: request.headers["user-agent"] || "",
        success: false,
        metadata: { reason: socketFailureReason(error) }
      }).catch(() => null);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (socket, request) => {
    const actor = request.chatAuth;
    socket.isAlive = true;
    const unregister = actor.userType === "admin"
      ? registerSupportAgent(actor.userId, socket)
      : registerChatClient(actor.userId, socket);
    send(socket, { type: "chat:ready", userId: actor.userId, userType: actor.userType });

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", async (raw) => {
      try {
        const event = JSON.parse(String(raw || "{}"));
        if (event.type === "support:send") {
          const message = await sendSupportMessage(actor, event.payload?.conversationId, {
            message: event.payload?.message,
            clientMessageId: event.clientMessageId || event.payload?.clientMessageId
          });
          send(socket, { type: "support:ack", clientMessageId: event.clientMessageId || null, message });
          return;
        }

        if (actor.userType === "admin") {
          send(socket, { type: "chat:error", code: "support_events_only", message: "This admin socket accepts support-chat events only." });
          return;
        }

        if (event.type === "chat:send") {
          const message = await createMessage(actor, {
            ...event.payload,
            localMessageId: event.clientMessageId || event.payload?.localMessageId
          });
          const delivery = publishChatMessage(message);
          const current = delivery.recipient ? await markMessageDelivered(message.id) : message;
          if (current !== message) publishChatStatus(current);
          send(socket, { type: "chat:ack", clientMessageId: event.clientMessageId || null, message: current });
          return;
        }

        if (event.type === "chat:read") {
          const messages = await markThreadRead(actor, event.payload || {});
          messages.forEach(publishChatStatus);
          send(socket, { type: "chat:read:ack", read: messages.length });
          return;
        }

        if (event.type === "chat:typing") {
          const target = await resolveChatTarget(actor, event.payload || {});
          publishChatSignal(target.recipientId, {
            kind: "typing",
            threadId: target.thread.id,
            senderId: actor.userId,
            active: Boolean(event.payload?.active),
            at: new Date().toISOString()
          });
          return;
        }

        if (["call:offer", "call:answer", "call:ice", "call:end", "call:mute"].includes(event.type)) {
          send(socket, {
            type: "chat:error",
            code: "customer_care_calls_only",
            message: "Voice calls are available only through TitoPay Customer Care."
          });
          return;
        }
      } catch (error) {
        writeSecurityLog({
          actorType: actor.userType,
          actorId: actor.userId,
          eventType: "titopay_chat_socket_error",
          severity: "warning",
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          success: false,
          metadata: { error: error.message }
        }).catch(() => null);
        send(socket, { type: "chat:error", message: "TitoPay Chat could not process that request." });
      }
    });

    socket.on("close", unregister);
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30000);
  wss.on("close", () => clearInterval(heartbeat));
}

module.exports = { attachChatSocketServer };
