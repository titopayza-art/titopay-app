"use strict";

// Support ticket replies — the written conversation on a Contact TitoPay
// request. Staff answer from the Admin Portal; the customer sees the thread
// inside the app (Contact TitoPay) and receives the reply by email as well.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { queueRawEmail } = require("./email-centre-service");
const { shouldSendCustomerEmail } = require("./customer-notification-preference-service");

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
     WHERE st.user_id = $1
     ORDER BY st.updated_at DESC
     LIMIT 100`,
    [userId]
  );
  return rows;
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
  return rows;
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
    const safeReply = emailSafe(reply.message);
    const safeOriginal = emailSafe(ticket.message).slice(0, 600);
    await queueRawEmail({
      recipient: account.email,
      subject: `TitoPay Customer Care replied — ${reference}`,
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
      metadata: { ticketId: ticket.id, replyId: reply.id }
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
  listMyTickets,
  listTicketsForAdmin,
  addAdminReply,
  addCustomerReply
};
