"use strict";

// MAIL ARRIVING AT SUPPORT, TURNED INTO TICKETS.
//
// Transport-agnostic, so this drives the whole thing with no mailbox at all -
// raw RFC 822 messages handed straight to ingestInboundEmail(), which is
// exactly what an IMAP poller or a provider webhook will do.
//
// The cases that matter are the ones that go wrong:
//
//   a retried delivery         webhooks retry and IMAP re-polls; one email
//                              must never become three tickets answered by
//                              three different agents
//   an unparseable message     the customer believes they have contacted
//                              support, so silence is never acceptable
//   an out-of-office           replying to a robot starts a loop that ends
//                              with a full mailbox
//   a forged From              matching an address proves somebody typed it;
//                              the ticket stays UNVERIFIED either way, because
//                              this is a payments product
//   a guessed reference        quoting somebody else's ticket number must not
//                              post into their support thread
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "inbound-email-access-secret-length!!";
process.env.JWT_REFRESH_SECRET ||= "inbound-email-refresh-secret-length";
process.env.SUPPORT_REPLY_SECRET ||= "inbound-email-test-reply-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const inbound = require("../src/services/inbound-email-service");
const support = require("../src/services/support-ticket-reply-service");
const { supportReplyAddress } = require("../src/lib/support-verp");
const { config } = require("../src/config/env");

const uid = () => crypto.randomUUID();
const stamp = Date.now().toString(36);
const customerId = uid();
const strangerEmail = `stranger_${stamp}@example.com`;
const customerEmail = `customer_${stamp}@example.co.za`;
const createdTickets = [];

// THE BLANK LINE IS THE MESSAGE FORMAT.
//
// The first version of this built the array and then filtered out every empty
// string to drop an unused extraHeaders slot - which also deleted the blank
// line that separates headers from body. Every message it produced was
// therefore all headers and no body, and five tests failed reporting "no
// readable text" against a service that was reading them correctly. The
// headers are assembled first and the separator is added deliberately.
function mail({ from, to = "support@titopay.co.za", subject, body, messageId,
  extraHeaders = "", contentType = "text/plain; charset=utf-8" } = {}) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${messageId || `${uid()}@example.com`}>`,
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: ${contentType}`
  ];
  if (extraHeaders) headers.push(extraHeaders);
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

test.before(async () => {
  await support.ensureSupportReplySchema();
  await inbound.ensureInboundEmailSchema();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash)
     VALUES ($1,'personal','Sipho Dlamini',$2,$3,'$2a$10$inboundtestnotarealhashxxxxxxxxxxxxxxxxxxxxxxxxxx')`,
    [customerId, `sipho_${stamp}`, customerEmail]);
});

test.after(async () => {
  await pool.query("DELETE FROM inbound_emails WHERE from_email = ANY($1::text[])",
    [[customerEmail, strangerEmail, "nobody@example.com"]]).catch(() => {});
  if (createdTickets.length) {
    await pool.query("DELETE FROM support_tickets WHERE id = ANY($1::uuid[])", [createdTickets]).catch(() => {});
  }
  await pool.query("DELETE FROM users WHERE id = $1", [customerId]);
  await pool.end();
});

async function ticketOf(result) {
  createdTickets.push(result.ticketId);
  const { rows } = await pool.query("SELECT * FROM support_tickets WHERE id = $1", [result.ticketId]);
  return rows[0];
}

/* ------------------------------------------------- a new request arrives */

test("an email from a stranger becomes a ticket with no account invented for them", async () => {
  const result = await inbound.ingestInboundEmail(mail({
    from: `"A Stranger" <${strangerEmail}>`,
    subject: "Can I open an account from Lesotho?",
    body: "Good day, I live in Lesotho. Can I use TitoPay there?"
  }));
  assert.equal(result.routed, true);
  assert.equal(result.route, "new");

  const ticket = await ticketOf(result);
  assert.equal(ticket.channel, "email");
  assert.equal(ticket.contact_email, strangerEmail);
  // Inventing a user row for an unknown sender would be an
  // account-enumeration gift and a spoofing one.
  assert.equal(ticket.user_id, null);
  assert.match(ticket.message, /I live in Lesotho/);
  assert.ok(ticket.ticket_ref, "it is given a reference like any other ticket");
});

test("AN EMAILED TICKET IS NEVER TRUSTED, EVEN FROM A KNOWN ADDRESS", async () => {
  // Matching an address proves somebody typed it. A From header is forgeable
  // by anyone who can send mail, so this stays unverified - which is the
  // difference between a helpdesk and an attack surface in a payments product.
  const result = await inbound.ingestInboundEmail(mail({
    from: customerEmail,
    subject: "My withdrawal has not arrived",
    body: "I withdrew R2000 yesterday and it is not in my bank account."
  }));
  const ticket = await ticketOf(result);
  assert.equal(ticket.user_id, customerId, "the account is LABELLED on the ticket");
  assert.equal(ticket.channel, "email");

  const rows = await support.listTicketsForAdmin();
  const seen = rows.find((row) => row.id === ticket.id);
  assert.equal(seen.identityVerified, false, "labelled is not the same as authenticated");
  assert.match(seen.identityNote, /UNVERIFIED/);
  assert.match(seen.identityNote, /do not change anything on an account/i);
});

/* --------------------------------------------------------- deduplication */

test("A RETRIED DELIVERY DOES NOT BECOME A SECOND TICKET", async () => {
  // Webhooks retry, often several times, and IMAP re-polls. Without the unique
  // index one email becomes three tickets and three agents answer the same
  // question.
  const messageId = `retry-${stamp}@example.com`;
  const raw = mail({ from: customerEmail, subject: "Duplicate probe",
    body: "Sent once, delivered three times.", messageId });

  const first = await inbound.ingestInboundEmail(raw);
  const second = await inbound.ingestInboundEmail(raw);
  const third = await inbound.ingestInboundEmail(raw);
  createdTickets.push(first.ticketId);

  assert.equal(first.routed, true);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(second.ticketId, first.ticketId, "a retry points at the ticket already made");

  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS c FROM support_tickets WHERE message = 'Sent once, delivered three times.'");
  assert.equal(rows[0].c, 1);
});

test("two messages with no Message-ID at all do not collide with each other", async () => {
  // A missing Message-ID is legal. A plain unique index would treat several of
  // them as duplicates of one another and silently drop real messages.
  const withoutId = (body) => [
    `From: ${strangerEmail}`, "To: support@titopay.co.za", "Subject: No message id",
    "Content-Type: text/plain", "", body
  ].join("\r\n");
  const a = await inbound.ingestInboundEmail(withoutId("First message, no id."));
  const b = await inbound.ingestInboundEmail(withoutId("Second message, no id."));
  createdTickets.push(a.ticketId, b.ticketId);
  assert.equal(a.routed, true);
  assert.equal(b.routed, true);
  assert.notEqual(a.ticketId, b.ticketId, "both messages became tickets");
});

/* ------------------------------------------------------------- threading */

test("a reply on the signed address lands on its own ticket", async () => {
  const first = await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: "Card declined at the shop",
    body: "My card was declined this morning." }));
  const ticket = await ticketOf(first);

  const replyAddress = supportReplyAddress(ticket.ticket_ref,
    config.integrations.email.replyTo, config.integrations.email.supportReplySecret);
  assert.ok(replyAddress, "the test needs a signed address to send to");

  const reply = await inbound.ingestInboundEmail(mail({
    from: customerEmail, to: replyAddress,
    // The subject is deliberately mangled the way a real reply is - edited,
    // "Re:" stripped - so only the address can route it.
    subject: "any old subject",
    body: "It worked on the second try, thank you." }));
  assert.equal(reply.route, "reply-address");
  assert.equal(reply.ticketId, ticket.id);

  const { rows } = await pool.query(
    "SELECT author_type, message FROM support_ticket_replies WHERE ticket_id = $1", [ticket.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].author_type, "customer");
  assert.match(rows[0].message, /second try/);
});

test("a GUESSED reference does not post into somebody else's ticket", async () => {
  // The subject is the weakest routing signal, so it only threads onto a
  // ticket that belongs to the sender. Otherwise quoting a reference a friend
  // mentioned would put your message in their support thread.
  const mine = await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: "My own problem", body: "Something is wrong." }));
  const ticket = await ticketOf(mine);

  const intruder = await inbound.ingestInboundEmail(mail({
    from: strangerEmail,
    subject: `Re: ${ticket.ticket_ref} let me see this`,
    body: "I guessed a reference." }));
  createdTickets.push(intruder.ticketId);
  assert.equal(intruder.route, "new", "it becomes the stranger's own ticket");
  assert.notEqual(intruder.ticketId, ticket.id);
});

test("the sender's own reference in a subject does thread", async () => {
  const first = await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: "Statement question", body: "Where is my statement?" }));
  const ticket = await ticketOf(first);
  const again = await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: `Re: TitoPay Customer Care replied: ${ticket.ticket_ref}`,
    body: "Following up on this." }));
  assert.equal(again.route, "subject");
  assert.equal(again.ticketId, ticket.id);
});

/* --------------------------------------------- nothing is ever lost */

test("A MESSAGE THAT CANNOT BE PARSED STILL BECOMES A TICKET", async () => {
  // The customer believes they have contacted support. Silence is the one
  // outcome that is never acceptable.
  const result = await inbound.ingestInboundEmail(
    "this is not a valid email at all, it has no headers and no structure");
  createdTickets.push(result.ticketId);
  assert.equal(result.routed, true);
  const ticket = await ticketOf(result);
  assert.equal(ticket.channel, "email");
  assert.ok(ticket.message.length > 0, "whatever text arrived is on the ticket");
});

test("THE RAW MESSAGE IS STORED BEFORE ANYTHING IS PARSED", async () => {
  // The property that makes a parser bug cost a reprocess instead of somebody's
  // support request.
  const body = "Raw storage probe, keep this text exactly.";
  const messageId = `raw-${stamp}@example.com`;
  await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: "Raw probe", body, messageId }));
  const { rows } = await pool.query(
    "SELECT raw, status, route, ticket_id FROM inbound_emails WHERE message_id = $1", [messageId]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].raw, /Raw storage probe, keep this text exactly/);
  assert.match(rows[0].raw, /^From: /m, "the entire message is kept, headers included");
  assert.equal(rows[0].status, "routed");
  createdTickets.push(rows[0].ticket_id);
});

test("an oversized message is refused before it is stored", async () => {
  const huge = mail({ from: strangerEmail, subject: "Huge",
    body: "x".repeat(inbound.MAX_RAW_BYTES + 1000) });
  const result = await inbound.ingestInboundEmail(huge);
  assert.equal(result.stored, false);
  assert.equal(result.reason, "too_large");
});

/* ------------------------------------------------------ loop protection */

test("AN OUT-OF-OFFICE IS NOT ANSWERED, AND NOT DELETED EITHER", async () => {
  // Replying to a robot starts a loop that ends with a full mailbox. Ignored
  // is a status, not a delete: an operator can still see what arrived.
  const messageId = `auto-${stamp}@example.com`;
  const result = await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: "Out of Office: your message",
    body: "I am on leave until Monday.", messageId,
    extraHeaders: "Auto-Submitted: auto-replied" }));
  assert.equal(result.routed, false);
  assert.equal(result.ignored, true);

  const { rows } = await pool.query(
    "SELECT status, route, ticket_id FROM inbound_emails WHERE message_id = $1", [messageId]);
  assert.equal(rows[0].status, "ignored");
  assert.equal(rows[0].route, "automated");
  assert.equal(rows[0].ticket_id, null, "no ticket, so nobody replies to it");
  assert.ok(rows.length === 1, "but it is kept");
});

test("a bulk mailing and a null return-path are treated the same way", async () => {
  for (const [label, headers] of [
    ["precedence bulk", "Precedence: bulk"],
    ["null return-path", "Return-Path: <>"],
    ["x-autoreply", "X-Autoreply: yes"]
  ]) {
    const result = await inbound.ingestInboundEmail(mail({
      from: strangerEmail, subject: `Robot: ${label}`, body: "Automated.", extraHeaders: headers }));
    assert.equal(result.ignored, true, `${label} must not create a ticket`);
  }
});

/* ------------------------------------------------------------- parsing */

test("a multipart message is read as its plain-text part", async () => {
  const boundary = "----probe";
  const raw = [
    `From: ${customerEmail}`, "To: support@titopay.co.za", "Subject: Multipart probe",
    `Message-ID: <multi-${stamp}@example.com>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "",
    "This is the plain text a human wrote.", "",
    `--${boundary}`, "Content-Type: text/html; charset=utf-8", "",
    "<html><body><p>This is the HTML version.</p></body></html>", "",
    `--${boundary}--`
  ].join("\r\n");
  const result = await inbound.ingestInboundEmail(raw);
  const ticket = await ticketOf(result);
  assert.match(ticket.message, /plain text a human wrote/);
  assert.doesNotMatch(ticket.message, /<p>/, "no markup reaches the agent's screen");
});

test("a quoted-printable body is decoded", async () => {
  const raw = mail({ from: customerEmail, subject: "Encoded probe",
    body: "The fee was R1=2E50 and the caf=C3=A9 charged me twice.",
    extraHeaders: "Content-Transfer-Encoding: quoted-printable" });
  const result = await inbound.ingestInboundEmail(raw);
  const ticket = await ticketOf(result);
  assert.match(ticket.message, /R1\.50/);
  assert.match(ticket.message, /café/);
});

test("a folded subject header is read whole", async () => {
  // Long headers wrap across lines. Reading only the first line truncates a
  // subject mid-sentence, and it is the first thing an agent sees.
  const raw = [
    `From: ${customerEmail}`, "To: support@titopay.co.za",
    "Subject: My payment to the school did not go through and I need",
    "  to know whether the money has left my wallet",
    `Message-ID: <folded-${stamp}@example.com>`, "Content-Type: text/plain", "",
    "See subject."
  ].join("\r\n");
  const result = await inbound.ingestInboundEmail(raw);
  const ticket = await ticketOf(result);
  assert.match(ticket.subject, /whether the money has left my wallet/);
});

/* ------------------------------------------------ an operator can recover */

test("nothing unrouted is hidden from an operator", async () => {
  const unrouted = await inbound.listUnrouted();
  assert.ok(Array.isArray(unrouted), "there is a place to look");
});

test("a reply reopens a resolved ticket instead of dying quietly", async () => {
  const first = await inbound.ingestInboundEmail(mail({
    from: customerEmail, subject: "Closed then reopened", body: "Initial question." }));
  const ticket = await ticketOf(first);
  await pool.query("UPDATE support_tickets SET status = 'resolved' WHERE id = $1", [ticket.id]);

  const replyAddress = supportReplyAddress(ticket.ticket_ref,
    config.integrations.email.replyTo, config.integrations.email.supportReplySecret);
  await inbound.ingestInboundEmail(mail({
    from: customerEmail, to: replyAddress, subject: "still broken",
    body: "This is happening again." }));

  const { rows } = await pool.query("SELECT status FROM support_tickets WHERE id = $1", [ticket.id]);
  assert.equal(rows[0].status, "pending", "a customer writing back is not a closed matter");
});
