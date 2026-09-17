"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const { isVerifiedTitoPayUser } = require("../src/lib/chat-policy");
const {
  createMessage,
  markMessageDelivered,
  markThreadRead
} = require("../src/services/chat-service");

const senderId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const actor = {
  userId: senderId,
  userType: "customer",
  ipAddress: "127.0.0.1",
  userAgent: "node-test"
};

test.after(() => pool.end());

test("chat policy accepts only active users with approved verification", () => {
  assert.equal(isVerifiedTitoPayUser({ status: "active", fica_status: "approved" }), true);
  assert.equal(isVerifiedTitoPayUser({ status: "active", fica_status: "verified" }), true);
  assert.equal(isVerifiedTitoPayUser({ status: "active", fica_status: "pending" }), false);
  assert.equal(isVerifiedTitoPayUser({ status: "active", fica_status: "pending", wallet_id: "9152641376" }), true);
  assert.equal(isVerifiedTitoPayUser({ id: senderId, status: "active", fica_status: "pending" }), false);
  assert.equal(isVerifiedTitoPayUser({ status: "suspended", fica_status: "approved" }), false);
});

test("first send creates a thread and an idempotent retry returns the original message", async () => {
  let threadCreated = false;
  let messageCreated = false;
  let messageInsertAttempts = 0;
  const originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT users.id, users.status, users.fica_status")) {
      return { rows: [{ id: senderId, status: "active", fica_status: "approved", wallet_id: "9152641376" }] };
    }
    if (query.includes("FROM chat_threads") && query.includes("id::TEXT")) {
      return { rows: threadCreated ? [{
        id: threadId,
        client_thread_id: "client-thread-1",
        participant_a: senderId,
        participant_b: recipientId,
        thread_type: "direct",
        status: "active"
      }] : [] };
    }
    if (query.startsWith("SELECT id, username") && query.includes("WHERE id = $1")) {
      return { rows: [{
        id: recipientId,
        username: "verified-user",
        account_type: "personal",
        full_name: "Verified User",
        status: "active",
        fica_status: "approved",
        wallet_id: "9152641377"
      }] };
    }
    if (query.startsWith("INSERT INTO chat_threads")) {
      threadCreated = true;
      return { rows: [{
        id: threadId,
        client_thread_id: "client-thread-1",
        participant_a: senderId,
        participant_b: recipientId,
        thread_type: "direct",
        status: "active"
      }] };
    }
    if (query.startsWith("INSERT INTO chat_messages")) {
      messageInsertAttempts += 1;
      if (messageCreated) return { rows: [] };
      messageCreated = true;
      return { rows: [{
        id: messageId,
        thread_id: threadId,
        sender_user_id: senderId,
        recipient_user_id: recipientId,
        body: "Hello",
        message_type: "text",
        status: "sent",
        client_message_id: "client-message-1",
        metadata: {},
        created_at: new Date().toISOString()
      }] };
    }
    if (query.startsWith("SELECT * FROM chat_messages WHERE sender_user_id")) {
      return { rows: [{
        id: messageId,
        thread_id: threadId,
        sender_user_id: senderId,
        recipient_user_id: recipientId,
        body: "Hello",
        message_type: "text",
        status: "sent",
        client_message_id: "client-message-1",
        metadata: {},
        created_at: new Date().toISOString()
      }] };
    }
    return { rows: [] };
  };

  try {
    const payload = {
      threadId: "client-thread-1",
      participantId: recipientId,
      message: "Hello",
      localMessageId: "client-message-1"
    };
    const first = await createMessage(actor, payload);
    const retry = await createMessage(actor, payload);
    assert.equal(first.id, messageId);
    assert.equal(retry.id, messageId);
    assert.equal(first.status, "sent");
    assert.equal(messageInsertAttempts, 2);
  } finally {
    pool.query = originalQuery;
  }
});

test("delivery and read transitions return public receipt timestamps", async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT users.id, users.status, users.fica_status")) {
      return { rows: [{ id: recipientId, status: "active", fica_status: "approved", wallet_id: "9152641377" }] };
    }
    if (query.startsWith("UPDATE chat_messages") && query.includes("delivered_at")) {
      return { rows: [{
        id: messageId,
        thread_id: threadId,
        sender_user_id: senderId,
        recipient_user_id: recipientId,
        body: "Hello",
        message_type: "text",
        status: query.includes("read_at") ? "read" : "delivered",
        delivered_at: new Date().toISOString(),
        read_at: query.includes("read_at") ? new Date().toISOString() : null,
        metadata: {}
      }] };
    }
    if (query.includes("FROM chat_threads")) {
      return { rows: [{
        id: threadId,
        participant_a: senderId,
        participant_b: recipientId,
        status: "active"
      }] };
    }
    return { rows: [] };
  };

  try {
    const delivered = await markMessageDelivered(messageId);
    const read = await markThreadRead({ ...actor, userId: recipientId }, { threadId });
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.delivered, true);
    assert.equal(read[0].status, "read");
    assert.equal(read[0].read, true);
  } finally {
    pool.query = originalQuery;
  }
});
