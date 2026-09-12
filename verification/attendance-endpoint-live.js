"use strict";

// ATTENDANCE ENDPOINT AUTHORIZATION, AGAINST A REAL DATABASE.
//
// GET /v1/ticketing/business/events/:id/attendance is gated by the same "scan"
// permission the scanner uses. This proves the gate the route applies:
//   - the organiser can read the count
//   - an assigned scanner (event_staff with "scan") can read it
//   - a stranger is refused (canManageEventTicketing === false → route 403s)
//   - the count itself is correct (issued vs scanned)
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/attendance-endpoint-live.js
//
// Seeds throwaway accounts and deletes them at the end. No existing data touched.

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

const TAG = "attlive";
const ids = {
  businessUser: randomUUID(), buyerUser: randomUUID(), strangerUser: randomUUID(), scannerUser: randomUUID(),
  bizWallet: randomUUID(), buyerWallet: randomUUID()
};

async function seed() {
  await ticketing.ensureTicketingSchema();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Org','${TAG}_biz','${TAG}_biz@example.invalid','27110000101','x','active',FALSE,'pending')`,
    [ids.businessUser]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`,
    [ids.bizWallet, String(Date.now()).slice(-9), ids.businessUser]);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal','${TAG} Buyer','${TAG}_buyer','${TAG}_buyer@example.invalid','27110000102','x','active',FALSE,'approved')`,
    [ids.buyerUser]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',0,0,'active')`,
    [ids.buyerWallet, String(Date.now() + 1).slice(-9), ids.buyerUser]);
  // A stranger (another business) with no relationship to the event.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Stranger','${TAG}_str','${TAG}_str@example.invalid','27110000103','x','active',FALSE,'pending')`,
    [ids.strangerUser]);
  // A PERSONAL user who will be assigned as a scanner — deliberately with FICA
  // still PENDING, which is the normal state of a helper's account. Scanning
  // moves no money, so this must be allowed (it used to be refused, which is
  // why organisers "couldn't add staff").
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal','${TAG} Scanner','${TAG}_scan','${TAG}_scan@example.invalid','27110000104','x','active',FALSE,'pending')`,
    [ids.scannerUser]);
}

async function cleanup() {
  const events = (await pool.query("SELECT id FROM events WHERE business_user_id = $1", [ids.businessUser])).rows.map((r) => r.id);
  for (const eventId of events) {
    await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM event_staff WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
  }
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [[ids.businessUser, ids.buyerUser]]).catch(() => {});
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [[ids.bizWallet, ids.buyerWallet]]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[ids.bizWallet, ids.buyerWallet]]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.businessUser, ids.buyerUser, ids.strangerUser, ids.scannerUser]]);
}

// Mirrors exactly what the route does before returning the count.
async function attendanceAsRoute(userId, eventId) {
  const allowed = await ticketing.canManageEventTicketing(userId, eventId, "scan");
  if (!allowed) return { status: 403 };
  return { status: 200, attendance: await ticketing.eventAttendance(eventId) };
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    await seed();
    console.log("\n" + "=".repeat(78));
    console.log("  ATTENDANCE ENDPOINT AUTHORIZATION, REAL DATABASE");
    console.log("=".repeat(78));

    const draft = await ticketing.createEventDraft(ids.businessUser, {
      eventName: `${TAG} Free Meetup`, category: "conference", eventDate: "2027-03-01", startTime: "09:00",
      venueName: "Hall", fullVenueAddress: "1 St", city: "JHB", province: "Gauteng",
      ticketTypes: [{ ticketName: "General", price: 0, quantityAvailable: 50 }]
    });
    await pool.query("UPDATE events SET status='approved', approved_at=NOW() WHERE id=$1", [draft.id]);
    const slug = (await pool.query("SELECT slug FROM events WHERE id = $1", [draft.id])).rows[0].slug;

    // Two free tickets issued, none scanned yet.
    await ticketing.purchaseTickets({ userId: ids.buyerUser }, slug, { quantity: 2, buyerDetails: { name: "B" } });

    // 1. Organiser can read, count is 0 of 2.
    const asOwner = await attendanceAsRoute(ids.businessUser, draft.id);
    assert.equal(asOwner.status, 200, "organiser is allowed");
    assert.deepEqual(asOwner.attendance, { scanned: 0, total: 2 }, `owner sees 0 of 2, got ${JSON.stringify(asOwner.attendance)}`);
    ok("organiser reads the count before any scan: 0 of 2");

    // 2. Stranger is refused (route would 403).
    const asStranger = await attendanceAsRoute(ids.strangerUser, draft.id);
    assert.equal(asStranger.status, 403, "an unrelated business must be refused");
    assert.equal(asStranger.attendance, undefined, "a refused caller gets no count");
    ok("an unrelated business is refused (403), and sees no numbers");

    // 3. Assign a scanner with FICA still PENDING — this is the exact case the
    //    organiser hit ("can't add staff"): a door role needs an active
    //    account, not FICA.
    await ticketing.addEventStaff({ userId: ids.businessUser }, draft.id, { identifier: `${TAG}_scan`, role: "scanner", permissions: ["scan"] });
    const asScanner = await attendanceAsRoute(ids.scannerUser, draft.id);
    assert.equal(asScanner.status, 200, "an assigned scanner is allowed");
    assert.deepEqual(asScanner.attendance, { scanned: 0, total: 2 });
    ok("a PENDING-FICA personal user was added as staff and can read the count");

    // 3b. The assignment is what unlocks the personal scanner: the staff list
    //     endpoint returns exactly the assigned event for the scanner, and
    //     nothing at all for a stranger.
    const scannerEvents = await ticketing.listStaffScanEvents(ids.scannerUser);
    assert.equal(scannerEvents.length, 1, "the scanner sees exactly the event they were assigned to");
    assert.equal(scannerEvents[0].id, draft.id);
    assert.match(scannerEvents[0].eventName, /Free Meetup/);
    const strangerEvents = await ticketing.listStaffScanEvents(ids.strangerUser);
    assert.equal(strangerEvents.length, 0, "a stranger sees no staff events");
    ok("staff/events lists the assignment for the scanner and nothing for a stranger");

    // 3c. Lookup safety: an @username (no digits) must resolve to exactly that
    //     user. The old lookup's digits clause compared against the EMPTY
    //     string for such identifiers, which could match a random account with
    //     no phone on file — the add then landed on a stranger, the organiser
    //     saw nothing, and the intended scanner never got the event.
    const decoyId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
       VALUES ($1,'personal','${TAG} Decoy','${TAG}_decoy','${TAG}_decoy@example.invalid',NULL,'x','active',FALSE,'pending')`,
      [decoyId]);
    const byUsername = await ticketing.addEventStaff({ userId: ids.businessUser }, draft.id, { identifier: `@${TAG}_scan`, role: "scanner", permissions: ["scan"] });
    assert.equal(byUsername.user.id, ids.scannerUser, "an @username resolves to exactly that user, never a phoneless stranger");
    const byEmail = await ticketing.addEventStaff({ userId: ids.businessUser }, draft.id, { identifier: `${TAG}_scan@example.invalid`, role: "scanner", permissions: ["scan"] });
    assert.equal(byEmail.user.id, ids.scannerUser, "an email resolves to exactly that user too");
    await pool.query("DELETE FROM users WHERE id = $1", [decoyId]);
    ok("staff lookup resolves @usernames and emails exactly — never a phoneless stranger");

    // 4. Scan one ticket; the count the endpoint returns moves to 1 of 2.
    const code = (await pool.query("SELECT ticket_code FROM tickets WHERE event_id = $1 ORDER BY created_at LIMIT 1", [draft.id])).rows[0].ticket_code;
    await ticketing.scanTicket({ userId: ids.scannerUser }, { ticketCode: code });
    const afterScan = await attendanceAsRoute(ids.businessUser, draft.id);
    assert.deepEqual(afterScan.attendance, { scanned: 1, total: 2 }, `after one scan it is 1 of 2, got ${JSON.stringify(afterScan.attendance)}`);
    ok("after a scanner scans one ticket, the endpoint reports 1 of 2");

    // 5. Removing the scanner takes the event away from them again: their staff
    //    list empties and the attendance read is refused.
    await ticketing.removeEventStaff({ userId: ids.businessUser }, draft.id, ids.scannerUser);
    assert.equal((await ticketing.listStaffScanEvents(ids.scannerUser)).length, 0, "a removed scanner sees no staff events");
    const removedRead = await attendanceAsRoute(ids.scannerUser, draft.id);
    assert.equal(removedRead.status, 403, "a removed scanner can no longer read the count");
    ok("removing a scanner revokes their access immediately");

    console.log("\n" + "=".repeat(78));
    console.log(`  ALL ${passed} CHECKS PASSED — attendance endpoint gates on scan permission and counts correctly.`);
    console.log("=".repeat(78) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
})();
