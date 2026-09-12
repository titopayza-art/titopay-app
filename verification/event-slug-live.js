"use strict";

// THE WEB ADDRESS OF AN EVENT, WHICH IS WHAT AN ORGANISER SENDS OUT.
//
// A free name has always been used as it is. The question was only what happens
// on a COLLISION, and the answer used to be six characters of a sha1 digest:
//
//   app.titopay.co.za/events/titopay-launch-3d4c29
//
// unreadable, impossible to say out loud, and it looks like a fault. It is now
// the next free number, the way every publishing tool does it.
//
//   1. A free name is the address, untouched.
//   2. A second event with the same name gets -2, not a hex digest.
//   3. A third gets -3.
//   4. A long name is not cut leaving a dangling hyphen.
//   5. Punctuation, accents and emoji do not reach the address.
//   6. Renaming an event does not collide with its own current address.
//   7. Every slug already in the database is left exactly as it is.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/event-slug-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const ticketing = require("../api/src/services/ticketing-service");

const TAG = `sg${String(Date.now()).slice(-7)}`;
const org = randomUUID(), wal = randomUUID(), mer = randomUUID();

async function makeEvent(name) {
  const draft = await ticketing.createEventDraft(org, {
    eventName: name, category: "conference", description: "d",
    eventDate: "2027-06-06", startTime: "09:00", endTime: "17:00",
    venueName: "HQ", fullVenueAddress: "1 St", city: "Johannesburg", province: "Gauteng",
    termsConditions: "t", refundPolicy: { summary: "s" },
    ticketTypes: [{ ticketName: "General", price: 0, quantityAvailable: 10 }]
  });
  return { id: draft.id, slug: (await pool.query("SELECT slug FROM events WHERE id=$1", [draft.id])).rows[0].slug };
}

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  let before = [];
  try {
    await ticketing.ensureTicketingSchema();
    before = (await pool.query("SELECT id, slug FROM events ORDER BY created_at")).rows;

    await pool.query(`INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
      VALUES ($1,'business','${TAG} Org','${TAG}_o','${TAG}_o@example.invalid','27110000161','x','active',FALSE,'approved')`, [org]);
    await pool.query(`INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
      VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`, [wal, String(Date.now()).slice(-9), org]);
    await pool.query(`INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
      VALUES ($1,$2,$3,$4,'active','verified')`, [mer, org, `${TAG} Org`, `M${TAG}`]);

    const name = `${TAG} Launch`;
    const expected = `${TAG.toLowerCase()}-launch`;

    const first = await makeEvent(name);
    assert.equal(first.slug, expected, `a free name must be the address as it is`);
    ok("a free name is the address, untouched", `/events/${first.slug}`);

    const second = await makeEvent(name);
    assert.equal(second.slug, `${expected}-2`, `got "${second.slug}"`);
    assert.doesNotMatch(second.slug, /-[0-9a-f]{6}$/, "a hex digest is not a readable web address");
    ok("a second event with the same name gets -2, not a hex digest", `/events/${second.slug}`);

    const third = await makeEvent(name);
    assert.equal(third.slug, `${expected}-3`, `got "${third.slug}"`);
    ok("and a third gets -3", `/events/${third.slug}`);

    // A name long enough to be cut by the 70-character limit, arranged so the
    // cut lands on a hyphen.
    const long = await makeEvent(`${TAG} ${"Annual General Meeting ".repeat(4)}`);
    assert.doesNotMatch(long.slug, /-$/, `"${long.slug}" ends in a dangling hyphen`);
    assert.ok(long.slug.length <= 70);
    ok("a long name is not cut leaving a dangling hyphen", `/events/${long.slug}`);

    const messy = await makeEvent(`${TAG}  Braai & Chill!! 2027 — Jozi 🎉`);
    assert.match(messy.slug, /^[a-z0-9-]+$/, `"${messy.slug}" is not a clean address`);
    assert.doesNotMatch(messy.slug, /--/, "a doubled hyphen reads as a mistake");
    ok("punctuation, accents and emoji never reach the address", `/events/${messy.slug}`);

    // Renaming: the event must not collide with the address it already holds.
    const renamed = await ticketing.updateEventDraft(org, first.id, { eventName: name });
    assert.equal(renamed.slug, expected, `renaming to the same name moved the address to "${renamed.slug}"`);
    ok("renaming an event to its own name keeps its address", `/events/${renamed.slug}`);

    const after = (await pool.query("SELECT id, slug FROM events WHERE id = ANY($1::UUID[])",
      [before.map((r) => r.id)])).rows;
    const moved = after.filter((row) => {
      const was = before.find((r) => r.id === row.id);
      return was && was.slug !== row.slug;
    });
    assert.deepEqual(moved, [], "an existing event's address changed, which breaks every link already shared");
    ok("every event already in the database keeps its exact address", `${before.length} checked`);

    console.log(`\n  ${passed}/7 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    const events = (await pool.query("SELECT id FROM events WHERE business_user_id=$1", [org])).rows.map((r) => r.id);
    for (const id of events) {
      for (const table of ["tickets", "ticket_orders", "event_ticket_types", "event_audit_logs"]) {
        await pool.query(`DELETE FROM ${table} WHERE event_id=$1`, [id]).catch(() => {});
      }
      await pool.query("DELETE FROM events WHERE id=$1", [id]).catch(() => {});
    }
    await pool.query("DELETE FROM merchants WHERE id=$1", [mer]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE id=$1", [wal]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [org]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
