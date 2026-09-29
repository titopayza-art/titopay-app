"use strict";

// A CONVERSATION CLOSED FROM THE CONSOLE COULD NEVER BE USED AGAIN.
//
// Reported from the app: a chat that worked at 09:05 refused every message by
// 19:22, showing "This conversation is not available" and marking each one
// failed. The cause was not in the app. chat_threads.status had been set to
// 'archived' by the admin console's close action, every chat path refused
// anything that was not 'active', and NOTHING on the platform ever set a
// thread back to 'active'. A close was permanent and silent.
//
// The distinction these tests defend is that blocked and archived are not the
// same thing. Archived is housekeeping and a new message undoes it; blocked is
// a refusal and must stay one, or "block" would mean nothing.

const test = require("node:test");
const assert = require("node:assert/strict");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const chat = require("../src/services/chat-service");

let seq = 0;
async function makeUser(label) {
  const id = uuidv4();
  // wallet_number is constrained to ^[0-9]{1,10}$ and phone must be digits, so
  // both are built from a counter rather than from the uuid - a hex tag fails
  // the check constraint, which is how the first run of this file failed.
  seq += 1;
  const n = String(seq).padStart(4, "0");
  const stamp = String(Date.now()).slice(-6);
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,$2,$3,$4,$5,'personal','active','verified','x')`,
    [id, label, `${label.toLowerCase()}_${stamp}${n}`, `${label.toLowerCase()}_${stamp}${n}@test.local`,
      `+2782${stamp}${n.slice(0, 1)}`]
  );
  // Chat requires a verified customer holding a wallet.
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, wallet_number, status)
     VALUES ($1,$2,'personal','ZAR',$3,'active')`,
    [uuidv4(), id, `${stamp}${n}`]
  );
  return { id, actor: { userId: id, userType: "customer" } };
}

async function conversation() {
  const a = await makeUser("Sender");
  const b = await makeUser("Receiver");
  const sent = await chat.createMessage(a.actor, { participantId: b.id, message: "Hello" });
  const { rows } = await pool.query(
    "SELECT * FROM chat_threads WHERE $1::UUID IN (participant_a, participant_b) ORDER BY created_at DESC LIMIT 1",
    [a.id]);
  return { a, b, thread: rows[0], sent };
}

const setStatus = (id, status) =>
  pool.query("UPDATE chat_threads SET status = $2 WHERE id = $1", [id, status]);

test("the reported failure: a message into an archived conversation used to be refused forever", async () => {
  const { a, thread } = await conversation();
  // Exactly what POST /admin/support/conversations/:id/close does.
  await setStatus(thread.id, "archived");

  const reply = await chat.createMessage(a.actor, { threadId: thread.id, message: "Hi" });
  assert.ok(reply, "the message must go through rather than 403");

  const { rows } = await pool.query("SELECT status, metadata FROM chat_threads WHERE id = $1", [thread.id]);
  assert.equal(rows[0].status, "active", "writing again is the signal it was not finished");
  assert.ok(rows[0].metadata.reopened_at, "the reopen is recorded, not silent");
  assert.equal(rows[0].metadata.reopened_by, "participant_message");
});

test("the other participant can reopen it too, not only whoever wrote first", async () => {
  const { b, thread } = await conversation();
  await setStatus(thread.id, "archived");
  await chat.createMessage(b.actor, { threadId: thread.id, message: "Still stuck here" });
  const { rows } = await pool.query("SELECT status FROM chat_threads WHERE id = $1", [thread.id]);
  assert.equal(rows[0].status, "active");
});

test("A BLOCKED CONVERSATION STAYS BLOCKED - nobody writes their way back in", async () => {
  const { a, b, thread } = await conversation();
  await setStatus(thread.id, "blocked");
  await assert.rejects(
    chat.createMessage(a.actor, { threadId: thread.id, message: "let me in" }),
    /This conversation is not available/);
  await assert.rejects(
    chat.createMessage(b.actor, { threadId: thread.id, message: "or me" }),
    /This conversation is not available/);
  const { rows } = await pool.query("SELECT status FROM chat_threads WHERE id = $1", [thread.id]);
  assert.equal(rows[0].status, "blocked", "a block must survive being written to");
});

test("reading an archived conversation is allowed, and does not reopen it", async () => {
  const { a, thread } = await conversation();
  await setStatus(thread.id, "archived");

  // The customer's own history must stay readable - refusing it is what made
  // the closed chat look broken rather than closed.
  const messages = await chat.listThreadMessages(a.actor, { threadId: thread.id });
  assert.ok(Array.isArray(messages) && messages.length >= 1, "history stays readable");

  const { rows } = await pool.query("SELECT status FROM chat_threads WHERE id = $1", [thread.id]);
  assert.equal(rows[0].status, "archived",
    "merely looking must not undo an agent's tidy-up - only writing does");
});

test("reading a blocked conversation is still refused", async () => {
  const { a, thread } = await conversation();
  await setStatus(thread.id, "blocked");
  await assert.rejects(chat.listThreadMessages(a.actor, { threadId: thread.id }),
    /This conversation is not available/);
});

test("typing and call signalling do not reopen an archived conversation", async () => {
  const { a, thread } = await conversation();
  await setStatus(thread.id, "archived");
  // resolveChatTarget serves typing dots. A typing indicator is not somebody
  // saying something, so it must not undo a close on its own.
  await chat.resolveChatTarget(a.actor, { threadId: thread.id });
  const { rows } = await pool.query("SELECT status FROM chat_threads WHERE id = $1", [thread.id]);
  assert.equal(rows[0].status, "archived");
});

test("an active conversation is untouched by any of this", async () => {
  const { a, thread } = await conversation();
  await chat.createMessage(a.actor, { threadId: thread.id, message: "normal" });
  const { rows } = await pool.query("SELECT status, metadata FROM chat_threads WHERE id = $1", [thread.id]);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].metadata.reopened_at, undefined,
    "a thread that was never closed must not be stamped as reopened");
});

test.after(async () => { await pool.end().catch(() => null); });
