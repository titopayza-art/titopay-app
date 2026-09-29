"use strict";

// WILL THIS WORK AGAINST GOOGLE WORKSPACE?
//
// titopay.co.za's MX is smtp.google.com, so support@titopay.co.za is a Google
// mailbox and Gmail's IMAP is the only server that actually matters. The other
// suite proves the client against a deliberately minimal server; a minimal
// server is not what Gmail is.
//
// Gmail is chattier in exactly the way a hand-written parser gets caught out:
// SELECT returns six untagged lines before its tagged completion, STORE
// answers with an untagged FETCH nobody asked for, and the greeting is its own
// wording. A reader that assumed "the interesting line is the first one" or
// "the tagged line comes next" would pass every test in the other file and
// fail on the only mailbox this is pointed at.
//
// So this replays Gmail's actual response shapes. It is not proof against the
// live service - no test here can be, without credentials - but it removes the
// protocol guesswork, which is the part that was guesswork.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeImap, CRLF } = require("./helpers/fake-imap-server");
const { connectImap } = require("../src/lib/imap-client");

const MESSAGE = "Message-ID: <CAF=abc123@mail.gmail.com>\r\n"
  + "From: Thabo Nkosi <thabo@example.com>\r\n"
  + "To: support@titopay.co.za\r\n"
  + "Subject: Card declined at Checkers\r\n"
  + "Content-Type: text/plain; charset=UTF-8\r\n\r\n"
  + "My card was declined twice. Please help.\r\n";

// The untagged traffic Gmail actually sends, which a minimal server never does.
function gmailFlavour(rest, { tag, socket, state }) {
  if (/^SELECT\b/i.test(rest)) {
    socket.write(`* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen $NotPhishing $Phishing)${CRLF}`);
    socket.write(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen $NotPhishing $Phishing \\*)] Flags permitted.${CRLF}`);
    socket.write(`* OK [UIDVALIDITY 1] UIDs valid.${CRLF}`);
    socket.write(`* ${state.messages.length} EXISTS${CRLF}`);
    socket.write(`* 0 RECENT${CRLF}`);
    socket.write(`* OK [UIDNEXT 4827] Predicted next UID.${CRLF}`);
    socket.write(`* OK [HIGHESTMODSEQ 90210]${CRLF}`);
    socket.write(`${tag} OK [READ-WRITE] INBOX selected. (Success)${CRLF}`);
    return "handled";
  }
  if (/^UID\s+STORE\b/i.test(rest)) {
    const uid = Number(/^UID\s+STORE\s+(\d+)/i.exec(rest)?.[1]);
    const message = state.messages.find((item) => item.uid === uid);
    if (message) message.seen = true;
    // Gmail volunteers the new flags as an untagged FETCH first.
    socket.write(`* 1 FETCH (UID ${uid} FLAGS (\\Seen))${CRLF}`);
    socket.write(`${tag} OK Success${CRLF}`);
    return "handled";
  }
  if (/^UID\s+FETCH\b/i.test(rest) && /BODY\.PEEK\[\]/i.test(rest)) {
    const uid = Number(/^UID\s+FETCH\s+(\d+)/i.exec(rest)?.[1]);
    const message = state.messages.find((item) => item.uid === uid);
    if (!message) { socket.write(`${tag} OK Success${CRLF}`); return "handled"; }
    // Gmail puts FLAGS before the literal and closes the line after it, so the
    // logical line is text, then a literal, then more text.
    socket.write(`* 1 FETCH (UID ${uid} FLAGS () BODY[] {${message.raw.length}}${CRLF}`);
    socket.write(message.raw);
    socket.write(`)${CRLF}`);
    socket.write(`${tag} OK Success${CRLF}`);
    return "handled";
  }
  return null;
}

async function gmailServer(messages) {
  const fake = createFakeImap({
    messages,
    greeting: "* OK Gimap ready for requests from 41.13.0.1 h6mb000000000000",
    onCommand: gmailFlavour
  });
  return { fake, connection: await fake.listen() };
}

test("Gmail's greeting and its six-line SELECT are read correctly", async () => {
  const { fake, connection } = await gmailServer([{ uid: 4821, raw: MESSAGE }]);
  const imap = await connectImap({ ...connection,
    user: "support@titopay.co.za", password: "abcd efgh ijkl mnop" });
  const selected = await imap.select("INBOX");
  assert.equal(selected.exists, 1,
    "EXISTS must be found among the untagged lines, not assumed to be the first");
  await imap.logout();
  await fake.close();
});

test("an app password with spaces in it is sent intact", async () => {
  // Google prints app passwords as four groups of four. People paste them with
  // the spaces, and a quoted IMAP string carries them fine - but only if the
  // spaces are not treated as argument separators.
  const { fake, connection } = await gmailServer([]);
  const imap = await connectImap({ ...connection,
    user: "support@titopay.co.za", password: "abcd efgh ijkl mnop" });
  const login = fake.state.loginAttempts[0];
  assert.match(login, /"abcd efgh ijkl mnop"/,
    "the whole password must arrive as one quoted string");
  await imap.logout();
  await fake.close();
});

test("a message is fetched whole when FLAGS precede the literal", async () => {
  const { fake, connection } = await gmailServer([{ uid: 4821, raw: MESSAGE }]);
  const imap = await connectImap({ ...connection,
    user: "support@titopay.co.za", password: "app-password" });
  await imap.select("INBOX");
  const uids = await imap.searchUnseen();
  assert.deepEqual(uids, [4821]);
  const raw = await imap.fetchMessage(4821);
  assert.equal(raw.toString("utf8"), MESSAGE,
    "the literal must be read by its declared length, past the FLAGS that precede it");
  await imap.logout();
  await fake.close();
});

test("STORE's unsolicited untagged FETCH does not confuse the tagged completion", async () => {
  const { fake, connection } = await gmailServer([{ uid: 4821, raw: MESSAGE }]);
  const imap = await connectImap({ ...connection,
    user: "support@titopay.co.za", password: "app-password" });
  await imap.select("INBOX");
  await imap.markSeen(4821);
  assert.equal(fake.state.messages[0].seen, true);
  assert.deepEqual(await imap.searchUnseen(), [], "nothing is left unread");
  await imap.logout();
  await fake.close();
});

test("a Workspace account with IMAP switched off is reported in Google's own words", async () => {
  // What Gmail actually answers when IMAP is disabled for the mailbox. The
  // operator needs to see this sentence, not "login failed".
  const fake = createFakeImap({
    messages: [],
    greeting: "* OK Gimap ready",
    onCommand: (rest, { tag, socket }) => {
      if (/^LOGIN\b/i.test(rest)) {
        socket.write(`${tag} NO [ALERT] Please log in via your web browser: `
          + `https://support.google.com/mail/accounts/answer/78754 (Failure)${CRLF}`);
        return "handled";
      }
      return null;
    }
  });
  const connection = await fake.listen();
  await assert.rejects(
    connectImap({ ...connection, user: "support@titopay.co.za", password: "not-an-app-password" }),
    (error) => {
      assert.match(error.message, /log in via your web browser/,
        "Google's own remedy must reach the operator");
      assert.ok(!error.message.includes("not-an-app-password"),
        "and the password must never appear in an error");
      return true;
    }
  );
  await fake.close();
});
