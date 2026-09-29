"use strict";
// CAN THIS TICKET LINK A WRISTBAND? THE WHOLE CHAIN, AGAINST A REAL DATABASE.
//
// Reported three times as "the feature was removed". It was not - but saying
// so is not evidence. This walks the exact state a real organiser reported:
// an APPROVED event with CASHLESS ON, a valid ticket owned by the attendee,
// and no tag on it yet. If the button should appear, linkableTickets must
// return that ticket, and the ticket itself must carry the two facts that let
// the card explain itself.
//
// It also pins the three states where the button is correctly absent, so an
// empty screen can always be explained rather than guessed at.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/wristband-linkable-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const tags = require("../api/src/services/event-tag-service");
const ticketing = require("../api/src/services/ticketing-service");

const TAG = "wblive";
const ids = {
  organiser: randomUUID(), attendee: randomUUID(),
  event: randomUUID(), offEvent: randomUUID(),
  type: randomUUID(), offType: randomUUID(),
  order: randomUUID(), offOrder: randomUUID(),
  live: randomUUID(), linked: randomUUID(), offTicket: randomUUID()
};
const CODES = { live: "9000000001", linked: "9000000002", off: "9000000003" };
let passed = 0;
const ok = (m) => { passed += 1; console.log("  ✓ " + m); };

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Organiser','${TAG}_org','${TAG}_o@example.invalid','27110003301','x','active',FALSE,'approved'),
            ($2,'personal','${TAG} Attendee','${TAG}_att','${TAG}_a@example.invalid','27110003302','x','active',FALSE,'pending')`,
    [ids.organiser, ids.attendee]);
  // One event exactly as reported: approved, cashless ON. One with cashless off.
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date, cashless_tags_enabled)
     VALUES ($1,$2,'${TAG} Launch','${TAG}-launch','approved','2026-11-20',TRUE),
            ($3,$2,'${TAG} Quiet','${TAG}-quiet','approved','2026-11-21',FALSE)`,
    [ids.event, ids.organiser, ids.offEvent]);
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'General Admission',150,100),($3,$4,'General Admission',150,100)`,
    [ids.type, ids.event, ids.offType, ids.offEvent]);
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,'ORD-${TAG}-1',2,300,300,'paid'),($5,$6,$7,$4,'ORD-${TAG}-2',1,150,150,'paid')`,
    [ids.order, ids.event, ids.type, ids.attendee, ids.offOrder, ids.offEvent, ids.offType]);
  const ticket = async (id, order, event, type, code) => pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, qr_payload, attendee_name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'${TAG} Attendee','valid')`,
    [id, order, event, type, ids.attendee, code,
     JSON.stringify({ type: "titopay_ticket", ticketId: id, ticketCode: code, eventId: event })]);
  await ticket(ids.live, ids.order, ids.event, ids.type, CODES.live);
  await ticket(ids.linked, ids.order, ids.event, ids.type, CODES.linked);
  await ticket(ids.offTicket, ids.offOrder, ids.offEvent, ids.offType, CODES.off);
  // One ticket already wearing a band.
  await pool.query(
    `INSERT INTO event_tags (event_id, token_hash, tag_label, ticket_id, user_id, status, assigned_at)
     VALUES ($1,'${TAG}-hash','TP99000001',$2,$3,'ASSIGNED',NOW())`,
    [ids.event, ids.linked, ids.attendee]);
}

async function cleanup() {
  await pool.query("DELETE FROM event_tags WHERE event_id = ANY($1)", [[ids.event, ids.offEvent]]).catch(() => {});
  await pool.query("DELETE FROM tickets WHERE owner_user_id = $1", [ids.attendee]).catch(() => {});
  await pool.query("DELETE FROM ticket_orders WHERE buyer_user_id = $1", [ids.attendee]).catch(() => {});
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = ANY($1)", [[ids.event, ids.offEvent]]).catch(() => {});
  await pool.query("DELETE FROM events WHERE id = ANY($1)", [[ids.event, ids.offEvent]]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.organiser, ids.attendee]]).catch(() => {});
}

(async () => {
  try {
    await cleanup();
    await seed();

    const linkable = await tags.linkableTickets(ids.attendee);
    const codes = linkable.map((row) => row.ticketCode);
    assert.ok(codes.includes(CODES.live),
      `the cashless event's unlinked ticket must be offered — got ${JSON.stringify(codes)}`);
    ok("an approved + cashless event with an unlinked ticket IS offered a wristband");

    assert.ok(!codes.includes(CODES.linked), "a ticket that already wears a band is not offered again");
    assert.ok(!codes.includes(CODES.off), "a ticket for a non-cashless event is not offered");
    ok("already-linked and non-cashless tickets are correctly left out");

    // The card must be able to say WHY, so the ticket carries its own state.
    const mine = await ticketing.listMyTickets(ids.attendee);
    const byCode = Object.fromEntries(mine.map((row) => [row.ticketCode, row]));
    assert.equal(byCode[CODES.live].cashlessTagsEnabled, true);
    assert.equal(byCode[CODES.live].wristbandLinked, false);
    assert.equal(byCode[CODES.linked].wristbandLinked, true, "the linked ticket knows it is linked");
    assert.equal(byCode[CODES.off].cashlessTagsEnabled, false, "the quiet event's ticket knows it is not cashless");
    ok("every ticket carries the facts it needs to explain itself");

    // Switching cashless off takes the offer away; switching it on brings it back.
    await pool.query("UPDATE events SET cashless_tags_enabled = FALSE WHERE id = $1", [ids.event]);
    assert.equal((await tags.linkableTickets(ids.attendee)).length, 0, "cashless off removes the offer");
    await pool.query("UPDATE events SET cashless_tags_enabled = TRUE WHERE id = $1", [ids.event]);
    assert.equal((await tags.linkableTickets(ids.attendee)).length, 1, "cashless on restores it");
    ok("the organiser's cashless switch is what drives it, in both directions");

    console.log("\n" + "=".repeat(78));
    console.log(`  ALL ${passed} CHECKS PASSED — with cashless on, the wristband IS offered.`);
    console.log("=".repeat(78) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch(() => {});
    await pool.end();
  }
})();
