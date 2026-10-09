const QRCode = require("qrcode");
const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { randomCode, randomToken, sha256 } = require("../../lib/crypto");
const { conflict, notFound, bad, forbidden } = require("../../lib/errors");
const outbox = require("../messaging/outbox");
const templates = require("../messaging/templates");
const qr = require("./qr");

async function issueForOrder(client, order) {
  const { rows: items } = await client.query("SELECT * FROM order_items WHERE order_id = $1", [order.id]);
  const tickets = [];
  for (const item of items) {
    for (let i = 0; i < item.quantity; i++) {
      const { rows } = await client.query(
        `INSERT INTO tickets (code, order_id, order_item_id, event_id, ticket_type_id, owner_user_id, holder_name, price_cents, fee_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomCode(10), order.id, item.id, order.event_id, item.ticket_type_id, order.user_id, order.buyer_name, item.unit_price_cents, item.unit_fee_cents]);
      tickets.push(rows[0]);
    }
  }
  return tickets;
}

async function qrSvg(ticket) {
  return QRCode.toString(qr.payloadFor(ticket), { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0B1A33", light: "#FFFFFF" } });
}

async function listForUser(userId) {
  const { rows } = await db.query(
    `SELECT t.id, t.code, t.status, t.holder_name, t.admitted_at, t.qr_version, t.price_cents,
            tt.name AS ticket_type, e.id AS event_id, e.title, e.slug, e.venue_name, e.city, e.starts_at, e.ends_at,
            e.status AS event_status, e.transfers_enabled, e.image_upload_id, e.category, o.reference AS order_reference,
            (SELECT json_build_object('id', tr.id, 'toEmail', tr.to_email, 'expiresAt', tr.expires_at)
               FROM ticket_transfers tr WHERE tr.ticket_id = t.id AND tr.status = 'pending') AS pending_transfer
       FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.ticket_type_id
       JOIN orders o ON o.id = t.order_id
      WHERE t.owner_user_id = $1 ORDER BY e.starts_at, t.created_at`, [userId]);
  return rows;
}

async function ownedTicket(userId, ticketId, q = db, lock = false) {
  const { rows } = await q.query(
    `SELECT t.*, e.title, e.starts_at, e.status AS event_status, e.transfers_enabled
       FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1 AND t.owner_user_id = $2 ${lock ? "FOR UPDATE OF t" : ""}`,
    [ticketId, userId]);
  if (!rows[0]) throw notFound("Ticket not found.");
  return rows[0];
}

const TRANSFER_TTL_DAYS = 7;

async function startTransfer(user, ticketId, toEmail) {
  if (toEmail === user.email.toLowerCase()) throw bad("You already own this ticket.");
  return db.withTx(async (c) => {
    const t = await ownedTicket(user.id, ticketId, c, true);
    if (!t.transfers_enabled) throw conflict("The organiser has switched off transfers for this event.", "transfers_disabled");
    if (t.status !== "valid") throw conflict("Only unused, valid tickets can be transferred.", "ticket_not_valid");
    if (!["published"].includes(t.event_status) || new Date(t.starts_at) <= new Date()) throw conflict("Transfers close when the event starts.", "transfer_closed");
    const token = randomToken(24);
    const { rows: recipient } = await c.query("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active'", [toEmail]);
    const { rows } = await c.query(
      `INSERT INTO ticket_transfers (ticket_id, from_user_id, to_email, to_user_id, claim_token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '${TRANSFER_TTL_DAYS} days') RETURNING id, expires_at`,
      [t.id, user.id, toEmail, recipient[0]?.id || null, sha256(token)]);
    const { rows: ev } = await c.query("SELECT title, starts_at FROM events WHERE id = $1", [t.event_id]);
    const msg = templates.transferOffer({ fromName: user.fullName, event: ev[0], claimUrl: `${config.publicBaseUrl}/account#/claim/${token}` });
    await outbox.enqueue(c, { to: toEmail, ...msg, userId: recipient[0]?.id });
    await audit.record(c, { actor: user, action: "ticket.transfer_started", entityType: "ticket", entityId: t.id, details: { toEmail } });
    // The claim token is returned only in non-production so the flow can be
    // exercised without a mailbox; in production it travels by email only.
    return { id: rows[0].id, expiresAt: rows[0].expires_at, ...(config.isProd ? {} : { devClaimToken: token }) };
  });
}

async function cancelTransfer(user, transferId) {
  const { rowCount } = await db.query(
    "UPDATE ticket_transfers SET status = 'cancelled', completed_at = now() WHERE id = $1 AND from_user_id = $2 AND status = 'pending'", [transferId, user.id]);
  if (!rowCount) throw notFound("Transfer not found.");
  await audit.record(null, { actor: user, action: "ticket.transfer_cancelled", entityType: "ticket_transfer", entityId: transferId });
}

async function claimTransfer(user, { token, transferId }) {
  return db.withTx(async (c) => {
    const where = token ? "tr.claim_token_hash = $1" : "tr.id = $1 AND tr.to_user_id = $2";
    const params = token ? [sha256(token)] : [transferId, user.id];
    const { rows } = await c.query(`SELECT tr.* FROM ticket_transfers tr WHERE ${where} FOR UPDATE`, params);
    const tr = rows[0];
    if (!tr) throw notFound("This transfer link is not valid.");
    if (!token && !user.emailVerified) throw forbidden("Confirm your email address first, or use the link in the transfer email.");
    if (tr.status !== "pending") throw conflict("This transfer has already been completed or cancelled.", "transfer_closed");
    if (new Date(tr.expires_at) < new Date()) {
      await c.query("UPDATE ticket_transfers SET status = 'expired' WHERE id = $1", [tr.id]);
      throw conflict("This transfer has expired. Ask the sender to send it again.", "transfer_expired");
    }
    if (tr.from_user_id === user.id) throw bad("You cannot accept your own transfer.");
    const { rows: tk } = await c.query("SELECT t.*, e.title, e.starts_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1 FOR UPDATE OF t", [tr.ticket_id]);
    const t = tk[0];
    if (t.owner_user_id !== tr.from_user_id || t.status !== "valid") {
      await c.query("UPDATE ticket_transfers SET status = 'cancelled', completed_at = now() WHERE id = $1", [tr.id]);
      throw conflict("This ticket can no longer be transferred.", "ticket_not_valid");
    }
    // New owner, new QR version: the sender's copy stops working.
    await c.query("UPDATE tickets SET owner_user_id = $2, holder_name = $3, qr_version = qr_version + 1, updated_at = now() WHERE id = $1", [t.id, user.id, user.fullName]);
    // Any tag linked to the ticket belonged to the sender's identity; unlink it.
    await c.query("UPDATE tags SET ticket_id = NULL, updated_at = now() WHERE ticket_id = $1", [t.id]);
    await c.query("UPDATE ticket_transfers SET status = 'accepted', to_user_id = $2, completed_at = now() WHERE id = $1", [tr.id, user.id]);
    const { rows: sender } = await c.query("SELECT email FROM users WHERE id = $1", [tr.from_user_id]);
    await outbox.enqueue(c, { to: sender[0].email, ...templates.transferDone({ event: t, toEmail: user.email }), userId: tr.from_user_id });
    await audit.record(c, { actor: user, action: "ticket.transfer_accepted", entityType: "ticket", entityId: t.id, details: { from: tr.from_user_id } });
    return { ticketId: t.id, eventTitle: t.title };
  });
}

// --- admission -------------------------------------------------------------
const ADMIT_WINDOW_BEFORE_H = 12;
const ADMIT_WINDOW_AFTER_H = 6;

async function admit(staff, { eventId, payload, tagInput, gate }) {
  const tags = require("../tags/service");
  return db.withTx(async (c) => {
    const { rows: evRows } = await c.query("SELECT id, title, status, starts_at, ends_at FROM events WHERE id = $1", [eventId]);
    const ev = evRows[0];
    const log = async (outcome, ticketId = null) => {
      await c.query("INSERT INTO admission_log (event_id, ticket_id, scanned_by, outcome, gate) VALUES ($1,$2,$3,$4,$5)", [eventId, ticketId, staff.id, outcome, gate || null]);
    };
    const now = Date.now();
    if (ev.status !== "published" || now < new Date(ev.starts_at).getTime() - ADMIT_WINDOW_BEFORE_H * 3600e3 || now > new Date(ev.ends_at).getTime() + ADMIT_WINDOW_AFTER_H * 3600e3) {
      await log("event_not_live");
      return { outcome: "event_not_live", message: "This event is not open for entry right now." };
    }

    let ticket;
    if (tagInput) {
      const tag = await tags.resolve(c, tagInput);
      if (!tag || tag.status !== "active" || tag.event_id !== eventId || !tag.ticket_id) {
        await log("invalid");
        return { outcome: "invalid", message: "This tag is not linked to a ticket for this event." };
      }
      ticket = (await c.query("SELECT * FROM tickets WHERE id = $1", [tag.ticket_id])).rows[0];
    } else {
      const parsed = qr.parse(payload);
      if (!parsed) { await log("invalid"); return { outcome: "invalid", message: "Not a TicketRoom ticket, or the code has been altered." }; }
      ticket = (await c.query("SELECT * FROM tickets WHERE code = $1", [parsed.code])).rows[0];
      if (!ticket) { await log("invalid"); return { outcome: "invalid", message: "Ticket not found." }; }
      if (parsed.signed && parsed.version !== ticket.qr_version) {
        await log("invalid", ticket.id);
        return { outcome: "invalid", message: "This QR code was replaced (ticket transferred or reissued). Ask for the current ticket." };
      }
    }
    if (ticket.event_id !== eventId) { await log("wrong_event", ticket.id); return { outcome: "wrong_event", message: "This ticket is for a different event." }; }
    if (ticket.status === "revoked" || ticket.status === "refunded") { await log(ticket.status, ticket.id); return { outcome: ticket.status, message: `This ticket was ${ticket.status}.` }; }

    // The single atomic statement that prevents double entry.
    const { rows } = await c.query(
      `UPDATE tickets SET status = 'used', admitted_at = now(), admitted_by = $2, updated_at = now()
        WHERE id = $1 AND status = 'valid' RETURNING admitted_at`, [ticket.id, staff.id]);
    const { rows: info } = await c.query("SELECT tt.name AS ticket_type FROM ticket_types tt WHERE tt.id = $1", [ticket.ticket_type_id]);
    if (!rows[0]) {
      await log("already_used", ticket.id);
      return { outcome: "already_used", message: "Already scanned.", admittedAt: ticket.admitted_at, holderName: ticket.holder_name, ticketType: info[0]?.ticket_type };
    }
    await log("admitted", ticket.id);
    return { outcome: "admitted", message: "Admit", holderName: ticket.holder_name, ticketType: info[0]?.ticket_type, code: ticket.code };
  });
}

// Revokes the current QR and issues a fresh one (lost phone, leaked screenshot).
async function reissue(actor, ticketId, reason) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("UPDATE tickets SET qr_version = qr_version + 1, updated_at = now() WHERE id = $1 AND status = 'valid' RETURNING id, qr_version", [ticketId]);
    if (!rows[0]) throw conflict("Only valid tickets can be reissued.", "ticket_not_valid");
    await audit.record(c, { actor, action: "ticket.reissued", entityType: "ticket", entityId: ticketId, details: { reason } });
    return rows[0];
  });
}

async function revoke(actor, ticketId, reason) {
  return db.withTx(async (c) => {
    const { rows } = await c.query("UPDATE tickets SET status = 'revoked', revoked_reason = $2, updated_at = now() WHERE id = $1 AND status = 'valid' RETURNING id", [ticketId, reason]);
    if (!rows[0]) throw conflict("Only valid tickets can be revoked.", "ticket_not_valid");
    await c.query("UPDATE tags SET ticket_id = NULL WHERE ticket_id = $1", [ticketId]);
    await audit.record(c, { actor, action: "ticket.revoked", entityType: "ticket", entityId: ticketId, details: { reason } });
  });
}

module.exports = { issueForOrder, qrSvg, listForUser, ownedTicket, startTransfer, cancelTransfer, claimTransfer, admit, reissue, revoke };
