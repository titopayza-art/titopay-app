"use strict";

// THE PUBLIC SIDE OF A VENUE.
//
// This is the answer to "who will be booking". A business shares its link on
// WhatsApp, Instagram or a poster; whoever taps it lands here. They may have no
// TitoPay account and may never have heard of TitoPay, and it still has to work,
// because the reach of that link is most of what the R250 buys.
//
// EVERYTHING HERE IS READ-ONLY EXCEPT THE BOOKING ITSELF, and the shape returned
// is built by hand rather than by spreading a row. A published venue is exposed
// to the entire internet, so a column added later must never appear on this
// surface by accident: the owner's user id, internal notes and anything about
// other people's bookings all stay behind.
//
// WHAT A PUBLIC VIEWER IS NEVER TOLD: who else has booked, how many bookings
// exist, or anything identifying another customer. Availability is expressed as
// times that are open, and where the venue has asked for it, how many places
// remain - never as a list of what is taken.

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { ensureBookSchema } = require("./book-schema");
const { readServices, readOpeningHours } = require("./book-catalogue-service");
const booking = require("./book-booking-service");
const reference = require("../config/book-reference");

/** A published venue by its slug, or 404. Draft and paused venues do not exist here. */
async function publicVenue(slug) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT * FROM book_venues WHERE slug = $1 AND status = 'published' LIMIT 1",
    [String(slug || "").trim().toLowerCase()]
  );
  const venue = rows[0];
  if (!venue) throw new AppError(404, "That booking page was not found.");

  const [services, hours] = await Promise.all([
    readServices(venue.id, { activeOnly: true }),
    readOpeningHours(venue.id)
  ]);

  return {
    slug: venue.slug,
    name: venue.name,
    category: venue.category,
    categoryLabel: reference.categoryLabel(venue.category),
    bookingWord: reference.bookingWord(venue.category),
    tagline: venue.tagline,
    description: venue.description,
    address: {
      line: venue.address_line, suburb: venue.suburb, city: venue.city,
      province: venue.province
    },
    contact: { phone: venue.contact_phone, email: venue.contact_email, website: venue.website_url },
    coverImageUrl: venue.cover_image_url || null,
    gallery: venue.gallery || [],
    amenities: venue.amenities || [],
    // The venue's own choice about whether an exact count is public. Health
    // categories default this off, because a pollable free-slot number on a
    // practice is a patient-load signal rather than marketing.
    showsAvailabilityCount: venue.shows_availability_count,
    acceptsInstantBooking: venue.auto_confirm,
    openingHours: hours.map((rule) => ({
      dayOfWeek: rule.dayOfWeek,
      opensMinute: rule.opensMinute,
      closesMinute: rule.closesMinute
    })),
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description,
      price: service.price,
      durationMinutes: service.durationMinutes,
      // How many people one booking may cover. A haircut is one; a restaurant
      // table is several. The booking screen uses this to decide whether asking
      // "how many people" is a sensible question at all.
      capacity: service.capacity
    }))
  };
}

/**
 * Open times for one service on one day, for a public viewer.
 *
 * The venue's `showsAvailabilityCount` choice is honoured HERE rather than in
 * the client, so a business that asked not to publish numbers cannot have them
 * read out of the response by anybody who opens developer tools.
 */
async function publicAvailability(slug, serviceId, dateText) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT id, shows_availability_count FROM book_venues WHERE slug = $1 AND status = 'published' LIMIT 1",
    [String(slug || "").trim().toLowerCase()]
  );
  const venue = rows[0];
  if (!venue) throw new AppError(404, "That booking page was not found.");

  const result = await booking.availability(venue.id, serviceId, dateText);
  return {
    date: result.date,
    durationMinutes: result.durationMinutes,
    price: result.price,
    slots: result.slots.map((slot) => (venue.shows_availability_count
      ? slot
      : { startsAt: slot.startsAt, endsAt: slot.endsAt }))
  };
}

/**
 * Book, as a member of the public.
 *
 * NO ACCOUNT REQUIRED, deliberately. A business's customers are not TitoPay
 * users and requiring them to become one before they can book a table would
 * throw away most of the reach the link exists to provide. A signed-in customer
 * may pass their id so the booking also appears in their own list; a stranger
 * gives a name and a way to be reached, which is exactly what a phone booking
 * has always needed.
 */
async function publicBooking(slug, payload = {}, meta = {}) {
  await ensureBookSchema();
  const { rows } = await pool.query(
    "SELECT id FROM book_venues WHERE slug = $1 AND status = 'published' LIMIT 1",
    [String(slug || "").trim().toLowerCase()]
  );
  const venue = rows[0];
  if (!venue) throw new AppError(404, "That booking page was not found.");

  const made = await booking.createBooking({
    venueId: venue.id,
    serviceId: payload.serviceId,
    startsAt: payload.startsAt,
    partySize: payload.partySize,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerEmail: payload.customerEmail,
    customerNotes: payload.customerNotes,
    customerUserId: payload.customerUserId || null
  }, meta);

  // What the person who booked is told. Deliberately NOT the whole row: a
  // public caller has no business seeing internal ids or the resource they were
  // allocated to.
  return {
    reference: made.reference,
    status: made.status,
    startsAt: made.startsAt,
    endsAt: made.endsAt,
    partySize: made.partySize,
    quotedAmount: made.quotedAmount,
    confirmed: made.status === "confirmed"
  };
}

/**
 * How many times are open across the next week, for the shared-link preview.
 *
 * BOUNDED AND CHEAP ON PURPOSE. This runs on an unauthenticated endpoint that
 * crawlers hit, so it looks at seven days rather than the whole horizon and
 * stops at the first service. An expensive query here would slow the rest of
 * TitoPay for everybody.
 */
async function weekOpenCount(venueSlug) {
  await ensureBookSchema();
  // The internal id is read HERE rather than taken from publicVenue, which
  // deliberately does not expose it. An earlier version of this function read
  // venue.id off that shape, got undefined, and would have counted nothing.
  const { rows } = await pool.query(
    "SELECT id, shows_availability_count FROM book_venues WHERE slug = $1 AND status = 'published' LIMIT 1",
    [String(venueSlug || "").trim().toLowerCase()]
  );
  const venue = rows[0];
  if (!venue || !venue.shows_availability_count) return null;

  const services = await readServices(venue.id, { activeOnly: true });
  if (!services.length) return null;

  const service = services[0];
  let open = 0;
  for (let day = 0; day < 7; day += 1) {
    const date = new Date(Date.now() + day * 86400000);
    const text = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const result = await booking.availability(venue.id, service.id, text).catch(() => null);
    if (result) open += result.slots.length;
  }
  return open;
}

/* ------------------------------------------------------------- discovery */

/**
 * Published venues a customer can browse.
 *
 * ONLY PUBLISHED ONES, and only the fields a list row needs. A draft venue is
 * invisible here for the same reason it 404s on its own page: the business has
 * not said it is ready.
 */
async function discover({ category = "", city = "", search = "", limit = 40 } = {}) {
  await ensureBookSchema();
  const values = [];
  let clause = "v.status = 'published'";
  if (category) { values.push(category); clause += ` AND v.category = $${values.length}`; }
  if (city) { values.push(city); clause += ` AND LOWER(v.city) = LOWER($${values.length})`; }
  if (search) {
    // Name and tagline only. Searching the description would surface a venue
    // for a word buried in a paragraph, which reads as a wrong result.
    values.push(`%${String(search).trim().slice(0, 60)}%`);
    clause += ` AND (v.name ILIKE $${values.length} OR v.tagline ILIKE $${values.length})`;
  }
  values.push(Math.min(Math.max(Number.parseInt(limit, 10) || 40, 1), 100));

  const { rows } = await pool.query(
    `SELECT v.slug, v.name, v.category, v.tagline, v.city, v.suburb, v.cover_image_url,
            v.shows_availability_count,
            (SELECT COUNT(*)::int FROM book_services s
              WHERE s.venue_id = v.id AND s.status = 'active') AS service_count,
            (SELECT MIN(s.price) FROM book_services s
              WHERE s.venue_id = v.id AND s.status = 'active') AS from_price
       FROM book_venues v
      WHERE ${clause}
      ORDER BY v.published_at DESC NULLS LAST
      LIMIT $${values.length}`,
    values
  );

  // A venue with nothing to book is not shown. It would be a dead end: a
  // customer taps it, finds no services, and leaves.
  return rows.filter((row) => row.service_count > 0).map((row) => ({
    slug: row.slug,
    name: row.name,
    category: row.category,
    categoryLabel: reference.categoryLabel(row.category),
    tagline: row.tagline,
    coverImageUrl: row.cover_image_url || null,
    city: row.city,
    suburb: row.suburb,
    serviceCount: row.service_count,
    fromPrice: row.from_price === null ? null : Number(row.from_price)
  }));
}

/**
 * Is there anything worth browsing yet?
 *
 * This is what decides whether a personal user is shown the Book tile at all.
 * An empty discovery screen saying "no businesses near you yet" is honest and
 * poor; no tile is better, and it appears by itself the moment a real business
 * publishes. One cheap count, cached at the edge.
 */
async function discoverySummary() {
  await ensureBookSchema();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS venues
       FROM book_venues v
      WHERE v.status = 'published'
        AND EXISTS (SELECT 1 FROM book_services s WHERE s.venue_id = v.id AND s.status = 'active')`
  );
  const { rows: cities } = await pool.query(
    `SELECT DISTINCT v.city FROM book_venues v
      WHERE v.status = 'published' AND v.city IS NOT NULL AND v.city <> ''
      ORDER BY v.city LIMIT 50`
  );
  return {
    venues: rows[0].venues,
    available: rows[0].venues > 0,
    cities: cities.map((row) => row.city)
  };
}

module.exports = {
  publicVenue, publicAvailability, publicBooking, weekOpenCount,
  discover, discoverySummary
};
