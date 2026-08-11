"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "support-test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "support-test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");
const {
  processBotExchange,
  takeover,
  sendMessage,
  canSupport
} = require("../src/services/support-chat-service");
const {
  publishSupportEvent,
  registerChatClient,
  registerSupportAgent
} = require("../src/realtime/chat-hub");

const conversationId = "11111111-1111-4111-8111-111111111111";
const customerId = "22222222-2222-4222-8222-222222222222";
const agentOneId = "33333333-3333-4333-8333-333333333333";
const agentTwoId = "44444444-4444-4444-8444-444444444444";
const ticketId = "55555555-5555-4555-8555-555555555555";

test.after(() => pool.end());

function socket() {
  return {
    readyState: 1,
    events: [],
    send(raw) {
      this.events.push(JSON.parse(raw));
    }
  };
}

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function conversation(status, assignedAgentId = null) {
  const now = new Date().toISOString();
  return {
    id: conversationId,
    ticket_id: ticketId,
    ticket_ref: "TC123456",
    customer_id: customerId,
    customer_name: "Customer",
    customer_username: "customer",
    customer_account_type: "personal",
    customer_wallet_number: "1234567890",
    status,
    escalation_reason: "Human requested",
    assigned_agent_id: assignedAgentId,
    agent_name: assignedAgentId ? "Support Agent" : null,
    agent_username: assignedAgentId ? "support" : null,
    created_at: now,
    updated_at: now
  };
}

test("support RBAC accepts only explicitly authorised support roles", () => {
  assert.equal(canSupport("customer_support"), true);
  assert.equal(canSupport("super_admin"), true);
  assert.equal(canSupport("marketing"), false);
  assert.equal(canSupport("finance"), false);
});

test("Admin support ticket actions commit atomically and resolved notifications match the production schema", async () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const accessJti = "88888888-8888-4888-8888-888888888888";
  const token = signAccessToken({
    sub: agentOneId,
    sid: sessionId,
    jti: accessJti,
    typ: "admin",
    role: "super_admin",
    scope: "admin"
  });
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const commits = [];
  const notifications = [];
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT s.* FROM sessions s")) {
      return { rows: [{
        id: sessionId,
        user_id: agentOneId,
        user_type: "admin",
        access_jti: accessJti,
        last_activity_at: new Date(),
        expires_at: new Date(Date.now() + 60000)
      }] };
    }
    if (query.startsWith("SELECT * FROM admin_users")) {
      return { rows: [{
        id: agentOneId,
        user_type: "admin",
        role: "super_admin",
        status: "active",
        full_name: "Support Admin",
        username: "support-admin",
        email: "support@example.invalid"
      }] };
    }
    if (query.startsWith("UPDATE sessions SET last_activity_at")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected support auth query: ${query}`);
  };
  pool.connect = async () => ({
    release() {},
    async query(sql, params = []) {
      const query = String(sql).replace(/\s+/g, " ").trim();
      if (query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
      if (query === "COMMIT") {
        commits.push(true);
        return { rows: [] };
      }
      if (query.startsWith("UPDATE support_tickets")) {
        return { rows: [{
          id: ticketId,
          ticket_ref: "TC123456",
          user_id: customerId,
          status: params[1],
          assigned_to: params[2]
        }] };
      }
      if (query.startsWith("INSERT INTO notifications")) {
        notifications.push(query);
        assert.doesNotMatch(query, /\bdelivered_at\b/i);
        return { rows: [{ id: "99999999-9999-4999-8999-999999999999" }] };
      }
      if (query.startsWith("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected support action query: ${query}`);
    }
  });
  try {
    await withServer(async (baseUrl) => {
      for (const status of ["in_progress", "escalated", "resolved", "pending"]) {
        const response = await fetch(`${baseUrl}/v1/admin/support/tickets/${ticketId}/status`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ status })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).item.status, status);
      }
    });
    assert.equal(commits.length, 4);
    assert.equal(notifications.length, 1);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  }
});

test("chatbot exchange persists customer and bot messages in one transaction", async () => {
  const originalConnect = pool.connect;
  const insertedTypes = [];
  const client = {
    release() {},
    async query(sql, params = []) {
      const query = String(sql).replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
      if (query.startsWith("SELECT c.*")) return { rows: [conversation("BOT_ACTIVE")] };
      if (query.startsWith("INSERT INTO support_conversation_messages")) {
        insertedTypes.push(params[1]);
        return { rows: [{
          id: `${insertedTypes.length}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.slice(0, 36),
          conversation_id: conversationId,
          sender_type: params[1],
          sender_user_id: params[2],
          sender_admin_id: params[3],
          body: params[4],
          message_type: params[5],
          status: "sent",
          client_message_id: params[6],
          created_at: new Date().toISOString()
        }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  pool.connect = async () => client;
  try {
    const result = await processBotExchange(
      { userType: "customer", userId: customerId },
      { conversationId, message: "I need help", clientMessageId: "customer-1" },
      "How can I help?"
    );
    assert.deepEqual(insertedTypes, ["CUSTOMER", "BOT"]);
    assert.equal(result.status, "BOT_ACTIVE");
  } finally {
    pool.connect = originalConnect;
  }
});

test("chatbot is suppressed after a human agent takes over", async () => {
  const originalConnect = pool.connect;
  let rolledBack = false;
  pool.connect = async () => ({
    release() {},
    async query(sql) {
      const query = String(sql).replace(/\s+/g, " ").trim();
      if (query === "ROLLBACK") rolledBack = true;
      if (query.startsWith("SELECT c.*")) return { rows: [conversation("AGENT_ACTIVE", agentOneId)] };
      return { rows: [] };
    }
  });
  try {
    await assert.rejects(
      () => processBotExchange(
        { userType: "customer", userId: customerId },
        { conversationId, message: "Are you there?" },
        "Automatic bot response"
      ),
      /human support agent is handling/
    );
    assert.equal(rolledBack, true);
  } finally {
    pool.connect = originalConnect;
  }
});

test("atomic takeover assigns one agent and rejects the second agent", async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  let state = conversation("WAITING_FOR_AGENT");
  const statements = [];
  function client() {
    return {
      release() {},
      async query(sql, params = []) {
        const query = String(sql).replace(/\s+/g, " ").trim();
        statements.push(query);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
        if (query.startsWith("SELECT c.*")) return { rows: [{ ...state }] };
        if (query.startsWith("UPDATE support_conversations SET status='AGENT_ACTIVE'")) {
          if (state.status !== "WAITING_FOR_AGENT" || state.assigned_agent_id) return { rows: [] };
          state = { ...state, status: "AGENT_ACTIVE", assigned_agent_id: params[1], agent_name: "Support Agent" };
          return { rows: [{ ...state }] };
        }
        if (query.startsWith("INSERT INTO support_conversation_messages")) {
          return { rows: [{
            id: "66666666-6666-4666-8666-666666666666",
            conversation_id: conversationId,
            sender_type: "SYSTEM",
            body: params[4],
            message_type: "system",
            status: "sent",
            created_at: new Date().toISOString()
          }] };
        }
        return { rows: [], rowCount: 1 };
      }
    };
  }
  pool.connect = async () => client();
  pool.query = async () => ({ rows: [], rowCount: 1 });
  const agentOne = { userType: "admin", userId: agentOneId, role: "customer_support", username: "agent-one" };
  const agentTwo = { userType: "admin", userId: agentTwoId, role: "customer_support", username: "agent-two" };
  try {
    const won = await takeover(agentOne, conversationId);
    assert.equal(won.status, "AGENT_ACTIVE");
    assert.equal(won.assignedAgent.id, agentOneId);
    await assert.rejects(
      () => takeover(agentTwo, conversationId),
      /already been assigned to another support agent/
    );
    assert.equal(statements.some((query) => query.includes("FOR UPDATE OF c")), true);
    assert.equal(statements.some((query) => query.includes("assigned_agent_id IS NULL")), true);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test("an agent cannot message a conversation assigned to another agent", async () => {
  const originalConnect = pool.connect;
  let messageInserted = false;
  pool.connect = async () => ({
    release() {},
    async query(sql) {
      const query = String(sql).replace(/\s+/g, " ").trim();
      if (query.startsWith("SELECT c.*")) return { rows: [conversation("AGENT_ACTIVE", agentOneId)] };
      if (query.startsWith("INSERT INTO support_conversation_messages")) messageInserted = true;
      return { rows: [] };
    }
  });
  try {
    await assert.rejects(
      () => sendMessage(
        { userType: "admin", userId: agentTwoId, role: "customer_support" },
        conversationId,
        { message: "Unauthorised reply" }
      ),
      /assigned to another support agent/
    );
    assert.equal(messageInserted, false);
  } finally {
    pool.connect = originalConnect;
  }
});

test("support realtime events reach the customer and authorised agent channel", () => {
  const customer = socket();
  const agent = socket();
  const unregisterCustomer = registerChatClient(customerId, customer);
  const unregisterAgent = registerSupportAgent(agentOneId, agent);
  try {
    const delivery = publishSupportEvent(
      customerId,
      { type: "support:message", conversationId },
      { broadcastAgents: true }
    );
    assert.deepEqual(delivery, { customer: 1, agents: 1 });
    assert.equal(customer.events[0].type, "support:message");
    assert.equal(agent.events[0].conversationId, conversationId);
  } finally {
    unregisterCustomer();
    unregisterAgent();
  }
});

test("schema and routes expose the complete support lifecycle without altering financial tables", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8");
  const routes = fs.readFileSync(path.join(__dirname, "../src/routes/admin-support.routes.js"), "utf8");
  for (const table of ["support_conversations", "support_conversation_messages", "support_conversation_events"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const state of ["BOT_ACTIVE", "ESCALATED", "WAITING_FOR_AGENT", "AGENT_ACTIVE", "RESOLVED", "CLOSED", "REOPENED"]) {
    assert.match(schema, new RegExp(state));
  }
  for (const endpoint of ["takeover", "messages", "assign", "transfer", "resolve", "close", "reopen"]) {
    assert.match(routes, new RegExp(endpoint));
  }
  assert.doesNotMatch(schema, /ALTER TABLE wallets ADD COLUMN.*support/i);
  assert.doesNotMatch(schema, /ALTER TABLE transactions ADD COLUMN.*support/i);
});

test("customer and admin support conversation routes are registered and JWT protected", async () => {
  await withServer(async (baseUrl) => {
    for (const route of [
      "/v1/support/conversations",
      "/v1/admin/support/conversations"
    ]) {
      const response = await fetch(`${baseUrl}${route}`);
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.match(body.error, /Bearer token required/);
      assert.equal("stack" in body, false);
    }
  });
});
