// Unified tag registry for QR tags, NFC wristbands and NFC cards.
//
// Reader input forms:
//   "TRT1.<random token>"  QR tag, or NFC tag carrying an NDEF text record
//   "UID:04A1B2C3D4E5F6" or bare hex UID  NFC chip UID only
// The raw value is never stored: tags.token_hash = HMAC(pepper, normalised).
const config = require("../../config");
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { hmac, randomToken, randomCode, hashSecret, verifySecret } = require("../../lib/crypto");
const { bad, conflict, notFound } = require("../../lib/errors");

function normalise(input) {
  const s = String(input || "").trim();
  const tok = s.match(/^TRT1\.([A-Za-z0-9_-]{16,64})$/);
  if (tok) return { kind: "token", value: tok[1] };
  const uid = s.replace(/^UID:/i, "").replace(/[:\s-]/g, "").toUpperCase();
  if (/^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/.test(uid)) return { kind: "uid", value: uid };
  return null;
}

const tokenHash = (n) => hmac(config.keys.tagPepper, `${n.kind}:${n.value}`).toString("hex");
const formatDisplay = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

async function resolve(q, input) {
  const n = normalise(input);
  if (!n) return null;
  const { rows } = await q.query("SELECT * FROM tags WHERE token_hash = $1", [tokenHash(n)]);
  const tag = rows[0];
  if (tag && tag.status === "active" && tag.expires_at && new Date(tag.expires_at) < new Date()) tag.status = "expired";
  return tag || null;
}

async function logEvent(q, tagId, action, actor, details = {}) {
  await q.query("INSERT INTO tag_events (tag_id, action, actor_id, details) VALUES ($1,$2,$3,$4)", [tagId, action, actor?.id || null, details]);
}

// Admin: create a batch. "generate" mints random tokens for QR printing or
// NDEF encoding; "import" registers factory chip UIDs (identifier-only).
// Returns the printable/encodable values ONCE; they are not retrievable later.
async function createBatch(actor, { tagType, quantity, eventId, mode, uids, notes }) {
  if (mode === "import" && tagType === "qr_tag") throw bad("QR tags are generated, not imported.");
  return db.withTx(async (c) => {
    if (eventId) {
      const { rows } = await c.query("SELECT id FROM events WHERE id = $1", [eventId]);
      if (!rows[0]) throw notFound("Event not found.");
    }
    const count = mode === "import" ? uids.length : quantity;
    const { rows: b } = await c.query("INSERT INTO tag_batches (tag_type, event_id, quantity, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [tagType, eventId || null, count, notes || null, actor.id]);
    const out = [];
    for (let i = 0; i < count; i++) {
      let n, payload, level;
      if (mode === "import") {
        n = normalise(`UID:${uids[i]}`);
        if (!n || n.kind !== "uid") throw bad(`Line ${i + 1}: not a valid chip UID.`);
        payload = `UID:${n.value}`;
        level = "uid_only";
      } else {
        n = { kind: "token", value: randomToken(18) };
        payload = `TRT1.${n.value}`;
        level = "random_token";
      }
      const display = randomCode(8);
      const activation = randomCode(6);
      const { rows } = await c.query(
        `INSERT INTO tags (tag_type, token_hash, display_code, activation_code_hash, security_level, batch_id, event_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [tagType, tokenHash(n), display, hashSecret(activation), level, b[0].id, eventId || null, eventId ? "assigned" : "unassigned"]);
      await logEvent(c, rows[0].id, "created", actor, { batch: b[0].id });
      out.push({ tagId: rows[0].id, payload, displayCode: formatDisplay(display), activationCode: activation, securityLevel: level });
    }
    await audit.record(c, { actor, action: "tags.batch_created", entityType: "tag_batch", entityId: b[0].id, details: { tagType, count, eventId, mode } });
    return { batchId: b[0].id, tags: out };
  });
}

async function requireTicketForEvent(c, userId, eventId, ticketId) {
  const { rows } = await c.query(
    `SELECT id FROM tickets WHERE owner_user_id = $1 AND event_id = $2 AND status IN ('valid','used') ${ticketId ? "AND id = $3" : ""} ORDER BY created_at LIMIT 1`,
    ticketId ? [userId, eventId, ticketId] : [userId, eventId]);
  if (!rows[0]) throw conflict("You need a ticket for this event before linking a tag.", "no_ticket");
  return rows[0].id;
}

async function activate(c, tag, { userId, eventId, ticketId, actor, via }) {
  if (!["unassigned", "assigned"].includes(tag.status)) throw conflict(`This tag cannot be linked (status: ${tag.status}).`, "tag_unavailable");
  if (tag.event_id && tag.event_id !== eventId) throw conflict("This tag belongs to a different event.", "tag_wrong_event");
  const { rows: active } = await c.query("SELECT id FROM tags WHERE event_id = $1 AND user_id = $2 AND status = 'active'", [eventId, userId]);
  if (active[0]) throw conflict("You already have an active tag for this event. Report it lost first if you are replacing it.", "tag_already_linked");
  const { rowCount } = await c.query(
    `UPDATE tags SET status = 'active', user_id = $2, event_id = $3, ticket_id = $4, linked_at = now(), activated_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('unassigned','assigned') AND user_id IS NULL`, [tag.id, userId, eventId, ticketId]);
  if (!rowCount) throw conflict("This tag was just linked by someone else.", "tag_unavailable");
  await logEvent(c, tag.id, "linked", actor, { userId, eventId, ticketId, via });
}

const ATTEMPT_LIMIT = 5;
async function linkByAttendee(user, { displayCode, activationCode, eventId }) {
  const code = String(displayCode).toUpperCase().replace(/[\s-]/g, "");
  // Attempt accounting happens outside the linking transaction so a failed
  // attempt is recorded even though the request is rejected.
  const { rows: found } = await db.query("SELECT id, activation_code_hash FROM tags WHERE display_code = $1", [code]);
  const candidate = found[0];
  if (candidate) {
    const { rows: fails } = await db.query("SELECT count(*)::int AS n FROM tag_events WHERE tag_id = $1 AND action = 'link_failed' AND occurred_at > now() - interval '1 hour'", [candidate.id]);
    if (fails[0].n >= ATTEMPT_LIMIT) throw conflict("Too many failed attempts on this tag. Visit the registration desk.", "tag_locked");
  }
  // Same message for an unknown code and a wrong activation code.
  if (!candidate || !candidate.activation_code_hash || !verifySecret(String(activationCode).toUpperCase().trim(), candidate.activation_code_hash)) {
    if (candidate) await logEvent(db, candidate.id, "link_failed", user, { reason: "bad_activation" });
    throw conflict("That tag code and activation code do not match.", "tag_code_mismatch");
  }
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM tags WHERE id = $1 FOR UPDATE", [candidate.id]);
    const tag = rows[0];
    const { rows: ev } = await c.query("SELECT id, status, ends_at FROM events WHERE id = $1", [eventId]);
    if (!ev[0] || ev[0].status !== "published" || new Date(ev[0].ends_at) < new Date()) throw conflict("This event is not open for tag linking.", "event_closed");
    const ticketId = await requireTicketForEvent(c, user.id, eventId);
    await activate(c, tag, { userId: user.id, eventId, ticketId, actor: user, via: "attendee" });
    await audit.record(c, { actor: user, action: "tag.linked", entityType: "tag", entityId: tag.id, details: { eventId } });
    return { tagId: tag.id };
  });
}

// Registration desk: staff hold the tag and the attendee's ticket QR.
async function linkByStaff(staff, { eventId, tagInput, ticketPayload }) {
  const qr = require("../tickets/qr");
  return db.withTx(async (c) => {
    const parsed = qr.parse(ticketPayload);
    if (!parsed) throw bad("Scan the attendee's ticket QR code.");
    const { rows: t } = await c.query("SELECT * FROM tickets WHERE code = $1 AND event_id = $2", [parsed.code, eventId]);
    const ticket = t[0];
    if (!ticket || !["valid", "used"].includes(ticket.status) || (parsed.signed && parsed.version !== ticket.qr_version)) throw conflict("That ticket is not valid for this event.", "ticket_not_valid");
    const n = normalise(tagInput);
    if (!n) throw bad("Unrecognised tag. Scan the tag again.");
    const { rows } = await c.query("SELECT * FROM tags WHERE token_hash = $1 FOR UPDATE", [tokenHash(n)]);
    if (!rows[0]) throw notFound("This tag is not registered with TicketRoom.");
    await activate(c, rows[0], { userId: ticket.owner_user_id, eventId, ticketId: ticket.id, actor: staff, via: "staff" });
    await audit.record(c, { actor: staff, action: "tag.linked_by_staff", entityType: "tag", entityId: rows[0].id, details: { eventId, ticketId: ticket.id } });
    return { tagId: rows[0].id, holderName: ticket.holder_name };
  });
}

// Lost/stolen: immediate. Blocks every future purchase and admission.
async function reportLost(user, tagId) {
  return db.withTx(async (c) => {
    const { rowCount } = await c.query(
      "UPDATE tags SET status = 'lost', status_reason = 'reported lost by attendee', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active'", [tagId, user.id]);
    if (!rowCount) throw notFound("Active tag not found.");
    await logEvent(c, tagId, "reported_lost", user);
    await audit.record(c, { actor: user, action: "tag.reported_lost", entityType: "tag", entityId: tagId });
  });
}

async function setStatus(actor, tagId, status, reason) {
  const allowed = { blocked: ["active", "assigned", "unassigned"], revoked: ["active", "assigned", "unassigned", "blocked", "lost"], active: ["blocked"] };
  return db.withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM tags WHERE id = $1 FOR UPDATE", [tagId]);
    const tag = rows[0];
    if (!tag) throw notFound("Tag not found.");
    if (!allowed[status]?.includes(tag.status)) throw conflict(`Cannot change a ${tag.status} tag to ${status}.`, "bad_transition");
    if (status === "active") {
      if (!tag.user_id) throw conflict("Only a linked tag can be unblocked.", "bad_transition");
      const { rows: other } = await c.query("SELECT id FROM tags WHERE event_id = $1 AND user_id = $2 AND status = 'active' AND id <> $3", [tag.event_id, tag.user_id, tag.id]);
      if (other[0]) throw conflict("The attendee already has another active tag.", "tag_already_linked");
    }
    await c.query("UPDATE tags SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1", [tagId, status, reason]);
    await logEvent(c, tagId, `status:${status}`, actor, { reason });
    await audit.record(c, { actor, action: `tag.${status}`, entityType: "tag", entityId: tagId, details: { reason, from: tag.status } });
  });
}

// Staff replacement: the old tag is retired, the new one takes over the same
// attendee and ticket. Balance lives on the attendee's event account, not the
// tag, so it carries over automatically.
async function replace(staff, { eventId, oldTagId, newTagInput }) {
  return db.withTx(async (c) => {
    const { rows: o } = await c.query("SELECT * FROM tags WHERE id = $1 AND event_id = $2 FOR UPDATE", [oldTagId, eventId]);
    const old = o[0];
    if (!old || !old.user_id || !["active", "lost", "blocked"].includes(old.status)) throw conflict("That tag cannot be replaced.", "bad_transition");
    const n = normalise(newTagInput);
    if (!n) throw bad("Unrecognised new tag.");
    const { rows: nw } = await c.query("SELECT * FROM tags WHERE token_hash = $1 FOR UPDATE", [tokenHash(n)]);
    if (!nw[0]) throw notFound("The new tag is not registered.");
    await c.query("UPDATE tags SET status = 'replaced', status_reason = 'replaced at desk', replaced_by_tag_id = $2, updated_at = now() WHERE id = $1", [old.id, nw[0].id]);
    await activate(c, nw[0], { userId: old.user_id, eventId, ticketId: old.ticket_id, actor: staff, via: "replacement" });
    await logEvent(c, old.id, "replaced", staff, { newTagId: nw[0].id });
    await audit.record(c, { actor: staff, action: "tag.replaced", entityType: "tag", entityId: old.id, details: { newTagId: nw[0].id } });
    return { newTagId: nw[0].id };
  });
}

async function listForUser(userId) {
  const { rows } = await db.query(
    `SELECT t.id, t.tag_type, t.display_code, t.status, t.security_level, t.linked_at, t.last_used_at, e.id AS event_id, e.title AS event_title, e.starts_at
       FROM tags t LEFT JOIN events e ON e.id = t.event_id WHERE t.user_id = $1 ORDER BY t.linked_at DESC NULLS LAST`, [userId]);
  return rows.map((r) => ({ ...r, display_code: formatDisplay(r.display_code) }));
}

module.exports = { normalise, tokenHash, resolve, createBatch, linkByAttendee, linkByStaff, reportLost, setStatus, replace, listForUser, formatDisplay, logEvent };
