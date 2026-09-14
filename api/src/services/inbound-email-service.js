"use strict";

// MAIL ARRIVING AT support@titopay.co.za, TURNED INTO SUPPORT TICKETS.
//
// Transport-agnostic on purpose. Whether the message is fetched over IMAP or
// pushed by a provider's inbound webhook, the adapter's only job is to hand
// ingestInboundEmail() a raw RFC 822 message. Everything below - storing,
// deduplicating, parsing, routing, creating the ticket - is the same either
// way, so the choice of transport is a small adapter at the end rather than a
// rewrite. It also means this is fully testable with no mailbox at all.
//
// THREE RULES, EACH LEARNED FROM SOMETHING THAT GOES WRONG IN MAIL SYSTEMS.
//
// 1. THE RAW MESSAGE IS STORED BEFORE ANYTHING IS PARSED.
//    Parsing attacker-controlled MIME is where bugs live. If the parser
//    throws, mangles a body, or meets an encoding nobody anticipated, the
//    customer's message must still exist - so it is written to the database
//    first and everything afterwards reads from that copy. A parser bug then
//    costs a reprocess, not somebody's support request. This is the same
//    discipline vas-purchase-service uses for money: persist, then act.
//
// 2. A MESSAGE IS PROCESSED ONCE, ENFORCED BY THE DATABASE.
//    IMAP re-polls. Webhooks retry, often several times, and a provider that
//    does not get a 200 quickly will send the same message again. Without a
//    unique index on Message-ID one email becomes three tickets, and a
//    customer gets three different agents answering the same question.
//
// 3. A MESSAGE IS NEVER LOST TO A ROUTING FAILURE.
//    If the sender cannot be matched, the thread cannot be identified, or the
//    body cannot be parsed, a ticket is still created carrying whatever was
//    understood. Silence is the one outcome that is never acceptable: the
//    customer believes they have contacted support.
//
// AND THE RULE THAT MAKES THIS SAFE FOR A PAYMENTS PRODUCT: every ticket
// created here is channel 'email', which support-ticket-reply-service treats
// as UNVERIFIED. A From header is forgeable by anyone who can send mail, so an
// emailed request is a message from somebody CLAIMING to be the account
// holder. It may be read and answered; it must never on its own authorise
// anything on an account.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { generateUniqueTicketRef } = require("../lib/ticket-id");
const { findTicketRefInRecipients } = require("../lib/support-verp");
const { config } = require("../config/env");

// A mail server will happily hand over something enormous. These are the
// limits at which this stops being a support request and starts being a
// denial-of-service, and they are applied before the raw message is stored.
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_SUBJECT = 300;
const MAX_BODY = 20000;

let schemaReady = null;
function ensureInboundEmailSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS inbound_emails (
          id UUID PRIMARY KEY,
          message_id TEXT,
          raw TEXT NOT NULL,
          from_email TEXT,
          subject TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'received'
            CHECK (status IN ('received','routed','ignored','failed')),
          ticket_id UUID REFERENCES support_tickets(id) ON DELETE SET NULL,
          route TEXT,
          failure_reason TEXT
        )`);
      // THE DEDUPLICATION GUARANTEE, held by the database rather than by a
      // check-then-insert that two concurrent deliveries would both pass.
      // Partial, because a message with no Message-ID header is legal and
      // several of them must not collide with each other on NULL.
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_emails_message_id
         ON inbound_emails (message_id) WHERE message_id IS NOT NULL`
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_inbound_emails_status ON inbound_emails (status, received_at DESC)"
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/* ------------------------------------------------------------- parsing */

// A DELIBERATELY SMALL RFC 822 READER.
//
// Not a full MIME implementation, and not trying to be. It reads the headers
// this service routes on and finds a readable body, and where it cannot, the
// message still becomes a ticket carrying the raw text - see rule 3. Writing
// only what is needed keeps the amount of code reading hostile input small,
// which is worth more here than completeness.
function unfoldHeaders(rawHeaders) {
  // A long header is folded across lines with leading whitespace. Joining
  // those back together has to happen before anything is read, or a folded
  // Subject or References silently truncates.
  return String(rawHeaders || "").replace(/\r?\n[ \t]+/g, " ");
}

function parseHeaders(rawHeaders) {
  const headers = {};
  for (const line of unfoldHeaders(rawHeaders).split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (!name) continue;
    // Repeated headers (Received, References) keep every occurrence; the
    // routing ladder wants all of them.
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] += ` ${value}`;
  }
  return headers;
}

// DECODED AS BYTES, THEN READ AS UTF-8 - and the first version did not.
//
// Quoted-printable encodes BYTES. "=C3=A9" is the two-byte UTF-8 sequence for
// é, not two characters. Turning each =XX into String.fromCharCode produced
// "cafÃ©" - the classic mojibake - which would have reached agents on every
// message containing an accent, and South African support mail is full of
// them: café, Müller, and every African-language name with a diacritic.
//
// So the escapes are resolved into a byte buffer and the buffer is decoded
// once, as UTF-8.
function decodeQuotedPrintable(text) {
  const unfolded = String(text || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const character = unfolded[index];
    if (character === "=" && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    // Anything not escaped is already plain ASCII in a quoted-printable body.
    const code = character.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else bytes.push(...Buffer.from(character, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBody(body, encoding) {
  const value = String(encoding || "").trim().toLowerCase();
  try {
    if (value === "base64") return Buffer.from(String(body || "").replace(/\s+/g, ""), "base64").toString("utf8");
    if (value === "quoted-printable") return decodeQuotedPrintable(body);
  } catch (error) {
    // An encoding we cannot decode is not a reason to lose the message; the
    // undecoded text still tells an agent what was sent.
    return String(body || "");
  }
  return String(body || "");
}

// The plain-text part of a multipart message, or the body itself when there is
// only one part. HTML is used only when there is nothing else, stripped to
// text, because an agent reads this in a table cell.
function extractBody(headers, body) {
  const contentType = String(headers["content-type"] || "");
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!/multipart/i.test(contentType) || !boundaryMatch) {
    return decodeBody(body, headers["content-transfer-encoding"]);
  }
  const parts = String(body || "").split(`--${boundaryMatch[1]}`);
  let html = "";
  for (const part of parts) {
    const split = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
    if (split < 0) continue;
    const partHeaders = parseHeaders(part.slice(0, split));
    const partBody = part.slice(split).replace(/^\r?\n\r?\n/, "");
    const type = String(partHeaders["content-type"] || "").toLowerCase();
    // Attachments are not bodies. They are noted on the ticket rather than
    // inlined, and the raw message keeps them until there is somewhere to put
    // them.
    if (/attachment/i.test(String(partHeaders["content-disposition"] || ""))) continue;
    if (type.startsWith("text/plain")) {
      return decodeBody(partBody, partHeaders["content-transfer-encoding"]);
    }
    if (!html && type.startsWith("text/html")) {
      html = decodeBody(partBody, partHeaders["content-transfer-encoding"]);
    }
  }
  if (html) {
    return html.replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return decodeBody(body, headers["content-transfer-encoding"]);
}

// "Name" <someone@example.com> -> someone@example.com
function addressOf(value) {
  const text = String(value || "").trim();
  const angled = /<([^>]+)>/.exec(text);
  const candidate = (angled ? angled[1] : text).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

function addressList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseMessage(raw) {
  const text = String(raw || "");
  const breakAt = text.search(/\r?\n\r?\n/);
  const headerBlock = breakAt >= 0 ? text.slice(0, breakAt) : text;
  const body = breakAt >= 0 ? text.slice(breakAt).replace(/^\r?\n\r?\n/, "") : "";
  const headers = parseHeaders(headerBlock);
  return {
    headers,
    // NORMALISED, because the angle brackets are syntax and not part of the id.
    //
    // The header reads "<abc@example.com>" but In-Reply-To matching already
    // strips the brackets before comparing against email_queue, and providers
    // record their ids bare. Storing the bracketed form made the deduplication
    // key a different string from the one everything else uses - so a message
    // could be stored once and looked up never.
    messageId: (headers["message-id"] || "").trim().replace(/^<|>$/g, "") || null,
    from: addressOf(headers.from),
    fromName: String(headers.from || "").replace(/<[^>]*>/, "").replace(/"/g, "").trim(),
    recipients: [
      ...addressList(headers.to),
      ...addressList(headers.cc),
      ...addressList(headers["delivered-to"]),
      ...addressList(headers["x-original-to"])
    ],
    subject: String(headers.subject || "").slice(0, MAX_SUBJECT).trim(),
    inReplyTo: (headers["in-reply-to"] || "").trim(),
    references: (headers.references || "").trim(),
    body: extractBody(headers, body).slice(0, MAX_BODY).trim(),
    // A bounce, an out-of-office or another robot. Replying to one of these
    // starts a loop that only stops when somebody notices the mailbox is full.
    automated: Boolean(headers["auto-submitted"] && !/^no$/i.test(headers["auto-submitted"]))
      || /^(bulk|list|auto_reply)$/i.test(String(headers.precedence || "").trim())
      || Boolean(headers["x-autoreply"]) || Boolean(headers["x-autorespond"])
      || /^<>$/.test(String(headers["return-path"] || "").trim())
  };
}

/* ------------------------------------------------------------- routing */

// WHICH TICKET THIS BELONGS TO, IN FALLING ORDER OF AUTHORITY.
//
//  1. the signed reply address  support+TP123456.<tag>@ours. It is in the
//     envelope, so it survives an edited subject, a stripped "Re:", and a
//     thread forwarded through three people. Signed, so nobody reaches a
//     stranger's ticket by guessing a number.
//  2. In-Reply-To / References  RFC-correct threading against the message ids
//     of mail we actually sent.
//  3. the subject               TP###### appears there because outbound
//     replies put it there. Weakest of the three, because subjects are edited.
//  4. nothing                   a new request, which is the common case.
//
// Each step is a separate query rather than one clever SQL statement, because
// when a message lands on the wrong thread the first question is which rule
// put it there, and `route` records exactly that.
async function findTicketForMessage(message, client = pool) {
  const secret = config.integrations.email.supportReplySecret;
  const base = config.integrations.email.replyTo;

  const tagged = findTicketRefInRecipients(message.recipients, secret, base);
  if (tagged) {
    const { rows } = await client.query(
      "SELECT * FROM support_tickets WHERE ticket_ref = $1 LIMIT 1", [tagged.ticketRef]);
    if (rows[0]) return { ticket: rows[0], route: "reply-address" };
  }

  const quoted = [message.inReplyTo, message.references].filter(Boolean).join(" ");
  const ids = quoted.match(/<[^>]+>/g) || [];
  if (ids.length) {
    // email_queue records the provider's message id and, since the support
    // reply work, the ticket reference alongside it - which is what makes this
    // step possible at all.
    const { rows } = await client.query(
      `SELECT metadata->>'ticketRef' AS ticket_ref
         FROM email_queue
        WHERE provider_message_id = ANY($1::text[])
          AND metadata->>'ticketRef' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [ids.map((id) => id.replace(/^<|>$/g, ""))]
    ).catch(() => ({ rows: [] }));
    if (rows[0]?.ticket_ref) {
      const { rows: tickets } = await client.query(
        "SELECT * FROM support_tickets WHERE ticket_ref = $1 LIMIT 1", [rows[0].ticket_ref]);
      if (tickets[0]) return { ticket: tickets[0], route: "in-reply-to" };
    }
  }

  const inSubject = /\b([A-Z]{2}[0-9]{6})\b/.exec(message.subject || "");
  if (inSubject) {
    const { rows } = await client.query(
      "SELECT * FROM support_tickets WHERE ticket_ref = $1 LIMIT 1", [inSubject[1]]);
    // The subject is the weakest signal, so it only threads onto a ticket that
    // belongs to the person writing - otherwise quoting a reference somebody
    // mentioned to you would post into their support thread.
    if (rows[0] && message.from) {
      const owner = await senderAccount(message.from, client);
      if (owner && rows[0].user_id === owner.id) return { ticket: rows[0], route: "subject" };
      if (!rows[0].user_id && String(rows[0].contact_email || "").toLowerCase() === message.from) {
        return { ticket: rows[0], route: "subject" };
      }
    }
  }
  return { ticket: null, route: "new" };
}

// The account behind an email address, if there is one. Used to LABEL the
// ticket, never to authenticate it: matching an address proves only that
// somebody typed it, and the ticket stays channel 'email' and unverified
// either way.
async function senderAccount(email, client = pool) {
  if (!email) return null;
  const { rows } = await client.query(
    "SELECT id, full_name, username FROM users WHERE LOWER(email) = $1 LIMIT 1", [email]);
  return rows[0] || null;
}

/* ------------------------------------------------------------- ingest */

// The entry point every adapter calls. Takes a raw RFC 822 message and nothing
// else.
async function ingestInboundEmail(raw, { source = "unknown" } = {}) {
  await ensureInboundEmailSchema();
  const text = String(raw || "");
  if (!text.trim()) return { stored: false, reason: "empty" };
  if (Buffer.byteLength(text, "utf8") > MAX_RAW_BYTES) {
    return { stored: false, reason: "too_large" };
  }

  // PARSED ONLY FAR ENOUGH TO DEDUPLICATE. The full parse happens after the
  // raw message is safely on disk.
  let messageId = null;
  let fromEmail = null;
  let subject = null;
  try {
    const peek = parseMessage(text);
    messageId = peek.messageId;
    fromEmail = peek.from || null;
    subject = peek.subject || null;
  } catch (error) {
    // Even a message we cannot read the headers of gets stored.
    console.error("[inbound-email] header peek failed", { message: error.message });
  }

  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO inbound_emails (id, message_id, raw, from_email, subject)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [id, messageId, text, fromEmail, subject]
  );
  if (!rows[0]) {
    // Already have it. A retried webhook and a re-polled mailbox both land
    // here, and neither may produce a second ticket.
    const { rows: existing } = await pool.query(
      "SELECT id, ticket_id, status FROM inbound_emails WHERE message_id = $1", [messageId]);
    return { stored: false, duplicate: true, id: existing[0]?.id || null,
      ticketId: existing[0]?.ticket_id || null };
  }
  const outcome = await routeStoredEmail(id, { source });
  return { stored: true, id, ...outcome };
}

// Parses and routes a message that is already safely stored. Separate from
// ingest so a message that failed to route can be reprocessed after a fix
// without the sender having to write again.
async function routeStoredEmail(id, { source = "unknown" } = {}) {
  await ensureInboundEmailSchema();
  const { rows } = await pool.query("SELECT * FROM inbound_emails WHERE id = $1", [id]);
  const record = rows[0];
  if (!record) return { routed: false, reason: "not_found" };

  let message;
  try {
    message = parseMessage(record.raw);
  } catch (error) {
    // RULE 3. A message we cannot parse still becomes a ticket, carrying what
    // we have, because the customer believes they have contacted support.
    message = { headers: {}, messageId: record.message_id, from: record.from_email || "",
      fromName: "", recipients: [], subject: record.subject || "Support request received by email",
      inReplyTo: "", references: "", body: String(record.raw).slice(0, MAX_BODY), automated: false };
  }

  // Robots do not get answers, and answering one starts a loop that ends with
  // a full mailbox. Kept, not discarded - "ignored" is a status, not a delete.
  if (message.automated) {
    await pool.query(
      "UPDATE inbound_emails SET status = 'ignored', route = 'automated', processed_at = NOW() WHERE id = $1",
      [id]);
    return { routed: false, ignored: true, reason: "automated" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { ticket, route } = await findTicketForMessage(message, client);
    const sender = await senderAccount(message.from, client);
    const body = message.body || "(This email arrived with no readable text. The original is kept.)";

    let ticketId;
    if (ticket) {
      // An existing thread: the message becomes a reply on it, never a second
      // ticket for the same conversation.
      await client.query(
        `INSERT INTO support_ticket_replies (id, ticket_id, author_type, author_id, author_label, message)
         VALUES ($1,$2,'customer',$3,$4,$5)`,
        [uuidv4(), ticket.id, sender?.id || null,
          message.fromName || message.from || "Customer", body]
      );
      await client.query(
        "UPDATE support_tickets SET status = CASE WHEN status IN ('resolved','closed') THEN 'pending' ELSE status END, updated_at = NOW() WHERE id = $1",
        [ticket.id]);
      ticketId = ticket.id;
    } else {
      ticketId = uuidv4();
      const ticketRef = await generateUniqueTicketRef(client, "TP");
      await client.query(
        `INSERT INTO support_tickets
           (id, ticket_ref, user_id, category, subject, message, status, channel, contact_email)
         VALUES ($1,$2,$3,'email',$4,$5,'pending','email',$6)`,
        [ticketId, ticketRef, sender?.id || null,
          message.subject || "Support request received by email", body, message.from || null]
      );
    }

    await client.query(
      "UPDATE inbound_emails SET status = 'routed', route = $2, ticket_id = $3, processed_at = NOW() WHERE id = $1",
      [id, route, ticketId]);
    await client.query("COMMIT");
    return { routed: true, ticketId, route, matchedAccount: Boolean(sender), source };
  } catch (error) {
    await client.query("ROLLBACK");
    await pool.query(
      "UPDATE inbound_emails SET status = 'failed', failure_reason = $2, processed_at = NOW() WHERE id = $1",
      [id, String(error.message || "unknown").slice(0, 300)]).catch(() => {});
    console.error("[inbound-email] routing failed", { id, message: error.message });
    return { routed: false, reason: "error", error: error.message };
  } finally {
    client.release();
  }
}

// A MESSAGE WE DELIBERATELY DID NOT ACCEPT, WRITTEN DOWN ANYWAY.
//
// An adapter sometimes decides not to take a message at all - most often
// because it is far too large to pull into memory. Rule 3 still applies: the
// customer believes they have contacted support, so "too big, forget it" is
// not an outcome. No ticket is created, because the content was never read and
// inventing one would put a blank in front of an agent; instead the row lands
// in the same failed queue an operator already watches, carrying enough to go
// and look in the mailbox.
async function recordUnprocessable({ messageId = null, fromEmail = null, subject = null,
  reason = "unprocessable", note = "" } = {}) {
  await ensureInboundEmailSchema();
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO inbound_emails (id, message_id, raw, from_email, subject, status, failure_reason, processed_at)
     VALUES ($1,$2,$3,$4,$5,'failed',$6,NOW())
     ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [id, messageId, String(note || reason).slice(0, MAX_BODY), fromEmail,
      (subject || "").slice(0, MAX_SUBJECT) || null, String(reason).slice(0, 300)]
  );
  return { recorded: Boolean(rows[0]), id: rows[0]?.id || null, duplicate: !rows[0] };
}

// Anything that failed to route, for an operator to look at and reprocess.
// The raw message is still there, which is the entire point of storing it
// first.
async function listUnrouted({ limit = 50 } = {}) {
  await ensureInboundEmailSchema();
  const { rows } = await pool.query(
    `SELECT id, message_id, from_email, subject, status, failure_reason, received_at
       FROM inbound_emails WHERE status IN ('failed','received')
      ORDER BY received_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return rows;
}

module.exports = {
  ensureInboundEmailSchema,
  ingestInboundEmail,
  routeStoredEmail,
  recordUnprocessable,
  listUnrouted,
  // Exported for tests and for whichever adapter is built next.
  parseMessage,
  findTicketForMessage,
  MAX_RAW_BYTES
};
