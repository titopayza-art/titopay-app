"use strict";

// Support ticket replies — the written conversation on a Contact TitoPay
// request. Staff answer from the Admin Portal; the customer sees the thread
// inside the app (Contact TitoPay) and receives the reply by email as well.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { queueRawEmail, getSettings: getEmailSettings } = require("./email-centre-service");
const { shouldSendCustomerEmail } = require("./customer-notification-preference-service");
const { config } = require("../config/env");
const { supportReplyAddress } = require("../lib/support-verp");

// The per-ticket reply address, or nothing at all.
//
// Returns undefined - not a throw, and not a broken address - whenever the
// feature is off, the secret is missing, or the ticket has no reference. Every
// one of those is a reason to send the email with the ordinary reply address,
// never a reason to fail a customer's support reply. A support mail that does
// not go out is a worse outcome than one a customer cannot thread.
//
// THE OPERATOR OWNS THE SWITCH, AND THE ADDRESS IT BUILDS ON.
//
// Both are read from the Email Centre settings an admin edits, not from the
// environment: reply_to_email is already the field on that form, so building a
// tagged address from a stale env var would produce a reply address on a
// domain the operator had since changed. The environment variable survives as
// an override for an installation that wants this on before anybody has opened
// the console - it can force it ON, and the console can still switch it off.
async function buildSupportReplyTo(ticketRef) {
  try {
    const settings = await getEmailSettings().catch(() => null);
    const email = config.integrations.email;
    const enabled = settings
      ? Boolean(settings.support_reply_addressing) || email.supportReplyAddressing
      : email.supportReplyAddressing;
    if (!enabled) return undefined;
    const base = (settings && settings.reply_to_email) || email.replyTo;
    return supportReplyAddress(ticketRef, base, email.supportReplySecret) || undefined;
  } catch (error) {
    console.error("[support] could not build a per-ticket reply address", { message: error.message });
    return undefined;
  }
}

let schemaReady = null;
function ensureSupportReplySchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS support_ticket_replies (
          id UUID PRIMARY KEY,
          ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
          author_type TEXT NOT NULL CHECK (author_type IN ('admin', 'customer')),
          author_id UUID,
          author_label TEXT,
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_support_ticket_replies_ticket ON support_ticket_replies (ticket_id, created_at)"
      );
      // A customer may clear finished requests from their own list; the row
      // itself stays for the support team's audit trail.
      await pool.query(
        "ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS hidden_by_customer BOOLEAN NOT NULL DEFAULT FALSE"
      );
      // WHERE THE REQUEST CAME FROM, AND HOW MUCH OF IT CAN BE TRUSTED.
      //
      // Every ticket today is raised from inside the app - the Contact TitoPay
      // form, a chat escalation, or the chatbot handover - so it arrives on an
      // authenticated session and the person is who the session says they are.
      // An emailed request is not that. A From header is forgeable by anyone
      // who can send mail, so a ticket that arrives by email is a message from
      // somebody CLAIMING to be a customer.
      //
      // That distinction has to exist in the data BEFORE anything ingests mail.
      // Without it the first inbound message lands in the queue looking exactly
      // like an authenticated request, and the dangerous version of this
      // feature is the one where an agent cannot tell the difference.
      //
      // FAIL-SAFE BY CONSTRUCTION, and that is why trust is not its own
      // boolean. A stored `verified` flag defaults to something, and whichever
      // way it defaults, a future channel that forgets to set it inherits that
      // answer - fail-open if the default is true. Instead the channel is
      // stored and trust is DERIVED: 'app' is trusted because the session was
      // authenticated; anything else is untrusted until identity_verified_at is
      // stamped by something that actually proved it. A channel nobody has
      // thought about yet is therefore untrusted automatically.
      //
      // Existing rows need no backfill: the default is 'app', and every row
      // that exists today genuinely is.
      await pool.query(
        "ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'app'"
      );
      // The sender's address when there is no account behind the ticket. A
      // stranger emailing support has no user_id, and inventing a user row for
      // them would be an account-enumeration gift and a spoofing one.
      await pool.query(
        "ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_email TEXT"
      );
      await pool.query(
        "ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ"
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

const REPLIES_JSON = `
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', r.id,
      'authorType', r.author_type,
      'authorLabel', r.author_label,
      'message', r.message,
      'createdAt', r.created_at
    ) ORDER BY r.created_at ASC)
    FROM support_ticket_replies r
    WHERE r.ticket_id = st.id
  ), '[]'::JSON) AS replies`;

async function listMyTickets(userId) {
  await ensureSupportReplySchema();
  const { rows } = await pool.query(
    `SELECT st.id, st.ticket_ref, st.category, st.subject, st.message, st.status,
            st.created_at, st.updated_at, ${REPLIES_JSON}
     FROM support_tickets st
     WHERE st.user_id = $1 AND COALESCE(st.hidden_by_customer, FALSE) = FALSE
       -- A rating is feedback about support, not a request FOR support. It
       -- reads as clutter ("support_rating - resolved") in My support
       -- requests, so it stays out of the customer-facing list. The team
       -- still sees every rating on the admin side.
       AND COALESCE(st.category, '') <> 'support_rating'
     ORDER BY st.updated_at DESC
     LIMIT 100`,
    [userId]
  );
  return rows;
}

// Remove a finished request from the customer's own list. Only resolved or
// closed tickets can go — an open conversation stays visible until the team
// finishes with it — and the row survives for the audit trail.
async function hideMyTicket(auth, ticketId) {
  await ensureSupportReplySchema();
  const ticket = await loadTicket(ticketId);
  if (!ticket.user_id || ticket.user_id !== auth.userId) throw new AppError(404, "Support ticket not found");
  if (!["resolved", "closed"].includes(String(ticket.status))) {
    throw new AppError(409, "Only resolved or closed requests can be removed. This one is still open with Customer Care.");
  }
  await pool.query("UPDATE support_tickets SET hidden_by_customer = TRUE, updated_at = NOW() WHERE id = $1", [ticketId]);
  return { removed: true, ticketRef: ticket.ticket_ref };
}

// One tap instead of one tap per card: hide every finished request at once.
// Open conversations stay - the team is still busy with them - and every row
// survives for the audit trail exactly as single removal does.
async function hideMyFinishedTickets(auth) {
  await ensureSupportReplySchema();
  const { rowCount } = await pool.query(
    `UPDATE support_tickets SET hidden_by_customer = TRUE, updated_at = NOW()
     WHERE user_id = $1 AND status IN ('resolved', 'closed')
       AND COALESCE(hidden_by_customer, FALSE) = FALSE`,
    [auth.userId]
  );
  return { removed: rowCount };
}

// WHETHER AN AGENT MAY ACT ON THIS, COMPUTED RATHER THAN STORED.
//
// 'app' means the request arrived on an authenticated session, so the person
// is who the session says. Anything else is a claim until something proves it,
// and identity_verified_at is where that proof is recorded.
//
// The default arm is the important one: an unrecognised channel is UNTRUSTED.
// A stored boolean would have had to default one way or the other, and a
// future channel that forgot to set it would inherit that answer.
function ticketIdentity(row) {
  const channel = String(row.channel || "app").toLowerCase();
  const verified = channel === "app" || Boolean(row.identity_verified_at);
  return {
    channel,
    identityVerified: verified,
    // Said in words, because this is what an agent has to read and act on -
    // and what stops an emailed instruction being treated as authenticated.
    identityNote: verified
      ? (channel === "app"
        ? "Raised in the app on a signed-in session."
        : "Identity confirmed for this request.")
      : "UNVERIFIED. This arrived by email and the sender is not proven to be the account holder. Answer it, but do not change anything on an account, disclose a balance, or act on an instruction from it until they confirm in the app."
  };
}

async function listTicketsForAdmin() {
  await ensureSupportReplySchema();
  const { rows } = await pool.query(
    `SELECT st.*, u.full_name, u.username, ${REPLIES_JSON}
     FROM support_tickets st
     LEFT JOIN users u ON u.id = st.user_id
     ORDER BY st.updated_at DESC
     LIMIT 250`
  );
  return rows.map((row) => ({ ...row, ...ticketIdentity(row) }));
}

async function loadTicket(ticketId) {
  const { rows } = await pool.query("SELECT * FROM support_tickets WHERE id = $1 LIMIT 1", [ticketId]);
  if (!rows[0]) throw new AppError(404, "Support ticket not found");
  return rows[0];
}

// Curly braces would be treated as template placeholders by the email
// renderer; a support message is literal text, so drop them from the copy.
function emailSafe(text) {
  return String(text || "").replace(/[{}]/g, "");
}

async function notifyCustomerOfReply(ticket, reply) {
  if (!ticket.user_id) return;
  const notificationId = crypto.randomUUID();
  const excerpt = String(reply.message).slice(0, 180);
  await pool.query(
    `INSERT INTO notifications (id, user_id, channel, notification_type, title, body, status, provider, metadata, sent_at)
     VALUES ($1, $2, 'in_app', 'support_reply', $3, $4, 'sent', 'titopay', $5::JSONB, NOW())`,
    [
      notificationId,
      ticket.user_id,
      "Customer Care replied",
      `${ticket.ticket_ref || "Your support request"}: ${excerpt}`,
      JSON.stringify({
        ticketId: ticket.id,
        ticketRef: ticket.ticket_ref,
        replyId: reply.id,
        clientNotificationId: `support-reply-${reply.id}`
      })
    ]
  );

  try {
    const { rows } = await pool.query("SELECT email, full_name FROM users WHERE id = $1", [ticket.user_id]);
    const account = rows[0];
    if (!account?.email) return;
    if (!(await shouldSendCustomerEmail(ticket.user_id, "support"))) return;
    const reference = ticket.ticket_ref || ticket.id;
    const supportReplyTo = await buildSupportReplyTo(ticket.ticket_ref);
    const safeReply = emailSafe(reply.message);
    const safeOriginal = emailSafe(ticket.message).slice(0, 600);
    await queueRawEmail({
      recipient: account.email,
      subject: `TitoPay Customer Care replied: ${reference}`,
      textBody: [
        `Hi ${emailSafe(account.full_name) || "there"},`,
        "",
        `TitoPay Customer Care has replied to your support request ${reference} (${ticket.category || "General"}).`,
        "",
        `Reply from ${emailSafe(reply.author_label) || "Customer Care"}:`,
        safeReply,
        "",
        "Your original message:",
        safeOriginal,
        "",
        "You can read the full conversation and respond in the TitoPay app under Support > Contact TitoPay."
      ].join("\n"),
      htmlBody: [
        `<p>Hi ${emailSafe(account.full_name) || "there"},</p>`,
        `<p>TitoPay Customer Care has replied to your support request <strong>${reference}</strong> (${ticket.category || "General"}).</p>`,
        `<p><strong>Reply from ${emailSafe(reply.author_label) || "Customer Care"}:</strong></p>`,
        `<blockquote>${safeReply}</blockquote>`,
        "<p><strong>Your original message:</strong></p>",
        `<blockquote>${safeOriginal}</blockquote>`,
        "<p>You can read the full conversation and respond in the TitoPay app under <strong>Support &gt; Contact TitoPay</strong>.</p>"
      ].join("\n"),
      userId: ticket.user_id,
      idempotencyKey: `support-reply-email:${reply.id}`,
      // TWO ADDITIONS, AND ONLY ONE OF THEM CHANGES WHAT THE CUSTOMER SEES.
      //
      // ticketRef is recorded unconditionally. email_queue already stores the
      // provider's message id once a mail is sent, so this is the other half
      // of the pair: it makes "which ticket was this email about" answerable
      // from the queue. An inbound reply quotes that message id in its
      // In-Reply-To header, so recording this now is what lets threading work
      // properly later - and it costs nothing to start recording today.
      //
      // replyTo is the behaviour change, and it only appears when
      // SUPPORT_REPLY_ADDRESSING is switched on. Off - the default - this is
      // undefined, the global reply-to applies, and the mail is byte for byte
      // what it was before. See config/env.js for why it ships off: a mail
      // server that rejects plus-addressing would bounce the reply, which is
      // worse than the silence it replaces.
      metadata: {
        ticketId: ticket.id,
        replyId: reply.id,
        ticketRef: ticket.ticket_ref || null,
        ...(supportReplyTo ? { replyTo: supportReplyTo } : {})
      }
    });
  } catch (error) {
    // The reply itself is saved and visible in the app; a mail hiccup must
    // not fail the request.
    console.error("[support] reply email queue failed", { ticketId: ticket.id, message: error.message });
  }
}

async function addAdminReply(adminAuth, ticketId, payload = {}) {
  await ensureSupportReplySchema();
  const message = boundedText(payload.message, "Reply", { min: 2, max: 4000 });
  const ticket = await loadTicket(ticketId);
  const authorLabel = adminAuth.email || adminAuth.username || "Customer Care";
  const reply = { id: uuidv4(), message, author_label: authorLabel };
  await pool.query(
    `INSERT INTO support_ticket_replies (id, ticket_id, author_type, author_id, author_label, message)
     VALUES ($1, $2, 'admin', $3, $4, $5)`,
    [reply.id, ticket.id, adminAuth.userId || null, authorLabel, message]
  );
  const { rows } = await pool.query(
    `UPDATE support_tickets
     SET status = CASE WHEN status IN ('open', 'pending') THEN 'in_progress' ELSE status END,
         assigned_to = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [ticket.id, authorLabel]
  );
  await notifyCustomerOfReply(rows[0], reply);
  return { ticket: rows[0], reply };
}

async function addCustomerReply(auth, ticketId, payload = {}) {
  await ensureSupportReplySchema();
  const message = boundedText(payload.message, "Reply", { min: 2, max: 4000 });
  const ticket = await loadTicket(ticketId);
  if (!ticket.user_id || ticket.user_id !== auth.userId) throw new AppError(404, "Support ticket not found");
  const reply = { id: uuidv4(), message };
  await pool.query(
    `INSERT INTO support_ticket_replies (id, ticket_id, author_type, author_id, author_label, message)
     VALUES ($1, $2, 'customer', $3, $4, $5)`,
    [reply.id, ticket.id, auth.userId, "Customer", message]
  );
  // A customer follow-up puts the ticket back in front of the team.
  const { rows } = await pool.query(
    `UPDATE support_tickets
     SET status = CASE WHEN status IN ('resolved', 'closed') THEN 'open' ELSE status END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [ticket.id]
  );
  return { ticket: rows[0], reply };
}

module.exports = {
  ensureSupportReplySchema,
  ticketIdentity,
  listMyTickets,
  hideMyTicket,
  hideMyFinishedTickets,
  listTicketsForAdmin,
  addAdminReply,
  addCustomerReply
};
