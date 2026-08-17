"use strict";

// WHAT A VENUE OFFERS, AND WHAT IT OFFERS IT WITH.
//
// A SERVICE is the thing a customer picks: a haircut, a full wash, a table for
// dinner, a 45 minute consultation. It carries the price and the duration.
//
// A RESOURCE is the thing that gets occupied while it happens: a chair, a bay,
// a table, a consulting room, a class with twenty seats. One shape for all of
// them, because they are all "a thing that can hold N bookings at once".
//
// The two are joined many to many, because a wash bay serves three wash packages
// and a stylist does both cuts and colour. Without that join, availability
// cannot know which resources to look at for a chosen service.

const { randomUUID } = require("node:crypto");

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { ensureBookSchema } = require("./book-schema");
const { canManageVenue } = require("./book-service");

function money(value) {
  const amount = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) throw new AppError(400, "That price is not valid.");
  return amount;
}
function whole(value, label, { min, max }) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(400, `${label} must be a whole number between ${min} and ${max}.`);
  }
  return number;
}
function requireText(value, label, max = 120) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw new AppError(400, `${label} is required.`);
  if (text.length > max) throw new AppError(400, `${label} must be ${max} characters or fewer.`);
  return text;
}

/* ---------------------------------------------------------------- shaping */

function shapeService(row, resourceIds = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    durationMinutes: row.duration_minutes,
    capacity: row.capacity,
    bufferMinutes: row.buffer_minutes,
    leadTimeMinutes: row.lead_time_minutes,
    bookingHorizonDays: row.booking_horizon_days,
    cancellationNoticeMinutes: row.cancellation_notice_minutes,
    status: row.status,
    sortOrder: row.sort_order,
    resourceIds
  };
}
function shapeResource(row) {
  return {
    id: row.id,
    name: row.name,
    resourceType: row.resource_type,
    capacity: row.capacity,
    staffUserId: row.staff_user_id,
    status: row.status,
    sortOrder: row.sort_order
  };
}

/* --------------------------------------------------------------- services */

async function listServices(userId, venueId) {
  await canManageVenue(userId, venueId);
  return readServices(venueId);
}

// Shared by the owner's console and the public page, so both always see the
// same shape and a field can never be present in one and missing in the other.
async function readServices(venueId, { activeOnly = false } = {}) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    `SELECT * FROM book_services WHERE venue_id = $1 ${activeOnly ? "AND status = 'active'" : ""}
      ORDER BY sort_order, created_at`,
    [venueId]
  );
  if (!rows.length) return [];
  const { rows: links } = await pool.query(
    "SELECT service_id, resource_id FROM book_service_resources WHERE service_id = ANY($1::uuid[])",
    [rows.map((r) => r.id)]
  );
  return rows.map((row) =>
    shapeService(row, links.filter((l) => l.service_id === row.id).map((l) => l.resource_id)));
}

async function createService(actor, venueId, payload = {}, meta = {}) {
  await canManageVenue(actor.userId, venueId);
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO book_services
       (id, venue_id, name, description, price, duration_minutes, capacity,
        buffer_minutes, lead_time_minutes, booking_horizon_days,
        cancellation_notice_minutes, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id, venueId,
     requireText(payload.name, "Service name"),
     payload.description ? String(payload.description).trim().slice(0, 600) : null,
     money(payload.price ?? 0),
     whole(payload.durationMinutes ?? 60, "Duration", { min: 5, max: 1440 }),
     whole(payload.capacity ?? 1, "Capacity", { min: 1, max: 1000 }),
     whole(payload.bufferMinutes ?? 0, "Buffer", { min: 0, max: 480 }),
     whole(payload.leadTimeMinutes ?? 0, "Notice needed", { min: 0, max: 43200 }),
     whole(payload.bookingHorizonDays ?? 90, "How far ahead", { min: 1, max: 730 }),
     whole(payload.cancellationNoticeMinutes ?? 0, "Cancellation notice", { min: 0, max: 43200 }),
     whole(payload.sortOrder ?? 0, "Order", { min: 0, max: 9999 })]
  );
  await linkResources(id, payload.resourceIds, venueId);
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_service_created",
    entityType: "book_service", entityId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { venueId }
  }).catch(() => {});
  return shapeService(rows[0], Array.isArray(payload.resourceIds) ? payload.resourceIds : []);
}

async function updateService(actor, venueId, serviceId, payload = {}, meta = {}) {
  await canManageVenue(actor.userId, venueId);
  const sets = [];
  const values = [];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (payload.name !== undefined) set("name", requireText(payload.name, "Service name"));
  if (payload.description !== undefined) {
    set("description", payload.description ? String(payload.description).trim().slice(0, 600) : null);
  }
  if (payload.price !== undefined) set("price", money(payload.price));
  if (payload.durationMinutes !== undefined) set("duration_minutes", whole(payload.durationMinutes, "Duration", { min: 5, max: 1440 }));
  if (payload.capacity !== undefined) set("capacity", whole(payload.capacity, "Capacity", { min: 1, max: 1000 }));
  if (payload.bufferMinutes !== undefined) set("buffer_minutes", whole(payload.bufferMinutes, "Buffer", { min: 0, max: 480 }));
  if (payload.leadTimeMinutes !== undefined) set("lead_time_minutes", whole(payload.leadTimeMinutes, "Notice needed", { min: 0, max: 43200 }));
  if (payload.bookingHorizonDays !== undefined) set("booking_horizon_days", whole(payload.bookingHorizonDays, "How far ahead", { min: 1, max: 730 }));
  if (payload.cancellationNoticeMinutes !== undefined) set("cancellation_notice_minutes", whole(payload.cancellationNoticeMinutes, "Cancellation notice", { min: 0, max: 43200 }));
  if (payload.status !== undefined) {
    if (!["active", "inactive"].includes(payload.status)) throw new AppError(400, "That is not a valid service status.");
    set("status", payload.status);
  }
  if (payload.sortOrder !== undefined) set("sort_order", whole(payload.sortOrder, "Order", { min: 0, max: 9999 }));

  if (sets.length) {
    values.push(serviceId, venueId);
    const { rows } = await pool.query(
      `UPDATE book_services SET ${sets.join(", ")}, updated_at = NOW()
        WHERE id = $${values.length - 1} AND venue_id = $${values.length} RETURNING *`,
      values
    );
    if (!rows[0]) throw new AppError(404, "That service was not found.");
  }
  if (payload.resourceIds !== undefined) await linkResources(serviceId, payload.resourceIds, venueId);

  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_service_updated",
    entityType: "book_service", entityId: serviceId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { venueId }
  }).catch(() => {});

  const all = await readServices(venueId);
  const found = all.find((s) => s.id === serviceId);
  if (!found) throw new AppError(404, "That service was not found.");
  return found;
}

// Replace the whole set rather than diff it: the screen sends what it wants the
// links to BE, and a partial diff is a place for a stale link to survive.
async function linkResources(serviceId, resourceIds, venueId) {
  if (resourceIds === undefined) return;
  const wanted = Array.isArray(resourceIds) ? [...new Set(resourceIds.map(String))] : [];
  if (wanted.length) {
    // Every resource must belong to the same venue, or a service could be
    // pointed at another business's chair.
    const { rows } = await pool.query(
      "SELECT id FROM book_resources WHERE id = ANY($1::uuid[]) AND venue_id = $2",
      [wanted, venueId]
    );
    if (rows.length !== wanted.length) {
      throw new AppError(400, "One of those cannot be used by this business.");
    }
  }
  await pool.query("DELETE FROM book_service_resources WHERE service_id = $1", [serviceId]);
  for (const resourceId of wanted) {
    await pool.query(
      `INSERT INTO book_service_resources (id, service_id, resource_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), serviceId, resourceId]
    );
  }
}

/* -------------------------------------------------------------- resources */

async function listResources(userId, venueId) {
  await canManageVenue(userId, venueId);
  return readResources(venueId);
}

async function readResources(venueId, { activeOnly = false } = {}) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    `SELECT * FROM book_resources WHERE venue_id = $1 ${activeOnly ? "AND status = 'active'" : ""}
      ORDER BY sort_order, created_at`,
    [venueId]
  );
  return rows.map(shapeResource);
}

async function createResource(actor, venueId, payload = {}, meta = {}) {
  await canManageVenue(actor.userId, venueId);
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO book_resources (id, venue_id, name, resource_type, capacity, staff_user_id, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, venueId,
     requireText(payload.name, "Name", 80),
     payload.resourceType ? String(payload.resourceType).trim().slice(0, 40) : "general",
     whole(payload.capacity ?? 1, "Capacity", { min: 1, max: 1000 }),
     payload.staffUserId || null,
     whole(payload.sortOrder ?? 0, "Order", { min: 0, max: 9999 })]
  );
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_resource_created",
    entityType: "book_resource", entityId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { venueId }
  }).catch(() => {});
  return shapeResource(rows[0]);
}

async function updateResource(actor, venueId, resourceId, payload = {}, meta = {}) {
  await canManageVenue(actor.userId, venueId);
  const sets = [];
  const values = [];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (payload.name !== undefined) set("name", requireText(payload.name, "Name", 80));
  if (payload.resourceType !== undefined) set("resource_type", String(payload.resourceType).trim().slice(0, 40) || "general");
  if (payload.capacity !== undefined) set("capacity", whole(payload.capacity, "Capacity", { min: 1, max: 1000 }));
  if (payload.staffUserId !== undefined) set("staff_user_id", payload.staffUserId || null);
  if (payload.status !== undefined) {
    if (!["active", "inactive"].includes(payload.status)) throw new AppError(400, "That is not a valid status.");
    set("status", payload.status);
  }
  if (payload.sortOrder !== undefined) set("sort_order", whole(payload.sortOrder, "Order", { min: 0, max: 9999 }));
  if (!sets.length) {
    const all = await readResources(venueId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new AppError(404, "That was not found.");
    return found;
  }
  values.push(resourceId, venueId);
  const { rows } = await pool.query(
    `UPDATE book_resources SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND venue_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) throw new AppError(404, "That was not found.");
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_resource_updated",
    entityType: "book_resource", entityId: resourceId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { venueId }
  }).catch(() => {});
  return shapeResource(rows[0]);
}

/* ------------------------------------------------------------ opening hours */

// Stored as minutes from midnight. See the migration for why that rather than a
// TIME column: an opening hour is a wall-clock fact about a place, and an
// integer says so unambiguously regardless of timezone.
function shapeRule(row) {
  return {
    id: row.id,
    resourceId: row.resource_id,
    dayOfWeek: row.day_of_week,
    opensMinute: row.opens_minute,
    closesMinute: row.closes_minute
  };
}

async function listOpeningHours(userId, venueId) {
  await canManageVenue(userId, venueId);
  return readOpeningHours(venueId);
}

async function readOpeningHours(venueId) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT * FROM book_availability_rules WHERE venue_id = $1 ORDER BY day_of_week, opens_minute",
    [venueId]
  );
  return rows.map(shapeRule);
}

/**
 * Replace the whole week in one call.
 *
 * A screen that edits opening hours edits the WEEK, not one row, and sending the
 * whole week means a removed Sunday is actually removed rather than left behind
 * because the client forgot to delete it.
 */
async function setOpeningHours(actor, venueId, rules = [], meta = {}) {
  await canManageVenue(actor.userId, venueId);
  if (!Array.isArray(rules)) throw new AppError(400, "Opening hours must be a list.");
  if (rules.length > 60) throw new AppError(400, "That is too many opening hour rules.");

  const prepared = rules.map((rule) => {
    const day = whole(rule.dayOfWeek, "Day", { min: 0, max: 6 });
    const opens = whole(rule.opensMinute, "Opening time", { min: 0, max: 1439 });
    const closes = whole(rule.closesMinute, "Closing time", { min: 1, max: 1440 });
    if (closes <= opens) throw new AppError(400, "A closing time must be after its opening time.");
    return { day, opens, closes, resourceId: rule.resourceId || null };
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM book_availability_rules WHERE venue_id = $1", [venueId]);
    for (const rule of prepared) {
      await client.query(
        `INSERT INTO book_availability_rules
           (id, venue_id, resource_id, day_of_week, opens_minute, closes_minute)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), venueId, rule.resourceId, rule.day, rule.opens, rule.closes]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_opening_hours_set",
    entityType: "book_venue", entityId: venueId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { ruleCount: prepared.length }
  }).catch(() => {});

  return readOpeningHours(venueId);
}

module.exports = {
  listServices, readServices, createService, updateService,
  listResources, readResources, createResource, updateResource,
  listOpeningHours, readOpeningHours, setOpeningHours
};
