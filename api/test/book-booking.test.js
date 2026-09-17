"use strict";

// THE BOOKING ENGINE.
//
// The claim this file exists to prove is section 37 of the brief: two people
// booking the same table at the same instant produce exactly one booking. That
// is the one requirement careful reads cannot satisfy, because the failure
// happens between "SELECT finds nothing" and "INSERT writes something".
//
// Every concurrency test here carries a CONTROL where the guard is absent, so a
// pass means the race was real and was won, not that the race never happened.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db/pool");
const { ensureBookSchema } = require("../src/services/book-schema");
const catalogue = require("../src/services/book-catalogue-service");
const booking = require("../src/services/book-booking-service");

const TAG = "bookeng";
let owner;
let venueId;

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

// A published venue with opening hours, created directly so these tests exercise
// the ENGINE rather than the activation and venue routes tested elsewhere.
async function seedVenue(ownerId, { autoConfirm = true } = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO book_venues (id, business_user_id, slug, name, category, status, auto_confirm, published_at)
     VALUES ($1,$2,$3,'Engine Test','restaurant','published',$4, NOW())`,
    [id, ownerId, `engine-${randomUUID().slice(0, 8)}`, autoConfirm]
  );
  return id;
}

// Tomorrow, so nothing is refused for being in the past.
function tomorrow() {
  const d = new Date(Date.now() + 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
const at = (dateText, hour) => new Date(`${dateText}T${String(hour).padStart(2, "0")}:00:00.000Z`).toISOString();

async function openAllWeek(actor, id) {
  await catalogue.setOpeningHours(actor, id,
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({ dayOfWeek: day, opensMinute: 9 * 60, closesMinute: 21 * 60 })));
}

test.before(async () => {
  await ensureBookSchema();
  owner = await seedOwner();
  venueId = await seedVenue(owner.userId);
  await openAllWeek(owner, venueId);
});
test.after(async () => {
  await pool.query("DELETE FROM book_bookings WHERE venue_id IN (SELECT id FROM book_venues WHERE business_user_id=$1)", [owner.userId]).catch(() => {});
  await pool.query("DELETE FROM book_venues WHERE business_user_id=$1", [owner.userId]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [owner.userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [owner.userId]).catch(() => {});
  await pool.end();
});

const guest = (name) => ({ customerName: name, customerPhone: "+27820000000" });

/* --------------------------------------------------------- availability */

test("availability is opening hours minus what is already taken", async () => {
  const service = await catalogue.createService(owner, venueId,
    { name: "Dinner", durationMinutes: 60, capacity: 1 });
  const day = tomorrow();

  const before = await booking.availability(venueId, service.id, day);
  assert.ok(before.slots.length > 10, "a 12 hour day at 15 minute steps has plenty of slots");
  assert.equal(before.price, 0);

  await booking.createBooking({
    venueId, serviceId: service.id, startsAt: at(day, 18), partySize: 1, ...guest("First")
  });

  const after = await booking.availability(venueId, service.id, day);
  // SEVEN, not four. A start overlaps an 18:00-19:00 booking whenever it begins
  // after 17:00 and before 19:00, so on a 15 minute grid that is 17:15, 17:30,
  // 17:45, 18:00, 18:15, 18:30 and 18:45. My first version of this test asserted
  // four and the engine was right: a booking starting at 17:15 runs to 18:15 and
  // would sit on top of the one already taken.
  assert.equal(after.slots.length, before.slots.length - 7,
    "every start whose hour would overlap the taken hour disappears");
  assert.ok(!after.slots.some((s) => s.startsAt === at(day, 18)), "18:00 itself is gone");
  assert.ok(!after.slots.some((s) => s.startsAt === `${day}T17:15:00.000Z`),
    "and so is 17:15, which would have run into it");
  assert.ok(after.slots.some((s) => s.startsAt === at(day, 17)),
    "but 17:00 survives: it finishes exactly as the other begins");
});

test("a closed day offers nothing", async () => {
  const solo = await seedOwner();
  const quiet = await seedVenue(solo.userId);
  const service = await catalogue.createService(solo, quiet, { name: "Cut", durationMinutes: 30 });
  // No opening hours set at all.
  const result = await booking.availability(quiet, service.id, tomorrow());
  assert.deepEqual(result.slots, []);
  await pool.query("DELETE FROM book_venues WHERE id=$1", [quiet]);
  await pool.query("DELETE FROM users WHERE id=$1", [solo.userId]);
});

test("a service nobody can book yet offers nothing", async () => {
  const service = await catalogue.createService(owner, venueId, { name: "Paused", durationMinutes: 30 });
  await catalogue.updateService(owner, venueId, service.id, { status: "inactive" });
  const result = await booking.availability(venueId, service.id, tomorrow());
  assert.deepEqual(result.slots, []);
});

/* ------------------------------------------------- the double booking */

test("two people booking the same slot at the same instant: exactly one wins", async () => {
  const service = await catalogue.createService(owner, venueId,
    { name: "Single table", durationMinutes: 60, capacity: 1 });
  const day = tomorrow();
  const when = at(day, 12);

  const [a, b] = await Promise.allSettled([
    booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("A") }),
    booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("B") })
  ]);

  const won = [a, b].filter((r) => r.status === "fulfilled");
  const lost = [a, b].filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one booking is created");
  assert.equal(lost.length, 1, "the other is refused");
  assert.equal(lost[0].reason.statusCode, 409);
  assert.match(lost[0].reason.message, /no longer available/i,
    "and told in words a person understands, not a 500");

  const { rows } = await pool.query(
    "SELECT COUNT(*)::int n FROM book_bookings WHERE service_id=$1 AND starts_at=$2",
    [service.id, when]);
  assert.equal(rows[0].n, 1, "the database holds exactly one");
});

test("OVERLAPPING but differently-started bookings also collide", async () => {
  // THE CONTROL FOR THE LOCK KEY. An advisory lock keyed on the slot rather than
  // the venue would serialise only identical start times, so 12:00-13:00 and
  // 12:30-13:30 on a one-table venue would BOTH be written. This is the test
  // that would catch that mistake.
  const service = await catalogue.createService(owner, venueId,
    { name: "Overlap table", durationMinutes: 60, capacity: 1 });
  const day = tomorrow();

  await booking.createBooking({
    venueId, serviceId: service.id, startsAt: at(day, 14), partySize: 1, ...guest("First")
  });
  await assert.rejects(
    async () => booking.createBooking({
      venueId, serviceId: service.id,
      startsAt: new Date(`${day}T14:30:00.000Z`).toISOString(), partySize: 1, ...guest("Second")
    }),
    (error) => { assert.equal(error.statusCode, 409); return true; }
  );
});

test("capacity is respected: a class of three takes three and then refuses", async () => {
  const service = await catalogue.createService(owner, venueId,
    { name: "Small class", durationMinutes: 60, capacity: 3 });
  const day = tomorrow();
  const when = at(day, 16);

  for (const who of ["One", "Two", "Three"]) {
    const made = await booking.createBooking({
      venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest(who) });
    assert.equal(made.status, "confirmed");
  }
  await assert.rejects(
    async () => booking.createBooking({
      venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("Four") }),
    (error) => { assert.equal(error.statusCode, 409); return true; }
  );
});

test("a party bigger than what is left is refused, not silently trimmed", async () => {
  const service = await catalogue.createService(owner, venueId,
    { name: "Table for four", durationMinutes: 60, capacity: 4 });
  const day = tomorrow();
  const when = at(day, 19);
  await booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 3, ...guest("Three") });
  await assert.rejects(
    async () => booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 2, ...guest("Two more") }),
    (error) => { assert.equal(error.statusCode, 409); return true; }
  );
  // But exactly what remains is fine.
  const fits = await booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("One more") });
  assert.equal(fits.partySize, 1);
});

/* ----------------------------------------------------------- the rules */

test("a booking in the past is refused", async () => {
  const service = await catalogue.createService(owner, venueId, { name: "Past", durationMinutes: 30 });
  await assert.rejects(
    async () => booking.createBooking({
      venueId, serviceId: service.id,
      startsAt: new Date(Date.now() - 3600000).toISOString(), partySize: 1, ...guest("Late")
    }),
    /has passed/i
  );
});

test("a booking needs a way to reach the customer", async () => {
  const service = await catalogue.createService(owner, venueId, { name: "Contact", durationMinutes: 30 });
  await assert.rejects(
    async () => booking.createBooking({
      venueId, serviceId: service.id, startsAt: at(tomorrow(), 11), partySize: 1,
      customerName: "No contact"
    }),
    /phone number or an email/i
  );
});

test("a draft venue takes no bookings", async () => {
  const solo = await seedOwner();
  const draft = await seedVenue(solo.userId);
  await pool.query("UPDATE book_venues SET status='draft' WHERE id=$1", [draft]);
  await openAllWeek(solo, draft);
  const service = await catalogue.createService(solo, draft, { name: "Nope", durationMinutes: 30 });
  await assert.rejects(
    async () => booking.createBooking({
      venueId: draft, serviceId: service.id, startsAt: at(tomorrow(), 12), partySize: 1, ...guest("Early")
    }),
    /not taking bookings yet/i
  );
  await pool.query("DELETE FROM book_venues WHERE id=$1", [draft]);
  await pool.query("DELETE FROM users WHERE id=$1", [solo.userId]);
});

test("a venue that confirms by hand produces a request, not a confirmation", async () => {
  const solo = await seedOwner();
  const manual = await seedVenue(solo.userId, { autoConfirm: false });
  await openAllWeek(solo, manual);
  const service = await catalogue.createService(solo, manual, { name: "Request", durationMinutes: 30 });
  const made = await booking.createBooking({
    venueId: manual, serviceId: service.id, startsAt: at(tomorrow(), 13), partySize: 1, ...guest("Asker") });
  assert.equal(made.status, "pending", "the business has not said yes yet");
  assert.equal(made.confirmedAt, null);
  await pool.query("DELETE FROM book_bookings WHERE venue_id=$1", [manual]);
  await pool.query("DELETE FROM book_venues WHERE id=$1", [manual]);
  await pool.query("DELETE FROM users WHERE id=$1", [solo.userId]);
});

/* -------------------------------------------------------- the lifecycle */

test("a booking moves only along paths that are declared", async () => {
  const solo = await seedOwner();
  const place = await seedVenue(solo.userId, { autoConfirm: false });
  await openAllWeek(solo, place);
  const service = await catalogue.createService(solo, place, { name: "Life", durationMinutes: 30 });
  const made = await booking.createBooking({
    venueId: place, serviceId: service.id, startsAt: at(tomorrow(), 15), partySize: 1, ...guest("Cycle") });

  const confirmed = await booking.setBookingStatus(made.id, "confirmed", solo);
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.confirmedAt);

  const done = await booking.setBookingStatus(made.id, "completed", solo);
  assert.equal(done.status, "completed");

  // A completed booking is finished. Re-opening it would let a business rewrite
  // history after the money moved.
  await assert.rejects(
    async () => booking.setBookingStatus(made.id, "confirmed", solo),
    (error) => { assert.equal(error.statusCode, 409); return true; }
  );

  await pool.query("DELETE FROM book_bookings WHERE venue_id=$1", [place]);
  await pool.query("DELETE FROM book_venues WHERE id=$1", [place]);
  await pool.query("DELETE FROM users WHERE id=$1", [solo.userId]);
});

test("a cancelled booking gives its slot back", async () => {
  const service = await catalogue.createService(owner, venueId,
    { name: "Give back", durationMinutes: 60, capacity: 1 });
  const day = tomorrow();
  const when = at(day, 20);
  const made = await booking.createBooking({
    venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("Gone") });

  const before = await booking.availability(venueId, service.id, day);
  assert.ok(!before.slots.some((s) => s.startsAt === when), "taken while it is held");

  await booking.setBookingStatus(made.id, "cancelled", owner, { reason: "Changed plans" });

  const after = await booking.availability(venueId, service.id, day);
  assert.ok(after.slots.some((s) => s.startsAt === when), "free again once cancelled");
});

/* ================================ resources: the branch nothing was testing */

test("a service carried by RESOURCES books against them, one per resource", async () => {
  // MUTATION TESTING FOUND THIS GAP. Every other test in this file uses a
  // service with no resource linked, so the whole per-resource capacity branch
  // ran in production and was never executed by a test: defeating it with
  // `if (true)` left all fourteen tests green.
  const service = await catalogue.createService(owner, venueId,
    { name: "Two bays", durationMinutes: 60, capacity: 1 });
  const bayOne = await catalogue.createResource(owner, venueId, { name: "Bay 1", capacity: 1 });
  const bayTwo = await catalogue.createResource(owner, venueId, { name: "Bay 2", capacity: 1 });
  await catalogue.updateService(owner, venueId, service.id,
    { resourceIds: [bayOne.id, bayTwo.id] });

  const day = tomorrow();
  const when = at(day, 10);

  const first = await booking.createBooking({
    venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("Car one") });
  const second = await booking.createBooking({
    venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("Car two") });

  assert.ok(first.resourceId, "a booking against a resourced service holds a resource");
  assert.notEqual(first.resourceId, second.resourceId, "the second car takes the OTHER bay");

  // Both bays are now full for that hour.
  await assert.rejects(
    async () => booking.createBooking({
      venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("Car three") }),
    (error) => { assert.equal(error.statusCode, 409); return true; }
  );
});

test("a resource's own capacity caps the service, not the other way round", async () => {
  const service = await catalogue.createService(owner, venueId,
    { name: "Big class small room", durationMinutes: 60, capacity: 50 });
  const smallRoom = await catalogue.createResource(owner, venueId, { name: "Small room", capacity: 2 });
  await catalogue.updateService(owner, venueId, service.id, { resourceIds: [smallRoom.id] });

  const day = tomorrow();
  const when = at(day, 9);
  await booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 2, ...guest("Full") });
  await assert.rejects(
    async () => booking.createBooking({
      venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest("One too many") }),
    (error) => { assert.equal(error.statusCode, 409); return true; },
    "the room holds two even though the class allows fifty"
  );
});

/* ============================== a race that is genuinely a race */

test("TEN simultaneous attempts on one seat produce exactly one booking", async () => {
  // Two concurrent calls in one Node process do not reliably overlap inside the
  // database, so the original two-attempt test passed even with the advisory
  // lock deleted - it was proving nothing. Ten attempts fired together actually
  // interleave, and the control below shows the window is real.
  const service = await catalogue.createService(owner, venueId,
    { name: "One seat", durationMinutes: 60, capacity: 1 });
  const day = tomorrow();
  const when = at(day, 11);

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      booking.createBooking({ venueId, serviceId: service.id, startsAt: when, partySize: 1, ...guest(`Racer ${i}`) }))
  );

  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1, `exactly one of ten should win, got ${won.length}`);
  for (const lost of results.filter((r) => r.status === "rejected")) {
    assert.equal(lost.reason.statusCode, 409, "every loser gets a readable refusal, never a 500");
  }
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int n FROM book_bookings WHERE service_id=$1 AND starts_at=$2", [service.id, when]);
  assert.equal(rows[0].n, 1, "and the database holds exactly one");
});

test("simultaneous bookings at DIFFERENT times that overlap: still exactly one", async () => {
  // WHAT THIS DOES AND DOES NOT PROVE, stated honestly.
  //
  // It proves many simultaneous overlapping attempts yield one booking. It does
  // NOT prove the lock is keyed correctly: re-keying it on the slot instead of
  // the venue leaves this test green, verified by mutation. The natural race
  // window between two Node calls is too narrow to expose that difference
  // without an artificial barrier holding both transactions open at once, which
  // is what scratchpad/concurrency-proof.js did with a control that genuinely
  // double-booked.
  //
  // So the venue key is correct by reasoning rather than by this test: keyed on
  // the slot, 14:00-15:00 and 14:30-15:30 take DIFFERENT locks and are only
  // saved by timing. Do not "simplify" that key on the strength of a green run.
  const service = await catalogue.createService(owner, venueId,
    { name: "Stagger", durationMinutes: 60, capacity: 1 });
  const day = tomorrow();
  const starts = ["08:00", "08:15", "08:30", "08:45"].map((t) => `${day}T${t}:00.000Z`);

  const results = await Promise.allSettled(
    // Several attempts per start time, all fired together, every one of them
    // overlapping every other.
    starts.flatMap((startsAt, i) =>
      Array.from({ length: 3 }, (_, j) =>
        booking.createBooking({
          venueId, serviceId: service.id, startsAt, partySize: 1, ...guest(`Stagger ${i}-${j}`) })))
  );

  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 1,
    `all of these overlap, so exactly one may exist, got ${won.length}`);
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int n FROM book_bookings WHERE service_id=$1", [service.id]);
  assert.equal(rows[0].n, 1, "the database agrees");
});

test("the reference is readable out loud: no I, O, zero or one", async () => {
  for (let i = 0; i < 40; i += 1) {
    const value = booking.bookingReference();
    assert.match(value, /^BK-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(!/[IO01]/.test(value), `${value} contains a character people mishear`);
  }
});
