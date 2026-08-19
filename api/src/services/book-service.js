"use strict";

// TITOPAY BOOK: VENUES.
//
// A venue is a business's bookable presence: what it is, where it is, and the
// web address people share to reach it. One business account may run several,
// because a restaurant group with three branches is three places to book even
// though it is one business.
//
// AUTHORISATION HAS EXACTLY ONE ANSWER HERE, canManageVenue, and every route
// calls it. The alternative is an inline ownership WHERE clause repeated per
// handler, which is how a system ends up with eleven answers to one question and
// a tenth that is subtly wrong. This is the same discipline
// canManageEventTicketing follows in ticketing-service.

const { randomUUID, createHash } = require("node:crypto");

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { ensureBookSchema } = require("./book-schema");
const { assertActivated } = require("./book-activation-service");
const reference = require("../config/book-reference");

// THE SAME IMAGE RULE TICKETING ALREADY USES, not a second one. A data: URL up
// to 700KB, or an http(s) URL. Anything else is dropped rather than stored, so
// a screen can never render something the server did not vet. Kept identical to
// cleanEventBanner on purpose: two image rules that differ by a character is how
// one of them ends up wrong.
function cleanVenueImage(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
    if (Buffer.byteLength(raw, "utf8") > 700 * 1024) {
      throw new AppError(413, "That photo is too large. Choose a smaller one.");
    }
    return raw;
  }
  // AN EXTERNAL URL IS A BEACON ON A PUBLIC PAGE.
  //
  // This used to accept any http(s) URL and store it. A venue photo renders on
  // the public booking page, so a third-party host would receive the IP address
  // and user agent of every person who opened that page, and the venue owner
  // (or anyone who took over their account) chose the host. The API's own CSP,
  // img-src 'self' data:, blocks it from loading today, which means the only
  // thing it reliably did was leak viewers to whoever owned the link.
  //
  // Nothing in the product needs it: the photo control uploads and produces a
  // data: URL, and no screen submits a link. Dropping it here changes no
  // existing venue record, because a stored value is only rewritten when a
  // caller explicitly sends coverImageUrl, which only the uploader and the
  // remove button do.
  return "";
}

/* ------------------------------------------------------------- the address */

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Clean names first, a counter next, a digest only as a last resort.
//
// This mirrors uniqueSlug in ticketing-service deliberately, including the
// reason it was changed there: a random suffix on every slug produced addresses
// like kasi-kitchen-3d4c29, which look broken on a poster and which nobody can
// read out over a phone. A venue gets its own name unless somebody already has it.
async function uniqueSlug(base, venueId = null) {
  const candidate = slugify(base) || "venue";
  const taken = async (value) => {
    const { rows } = await pool.query(
      "SELECT id FROM book_venues WHERE slug = $1 AND ($2::UUID IS NULL OR id <> $2::UUID) LIMIT 1",
      [value, venueId]
    );
    return Boolean(rows[0]);
  };
  if (!(await taken(candidate))) return candidate;
  for (let counter = 2; counter <= 50; counter += 1) {
    const value = `${candidate}-${counter}`;
    if (!(await taken(value))) return value;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = `${candidate}-${createHash("sha1")
      .update(`${base}:${attempt}:${randomUUID()}`).digest("hex").slice(0, 6)}`;
    if (!(await taken(value))) return value;
  }
  throw new AppError(409, "Could not create a web address for this venue. Try a slightly different name.");
}

/* ------------------------------------------------------- may you touch it */

/**
 * THE ONE AUTHORISATION ANSWER. Returns the venue row, or throws.
 *
 * 404 rather than 403 for a venue you are not on, deliberately: a stranger must
 * not be able to discover that a venue id exists by the difference between the
 * two answers.
 */
async function canManageVenue(userId, venueId) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT * FROM book_venues WHERE id = $1 AND business_user_id = $2 LIMIT 1",
    [venueId, userId]
  );
  if (!rows[0]) throw new AppError(404, "That venue was not found on your account.");
  return rows[0];
}

/* ---------------------------------------------------------------- shaping */

// What the app is allowed to see. Explicit rather than SELECT *, so a column
// added later is never leaked to a screen by accident.
function shapeVenue(row) {
  if (!row) return null;
  const category = reference.category(row.category);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    categoryLabel: category ? category.label : row.category,
    bookingWord: reference.bookingWord(row.category),
    resourceWord: reference.resourceWord(row.category),
    tagline: row.tagline,
    description: row.description,
    address: {
      line: row.address_line, suburb: row.suburb, city: row.city,
      province: row.province, postalCode: row.postal_code
    },
    contact: { phone: row.contact_phone, email: row.contact_email, website: row.website_url },
    coverImageUrl: row.cover_image_url || null,
    gallery: row.gallery || [],
    openingHours: row.opening_hours || [],
    amenities: row.amenities || [],
    showsAvailabilityCount: row.shows_availability_count,
    autoConfirm: row.auto_confirm,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/* ------------------------------------------------------------ the writes */

function requireText(value, label, { min = 2, max = 120 } = {}) {
  const text = String(value == null ? "" : value).trim();
  if (text.length < min) throw new AppError(400, `${label} is required.`);
  if (text.length > max) throw new AppError(400, `${label} must be ${max} characters or fewer.`);
  return text;
}

/**
 * Create a venue.
 *
 * PAY FIRST. assertActivated throws 402 unless this business has bought Book,
 * so a venue cannot exist for a business that has not paid. That check lives
 * here rather than in the route because a second caller added later would
 * otherwise bypass it.
 */
async function createVenue(actor, payload = {}, meta = {}) {
  await ensureBookSchema();
  if (actor.accountType !== "business") {
    throw new AppError(403, "Only a business account can set up bookings.");
  }
  await assertActivated(actor.userId);

  const name = requireText(payload.name, "Business name");
  const category = String(payload.category || "").trim();
  if (!reference.isCategory(category)) {
    throw new AppError(400, "Choose what kind of business this is.");
  }

  const id = randomUUID();
  const slug = await uniqueSlug(name);
  // A doctor's exact free-slot count is a patient-load signal once it is public
  // and pollable; a restaurant's is marketing. Health categories start with the
  // counter off and every business can change it either way.
  const showsCount = reference.defaultShowsAvailabilityCount(category);

  const { rows } = await pool.query(
    `INSERT INTO book_venues
       (id, business_user_id, slug, name, category, tagline, description,
        address_line, suburb, city, province, postal_code,
        contact_phone, contact_email, website_url,
        shows_availability_count, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'draft',$2)
     RETURNING *`,
    [id, actor.userId, slug, name, category,
     payload.tagline ? String(payload.tagline).trim().slice(0, 160) : null,
     payload.description ? String(payload.description).trim().slice(0, 2000) : null,
     payload.addressLine ? String(payload.addressLine).trim().slice(0, 200) : null,
     payload.suburb ? String(payload.suburb).trim().slice(0, 80) : null,
     payload.city ? String(payload.city).trim().slice(0, 80) : null,
     payload.province ? String(payload.province).trim().slice(0, 80) : null,
     payload.postalCode ? String(payload.postalCode).trim().slice(0, 12) : null,
     payload.contactPhone ? String(payload.contactPhone).trim().slice(0, 30) : null,
     payload.contactEmail ? String(payload.contactEmail).trim().slice(0, 160) : null,
     payload.websiteUrl ? String(payload.websiteUrl).trim().slice(0, 200) : null,
     showsCount]
  );

  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_venue_created",
    entityType: "book_venue", entityId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { category, slug }
  }).catch((error) => console.error("[book] venue audit failed", { message: error.message }));

  return shapeVenue(rows[0]);
}

/** Every venue this business runs, newest first. */
async function listVenues(userId) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT * FROM book_venues WHERE business_user_id = $1 ORDER BY created_at DESC",
    [userId]
  );
  return rows.map(shapeVenue);
}

async function getVenue(userId, venueId) {
  return shapeVenue(await canManageVenue(userId, venueId));
}

/**
 * Update a venue. A partial patch: anything not sent is left alone, so a screen
 * that edits one field cannot blank the rest.
 */
async function updateVenue(actor, venueId, payload = {}, meta = {}) {
  const existing = await canManageVenue(actor.userId, venueId);

  const sets = [];
  const values = [];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (payload.name !== undefined) set("name", requireText(payload.name, "Business name"));
  if (payload.category !== undefined) {
    if (!reference.isCategory(payload.category)) throw new AppError(400, "Choose what kind of business this is.");
    set("category", payload.category);
  }
  for (const [key, column, max] of [
    ["tagline", "tagline", 160], ["description", "description", 2000],
    ["addressLine", "address_line", 200], ["suburb", "suburb", 80],
    ["city", "city", 80], ["province", "province", 80], ["postalCode", "postal_code", 12],
    ["contactPhone", "contact_phone", 30], ["contactEmail", "contact_email", 160],
    ["websiteUrl", "website_url", 200]
  ]) {
    if (payload[key] !== undefined) {
      const text = String(payload[key] == null ? "" : payload[key]).trim().slice(0, max);
      set(column, text || null);
    }
  }
  if (payload.coverImageUrl !== undefined) {
    // Anything unvetted is dropped rather than refused, which is the contract
    // this endpoint already had for javascript: URLs and the one its tests
    // pin. An external link now falls into the same bucket.
    set("cover_image_url", cleanVenueImage(payload.coverImageUrl) || null);
  }
  if (payload.gallery !== undefined) {
    const cleaned = (Array.isArray(payload.gallery) ? payload.gallery : [])
      .map(cleanVenueImage).filter(Boolean).slice(0, 6);
    set("gallery", JSON.stringify(cleaned));
  }
  if (payload.showsAvailabilityCount !== undefined) {
    set("shows_availability_count", Boolean(payload.showsAvailabilityCount));
  }
  if (payload.autoConfirm !== undefined) set("auto_confirm", Boolean(payload.autoConfirm));

  if (!sets.length) return shapeVenue(existing);

  // updated_at is maintained by the application here, because this schema has
  // exactly two triggers and both are on transactions.
  values.push(venueId);
  const { rows } = await pool.query(
    `UPDATE book_venues SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = $${values.length} RETURNING *`,
    values
  );

  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_venue_updated",
    entityType: "book_venue", entityId: venueId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { fields: Object.keys(payload) }
  }).catch(() => {});

  return shapeVenue(rows[0]);
}

/**
 * Publish or unpublish. Separate from updateVenue because going live is a
 * decision, not a field edit, and because it is the moment the public link
 * starts resolving.
 */
async function setVenueStatus(actor, venueId, status, meta = {}) {
  await canManageVenue(actor.userId, venueId);
  if (!reference.VENUE_STATUSES.includes(status)) {
    throw new AppError(400, "That is not a valid venue status.");
  }
  const { rows } = await pool.query(
    `UPDATE book_venues
        SET status = $2,
            published_at = CASE WHEN $2 = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END,
            archived_at  = CASE WHEN $2 = 'archived' THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [venueId, status]
  );
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId, action: "book_venue_status_changed",
    entityType: "book_venue", entityId: venueId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, metadata: { status }
  }).catch(() => {});
  return shapeVenue(rows[0]);
}

/** The options every setup screen renders from, so no list is hardcoded in the app. */
function options() {
  return {
    categories: reference.CATEGORIES.map((item) => ({
      key: item.key, label: item.label, group: item.group, hint: item.hint
    })),
    groups: reference.CATEGORY_GROUPS
  };
}

module.exports = {
  slugify,
  uniqueSlug,
  canManageVenue,
  shapeVenue,
  createVenue,
  listVenues,
  getVenue,
  updateVenue,
  setVenueStatus,
  options
};
