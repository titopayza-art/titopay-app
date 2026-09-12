"use strict";

const socketsByUser = new Map();
const supportAgentSockets = new Map();

function userKey(userId) {
  return String(userId || "").toLowerCase();
}

function registerChatClient(userId, socket) {
  const key = userKey(userId);
  if (!key) return () => {};
  if (!socketsByUser.has(key)) socketsByUser.set(key, new Set());
  socket.chatConnectedAt = new Date().toISOString();
  socketsByUser.get(key).add(socket);

  return () => {
    const sockets = socketsByUser.get(key);
    if (!sockets) return;
    sockets.delete(socket);
    if (!sockets.size) socketsByUser.delete(key);
  };
}

function registerSupportAgent(agentId, socket) {
  const key = userKey(agentId);
  if (!key) return () => {};
  if (!supportAgentSockets.has(key)) supportAgentSockets.set(key, new Set());
  socket.chatConnectedAt = new Date().toISOString();
  supportAgentSockets.get(key).add(socket);
  return () => {
    const sockets = supportAgentSockets.get(key);
    if (!sockets) return;
    sockets.delete(socket);
    if (!sockets.size) supportAgentSockets.delete(key);
  };
}

function getChatPresenceSnapshot() {
  const users = [];
  let connections = 0;
  for (const [userId, sockets] of socketsByUser.entries()) {
    const active = Array.from(sockets).filter((socket) => socket.readyState === 1);
    if (!active.length) continue;
    connections += active.length;
    users.push({
      userId,
      connections: active.length,
      connectedAt: active
        .map((socket) => socket.chatConnectedAt)
        .filter(Boolean)
        .sort()[0] || null
    });
  }
  return { users, userCount: users.length, connectionCount: connections };
}

function publishToUser(userId, payload) {
  const sockets = socketsByUser.get(userKey(userId));
  if (!sockets || !sockets.size) return 0;
  const encoded = JSON.stringify(payload);
  let delivered = 0;
  for (const socket of sockets) {
    if (socket.readyState !== 1) continue;
    socket.send(encoded);
    delivered += 1;
  }
  return delivered;
}

function publishChatMessage(message) {
  if (!message) return { sender: 0, recipient: 0 };
  const payload = { type: "chat:message", message };
  return {
    sender: publishToUser(message.senderId, payload),
    recipient: publishToUser(message.recipientId, payload)
  };
}

function publishChatStatus(message) {
  if (!message) return;
  const payload = { type: "chat:status", message };
  publishToUser(message.senderId, payload);
  publishToUser(message.recipientId, payload);
}

function publishChatSignal(userId, signal) {
  return publishToUser(userId, { type: "chat:signal", signal });
}

function publishToSupportAgents(payload, assignedAgentId = null) {
  const encoded = JSON.stringify(payload);
  let delivered = 0;
  for (const [agentId, sockets] of supportAgentSockets.entries()) {
    if (assignedAgentId && agentId !== userKey(assignedAgentId)) continue;
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue;
      socket.send(encoded);
      delivered += 1;
    }
  }
  return delivered;
}

function publishSupportEvent(customerId, event, options = {}) {
  const customer = publishToUser(customerId, event);
  const agents = options.broadcastAgents
    ? publishToSupportAgents(event, options.assignedAgentId || null)
    : 0;
  return { customer, agents };
}

module.exports = {
  getChatPresenceSnapshot,
  publishChatMessage,
  publishChatStatus,
  publishChatSignal,
  publishSupportEvent,
  publishToSupportAgents,
  publishToUser,
  registerChatClient,
  registerSupportAgent
};
