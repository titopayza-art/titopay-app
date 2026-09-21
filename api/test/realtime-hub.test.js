"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getChatPresenceSnapshot,
  publishChatMessage,
  publishChatSignal,
  publishChatStatus,
  registerChatClient
} = require("../src/realtime/chat-hub");

function client() {
  return {
    readyState: 1,
    events: [],
    send(payload) {
      this.events.push(JSON.parse(payload));
    }
  };
}

test("realtime hub emits messages instantly to sender and recipient", () => {
  const sender = client();
  const recipient = client();
  const unregisterSender = registerChatClient("sender", sender);
  const unregisterRecipient = registerChatClient("recipient", recipient);
  try {
    const delivery = publishChatMessage({
      id: "message-1",
      senderId: "sender",
      recipientId: "recipient",
      status: "sent"
    });
    assert.deepEqual(delivery, { sender: 1, recipient: 1 });
    assert.equal(sender.events[0].type, "chat:message");
    assert.equal(recipient.events[0].type, "chat:message");
    const presence = getChatPresenceSnapshot();
    assert.equal(presence.userCount, 2);
    assert.equal(presence.connectionCount, 2);
    assert.equal(presence.users.every((item) => item.connectedAt), true);
  } finally {
    unregisterSender();
    unregisterRecipient();
  }
  assert.equal(getChatPresenceSnapshot().userCount, 0);
});

test("realtime hub emits typing and receipt updates", () => {
  const recipient = client();
  const unregister = registerChatClient("recipient", recipient);
  try {
    publishChatSignal("recipient", { kind: "typing", active: true });
    publishChatStatus({ id: "message-1", senderId: "sender", recipientId: "recipient", status: "read" });
    assert.deepEqual(recipient.events.map((event) => event.type), [
      "chat:signal",
      "chat:status"
    ]);
    assert.equal(recipient.events[0].signal.kind, "typing");
    assert.equal(recipient.events[1].message.status, "read");
  } finally {
    unregister();
  }
});
