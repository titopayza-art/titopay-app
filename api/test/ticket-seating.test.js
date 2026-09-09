"use strict";

// RESERVED SEATING: SECTION, ROW, SEAT.
//
// Ticketing was general admission only — a ticket type was a name, a price and
// a quantity, and the tickets table had no seat, row or section column at all.
// The app's ticket stub already read `ticket.seat` and would have rendered it;
// nothing ever sent one.
//
// The display is the easy half. The half that decides whether seating is real
// is this: A SEAT MAY BE SOLD ONCE. Two buyers reaching for the last seat at
// the same instant must come away with different seats, or with an honest
// refusal — never with the same seat each.
//
// That is enforced in the database, not in application code:
//   * (event_id, section, row_label, seat_number) is unique, so a layout
//     cannot contain the same seat twice.
//   * tickets.seat_id is unique, so one seat backs at most one ticket. Whatever
//     races, whatever retries, the second insert fails.
//   * allocation runs FOR UPDATE SKIP LOCKED inside the purchase transaction,
//     so a concurrent buyer skips held seats rather than queueing behind them.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { pool } = require("../src/db/pool");
const ticketing = require("../src/services/ticketing-service");

async function makeUser(name) {
  const id = crypto.randomUUID();
  const tag = "seat-" + id.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash, email, status)
     VALUES ($1,'personal',$2,$3,'x',$4,'active')`,
    [id, name, tag, tag + "@example.test"]);
  return id;
}

async function makeSeatedEvent(organiserId, { rows, seatsPerRow, section = "Block A" }) {
  await ticketing.ensureTicketingSchema();
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, slug, event_name, category, venue_name, event_date, status)
     VALUES ($1,$2,$3,'Seated Show','music','Test Arena',CURRENT_DATE + 20,'approved')`,
    [eventId, organiserId, "seated-" + eventId.slice(0, 8)]);
  const typeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'Seated Ticket',250,500)`,
    [typeId, eventId]);
  const result = await ticketing.defineSeating({ userId: organiserId }, eventId, {
    section, rows, seatsPerRow, ticketTypeId: typeId
  });
  return { eventId, typeId, result };
}

async function cleanup(eventId, userIds) {
  await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM event_seats WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => null);
  for (const id of userIds || []) {
    await pool.query("DELETE FROM event_audit_logs WHERE actor_id = $1", [id]).catch(() => null);
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => null);
  }
}

test("an organiser describes a section and the seats exist", async () => {
  const organiser = await makeUser("Organiser");
  const { eventId, typeId, result } = await makeSeatedEvent(organiser, { rows: ["A", "B", "C"], seatsPerRow: 10 });
  try {
    assert.equal(result.seatsCreated, 30, "3 rows of 10");
    const { rows } = await pool.query(
      "SELECT section, row_label, seat_number FROM event_seats WHERE event_id = $1 ORDER BY sort_order LIMIT 3",
      [eventId]);
    assert.deepEqual(rows[0], { section: "Block A", row_label: "A", seat_number: "1" });
    assert.deepEqual(rows[2], { section: "Block A", row_label: "A", seat_number: "3" });
    // The ticket type is marked seated, so purchase knows to allocate.
    const { rows: type } = await pool.query("SELECT seated FROM event_ticket_types WHERE id = $1", [typeId]);
    assert.equal(type[0].seated, true);
  } finally {
    await cleanup(eventId, [organiser]);
  }
});

test("defining the same section twice adds nothing and duplicates nothing", async () => {
  // An organiser correcting a typo elsewhere in the form must not double the
  // venue. The unique index makes re-running the definition a no-op.
  const organiser = await makeUser("Organiser");
  const { eventId, typeId } = await makeSeatedEvent(organiser, { rows: ["A", "B"], seatsPerRow: 5 });
  try {
    const again = await ticketing.defineSeating({ userId: organiser }, eventId, {
      section: "Block A", rows: ["A", "B"], seatsPerRow: 5, ticketTypeId: typeId
    });
    assert.equal(again.seatsCreated, 0, "nothing new was created");
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM event_seats WHERE event_id = $1", [eventId]);
    assert.equal(rows[0].n, 10, "still ten seats, not twenty");
  } finally {
    await cleanup(eventId, [organiser]);
  }
});

test("a seat is allocated once and the ticket carries it", async () => {
  const organiser = await makeUser("Organiser");
  const { eventId, typeId } = await makeSeatedEvent(organiser, { rows: ["A"], seatsPerRow: 4 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seats = await ticketing.allocateSeats(client, { eventId, ticketTypeId: typeId, quantity: 2 });
    assert.equal(seats.length, 2);
    assert.equal(seats[0].seat_number, "1");
    assert.equal(seats[1].seat_number, "2");
    await client.query("COMMIT");

    const { rows } = await pool.query(
      "SELECT status, COUNT(*)::int AS n FROM event_seats WHERE event_id = $1 GROUP BY status ORDER BY status", [eventId]);
    assert.deepEqual(rows, [{ status: "available", n: 2 }, { status: "held", n: 2 }]);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await cleanup(eventId, [organiser]);
  }
});

test("TWO BUYERS AT ONCE GET DIFFERENT SEATS, never the same one", async () => {
  // The question seating exists to answer. Both transactions are open at the
  // same time and both ask for the last two seats in a four-seat row.
  const organiser = await makeUser("Organiser");
  const { eventId, typeId } = await makeSeatedEvent(organiser, { rows: ["A"], seatsPerRow: 4 });
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    const seatsA = await ticketing.allocateSeats(a, { eventId, ticketTypeId: typeId, quantity: 2 });
    const seatsB = await ticketing.allocateSeats(b, { eventId, ticketTypeId: typeId, quantity: 2 });
    await a.query("COMMIT");
    await b.query("COMMIT");

    const idsA = seatsA.map((s) => s.id);
    const idsB = seatsB.map((s) => s.id);
    assert.equal(idsA.length, 2);
    assert.equal(idsB.length, 2);
    const overlap = idsA.filter((id) => idsB.includes(id));
    assert.deepEqual(overlap, [], "no seat was handed to both buyers");
    assert.equal(new Set([...idsA, ...idsB]).size, 4, "all four distinct seats went out");
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    a.release(); b.release();
    await cleanup(eventId, [organiser]);
  }
});

test("when the seats run out the buyer is told, not given someone else's", async () => {
  const organiser = await makeUser("Organiser");
  const { eventId, typeId } = await makeSeatedEvent(organiser, { rows: ["A"], seatsPerRow: 2 });
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await ticketing.allocateSeats(a, { eventId, ticketTypeId: typeId, quantity: 2 });
    await b.query("BEGIN");
    await assert.rejects(
      () => ticketing.allocateSeats(b, { eventId, ticketTypeId: typeId, quantity: 1 }),
      (error) => {
        assert.equal(error.statusCode, 409);
        // Not "sold out": the other buyer may not complete, and the seats may
        // come back. The message says what this buyer can do now.
        assert.match(error.message, /just gone|seats? left/i);
        return true;
      });
    await a.query("COMMIT");
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    a.release(); b.release();
    await cleanup(eventId, [organiser]);
  }
});

test("the database refuses a second ticket on one seat, whatever the code does", async () => {
  // The last line of defence. Even if allocation were bypassed entirely, the
  // unique index on tickets.seat_id makes a double sale impossible.
  const organiser = await makeUser("Organiser");
  const buyer = await makeUser("Buyer");
  const { eventId, typeId } = await makeSeatedEvent(organiser, { rows: ["A"], seatsPerRow: 1 });
  try {
    const { rows: seat } = await pool.query("SELECT id FROM event_seats WHERE event_id = $1", [eventId]);
    const orderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, status)
       VALUES ($1,$2,$3,$4,$5,1,'paid')`,
      [orderId, eventId, typeId, buyer, "ST-" + orderId.slice(0, 8)]);
    const insertTicket = (code) => pool.query(
      `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status, seat_id)
       VALUES ($1,$2,$3,$4,$5,$6,'valid',$7)`,
      [crypto.randomUUID(), orderId, eventId, typeId, buyer, code, seat[0].id]);
    await insertTicket(String(Math.floor(1000000 + Math.random() * 8999999)));
    await assert.rejects(() => insertTicket(String(Math.floor(1000000 + Math.random() * 8999999))),
      (error) => error.code === "23505", "the unique index rejects the second ticket on that seat");
  } finally {
    await cleanup(eventId, [organiser, buyer]);
  }
});

test("general admission is untouched: no seats, no allocation, no change", async () => {
  // Every event already selling must keep working exactly as it did.
  const organiser = await makeUser("Organiser");
  await ticketing.ensureTicketingSchema();
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, slug, event_name, category, venue_name, event_date, status)
     VALUES ($1,$2,$3,'GA Show','music','Test Hall',CURRENT_DATE + 20,'approved')`,
    [eventId, organiser, "ga-" + eventId.slice(0, 8)]);
  const typeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'General Admission',100,100)`,
    [typeId, eventId]);
  try {
    const { rows } = await pool.query("SELECT seated FROM event_ticket_types WHERE id = $1", [typeId]);
    assert.equal(rows[0].seated, false, "a ticket type is general admission unless seating is defined");
    const { rows: seats } = await pool.query("SELECT COUNT(*)::int AS n FROM event_seats WHERE event_id = $1", [eventId]);
    assert.equal(seats[0].n, 0);
  } finally {
    await cleanup(eventId, [organiser]);
  }
});
