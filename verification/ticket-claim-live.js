"use strict";

// GIFTED TICKET CLAIM — REAL DATABASE.
//
// A ticket bought as a gift is added to the recipient's account with its
// printed code. Proves: the claim moves the ticket (recipient sees it with a
// scannable QR, the giver no longer does), the gate still admits it under the
// new name, the previous owner is told in the app and by email, wrong codes
// are throttled hard, used/wristbanded tickets refuse politely, and linking a
// wristband becomes the recipient's right after the claim.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/ticket-claim-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
notif.deliverSms = async () => ({ id: "stub" });
const svc = require("../api/src/services/ticketing-service");
const eventTags = require("../api/src/services/event-tag-service");
const { ensureEmailSchema } = require("../api/src/services/email-centre-service");

const TAG = "claimlive";
const ids = {
  organiser: randomUUID(),
  gifter: randomUUID(),
  recipient: randomUUID(),
  stranger: randomUUID(),
  event: randomUUID(),
  ticketType: randomUUID(),
  order: randomUUID(),
  gifted: randomUUID(),
  used: randomUUID(),
  banded: randomUUID()
};
const CODES = { gifted: "9100000001", used: "9100000002", banded: "9100000003" };
let previousSendingEnabled = null;

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Events','${TAG}_org','${TAG}_org@example.invalid','27110000801','x','active',FALSE,'approved'),
            ($2,'personal','${TAG} Gifter','${TAG}_gifter','${TAG}_gifter@example.invalid','27110000802','x','active',FALSE,'pending'),
            ($3,'personal','${TAG} Recipient','${TAG}_recipient','${TAG}_recipient@example.invalid','27110000803','x','active',FALSE,'pending'),
            ($4,'personal','${TAG} Stranger','${TAG}_stranger','${TAG}_stranger@example.invalid','27110000804','x','active',FALSE,'pending')`,
    [ids.organiser, ids.gifter, ids.recipient, ids.stranger]
  );
  await svc.ensureTicketingSchema();
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date, cashless_tags_enabled)
     VALUES ($1,$2,'${TAG} Concert','${TAG}-concert','approved','2026-09-01',TRUE)`,
    [ids.event, ids.organiser]
  );
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'General',150,100)`,
    [ids.ticketType, ids.event]
  );
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,'ORD-${TAG}',3,450,450,'paid')`,
    [ids.order, ids.event, ids.ticketType, ids.gifter]
  );
  for (const [ticketId, code] of [[ids.gifted, CODES.gifted], [ids.used, CODES.used], [ids.banded, CODES.banded]]) {
    await pool.query(
      `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, qr_payload, attendee_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'${TAG} Gifter','valid')`,
      [ticketId, ids.order, ids.event, ids.ticketType, ids.gifter, code,
       JSON.stringify({ type: "titopay_ticket", ticketId, ticketCode: code, orderReference: `ORD-${TAG}`, eventId: ids.event })]
    );
  }
  await pool.query("UPDATE tickets SET status = 'scanned', scanned_at = NOW(), scanned_by = $2 WHERE id = $1", [ids.used, ids.organiser]);
  await pool.query(
    `INSERT INTO event_tags (event_id, token_hash, tag_label, ticket_id, user_id, status, assigned_at)
     VALUES ($1,'${TAG}-hash','${TAG}-TAG-1',$2,$3,'ASSIGNED',NOW())`,
    [ids.event, ids.banded, ids.gifter]
  );
  await ensureEmailSchema();
  const { rows } = await pool.query("SELECT sending_enabled FROM email_settings WHERE id=TRUE");
  previousSendingEnabled = rows[0] ? rows[0].sending_enabled : null;
  await pool.query("UPDATE email_settings SET sending_enabled=TRUE WHERE id=TRUE");
}

async function cleanup() {
  if (previousSendingEnabled !== null) {
    await pool.query("UPDATE email_settings SET sending_enabled=$1 WHERE id=TRUE", [previousSendingEnabled]).catch(() => {});
  }
  const users = [ids.organiser, ids.gifter, ids.recipient, ids.stranger];
  await pool.query("DELETE FROM email_queue WHERE idempotency_key LIKE 'ticket-claim-owner-alert:%' AND user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM event_tags WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM tickets WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1 OR actor_id = ANY($2)", [ids.event, users]).catch(() => {});
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM events WHERE id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM audit_logs WHERE actor_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  GIFTED TICKET CLAIM — CODE IN, TICKET + WRISTBAND RIGHTS MOVE, REAL DB");
    console.log("=".repeat(80));

    await seed();
    const recipient = { userId: ids.recipient, userType: "customer" };
    const stranger = { userId: ids.stranger, userType: "customer" };

    // 1. The recipient claims the gifted code — the ticket moves, with QR.
    const claimed = await svc.claimTicketByCode(recipient, CODES.gifted);
    assert.equal(claimed.ticketCode, CODES.gifted);
    assert.ok(String(claimed.qrImageDataUrl || "").startsWith("data:image/"), "the claimed ticket carries its scannable QR");
    const recipientTickets = await svc.listMyTickets(ids.recipient);
    assert.ok(recipientTickets.some((t) => t.ticketCode === CODES.gifted), "recipient sees the ticket in My Tickets");
    const gifterTickets = await svc.listMyTickets(ids.gifter);
    assert.ok(!gifterTickets.some((t) => t.ticketCode === CODES.gifted), "the giver no longer holds it");
    ok("claim moves the gifted ticket into the recipient's My Tickets");

    // 2. Entry is now under the recipient's name.
    const { rows: nameRows } = await pool.query("SELECT attendee_name FROM tickets WHERE id = $1", [ids.gifted]);
    assert.equal(nameRows[0].attendee_name, `${TAG} Recipient`, "the gate list shows the new holder");
    ok("the ticket is re-addressed to the recipient for the gate");

    // 3. The previous owner is told, in the app and by email.
    const { rows: alerts } = await pool.query(
      "SELECT * FROM notifications WHERE user_id = $1 AND notification_type = 'ticket_transferred'", [ids.gifter]);
    assert.equal(alerts.length, 1, "one in-app alert for the giver");
    const { rows: mails } = await pool.query(
      "SELECT recipient FROM email_queue WHERE idempotency_key = $1", [`ticket-claim-owner-alert:${ids.gifted}`]);
    assert.equal(mails.length, 1, "one alert email queued");
    assert.equal(mails[0].recipient, `${TAG}_gifter@example.invalid`);
    ok("the giver is notified in the app and by email the moment it moves");

    // 4. The wristband right follows the ticket: linkable for the recipient,
    //    not for the giver.
    const recipientLinkable = await eventTags.linkableTickets(ids.recipient);
    assert.ok(recipientLinkable.some((t) => t.ticketCode === CODES.gifted), "recipient can now link a wristband to it");
    const gifterLinkable = await eventTags.linkableTickets(ids.gifter);
    assert.ok(!gifterLinkable.some((t) => t.ticketCode === CODES.gifted), "the giver cannot");
    ok("the event wristband becomes the recipient's to link");

    // 5. The gate still admits the claimed ticket — nothing broke.
    const scan = await svc.scanTicket({ userId: ids.organiser, userType: "customer" }, { ticketCode: CODES.gifted });
    assert.ok(scan && (scan.admitted === true || scan.status === "scanned" || scan.ticket?.status === "scanned"), "the claimed ticket scans in");
    ok("the gate admits the claimed ticket exactly as before");

    // 6. A used ticket cannot be claimed.
    let used = false;
    try { await svc.claimTicketByCode(stranger, CODES.used); }
    catch (error) { used = error.statusCode === 409 && /scanned/i.test(error.message); }
    assert.ok(used, "a scanned ticket refuses the claim");
    ok("a ticket already scanned in cannot be taken over");

    // 7. A ticket with a live wristband refuses until the band is unlinked.
    let banded = false;
    try { await svc.claimTicketByCode(stranger, CODES.banded); }
    catch (error) { banded = error.statusCode === 409 && /wristband/i.test(error.message); }
    assert.ok(banded, "a wristbanded ticket refuses the claim");
    ok("a ticket with a live wristband linked cannot move underneath it");

    // 8. Guessing is throttled: 8 failures inside an hour block the next try.
    //    The stranger's two refused claims above already count as failures —
    //    exactly as they should — so six more wrong codes reach the cap.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let missed = false;
      try { await svc.claimTicketByCode(stranger, String(8200000000 + attempt)); }
      catch (error) { missed = error.statusCode === 404; }
      assert.ok(missed, "each wrong code is refused");
    }
    let throttled = false;
    try { await svc.claimTicketByCode(stranger, CODES.used); }
    catch (error) { throttled = error.statusCode === 429; }
    assert.ok(throttled, "the attempt after 8 failures inside an hour is throttled");
    ok("code guessing is throttled hard after 8 misses in an hour");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — gifted tickets move safely, nothing else moved.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
