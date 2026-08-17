"use strict";

// A STRANGER BOOKS A TABLE.
//
// This is the loop the whole product depends on and the thing that was missing
// when the business's shared link resolved to a bare 404. A person taps a link
// from WhatsApp, has never heard of TitoPay, has no account and no token, and
// must still be able to see the place and book it.
//
// It also pins the two things that make that surface safe: the public shape
// leaks nothing about the business's internals or other customers, and a venue
// that asked not to publish exact free-slot numbers does not have them readable
// out of the response by anybody who opens developer tools.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { ensureBookSchema } = require("../src/services/book-schema");
const catalogue = require("../src/services/book-catalogue-service");

const TAG = "bookpub";
let owner;
let venueId;
let serviceId;
let slug;
let server;
let baseUrl;

async function seedOwner() {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked)
     VALUES ($1,'business',$2,$3,$4,$5,'x','active',FALSE)`,
    [id, `${TAG} ${suffix}`, `${TAG}_${suffix}`, `${TAG}_${suffix}@example.invalid`,
     `2782${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  return { userId: id, accountType: "business", profileLocked: false };
}

function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

test.before(async () => {
  await ensureBookSchema();
  owner = await seedOwner();
  venueId = randomUUID();
  slug = `pub-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO book_venues
       (id, business_user_id, slug, name, category, status, auto_confirm, published_at,
        city, tagline, description, contact_phone)
     VALUES ($1,$2,$3,'Kasi Kitchen','restaurant','published',TRUE,NOW(),
             'Johannesburg','Home cooked meals','Soweto kitchen serving pap and chakalaka.','+27110000000')`,
    [venueId, owner.userId, slug]
  );
  await catalogue.setOpeningHours(owner, venueId,
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({ dayOfWeek: day, opensMinute: 9 * 60, closesMinute: 21 * 60 })));
  const service = await catalogue.createService(owner, venueId,
    { name: "Table for dinner", durationMinutes: 60, capacity: 4, price: 0 });
  serviceId = service.id;

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.query("DELETE FROM book_bookings WHERE venue_id=$1", [venueId]).catch(() => {});
  await pool.query("DELETE FROM book_venues WHERE business_user_id=$1", [owner.userId]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [owner.userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [owner.userId]).catch(() => {});
  await pool.end();
});

// NO AUTHORIZATION HEADER ANYWHERE IN THIS FILE. That is the point.
const get = (path) => fetch(`${baseUrl}${path}`);
const post = (path, body) => fetch(`${baseUrl}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

/* --------------------------------------------------- the link resolves */

test("a stranger with no account can open the booking page", async () => {
  const response = await get(`/v1/book/public/venues/${slug}`);
  assert.equal(response.status, 200, "no token, and it still answers");
  const { venue } = await response.json();
  assert.equal(venue.name, "Kasi Kitchen");
  assert.equal(venue.categoryLabel, "Restaurant");
  assert.equal(venue.bookingWord, "Reservation", "a restaurant takes reservations");
  assert.equal(venue.address.city, "Johannesburg");
  assert.equal(venue.services.length, 1);
  assert.equal(venue.openingHours.length, 7);
});

test("the public shape leaks nothing internal", async () => {
  const { venue } = await (await get(`/v1/book/public/venues/${slug}`)).json();
  const serialised = JSON.stringify(venue);
  // The owner's user id, the venue's internal id and anything about other
  // people's bookings must not be on a surface the whole internet can read.
  assert.ok(!serialised.includes(owner.userId), "the owner's user id is not published");
  assert.ok(!serialised.includes(venueId), "the internal venue id is not published");
  assert.equal(venue.id, undefined);
  assert.equal(venue.businessUserId, undefined);
  for (const forbidden of ["business_user_id", "created_by", "businessNotes", "bookings"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(venue, forbidden), `${forbidden} must not be public`);
  }
});

test("a draft venue does not exist as far as the public is concerned", async () => {
  const hidden = randomUUID();
  const hiddenSlug = `draft-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO book_venues (id, business_user_id, slug, name, category, status)
     VALUES ($1,$2,$3,'Not Live','cafe','draft')`, [hidden, owner.userId, hiddenSlug]);
  const response = await get(`/v1/book/public/venues/${hiddenSlug}`);
  assert.equal(response.status, 404, "404, not 403: a stranger learns nothing about it");
  await pool.query("DELETE FROM book_venues WHERE id=$1", [hidden]);
});

/* ------------------------------------------------------- availability */

test("a stranger can see open times without signing in", async () => {
  const day = tomorrow();
  const response = await get(`/v1/book/public/venues/${slug}/availability?serviceId=${serviceId}&date=${day}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.slots.length > 10);
  assert.equal(body.durationMinutes, 60);
  assert.ok(Object.prototype.hasOwnProperty.call(body.slots[0], "remaining"),
    "a restaurant publishes how many places are left, because for it that is marketing");
});

test("a practice that hides its numbers really hides them", async () => {
  // Not a client-side choice. A doctor's exact free-slot count is a patient-load
  // signal once it is public and pollable, so it is stripped SERVER SIDE and
  // cannot be read out of the response.
  const practice = randomUUID();
  const practiceSlug = `dr-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO book_venues (id, business_user_id, slug, name, category, status, auto_confirm,
                              published_at, shows_availability_count)
     VALUES ($1,$2,$3,'Dr Ndlovu','doctor','published',TRUE,NOW(),FALSE)`,
    [practice, owner.userId, practiceSlug]);
  await catalogue.setOpeningHours(owner, practice,
    [1, 2, 3, 4, 5].map((day) => ({ dayOfWeek: day, opensMinute: 8 * 60, closesMinute: 16 * 60 })));
  const consult = await catalogue.createService(owner, practice,
    { name: "Consultation", durationMinutes: 30, capacity: 1 });

  const body = await (await get(
    `/v1/book/public/venues/${practiceSlug}/availability?serviceId=${consult.id}&date=${tomorrow()}`)).json();
  if (body.slots.length) {
    assert.equal(body.slots[0].remaining, undefined,
      "the count is stripped on the server, not merely hidden by the screen");
    assert.ok(body.slots[0].startsAt, "the times themselves are still offered");
  }
  await pool.query("DELETE FROM book_venues WHERE id=$1", [practice]);
});

/* ------------------------------------------------------ the booking */

test("a stranger books a table and gets a reference they can read out", async () => {
  const day = tomorrow();
  const slots = (await (await get(
    `/v1/book/public/venues/${slug}/availability?serviceId=${serviceId}&date=${day}`)).json()).slots;

  const response = await post(`/v1/book/public/venues/${slug}/bookings`, {
    serviceId, startsAt: slots[0].startsAt, partySize: 2,
    customerName: "Thabo M", customerPhone: "+27821234567"
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { booking } = await response.json();

  assert.match(booking.reference, /^BK-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(booking.confirmed, true, "this venue confirms on the spot");
  assert.equal(booking.partySize, 2);

  // And the response tells the customer what they need, not the venue's internals.
  assert.equal(booking.venueId, undefined);
  assert.equal(booking.resourceId, undefined);
  assert.equal(booking.id, undefined);
});

test("the business sees that booking on its own list", async () => {
  const { rows } = await pool.query(
    "SELECT customer_name, party_size, status FROM book_bookings WHERE venue_id=$1 ORDER BY created_at DESC LIMIT 1",
    [venueId]);
  assert.equal(rows[0].customer_name, "Thabo M");
  assert.equal(rows[0].party_size, 2);
  assert.equal(rows[0].status, "confirmed");
});

test("a booking with no way to reach the customer is refused", async () => {
  const day = tomorrow();
  const slots = (await (await get(
    `/v1/book/public/venues/${slug}/availability?serviceId=${serviceId}&date=${day}`)).json()).slots;
  const response = await post(`/v1/book/public/venues/${slug}/bookings`, {
    serviceId, startsAt: slots[0].startsAt, partySize: 1, customerName: "Anonymous"
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /phone number or an email/i);
});

test("a taken time is refused in words, not a 500", async () => {
  const day = tomorrow();
  const slots = (await (await get(
    `/v1/book/public/venues/${slug}/availability?serviceId=${serviceId}&date=${day}`)).json()).slots;
  const when = slots[slots.length - 1].startsAt;
  const four = { serviceId, startsAt: when, partySize: 4, customerName: "Full", customerPhone: "+27820000001" };
  const first = await post(`/v1/book/public/venues/${slug}/bookings`, four);
  assert.equal(first.status, 201);
  const second = await post(`/v1/book/public/venues/${slug}/bookings`, {
    ...four, customerName: "Too late", customerPhone: "+27820000002" });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /no longer available/i);
});

test("booking a venue that does not exist is a plain 404", async () => {
  const response = await post("/v1/book/public/venues/no-such-place/bookings", {
    serviceId, startsAt: new Date(Date.now() + 86400000).toISOString(),
    partySize: 1, customerName: "Nobody", customerPhone: "+27820000003" });
  assert.equal(response.status, 404);
});
