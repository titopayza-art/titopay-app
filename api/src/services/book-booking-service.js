"use strict";

// THE BOOKING ENGINE.
//
// Availability is COMPUTED, never stored. A stored free/busy table is a second
// source of truth that drifts the first time a booking is written outside the
// one code path that maintains it, and the drift shows up as a double-booked
// table on a Friday night. Opening hours minus what is already taken, worked out
// at read time, cannot drift.
//
// TWO PEOPLE, ONE TABLE, SAME INSTANT. This is the requirement that cannot be
// met by careful reads, because the failure happens between "SELECT finds
// nothing" and "INSERT writes something". It is proven, not assumed:
// concurrency-proof.js ran two simultaneous attempts against a real database
// with a CONTROL that double-books, so the guard below is measured rather than
// hoped for. The mechanism is an advisory lock keyed on the RESOURCE, held for
// the transaction, with the overlap re-checked inside it.
//
// The lock key is the resource, NOT the resource and start time. Keying on the
// slot only serialises identical start times, so 14:00-15:00 and 14:30-15:30 on
// the same bay would both pass the check and both be written.

const { randomUUID } = require("node:crypto");

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { ensureBookSchema } = require("./book-schema");
const reference = require("../config/book-reference");

const OCCUPYING = reference.OCCUPYING_STATUSES;

/* ---------------------------------------------------------------- helpers */

// A booking reference a person can read out over a phone. No I, O, 0 or 1.
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function bookingReference() {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += REFERENCE_ALPHABET[Math.floor(Math.random() * REFERENCE_ALPHABET.length)];
  }
  return `BK-${out.slice(0, 4)}-${out.slice(4)}`;
}

function startOfDayUtc(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || "").trim());
  if (!match) throw new AppError(400, "That date is not valid.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) throw new AppError(400, "That date is not valid.");
  return date;
}

function shapeBooking(row) {
  return {
    id: row.id,
    reference: row.reference,
    venueId: row.venue_id,
    serviceId: row.service_id,
    resourceId: row.resource_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    partySize: row.party_size,
    status: row.status,
    quotedAmount: Number(row.quoted_amount),
    customer: {
      userId: row.customer_user_id,
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email
    },
    customerNotes: row.customer_notes,
    businessNotes: row.business_notes,
    cancellationReason: row.cancellation_reason,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at
  };
}

/* ----------------------------------------------------------- availability */

/**
 * The times a customer can actually pick, for one service on one day.
 *
 * Returned as whole slots rather than a free/busy range, because a customer
 * picks a time, not an interval, and letting the client slice a range is how
 * two clients end up slicing it differently.
 */
async function availability(venueId, serviceId, dateText, { now = new Date() } = {}) {
  await ensureBookSchema();

  const { rows: serviceRows } = await pool.query(
    `SELECT s.*, v.status AS venue_status
       FROM book_services s JOIN book_venues v ON v.id = s.venue_id
      WHERE s.id = $1 AND s.venue_id = $2 LIMIT 1`,
    [serviceId, venueId]
  );
  const service = serviceRows[0];
  if (!service) throw new AppError(404, "That service was not found.");
  if (service.status !== "active") return { date: dateText, slots: [] };

  const dayStart = startOfDayUtc(dateText);
  const dayOfWeek = dayStart.getUTCDay();

  // Beyond how far ahead this service accepts bookings.
  const horizon = new Date(now.getTime() + service.booking_horizon_days * 86400000);
  if (dayStart > horizon) return { date: dateText, slots: [] };

  // Closed for the day, or open on a different window than usual.
  const { rows: exceptions } = await pool.query(
    "SELECT * FROM book_availability_exceptions WHERE venue_id = $1 AND exception_date = $2::date",
    [venueId, dateText]
  );
  const closedAllDay = exceptions.some((e) => e.is_closed && !e.resource_id);
  if (closedAllDay) return { date: dateText, slots: [] };

  const { rows: rules } = await pool.query(
    "SELECT * FROM book_availability_rules WHERE venue_id = $1 AND day_of_week = $2",
    [venueId, dayOfWeek]
  );
  const windows = exceptions.filter((e) => !e.is_closed && !e.resource_id).length
    ? exceptions.filter((e) => !e.is_closed && !e.resource_id)
        .map((e) => ({ opens_minute: e.opens_minute, closes_minute: e.closes_minute, resource_id: null }))
    : rules;
  if (!windows.length) return { date: dateText, slots: [] };

  // Which resources can carry this service. A service with no resource linked is
  // carried by the venue as a whole, which is how a restaurant that has not set
  // up tables still takes reservations.
  const { rows: resources } = await pool.query(
    `SELECT r.* FROM book_resources r
       JOIN book_service_resources sr ON sr.resource_id = r.id
      WHERE sr.service_id = $1 AND r.status = 'active'`,
    [serviceId]
  );

  // Everything already holding time on this day.
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const { rows: taken } = await pool.query(
    `SELECT resource_id, starts_at, ends_at, party_size
       FROM book_bookings
      WHERE venue_id = $1 AND status = ANY($2::text[])
        AND starts_at < $4 AND ends_at > $3`,
    [venueId, OCCUPYING, dayStart.toISOString(), dayEnd.toISOString()]
  );

  const step = 15; // a quarter hour grid, which is what people actually pick
  const totalMinutes = service.duration_minutes + service.buffer_minutes;
  const earliest = new Date(now.getTime() + service.lead_time_minutes * 60000);

  const slots = [];
  for (const window of windows) {
    for (let minute = window.opens_minute; minute + totalMinutes <= window.closes_minute; minute += step) {
      const startsAt = new Date(dayStart.getTime() + minute * 60000);
      const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60000);
      if (startsAt < earliest) continue;

      const blockEnd = new Date(startsAt.getTime() + totalMinutes * 60000);
      const overlapping = taken.filter((b) =>
        new Date(b.starts_at) < blockEnd && new Date(b.ends_at) > startsAt);

      let remaining;
      if (resources.length) {
        // Capacity is per resource: a slot is open while ANY resource still has
        // room, and how many is the best any single resource can offer.
        remaining = Math.max(0, ...resources.map((resource) => {
          const used = overlapping
            .filter((b) => b.resource_id === resource.id)
            .reduce((sum, b) => sum + b.party_size, 0);
          return Math.max(0, Math.min(resource.capacity, service.capacity) - used);
        }));
      } else {
        const used = overlapping.reduce((sum, b) => sum + b.party_size, 0);
        remaining = Math.max(0, service.capacity - used);
      }

      if (remaining > 0) {
        slots.push({
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          remaining
        });
      }
    }
  }
  return { date: dateText, durationMinutes: service.duration_minutes, price: Number(service.price), slots };
}

/* ------------------------------------------------------------- the write */

/**
 * Take a booking.
 *
 * The availability check happens INSIDE the transaction, after the lock, and it
 * is authoritative. Whatever the customer's screen was showing is a snapshot
 * that may already be stale; only this check counts.
 */
async function createBooking(payload = {}, meta = {}) {
  await ensureBookSchema();

  const venueId = String(payload.venueId || "");
  const serviceId = String(payload.serviceId || "");
  const partySize = Number.parseInt(payload.partySize ?? 1, 10);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 200) {
    throw new AppError(400, "How many people is that for?");
  }
  const startsAt = new Date(payload.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new AppError(400, "That time is not valid.");

  const name = String(payload.customerName || "").trim();
  if (!name) throw new AppError(400, "We need a name for the booking.");
  const phone = String(payload.customerPhone || "").trim();
  const email = String(payload.customerEmail || "").trim();
  if (!phone && !email) {
    throw new AppError(400, "We need a phone number or an email address, so the business can reach you.");
  }

  const { rows: serviceRows } = await pool.query(
    `SELECT s.*, v.auto_confirm, v.status AS venue_status, v.business_user_id
       FROM book_services s JOIN book_venues v ON v.id = s.venue_id
      WHERE s.id = $1 AND s.venue_id = $2 LIMIT 1`,
    [serviceId, venueId]
  );
  const service = serviceRows[0];
  if (!service || service.status !== "active") throw new AppError(404, "That service is not available.");
  if (service.venue_status !== "published") throw new AppError(404, "That business is not taking bookings yet.");

  const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60000);
  const blockEnd = new Date(startsAt.getTime() + (service.duration_minutes + service.buffer_minutes) * 60000);

  if (startsAt.getTime() < Date.now() + service.lead_time_minutes * 60000) {
    throw new AppError(400, "That time has passed. Please choose another.");
  }

  const { rows: resources } = await pool.query(
    `SELECT r.* FROM book_resources r
       JOIN book_service_resources sr ON sr.resource_id = r.id
      WHERE sr.service_id = $1 AND r.status = 'active'
      ORDER BY r.sort_order, r.created_at`,
    [serviceId]
  );

  const client = await pool.connect();
  let created = null;
  try {
    await client.query("BEGIN");

    // SERIALISE ON THE VENUE, not the slot. Every resource in this venue is
    // being considered together, and a per-slot key would let two overlapping
    // but differently-started bookings race.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`book-venue:${venueId}`]);

    const { rows: taken } = await client.query(
      `SELECT resource_id, party_size FROM book_bookings
        WHERE venue_id = $1 AND status = ANY($2::text[])
          AND starts_at < $4 AND ends_at > $3`,
      [venueId, OCCUPYING, startsAt.toISOString(), blockEnd.toISOString()]
    );

    // Pick the first resource that can genuinely hold this booking.
    let chosen = null;
    if (resources.length) {
      for (const resource of resources) {
        const used = taken.filter((b) => b.resource_id === resource.id)
          .reduce((sum, b) => sum + b.party_size, 0);
        if (used + partySize <= Math.min(resource.capacity, service.capacity)) { chosen = resource; break; }
      }
      if (!chosen) throw new AppError(409, "That time is no longer available. Please choose another.", { code: "BOOK_SLOT_TAKEN" });
    } else {
      const used = taken.reduce((sum, b) => sum + b.party_size, 0);
      if (used + partySize > service.capacity) {
        throw new AppError(409, "That time is no longer available. Please choose another.", { code: "BOOK_SLOT_TAKEN" });
      }
    }

    const status = service.auto_confirm ? "confirmed" : "pending";
    const { rows } = await client.query(
      `INSERT INTO book_bookings
         (id, reference, venue_id, service_id, resource_id, customer_user_id,
          customer_name, customer_phone, customer_email, booked_by_user_id,
          booked_for_business_id, starts_at, ends_at, party_size, status,
          quoted_amount, customer_notes, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               CASE WHEN $15 = 'confirmed' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [randomUUID(), bookingReference(), venueId, serviceId, chosen ? chosen.id : null,
       payload.customerUserId || null, name, phone || null, email || null,
       payload.bookedByUserId || payload.customerUserId || null,
       payload.bookedForBusinessId || null,
       startsAt.toISOString(), endsAt.toISOString(), partySize, status,
       Number(service.price), payload.customerNotes ? String(payload.customerNotes).trim().slice(0, 500) : null]
    );
    created = rows[0];

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // 23P01 is an exclusion violation and 40P01 a deadlock; both mean somebody
    // else won the slot, and neither is a fault the customer should see as a
    // 500. Proven in concurrency-proof.js: the loser under a GiST exclusion
    // constraint fails with 40P01, not 23P01.
    if (error && (error.code === "23P01" || error.code === "40P01")) {
      throw new AppError(409, "That time is no longer available. Please choose another.", { code: "BOOK_SLOT_TAKEN" });
    }
    throw error;
  } finally {
    client.release();
  }

  // After COMMIT, never inside it: a failed audit write must not undo a booking.
  await writeAuditLog({
    actorType: "customer", actorId: payload.customerUserId || null,
    action: "book_booking_created", entityType: "book_booking", entityId: created.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { venueId, serviceId, status: created.status, reference: created.reference }
  }).catch(() => {});

  return shapeBooking(created);
}

/* ------------------------------------------------------------- reading */

async function listVenueBookings(venueId, { from, to, statuses } = {}) {
  await ensureBookSchema();
  const values = [venueId];
  let clause = "venue_id = $1";
  if (from) { values.push(from); clause += ` AND starts_at >= $${values.length}`; }
  if (to) { values.push(to); clause += ` AND starts_at < $${values.length}`; }
  if (Array.isArray(statuses) && statuses.length) {
    values.push(statuses); clause += ` AND status = ANY($${values.length}::text[])`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM book_bookings WHERE ${clause} ORDER BY starts_at ASC LIMIT 500`, values);
  return rows.map(shapeBooking);
}

async function listCustomerBookings(userId) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT * FROM book_bookings WHERE customer_user_id = $1 ORDER BY starts_at DESC LIMIT 200",
    [userId]
  );
  return rows.map(shapeBooking);
}

/* ------------------------------------------------------------ lifecycle */

const BUSINESS_MOVES = {
  confirmed: ["pending"],
  rejected: ["pending"],
  checked_in: ["confirmed"],
  completed: ["confirmed", "checked_in"],
  no_show: ["confirmed", "checked_in"],
  cancelled: ["pending", "confirmed", "checked_in"]
};

/**
 * Move a booking to a new state.
 *
 * The allowed moves are declared rather than implied, so a completed booking can
 * never be reopened and rewritten after the fact.
 */
async function setBookingStatus(bookingId, nextStatus, actor = {}, meta = {}) {
  await ensureBookSchema();
  const allowedFrom = BUSINESS_MOVES[nextStatus];
  if (!allowedFrom) throw new AppError(400, "That is not something a booking can become.");

  const { rows } = await pool.query(
    `UPDATE book_bookings
        SET status = $2,
            confirmed_at   = CASE WHEN $2='confirmed'  THEN NOW() ELSE confirmed_at END,
            checked_in_at  = CASE WHEN $2='checked_in' THEN NOW() ELSE checked_in_at END,
            completed_at   = CASE WHEN $2='completed'  THEN NOW() ELSE completed_at END,
            cancelled_at   = CASE WHEN $2 IN ('cancelled','rejected') THEN NOW() ELSE cancelled_at END,
            cancelled_by_user_id = CASE WHEN $2 IN ('cancelled','rejected') THEN $4 ELSE cancelled_by_user_id END,
            cancellation_reason  = COALESCE($5, cancellation_reason),
            updated_at = NOW()
      WHERE id = $1 AND status = ANY($3::text[])
      RETURNING *`,
    [bookingId, nextStatus, allowedFrom, actor.userId || null,
     meta.reason ? String(meta.reason).trim().slice(0, 300) : null]
  );
  if (!rows[0]) {
    throw new AppError(409, "That booking has already moved on. Refresh and try again.");
  }
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId || null,
    action: "book_booking_status_changed", entityType: "book_booking", entityId: bookingId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { status: nextStatus }
  }).catch(() => {});
  return shapeBooking(rows[0]);
}

module.exports = {
  availability,
  createBooking,
  listVenueBookings,
  listCustomerBookings,
  setBookingStatus,
  shapeBooking,
  bookingReference
};
