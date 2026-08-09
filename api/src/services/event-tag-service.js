"use strict";

// Event Tags — cashless NFC/RFID credentials for TitoPay events.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
//
//   An Event Tag is a CREDENTIAL, not a wallet.
//
// There is no event balance, no event top-up, no event withdrawal and no second
// ledger anywhere in here. A tap resolves the tag to the attendee's EXISTING
// TitoPay wallet and the money moves through the EXISTING wallet_ledger via
// applyWalletMovement, exactly as a QR payment or a ticket purchase does. That
// is what makes a lost tag cheap: the money was never on the wristband, so
// blocking it and issuing another moves nothing.
//
// The credential itself is a 32-byte random token shown once at issue time.
// Only its SHA-256 is stored, so reading the database yields no working tag. It
// carries no user id, wallet id, event id or database id — the server resolves
// all of that from the hash.
//
// The charge path deliberately mirrors the proven structure of
// pos/service.js confirmPayment — advisory-locked idempotency, both wallets
// SELECT ... FOR UPDATE, one transaction row, two ledger entries, all inside a
// single BEGIN/COMMIT — and reuses its idempotency tables. It is a separate
// function rather than a branch inside confirmPayment because the trust model
// differs: a POS confirm is authorised by the CUSTOMER's own token, while a tag
// tap is authorised by the TERMINAL. Widening confirmPayment to accept
// terminal-authorised debits would change the security properties of a live
// integration, so it is left exactly as it is.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config/env");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { applyWalletMovement } = require("./wallet-service");
const { writeAuditLog } = require("./audit-service");

const TAG_PREFIX = "ETAG";

// The Event Tag tables are created by ensureTicketingSchema alongside the rest
// of the ticketing schema, which is the established bootstrap for this module.
// That function replays its whole DO block on every call, so it is run once per
// process here instead of on every request — and deliberately NOT on the charge
// path at all, because a tag cannot be tapped before it was issued, and issuing
// already went through it.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = require("./ticketing-service").ensureTicketingSchema().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Opaque, unpredictable, and carrying nothing about the holder. 32 random bytes
// is 256 bits of entropy, so enumeration is not a threat model that applies.
function mintTagToken() {
  return `${TAG_PREFIX}_${crypto.randomBytes(32).toString("base64url")}`;
}

// What staff read off a wristband to identify it by eye. Random, and unrelated
// to the credential, so seeing a label tells you nothing about the token.
function mintTagLabel() {
  return `T${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

// Deliberately the same rule the POS lane already applies — parsed from the
// text so "1.005" or "1e3" cannot round their way past the ceiling — and the
// same configured maximum, so a tag tap can never authorise more than a card
// tap at the same terminal. Returns rands, which is what the ledger stores.
function money(value, label = "Amount") {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new AppError(400, `${label} is invalid`);
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > Math.round(config.pos.maxAmount * 100)) {
    throw new AppError(400, `${label} is outside the supported range`);
  }
  return cents / 100;
}

// Never leaks the token or its hash. This is what every endpoint returns.
function publicTag(row = {}) {
  return {
    tagId: row.id,
    tagLabel: row.tag_label,
    eventId: row.event_id,
    ticketId: row.ticket_id || null,
    status: row.status,
    issuedAt: row.issued_at,
    assignedAt: row.assigned_at,
    activatedAt: row.activated_at,
    blockedAt: row.blocked_at,
    replacedAt: row.replaced_at,
    deactivatedAt: row.deactivated_at,
    replacedByTagId: row.replaced_by_tag_id || null
  };
}

async function recordTagEvent(client, { tagId, eventId, action, previousStatus, nextStatus, actor = {}, metadata = {} }) {
  await client.query(
    `INSERT INTO event_tag_events (id, tag_id, event_id, action, previous_status, next_status, actor_type, actor_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::JSONB)`,
    [uuidv4(), tagId, eventId, action, previousStatus || null, nextStatus || null,
      actor.userType || actor.actorType || null, actor.userId || actor.actorId || null, JSON.stringify(metadata)]
  );
}

async function assertCashlessEvent(client, eventId) {
  const { rows } = await client.query(
    "SELECT id, event_name, status, cashless_tags_enabled, cashless_settings FROM events WHERE id = $1 LIMIT 1",
    [eventId]
  );
  const event = rows[0];
  if (!event) throw new AppError(404, "Event not found");
  if (!event.cashless_tags_enabled) throw new AppError(409, "Cashless Event Tags are not enabled for this event");
  return event;
}

/* ========================================================================
   Issuing, assigning and the rest of a tag's life
   ======================================================================== */

// Issue a batch of blank tags for an event. They carry no attendee yet. The
// tokens are returned ONCE, here, for writing to the physical credentials —
// they cannot be read back afterwards.
async function issueTags(actor, eventId, count = 1) {
  await ensureSchema();
  const quantity = Math.min(Math.max(Number(count) || 1, 1), 500);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await assertCashlessEvent(client, eventId);
    const issued = [];
    for (let index = 0; index < quantity; index += 1) {
      const token = mintTagToken();
      const id = uuidv4();
      const { rows } = await client.query(
        `INSERT INTO event_tags (id, event_id, token_hash, tag_label, status)
         VALUES ($1,$2,$3,$4,'UNASSIGNED') RETURNING *`,
        [id, event.id, sha256(token), mintTagLabel()]
      );
      await recordTagEvent(client, { tagId: id, eventId: event.id, action: "issued", nextStatus: "UNASSIGNED", actor });
      issued.push({ ...publicTag(rows[0]), token });
    }
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actor.userType, actorId: actor.userId, action: "event_tags_issued",
      entityType: "event", entityId: eventId, metadata: { quantity }
    }).catch(() => {});
    return { issued };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Link a physical tag to an attendee's ticket and activate it in one step —
// which is how it actually happens at a gate: scan the wristband, scan the
// ticket, hand it over.
async function assignTag(actor, eventId, { token, ticketCode, activate = true }) {
  await ensureSchema();
  if (!token) throw new AppError(400, "Tag credential is required");
  if (!ticketCode) throw new AppError(400, "Ticket code is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await assertCashlessEvent(client, eventId);

    const tagResult = await client.query(
      "SELECT * FROM event_tags WHERE token_hash = $1 LIMIT 1 FOR UPDATE",
      [sha256(token)]
    );
    const tag = tagResult.rows[0];
    if (!tag) throw new AppError(404, "Tag not recognised");
    // A tag issued for one event can never be used at another, even by staff
    // who legitimately work both.
    if (tag.event_id !== event.id) throw new AppError(409, "Tag belongs to a different event");
    if (tag.status === "ACTIVE" || tag.status === "ASSIGNED") throw new AppError(409, "Tag is already assigned to an attendee");
    if (["BLOCKED", "LOST", "REPLACED", "DEACTIVATED"].includes(tag.status)) {
      throw new AppError(409, `Tag is ${tag.status.toLowerCase()} and cannot be assigned`);
    }

    const ticketResult = await client.query(
      `SELECT t.id, t.event_id, t.owner_user_id, t.status
         FROM tickets t WHERE t.ticket_code = $1 LIMIT 1 FOR UPDATE`,
      [String(ticketCode).trim()]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket) throw new AppError(404, "Ticket not found");
    if (ticket.event_id !== event.id) throw new AppError(409, "Ticket belongs to a different event");
    if (ticket.status !== "valid") throw new AppError(409, `Ticket is ${ticket.status}`);

    const nextStatus = activate ? "ACTIVE" : "ASSIGNED";
    let updated;
    try {
      const result = await client.query(
        `UPDATE event_tags
            SET ticket_id = $2, user_id = $3, status = $4,
                assigned_at = NOW(), activated_at = CASE WHEN $4 = 'ACTIVE' THEN NOW() ELSE activated_at END,
                updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [tag.id, ticket.id, ticket.owner_user_id, nextStatus]
      );
      updated = result.rows[0];
    } catch (error) {
      // The partial unique index on (ticket_id) for live tags is what stops a
      // second wristband being handed to the same attendee by mistake.
      if (error.code === "23505") throw new AppError(409, "This ticket already has a live Event Tag");
      throw error;
    }

    await recordTagEvent(client, {
      tagId: tag.id, eventId: event.id, action: activate ? "assigned_and_activated" : "assigned",
      previousStatus: tag.status, nextStatus, actor, metadata: { ticketId: ticket.id }
    });
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actor.userType, actorId: actor.userId, action: "event_tag_assigned",
      entityType: "event_tag", entityId: tag.id, metadata: { eventId: event.id, ticketId: ticket.id, activated: activate }
    }).catch(() => {});
    return publicTag(updated);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The attendee linking their own wristband, by holding it against their phone.
//
// This is assignTag with the gate swapped: instead of "is the caller staff for
// this event", the question is "is this the caller's own ticket". Everything
// else is identical and is re-checked here — the tag must be a blank tag, it
// must belong to the same event as the ticket, and the ticket must be valid.
//
// Handing this to the customer is safe because possession of the physical tag
// is the thing being asserted, and the organiser controls who gets one. What it
// cannot do is attach a tag to somebody else's ticket, take over a tag that is
// already live, or reach across to another event.
async function linkMyTag(actor, { token, ticketCode, ticketId } = {}) {
  await ensureSchema();
  if (!token) throw new AppError(400, "Tag credential is required");
  if (!ticketCode && !ticketId) throw new AppError(400, "Ticket is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The ticket first, and only if it is this customer's own.
    const ticketResult = await client.query(
      `SELECT t.id, t.event_id, t.owner_user_id, t.status,
              e.event_name, e.status AS event_status, e.cashless_tags_enabled
         FROM tickets t
         JOIN events e ON e.id = t.event_id
        WHERE ${ticketId ? "t.id = $1" : "t.ticket_code = $1"}
          AND t.owner_user_id = $2
        LIMIT 1
        FOR UPDATE OF t`,
      [String(ticketId || ticketCode).trim(), actor.userId]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket) throw new AppError(404, "Ticket not found");
    if (!ticket.cashless_tags_enabled) throw new AppError(409, "This event does not use Event Tags");
    if (ticket.event_status !== "approved") throw new AppError(409, "This event is not currently accepting Event Tags");
    if (ticket.status !== "valid") throw new AppError(409, `Ticket is ${ticket.status}`);

    const tagResult = await client.query(
      "SELECT * FROM event_tags WHERE token_hash = $1 LIMIT 1 FOR UPDATE",
      [sha256(token)]
    );
    const tag = tagResult.rows[0];
    if (!tag) throw new AppError(404, "That tag is not recognised. Ask event staff to check it.");
    if (tag.event_id !== ticket.event_id) throw new AppError(409, "That tag belongs to a different event");
    if (tag.status === "ACTIVE" || tag.status === "ASSIGNED") {
      // If it is already theirs, say so kindly rather than refusing blankly.
      if (tag.user_id === actor.userId) throw new AppError(409, "This tag is already linked to your ticket");
      throw new AppError(409, "That tag is already linked to another attendee");
    }
    if (tag.status !== "UNASSIGNED") throw new AppError(409, `That tag is ${tag.status.toLowerCase()} and cannot be linked`);

    let linked;
    try {
      const result = await client.query(
        `UPDATE event_tags
            SET ticket_id = $2, user_id = $3, status = 'ACTIVE',
                assigned_at = NOW(), activated_at = NOW(), updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [tag.id, ticket.id, actor.userId]
      );
      linked = result.rows[0];
    } catch (error) {
      if (error.code === "23505") throw new AppError(409, "This ticket already has a tag linked to it");
      throw error;
    }

    await recordTagEvent(client, {
      tagId: tag.id, eventId: ticket.event_id, action: "linked_by_attendee",
      previousStatus: tag.status, nextStatus: "ACTIVE", actor,
      metadata: { ticketId: ticket.id, channel: "self_service" }
    });
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actor.userType, actorId: actor.userId, action: "event_tag_self_linked",
      entityType: "event_tag", entityId: tag.id, metadata: { eventId: ticket.event_id, ticketId: ticket.id }
    }).catch(() => {});
    return { ...publicTag(linked), eventName: ticket.event_name };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The tickets this customer holds for cashless events that have no tag on them
// yet — which is exactly the list the "Link Event Tag" screen offers.
async function linkableTickets(userId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT t.id, t.ticket_code, e.id AS event_id, e.event_name, e.slug, e.event_date, e.venue_name
       FROM tickets t
       JOIN events e ON e.id = t.event_id
      WHERE t.owner_user_id = $1
        AND t.status = 'valid'
        AND e.cashless_tags_enabled = TRUE
        AND e.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM event_tags g
           WHERE g.ticket_id = t.id AND g.status IN ('ASSIGNED','ACTIVE')
        )
      ORDER BY e.event_date ASC NULLS LAST
      LIMIT 50`,
    [userId]
  );
  return rows.map((row) => ({
    ticketId: row.id,
    ticketCode: row.ticket_code,
    eventId: row.event_id,
    eventName: row.event_name,
    eventSlug: row.slug,
    eventDate: row.event_date,
    venueName: row.venue_name
  }));
}

async function setTagStatus(actor, tagId, nextStatus, { reason = "" } = {}) {
  await ensureSchema();
  const allowed = ["ACTIVE", "BLOCKED", "LOST", "DEACTIVATED"];
  if (!allowed.includes(nextStatus)) throw new AppError(400, "Unsupported tag status");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM event_tags WHERE id = $1 LIMIT 1 FOR UPDATE", [tagId]);
    const tag = rows[0];
    if (!tag) throw new AppError(404, "Tag not found");
    if (tag.status === "REPLACED") throw new AppError(409, "A replaced tag cannot change status");
    if (nextStatus === "ACTIVE" && !tag.ticket_id) throw new AppError(409, "Assign the tag to an attendee before activating it");

    const column = { BLOCKED: "blocked_at", LOST: "blocked_at", DEACTIVATED: "deactivated_at", ACTIVE: "activated_at" }[nextStatus];
    const { rows: updated } = await client.query(
      `UPDATE event_tags SET status = $2, ${column} = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [tagId, nextStatus]
    );
    await recordTagEvent(client, {
      tagId, eventId: tag.event_id, action: `status_${nextStatus.toLowerCase()}`,
      previousStatus: tag.status, nextStatus, actor, metadata: { reason: String(reason).slice(0, 300) }
    });
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actor.userType, actorId: actor.userId, action: `event_tag_${nextStatus.toLowerCase()}`,
      entityType: "event_tag", entityId: tagId, metadata: { eventId: tag.event_id, reason: String(reason).slice(0, 300) }
    }).catch(() => {});
    return publicTag(updated[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Replace a lost or blocked tag. Nothing financial happens here — and that is
// the whole point of the credential model. The attendee's money never left
// their TitoPay wallet, so a replacement is a new credential pointing at the
// same person, not a transfer of value off a wristband.
async function replaceTag(actor, oldTagId, { token, reason = "" }) {
  await ensureSchema();
  if (!token) throw new AppError(400, "Replacement tag credential is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM event_tags WHERE id = $1 LIMIT 1 FOR UPDATE", [oldTagId]);
    const oldTag = rows[0];
    if (!oldTag) throw new AppError(404, "Tag not found");
    if (!oldTag.ticket_id) throw new AppError(409, "Only a tag assigned to an attendee can be replaced");
    if (oldTag.status === "REPLACED") throw new AppError(409, "Tag has already been replaced");

    const replacementResult = await client.query(
      "SELECT * FROM event_tags WHERE token_hash = $1 LIMIT 1 FOR UPDATE",
      [sha256(token)]
    );
    const replacement = replacementResult.rows[0];
    if (!replacement) throw new AppError(404, "Replacement tag not recognised");
    if (replacement.event_id !== oldTag.event_id) throw new AppError(409, "Replacement tag belongs to a different event");
    if (replacement.status !== "UNASSIGNED") throw new AppError(409, "Replacement tag is not a blank tag");

    // The old credential stops authorising payments BEFORE the new one starts,
    // so there is never a moment when both are live for one attendee. The
    // partial unique index would refuse it anyway; this makes the order explicit.
    await client.query(
      `UPDATE event_tags SET status = 'REPLACED', replaced_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [oldTag.id]
    );
    const { rows: activated } = await client.query(
      `UPDATE event_tags
          SET ticket_id = $2, user_id = $3, status = 'ACTIVE',
              assigned_at = NOW(), activated_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [replacement.id, oldTag.ticket_id, oldTag.user_id]
    );
    await client.query("UPDATE event_tags SET replaced_by_tag_id = $2 WHERE id = $1", [oldTag.id, replacement.id]);

    await recordTagEvent(client, {
      tagId: oldTag.id, eventId: oldTag.event_id, action: "replaced",
      previousStatus: oldTag.status, nextStatus: "REPLACED", actor,
      metadata: { replacementTagId: replacement.id, reason: String(reason).slice(0, 300) }
    });
    await recordTagEvent(client, {
      tagId: replacement.id, eventId: replacement.event_id, action: "issued_as_replacement",
      previousStatus: "UNASSIGNED", nextStatus: "ACTIVE", actor, metadata: { replacesTagId: oldTag.id }
    });
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actor.userType, actorId: actor.userId, action: "event_tag_replaced",
      entityType: "event_tag", entityId: oldTag.id,
      metadata: { eventId: oldTag.event_id, replacementTagId: replacement.id, reason: String(reason).slice(0, 300) }
    }).catch(() => {});
    return { previous: publicTag({ ...oldTag, status: "REPLACED", replaced_by_tag_id: replacement.id }), replacement: publicTag(activated[0]) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/* ========================================================================
   Tap to pay
   ======================================================================== */

// Every hop is re-verified server-side from the terminal's own identity. The
// request carries a tag credential and an amount; it does NOT get to say who
// the customer is, which wallet to debit or which event this is. Those are
// resolved here or the charge is refused.
async function chargeEventTag(terminal, payload = {}, idempotencyKey, requestId) {
  const token = String(payload.tagToken || payload.token || "").trim();
  if (!token) throw new AppError(400, "Tag credential is required");
  const amount = money(payload.amount, "Amount");
  const currency = String(payload.currency || "ZAR").toUpperCase();
  if (currency !== "ZAR") throw new AppError(400, "Only ZAR is supported");
  if (!idempotencyKey) throw new AppError(400, "Idempotency-Key is required");

  // The hash of the request, so a repeat of the SAME tap replays the stored
  // result while a DIFFERENT tap reusing the key is refused outright.
  const requestHash = sha256(`${sha256(token)}:${amount}:${currency}:${terminal.id}:${payload.merchantReference || ""}`);
  const scope = `event_tag_charge:${terminal.id}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${scope}:${idempotencyKey}`]);

    const replayResult = await client.query(
      "SELECT request_hash, response FROM pos_idempotency_keys WHERE scope = $1 AND idempotency_key = $2 LIMIT 1",
      [scope, idempotencyKey]
    );
    if (replayResult.rows[0]) {
      if (replayResult.rows[0].request_hash !== requestHash) {
        throw new AppError(409, "Idempotency-Key was already used for a different request");
      }
      await client.query("COMMIT");
      return { ...replayResult.rows[0].response, idempotentReplay: true };
    }

    // 1. The tag, and the event it belongs to.
    const tagResult = await client.query(
      `SELECT t.*, e.event_name, e.status AS event_status, e.cashless_tags_enabled
         FROM event_tags t
         JOIN events e ON e.id = t.event_id
        WHERE t.token_hash = $1
        LIMIT 1
        FOR UPDATE OF t`,
      [sha256(token)]
    );
    const tag = tagResult.rows[0];
    if (!tag) throw new AppError(404, "Tag not recognised");
    // Suspending an event already stops ticket sales; it must stop the tags
    // too, or an event pulled for fraud would keep taking money at the bar.
    // "approved" is the only live state — a completed or cancelled event is
    // over, and its wristbands stop with it.
    if (tag.event_status !== "approved") throw new AppError(409, "This event is not currently accepting Event Tag payments");
    if (!tag.cashless_tags_enabled) throw new AppError(409, "Cashless Event Tags are not enabled for this event");
    if (tag.status !== "ACTIVE") throw new AppError(409, `Tag is ${tag.status.toLowerCase()}`);
    if (!tag.user_id) throw new AppError(409, "Tag is not linked to an attendee");

    // 2. The vendor must be authorised for THIS event, and the terminal must
    //    belong to that vendor. Either check failing is a refusal, which is
    //    what keeps Event A's tags from spending at Event B.
    const vendorResult = await client.query(
      `SELECT v.id, v.status FROM event_vendors v
        WHERE v.event_id = $1 AND v.merchant_id = $2 LIMIT 1`,
      [tag.event_id, terminal.merchant_id]
    );
    const vendor = vendorResult.rows[0];
    if (!vendor) throw new AppError(403, "This vendor is not authorised for the event");
    if (vendor.status !== "active") throw new AppError(403, "This vendor is suspended for the event");

    // 3. The attendee's EXISTING wallet. Locked for the duration so two
    //    terminals tapping at once cannot both pass the balance check.
    const walletResult = await client.query(
      `SELECT u.status AS account_status, u.profile_locked, w.*
         FROM users u
         JOIN wallets w ON w.user_id = u.id
        WHERE u.id = $1
        ORDER BY w.created_at ASC
        LIMIT 1
        FOR UPDATE OF w`,
      [tag.user_id]
    );
    const customerWallet = walletResult.rows[0];
    if (!customerWallet || customerWallet.account_status !== "active" || customerWallet.status !== "active") {
      throw new AppError(404, "Active customer wallet not found");
    }
    // A locked wallet stops paying out here exactly as it does everywhere else.
    if (customerWallet.profile_locked) throw new AppError(423, "Profile is locked. Financial transactions are disabled.");

    const merchantWalletResult = await client.query(
      `SELECT w.*
         FROM merchants m
         LEFT JOIN merchant_wallets mw ON mw.merchant_id = m.id AND mw.status = 'active'
         JOIN wallets w ON w.id = COALESCE(mw.wallet_id, (
           SELECT id FROM wallets WHERE user_id = m.user_id AND kind IN ('merchant','business') ORDER BY created_at ASC LIMIT 1
         ))
        WHERE m.id = $1 AND m.status = 'active'
        LIMIT 1
        FOR UPDATE OF w`,
      [terminal.merchant_id]
    );
    const merchantWallet = merchantWalletResult.rows[0];
    if (!merchantWallet || merchantWallet.status !== "active") throw new AppError(503, "Vendor settlement wallet is unavailable");

    if (Number(customerWallet.available_balance) < amount) throw new AppError(400, "Insufficient balance");

    // 4. The existing ledger does the work. One transaction row, one debit, one
    //    credit — the same shape as every other TitoPay payment.
    const transactionId = uuidv4();
    const reference = `ETAG-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const metadata = {
      channel: "EVENT_TAG",
      paymentMethod: "EVENT_TAG",
      eventId: tag.event_id,
      eventName: tag.event_name,
      vendorMerchantId: terminal.merchant_id,
      vendorName: terminal.business_name || null,
      terminalId: terminal.terminal_id,
      tagId: tag.id,
      tagLabel: tag.tag_label,
      merchantReference: payload.merchantReference ? String(payload.merchantReference).slice(0, 120) : null,
      requestId: requestId || null
    };
    await client.query(
      `INSERT INTO transactions
         (id,user_id,wallet_id,merchant_id,service_code,amount,fee,total,status,direction,reference,recipient_reference,metadata)
       VALUES ($1,$2,$3,$4,'event_tag',$5,0,$5,'processing','debit',$6,$7,$8::JSONB)`,
      [transactionId, tag.user_id, customerWallet.id, terminal.merchant_id, amount, reference,
        metadata.merchantReference, JSON.stringify(metadata)]
    );
    await applyWalletMovement(client, {
      walletId: customerWallet.id, transactionId, entryType: "debit", amount, reference,
      metadata: { channel: "EVENT_TAG", eventId: tag.event_id, terminalId: terminal.terminal_id }
    });
    await applyWalletMovement(client, {
      walletId: merchantWallet.id, transactionId, entryType: "credit", amount, reference,
      metadata: { channel: "EVENT_TAG", eventId: tag.event_id, customerId: tag.user_id }
    });
    await client.query("UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1", [transactionId]);

    await recordTagEvent(client, {
      tagId: tag.id, eventId: tag.event_id, action: "payment",
      previousStatus: "ACTIVE", nextStatus: "ACTIVE",
      actor: { actorType: "terminal", actorId: null },
      metadata: { amount, reference, terminalId: terminal.terminal_id, merchantId: terminal.merchant_id }
    });

    // The tag credential never appears in what the terminal is told.
    const response = {
      outcome: "APPROVED",
      reference,
      transactionId,
      amount,
      currency,
      event: { id: tag.event_id, name: tag.event_name },
      tagLabel: tag.tag_label,
      completedAt: new Date().toISOString()
    };
    await client.query(
      `INSERT INTO pos_idempotency_keys (scope, idempotency_key, request_hash, response) VALUES ($1,$2,$3,$4::JSONB)`,
      [scope, idempotencyKey, requestHash, JSON.stringify(response)]
    );
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/* ========================================================================
   Reading
   ======================================================================== */

async function listEventTags(eventId, { status = "", limit = 200 } = {}) {
  await ensureSchema();
  const params = [eventId];
  let where = "WHERE t.event_id = $1";
  if (status) { params.push(String(status).toUpperCase()); where += ` AND t.status = $${params.length}`; }
  params.push(Math.min(Number(limit) || 200, 500));
  const { rows } = await pool.query(
    `SELECT t.*, tk.ticket_code, u.full_name AS attendee_name
       FROM event_tags t
       LEFT JOIN tickets tk ON tk.id = t.ticket_id
       LEFT JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({ ...publicTag(row), ticketCode: row.ticket_code || null, attendeeName: row.attendee_name || null }));
}

// What the attendee sees in the app. Their own tags only, resolved from their
// authenticated user id — never from anything the client sends.
async function listMyEventTags(userId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT t.*, e.event_name, e.slug
       FROM event_tags t
       JOIN events e ON e.id = t.event_id
      WHERE t.user_id = $1 AND t.status <> 'REPLACED'
      ORDER BY t.created_at DESC
      LIMIT 50`,
    [userId]
  );
  return rows.map((row) => ({ ...publicTag(row), eventName: row.event_name, eventSlug: row.slug }));
}

// The attendee reporting their own wristband lost. Scoped to tags they own, so
// one customer can never block another's.
async function reportMyTagLost(actor, tagId) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT id, user_id FROM event_tags WHERE id = $1 LIMIT 1", [tagId]);
  if (!rows[0] || rows[0].user_id !== actor.userId) throw new AppError(404, "Tag not found");
  return setTagStatus(actor, tagId, "LOST", { reason: "Reported lost by the attendee" });
}

async function eventTagAnalytics(eventId) {
  await ensureSchema();
  const { rows: tagRows } = await pool.query(
    `SELECT status, COUNT(*)::INT AS count FROM event_tags WHERE event_id = $1 GROUP BY status`,
    [eventId]
  );
  const byStatus = {};
  tagRows.forEach((row) => { byStatus[row.status] = row.count; });

  // Derived from the real transactions table, not from a tally kept alongside
  // it, so these figures cannot drift from the ledger.
  const { rows: sales } = await pool.query(
    `SELECT COUNT(*)::INT AS payments,
            COALESCE(SUM(amount), 0)::NUMERIC AS total,
            COALESCE(AVG(amount), 0)::NUMERIC AS average
       FROM transactions
      WHERE service_code = 'event_tag'
        AND status = 'completed'
        AND metadata->>'eventId' = $1`,
    [eventId]
  );
  const { rows: byVendor } = await pool.query(
    `SELECT COALESCE(m.business_name, t.metadata->>'vendorName', 'Unknown vendor') AS vendor,
            COUNT(*)::INT AS payments,
            COALESCE(SUM(t.amount), 0)::NUMERIC AS total
       FROM transactions t
       LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE t.service_code = 'event_tag' AND t.status = 'completed' AND t.metadata->>'eventId' = $1
      GROUP BY 1 ORDER BY 3 DESC LIMIT 50`,
    [eventId]
  );
  const { rows: byTerminal } = await pool.query(
    `SELECT COALESCE(metadata->>'terminalId', 'unknown') AS terminal,
            COUNT(*)::INT AS payments,
            COALESCE(SUM(amount), 0)::NUMERIC AS total
       FROM transactions
      WHERE service_code = 'event_tag' AND status = 'completed' AND metadata->>'eventId' = $1
      GROUP BY 1 ORDER BY 3 DESC LIMIT 50`,
    [eventId]
  );

  return {
    // Deliberately no "event wallet balance": there is no event wallet.
    tagsIssued: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    tagsByStatus: byStatus,
    tagsActive: byStatus.ACTIVE || 0,
    tagsLostOrBlocked: (byStatus.LOST || 0) + (byStatus.BLOCKED || 0),
    tagsReplaced: byStatus.REPLACED || 0,
    payments: sales[0]?.payments || 0,
    totalSales: Number(sales[0]?.total || 0),
    averageTransaction: Number(sales[0]?.average || 0),
    salesByVendor: byVendor.map((row) => ({ vendor: row.vendor, payments: row.payments, total: Number(row.total) })),
    salesByTerminal: byTerminal.map((row) => ({ terminal: row.terminal, payments: row.payments, total: Number(row.total) }))
  };
}

/* ========================================================================
   Vendors
   ======================================================================== */

async function addEventVendor(actor, eventId, merchantId) {
  await ensureSchema();
  const { rows: merchants } = await pool.query("SELECT id, business_name, status FROM merchants WHERE id = $1 LIMIT 1", [merchantId]);
  if (!merchants[0]) throw new AppError(404, "Merchant not found");
  const { rows } = await pool.query(
    `INSERT INTO event_vendors (id, event_id, merchant_id, created_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (event_id, merchant_id) DO UPDATE SET status = 'active', updated_at = NOW()
     RETURNING *`,
    [uuidv4(), eventId, merchantId, actor.userId]
  );
  await writeAuditLog({
    actorType: actor.userType, actorId: actor.userId, action: "event_vendor_added",
    entityType: "event", entityId: eventId, metadata: { merchantId }
  }).catch(() => {});
  return { vendorId: rows[0].id, eventId, merchantId, businessName: merchants[0].business_name, status: rows[0].status };
}

async function listEventVendors(eventId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT v.id, v.status, m.id AS merchant_id, m.business_name, m.merchant_id AS merchant_code
       FROM event_vendors v JOIN merchants m ON m.id = v.merchant_id
      WHERE v.event_id = $1 ORDER BY m.business_name
      LIMIT 500`,
    [eventId]
  );
  return rows.map((row) => ({
    vendorId: row.id, status: row.status, merchantId: row.merchant_id,
    businessName: row.business_name, merchantCode: row.merchant_code
  }));
}

async function setEventCashless(actor, eventId, enabled, settings = {}) {
  await ensureSchema();
  const { rows } = await pool.query(
    `UPDATE events
        SET cashless_tags_enabled = $2,
            cashless_settings = COALESCE($3::JSONB, cashless_settings),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, event_name, cashless_tags_enabled, cashless_settings`,
    [eventId, Boolean(enabled), settings ? JSON.stringify(settings) : null]
  );
  if (!rows[0]) throw new AppError(404, "Event not found");
  await writeAuditLog({
    actorType: actor.userType, actorId: actor.userId, action: "event_cashless_updated",
    entityType: "event", entityId: eventId, metadata: { enabled: Boolean(enabled) }
  }).catch(() => {});
  return {
    eventId: rows[0].id, eventName: rows[0].event_name,
    cashlessTagsEnabled: rows[0].cashless_tags_enabled, cashlessSettings: rows[0].cashless_settings
  };
}

async function tagAuditTrail(tagId, limit = 100) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT action, previous_status, next_status, actor_type, actor_id, metadata, created_at
       FROM event_tag_events WHERE tag_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tagId, Math.min(Number(limit) || 100, 200)]
  );
  return rows;
}

module.exports = {
  mintTagToken,
  issueTags,
  assignTag,
  linkMyTag,
  linkableTickets,
  setTagStatus,
  replaceTag,
  chargeEventTag,
  listEventTags,
  listMyEventTags,
  reportMyTagLost,
  eventTagAnalytics,
  addEventVendor,
  listEventVendors,
  setEventCashless,
  tagAuditTrail,
  publicTag
};
