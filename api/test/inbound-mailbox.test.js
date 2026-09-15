"use strict";

// THE MAILBOX HALF OF SUPPORT EMAIL, TESTED AGAINST A REAL IMAP SERVER.
//
// test/helpers/fake-imap-server speaks the actual protocol over actual TLS, so
// these exercise the wire format rather than a mock of our own methods. The
// bugs that matter in an IMAP client - literals, a body that contains a brace,
// a credential with a newline in it - only exist at that level.

const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const { createFakeImap } = require("./helpers/fake-imap-server");
const { connectImap, parseLogicalLine, quoted, ImapError } = require("../src/lib/imap-client");
const mailbox = require("../src/services/inbound-mailbox-service");

function message({ id = "a@example.com", from = "Kagiso Dlamini <kagiso@example.com>",
  subject = "I cannot log in", body = "My app will not open.\r\n" } = {}) {
  return `Message-ID: <${id}>\r\nFrom: ${from}\r\nTo: support@titopay.co.za\r\n`
    + `Subject: ${subject}\r\nDate: Mon, 14 Sep 2026 09:00:00 +0200\r\n`
    + `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
}

async function withMailbox(messages, run, { settings = {} } = {}) {
  const fake = createFakeImap({ messages, ...(settings.fakeOptions || {}) });
  const connection = await fake.listen();
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    `UPDATE inbound_mailbox_settings
        SET enabled = TRUE, host = $1, port = $2, username = 'support@titopay.co.za',
            password_encrypted = $3, mailbox = 'INBOX',
            max_messages_per_poll = $4, max_message_bytes = $5,
            last_error = NULL, consecutive_failures = 0
      WHERE id = TRUE`,
    [connection.host, connection.port, mailbox.encryptSecret("app-password"),
      settings.maxMessagesPerPoll || 25, settings.maxMessageBytes || 2 * 1024 * 1024]
  );
  try {
    return await run({ fake, connection,
      poll: () => mailbox.pollMailbox({ overrides: { ca: connection.ca, servername: connection.servername } }) });
  } finally {
    await fake.close();
  }
}

async function reset() {
  await pool.query("DELETE FROM inbound_emails").catch(() => null);
  await pool.query("DELETE FROM support_ticket_replies").catch(() => null);
  await pool.query("DELETE FROM support_tickets WHERE channel = 'email'").catch(() => null);
}

/* ------------------------------------------------------- the wire format */

test("a literal is read by its declared length, not to the next line break", () => {
  // The body contains CRLFs and a decoy {99} marker. Reading to the next line
  // break would truncate it at "one"; reading 30 bytes gets all of it.
  const payload = "one\r\ntwo {99}\r\n";
  const raw = Buffer.from(`* 1 FETCH (UID 4 BODY[] {${payload.length}}\r\n${payload})\r\n`, "utf8");
  const line = parseLogicalLine(raw);
  assert.ok(line, "the line should parse");
  const literal = line.parts.find((part) => part.type === "literal");
  assert.equal(literal.value.toString("utf8"), payload);
  assert.equal(line.consumed, raw.length);
});

test("an incomplete literal waits for the rest instead of returning a short read", () => {
  const raw = Buffer.from("* 1 FETCH (UID 4 BODY[] {20}\r\nonly-ten..", "utf8");
  assert.equal(parseLogicalLine(raw), null);
});

test("a literal larger than the ceiling is refused rather than allocated", () => {
  const raw = Buffer.from("* 1 FETCH (UID 4 BODY[] {999999999}\r\n", "utf8");
  assert.throws(() => parseLogicalLine(raw), /Refusing a 999999999-byte literal/);
});

test("a credential containing a newline is refused, not escaped", () => {
  // In a line protocol a CRLF ends the command. Escaping is not good enough
  // here because there is no escape for a line break inside a quoted string -
  // the only safe answer is to refuse the value.
  assert.throws(() => quoted("pass\r\nA1 DELETE INBOX", "password"), /may not contain line breaks/);
  assert.throws(() => quoted("user\nX", "username"), /may not contain line breaks/);
  assert.equal(quoted('say "hi"', "username"), '"say \\"hi\\""');
  assert.equal(quoted("back\\slash", "username"), '"back\\\\slash"');
});

test("a newline in the password never reaches the wire as a second command", async () => {
  const fake = createFakeImap({ messages: [] });
  const connection = await fake.listen();
  await assert.rejects(
    connectImap({ ...connection, user: "support@titopay.co.za", password: "x\r\nA9 DELETE INBOX" }),
    /may not contain line breaks/
  );
  // The proof that matters: the server never saw a DELETE at all.
  assert.equal(fake.state.commands.filter((c) => /DELETE/i.test(c)).length, 0);
  await fake.close();
});

test("a rejected sign-in reports the server's own words and no password", async () => {
  const fake = createFakeImap({ messages: [] });
  const connection = await fake.listen();
  await assert.rejects(
    connectImap({ ...connection, user: "support@titopay.co.za", password: "BADPASS" }),
    (error) => {
      assert.ok(error instanceof ImapError);
      assert.match(error.message, /AUTHENTICATIONFAILED/);
      assert.ok(!error.message.includes("BADPASS"), "the password must never appear in an error");
      return true;
    }
  );
  await fake.close();
});

/* ------------------------------------------------------------- the poll */

test("an email in the mailbox becomes a support ticket", async () => {
  await reset();
  await withMailbox([{ uid: 11, raw: message({ subject: "I cannot log in" }) }], async ({ poll }) => {
    const result = await poll();
    assert.equal(result.ingested, 1, JSON.stringify(result));
    const { rows } = await pool.query(
      "SELECT ticket_ref, subject, channel, contact_email, status FROM support_tickets WHERE channel = 'email'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, "I cannot log in");
    assert.equal(rows[0].contact_email, "kagiso@example.com");
    assert.match(rows[0].ticket_ref, /^TP\d{6}$/);
  });
});

test("a ticket from email is marked unverified, so nothing can be actioned from it", async () => {
  await reset();
  await withMailbox([{ uid: 12, raw: message({ id: "verify@x" }) }], async ({ poll }) => {
    await poll();
    const { rows } = await pool.query(
      "SELECT channel, identity_verified_at FROM support_tickets WHERE channel = 'email'");
    assert.equal(rows[0].channel, "email");
    assert.equal(rows[0].identity_verified_at, null,
      "an emailed request must never arrive pre-verified - a From header is a claim");
  });
});

test("\\Seen is set only after the message is stored", async () => {
  await reset();
  await withMailbox([{ uid: 13, raw: message({ id: "seen@x" }) }], async ({ fake, poll }) => {
    assert.equal(fake.state.messages[0].seen, false, "starts unread");
    await poll();
    assert.equal(fake.state.messages[0].seen, true, "read only once it is safely ours");
    // And the order on the wire: the body was fetched with PEEK before STORE.
    const fetchAt = fake.state.commands.findIndex((c) => /BODY\.PEEK\[\]/i.test(c));
    const storeAt = fake.state.commands.findIndex((c) => /STORE.*Seen/i.test(c));
    assert.ok(fetchAt !== -1 && storeAt !== -1 && fetchAt < storeAt);
    assert.equal(fake.state.commands.filter((c) => /BODY\[\]/i.test(c) && !/PEEK/i.test(c)).length, 0,
      "a non-PEEK fetch would mark the message read before it was stored");
  });
});

test("a message left unread by a failure is collected on the next poll", async () => {
  await reset();
  // The server refuses the body fetch once. The message must stay unread.
  let refused = false;
  const fake = createFakeImap({
    messages: [{ uid: 14, raw: message({ id: "retry@x" }) }],
    onCommand: (rest, { tag, socket }) => {
      if (/BODY\.PEEK\[\]/i.test(rest) && !refused) {
        refused = true;
        socket.write(`${tag} NO temporary failure\r\n`);
        return "handled";
      }
      return null;
    }
  });
  const connection = await fake.listen();
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    `UPDATE inbound_mailbox_settings SET enabled = TRUE, host = $1, port = $2,
       username = 'support@titopay.co.za', password_encrypted = $3 WHERE id = TRUE`,
    [connection.host, connection.port, mailbox.encryptSecret("pw")]);
  const overrides = { ca: connection.ca, servername: connection.servername };

  const first = await mailbox.pollMailbox({ overrides });
  assert.equal(first.ingested, 0);
  assert.equal(fake.state.messages[0].seen, false, "a failed fetch must not mark it read");

  const second = await mailbox.pollMailbox({ overrides });
  assert.equal(second.ingested, 1, "the next pass collects it");
  assert.equal(fake.state.messages[0].seen, true);
  await fake.close();
});

test("the same message polled twice makes one ticket, not two", async () => {
  await reset();
  await withMailbox([{ uid: 15, raw: message({ id: "dupe@x" }) }], async ({ fake, poll }) => {
    await poll();
    // Put it back as unread, exactly as a mailbox would after a failed STORE.
    fake.state.messages[0].seen = false;
    const again = await poll();
    assert.equal(again.duplicates, 1);
    assert.equal(again.ingested, 0);
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM support_tickets WHERE channel = 'email'");
    assert.equal(rows[0].n, 1, "a re-polled message must never open a second ticket");
  });
});

test("a reply to an existing ticket threads onto it instead of opening another", async () => {
  await reset();
  await withMailbox([{ uid: 16, raw: message({ id: "first@x", subject: "Card declined" }) }],
    async ({ poll }) => {
      await poll();
      const { rows } = await pool.query("SELECT id, ticket_ref FROM support_tickets WHERE channel = 'email'");
      const ref = rows[0].ticket_ref;

      // The customer writes again quoting the reference in the subject, from
      // the same address - the weakest of the routing signals, and the one
      // that is only trusted when the sender owns the ticket.
      const followUp = message({ id: "second@x", subject: `Re: [${ref}] Card declined`,
        body: "Still not working.\r\n" });
      await withMailbox([{ uid: 17, raw: followUp }], async ({ poll: pollAgain }) => {
        await pollAgain();
        const tickets = await pool.query("SELECT COUNT(*)::int AS n FROM support_tickets WHERE channel = 'email'");
        assert.equal(tickets.rows[0].n, 1, "the follow-up must not open a second ticket");
        const replies = await pool.query(
          "SELECT message FROM support_ticket_replies WHERE ticket_id = $1", [rows[0].id]);
        assert.equal(replies.rows.length, 1);
        assert.match(replies.rows[0].message, /Still not working/);
      });
    });
});

test("an oversized email is refused without being read, and is still written down", async () => {
  await reset();
  const huge = message({ id: "huge@x", subject: "Screenshots attached",
    body: `${"x".repeat(60000)}\r\n` });
  await withMailbox([{ uid: 18, raw: huge }], async ({ fake, poll }) => {
    const result = await poll();
    assert.equal(result.skipped, 1);
    assert.equal(result.ingested, 0);
    // The body was never pulled across - only the headers.
    assert.equal(fake.state.commands.filter((c) => /BODY\.PEEK\[\]/i.test(c)).length, 0);
    assert.ok(fake.state.commands.some((c) => /BODY\.PEEK\[HEADER\]/i.test(c)));
    // And it is visible to an operator rather than silently gone.
    const { rows } = await pool.query(
      "SELECT status, failure_reason, from_email, subject FROM inbound_emails WHERE status = 'failed'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].failure_reason, "too_large");
    assert.equal(rows[0].from_email, "kagiso@example.com");
    assert.equal(rows[0].subject, "Screenshots attached");
    assert.equal(fake.state.messages[0].seen, true, "marked read so it does not fill every poll");
  }, { settings: { maxMessageBytes: 8 * 1024 } });
});

test("one unreadable message does not stop the rest of the batch", async () => {
  await reset();
  const fake = createFakeImap({
    messages: [
      { uid: 20, raw: message({ id: "bad@x" }) },
      { uid: 21, raw: message({ id: "good@x", subject: "Second message" }) }
    ],
    onCommand: (rest, { tag, socket }) => {
      if (/BODY\.PEEK\[\]/i.test(rest) && /FETCH 20\b/i.test(rest)) {
        socket.write(`${tag} NO broken\r\n`);
        return "handled";
      }
      return null;
    }
  });
  const connection = await fake.listen();
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    `UPDATE inbound_mailbox_settings SET enabled = TRUE, host = $1, port = $2,
       username = 'support@titopay.co.za', password_encrypted = $3 WHERE id = TRUE`,
    [connection.host, connection.port, mailbox.encryptSecret("pw")]);
  const result = await mailbox.pollMailbox({
    overrides: { ca: connection.ca, servername: connection.servername } });
  assert.equal(result.failed, 1);
  assert.equal(result.ingested, 1, "the healthy message still got through");
  assert.equal(fake.state.messages[0].seen, false, "the broken one stays for next time");
  assert.equal(fake.state.messages[1].seen, true);
  await fake.close();
});

test("the batch is capped, and the remainder is reported rather than dropped", async () => {
  await reset();
  const many = Array.from({ length: 5 }, (unused, index) =>
    ({ uid: 30 + index, raw: message({ id: `bulk${index}@x` }) }));
  await withMailbox(many, async ({ poll }) => {
    const result = await poll();
    assert.equal(result.ingested, 2);
    assert.equal(result.waiting, 3, "the rest are still there and reported");
  }, { settings: { maxMessagesPerPoll: 2 } });
});

test("an automated bounce is kept but never becomes a ticket", async () => {
  await reset();
  const bounce = `Message-ID: <bounce@x>\r\nFrom: MAILER-DAEMON@example.com\r\n`
    + `To: support@titopay.co.za\r\nSubject: Undelivered Mail Returned to Sender\r\n`
    + `Auto-Submitted: auto-replied\r\n\r\nDelivery failed.\r\n`;
  await withMailbox([{ uid: 40, raw: bounce }], async ({ fake, poll }) => {
    await poll();
    const tickets = await pool.query("SELECT COUNT(*)::int AS n FROM support_tickets WHERE channel = 'email'");
    assert.equal(tickets.rows[0].n, 0, "answering a robot starts a loop that fills the mailbox");
    const stored = await pool.query("SELECT status, route FROM inbound_emails WHERE message_id = 'bounce@x'");
    assert.equal(stored.rows[0].status, "ignored");
    assert.equal(stored.rows[0].route, "automated");
    assert.equal(fake.state.messages[0].seen, true);
  });
});

/* ---------------------------------------------------------- the settings */

test("the mailbox ships switched off", async () => {
  await mailbox.ensureInboundMailboxSchema();
  await pool.query("UPDATE inbound_mailbox_settings SET enabled = FALSE WHERE id = TRUE");
  const result = await mailbox.pollMailbox();
  assert.deepEqual(result, { skipped: "disabled" },
    "deploying this must not start reading a mailbox by itself");
});

test("the password is stored encrypted and never returned", async () => {
  await mailbox.ensureInboundMailboxSchema();
  await mailbox.updateMailboxSettings(
    { host: "imap.titopay.co.za", username: "support@titopay.co.za", password: "hunter2-app-password" },
    { adminId: null });

  const { rows } = await pool.query("SELECT password_encrypted FROM inbound_mailbox_settings WHERE id = TRUE");
  assert.ok(rows[0].password_encrypted.startsWith("enc:"), "must not be at rest in the clear");
  assert.ok(!rows[0].password_encrypted.includes("hunter2"));
  assert.equal(mailbox.decryptSecret(rows[0].password_encrypted), "hunter2-app-password");

  const shown = await mailbox.getMailboxSettings({ masked: true });
  assert.equal(shown.password, mailbox.MASK);
  assert.equal(shown.hasPassword, true);
  assert.ok(!JSON.stringify(shown).includes("hunter2"), "no caller of the masked form sees the secret");
});

test("saving without retyping the password keeps the stored one", async () => {
  await mailbox.ensureInboundMailboxSchema();
  await mailbox.updateMailboxSettings(
    { host: "imap.titopay.co.za", username: "support@titopay.co.za", password: "original-secret" },
    { adminId: null });
  // The console sends back the mask for a field nobody touched. Writing that
  // would replace the credential with bullet characters and lock the mailbox
  // out on the next poll.
  await mailbox.updateMailboxSettings({ password: mailbox.MASK, mailbox: "Support" }, { adminId: null });
  const settings = await mailbox.getMailboxSettings({ masked: false });
  assert.equal(settings.password, "original-secret");
  assert.equal(settings.mailbox, "Support");
});

test("settings that would break a poll are refused at the point of saving", async () => {
  await mailbox.ensureInboundMailboxSchema();
  await assert.rejects(
    mailbox.updateMailboxSettings({ host: "imap.titopay.co.za\r\nA1 LOGOUT" }, {}),
    /line breaks/);
  await assert.rejects(mailbox.updateMailboxSettings({ host: "not a hostname" }, {}), /hostname/);
  await assert.rejects(mailbox.updateMailboxSettings({ port: 0 }, {}), /between 1 and 65535/);
  await assert.rejects(mailbox.updateMailboxSettings({ pollSeconds: 5 }, {}), /between 15 and 3600/);
  await assert.rejects(mailbox.updateMailboxSettings({ maxMessagesPerPoll: 500 }, {}), /between 1 and 200/);
});

test("the mailbox cannot be switched on without somewhere to connect to", async () => {
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    "UPDATE inbound_mailbox_settings SET host = '', username = '', password_encrypted = '' WHERE id = TRUE");
  await assert.rejects(mailbox.updateMailboxSettings({ enabled: true }, {}),
    /host and username are required/);
  await assert.rejects(
    mailbox.updateMailboxSettings({ enabled: true, host: "imap.titopay.co.za", username: "s@t.co.za" }, {}),
    /password is required/);
});

test("a failed poll is recorded for an operator and counted", async () => {
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    `UPDATE inbound_mailbox_settings SET enabled = TRUE, host = '127.0.0.1', port = 1,
       username = 'support@titopay.co.za', password_encrypted = $1,
       last_error = NULL, consecutive_failures = 0 WHERE id = TRUE`,
    [mailbox.encryptSecret("pw")]);
  const result = await mailbox.pollMailbox();
  assert.ok(result.error, "a mailbox outage returns rather than throws, so the worker survives it");
  const settings = await mailbox.getMailboxSettings();
  assert.equal(settings.consecutiveFailures, 1);
  assert.ok(settings.lastError);
  assert.ok(settings.lastErrorAt);
});

test("the connection test reports what is waiting without reading anything", async () => {
  const fake = createFakeImap({ messages: [{ uid: 50, raw: message({ id: "probe@x" }) }] });
  const connection = await fake.listen();
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    `UPDATE inbound_mailbox_settings SET host = $1, port = $2,
       username = 'support@titopay.co.za', password_encrypted = $3 WHERE id = TRUE`,
    [connection.host, connection.port, mailbox.encryptSecret("pw")]);
  const result = await mailbox.testMailboxConnection(
    { ca: connection.ca, servername: connection.servername });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.waiting, 1);
  assert.equal(fake.state.messages[0].seen, false, "a test must not consume the mailbox");
  await fake.close();
});

test("a connection test against a wrong password fails without throwing", async () => {
  const fake = createFakeImap({ messages: [] });
  const connection = await fake.listen();
  await mailbox.ensureInboundMailboxSchema();
  await pool.query(
    `UPDATE inbound_mailbox_settings SET host = $1, port = $2,
       username = 'support@titopay.co.za', password_encrypted = $3 WHERE id = TRUE`,
    [connection.host, connection.port, mailbox.encryptSecret("BADPASS")]);
  const result = await mailbox.testMailboxConnection(
    { ca: connection.ca, servername: connection.servername });
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected the sign-in/);
  assert.ok(!result.error.includes("BADPASS"));
  await fake.close();
});

test.after(async () => { await pool.end().catch(() => null); });
