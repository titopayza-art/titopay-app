"use strict";

// ORGANISER CHANGE REQUESTS + SAFE CANCEL, PROVEN AGAINST A REAL DATABASE.
//
// An approved event is frozen to the organiser. This proves the new escape
// hatch end to end: the organiser asks to postpone / cancel / update / other,
// admin reviews, and the effect is applied — WITHOUT ever moving money in the
// apply step. The money-critical assertion is the cancel: a paid buyer gets a
// refund REQUEST (settled later through the guarded refund path), the business
// and buyer wallet balances DO NOT move on cancel, and the cancelled event's
// tickets stop scanning in.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/event-change-requests-live.js
//
// Seeds its own throwaway accounts and deletes them at the end.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
// Stub the notification transports before ticketing-service destructures them.
const notif = require("../api/src/services/notification-service");
const outbox = [];
notif.deliverEmail = async (args) => { outbox.push({ channel: "email", ...args }); return { id: `stub-${outbox.length}` }; };
notif.deliverSms = async (args) => { outbox.push({ channel: "sms", ...args }); return { id: `stub-${outbox.length}` }; };
const ticketing = require("../api/src/services/ticketing-service");

const TAG = "ecrlive";
const ids = {
  biz: randomUUID(), buyer: randomUUID(), merchant: randomUUID(),
  bizWallet: randomUUID(), buyerWallet: randomUUID(), admin: randomUUID()
};
const ADMIN = { userId: ids.admin };

const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

async function bal(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return Number(rows[0]?.available_balance || 0);
}

async function seed() {
  await ticketing.ensureTicketingSchema();
  // A FULLY VERIFIED business — it must be able to sell paid tickets.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Live Co','${TAG}_biz','${TAG}_biz@example.invalid','27110000201','x','active',FALSE,'approved')`,
    [ids.biz]);
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,'${TAG} Live Co','MID-${TAG}','active','verified')`,
    [ids.merchant, ids.biz]);
  // A small starting float, as a real trading business would hold — so a refund
  // (business net share + the small processing fee) is affordable.
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',200,0,'active')`,
    [ids.bizWallet, String(Date.now()).slice(-9), ids.biz]);
  // A buyer with enough balance to buy a paid ticket.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal','${TAG} Buyer','${TAG}_buyer','${TAG}_buyer@example.invalid','27110000202','x','active',FALSE,'approved')`,
    [ids.buyer]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',500,0,'active')`,
    [ids.buyerWallet, String(Date.now() + 1).slice(-9), ids.buyer]);
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     VALUES ($1,'${TAG} Admin','${TAG}_admin','${TAG}_admin@example.invalid','super_admin','x')`,
    [ids.admin]);
}

async function cleanup() {
  const events = (await pool.query("SELECT id FROM events WHERE business_user_id = $1", [ids.biz])).rows.map((r) => r.id);
  for (const e of events) {
    await pool.query("DELETE FROM ticket_refunds WHERE event_id = $1", [e]).catch(() => {});
    await pool.query("DELETE FROM tickets WHERE event_id = $1", [e]);
    await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [e]);
    await pool.query("DELETE FROM event_change_requests WHERE event_id = $1", [e]).catch(() => {});
    await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [e]);
    await pool.query("DELETE FROM event_approvals WHERE event_id = $1", [e]).catch(() => {});
    await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [e]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id = $1", [e]);
  }
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [[ids.biz, ids.buyer]]).catch(() => {});
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [[ids.bizWallet, ids.buyerWallet]]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[ids.bizWallet, ids.buyerWallet]]);
  await pool.query("DELETE FROM merchants WHERE id = $1", [ids.merchant]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.biz, ids.buyer]]);
  await pool.query("DELETE FROM admin_users WHERE id = $1", [ids.admin]);
}

async function makeApprovedEvent(name, tiers) {
  const draft = await ticketing.createEventDraft(ids.biz, {
    eventName: name, category: "conference", description: "d",
    eventDate: "2027-06-01", startTime: "09:00", endTime: "17:00",
    venueName: "Hall", fullVenueAddress: "1 St", city: "JHB", province: "Gauteng",
    termsConditions: "t", ticketTypes: tiers
  });
  await pool.query("UPDATE events SET status='approved', approved_at=NOW() WHERE id=$1", [draft.id]);
  const slug = (await pool.query("SELECT slug FROM events WHERE id=$1", [draft.id])).rows[0].slug;
  return { id: draft.id, slug };
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  const throws = async (fn, code, re) => {
    try { await fn(); } catch (e) { return e.statusCode === code && (!re || re.test(e.message)); }
    return false;
  };
  try {
    await seed();
    console.log("\n" + "=".repeat(78));
    console.log("  ORGANISER CHANGE REQUESTS + SAFE CANCEL, REAL DATABASE");
    console.log("=".repeat(78));

    // ---- Guard: no change request on a non-approved event -------------------
    const draftOnly = await ticketing.createEventDraft(ids.biz, {
      eventName: `${TAG} Draft`, ticketTypes: [{ ticketName: "General", price: 0, quantityAvailable: 10 }]
    });
    assert.ok(await throws(() => ticketing.requestEventChange({ userId: ids.biz }, draftOnly.id, { requestType: "cancel", reason: "x" }), 409, /already approved/i),
      "a draft event cannot take a change request");
    ok("a non-approved (draft) event refuses a change request (409)");

    // ---- Postpone ----------------------------------------------------------
    const evP = await makeApprovedEvent(`${TAG} Postpone Me`, [{ ticketName: "General", price: 0, quantityAvailable: 50 }]);
    const postReq = await ticketing.requestEventChange({ userId: ids.biz }, evP.id, {
      requestType: "postpone", reason: "Venue clash", requestedChanges: { eventDate: "2027-09-15", startTime: "10:00" }
    });
    assert.equal(postReq.status, "requested");
    ok("organiser raised a postpone request on an approved event");

    // Duplicate open request refused.
    assert.ok(await throws(() => ticketing.requestEventChange({ userId: ids.biz }, evP.id, { requestType: "other", reason: "again" }), 409, /pending change request/i),
      "second open request refused");
    ok("a second open request on the same event is refused (409)");

    // Admin sees it in the queue.
    const queue = await ticketing.listEventChangeRequests({ status: "requested" });
    assert.ok(queue.find((r) => r.id === postReq.id), "the request is in the admin queue");
    ok("the request appears in the admin change-request queue");

    // Admin approves -> date changes, request applied, holder notified is n/a (no buyers).
    outbox.length = 0;
    const appliedPost = await ticketing.processEventChangeRequest(postReq.id, { action: "approve", note: "ok" }, ADMIN);
    assert.equal(appliedPost.status, "applied");
    const newDate = (await pool.query("SELECT TO_CHAR(event_date,'YYYY-MM-DD') AS d, start_time FROM events WHERE id=$1", [evP.id])).rows[0];
    assert.equal(newDate.d, "2027-09-15", `date should move, got ${newDate.d}`);
    assert.equal(newDate.start_time, "10:00");
    assert.ok(outbox.some((m) => /change request approved/i.test(m.subject || "")), "organiser told it was approved");
    ok("admin approved the postpone: event date moved to 2027-09-15, organiser notified");

    // ---- Update details (ticket types must be untouched) -------------------
    const evU = await makeApprovedEvent(`${TAG} Update Me`, [{ ticketName: "General", price: 0, quantityAvailable: 40 }]);
    const typeBefore = (await pool.query("SELECT id, quantity_sold FROM event_ticket_types WHERE event_id=$1", [evU.id])).rows[0];
    const updReq = await ticketing.requestEventChange({ userId: ids.biz }, evU.id, {
      requestType: "update_details", reason: "typo", requestedChanges: { description: "A corrected description", venueName: "New Hall" }
    });
    await ticketing.processEventChangeRequest(updReq.id, { action: "approve" }, ADMIN);
    const evURow = (await pool.query("SELECT description, venue_name FROM events WHERE id=$1", [evU.id])).rows[0];
    assert.equal(evURow.description, "A corrected description");
    assert.equal(evURow.venue_name, "New Hall");
    const typeAfter = (await pool.query("SELECT id, quantity_sold FROM event_ticket_types WHERE event_id=$1", [evU.id])).rows[0];
    assert.equal(typeAfter.id, typeBefore.id, "ticket type row must be the SAME (not deleted/recreated)");
    ok("admin approved an update: details changed, ticket type row untouched (same id)");

    // ---- Decline -----------------------------------------------------------
    const evD = await makeApprovedEvent(`${TAG} Decline Me`, [{ ticketName: "General", price: 0, quantityAvailable: 10 }]);
    const decReq = await ticketing.requestEventChange({ userId: ids.biz }, evD.id, { requestType: "other", reason: "please add a sponsor logo" });
    outbox.length = 0;
    const declined = await ticketing.processEventChangeRequest(decReq.id, { action: "decline", note: "Not possible" }, ADMIN);
    assert.equal(declined.status, "rejected");
    assert.equal((await pool.query("SELECT status FROM events WHERE id=$1", [evD.id])).rows[0].status, "approved", "a declined request changes nothing about the event");
    assert.ok(outbox.some((m) => /declined/i.test(m.subject || "")), "organiser told it was declined");
    ok("a declined request rejects cleanly and leaves the event unchanged");

    // ---- Cancel (the money-critical path) ----------------------------------
    const evC = await makeApprovedEvent(`${TAG} Cancel Me`, [
      { ticketName: "General", price: 0, quantityAvailable: 50 },
      { ticketName: "VIP", price: 100, quantityAvailable: 50 }
    ]);
    const tiers = (await pool.query("SELECT id, ticket_name FROM event_ticket_types WHERE event_id=$1", [evC.id])).rows;
    const vip = tiers.find((t) => t.ticket_name === "VIP");
    const general = tiers.find((t) => t.ticket_name === "General");

    // Buyer buys 1 paid VIP and 1 free General.
    const buyerStart = await bal(ids.buyerWallet);
    const bizStart = await bal(ids.bizWallet);
    await ticketing.purchaseTickets({ userId: ids.buyer }, evC.slug, { ticketTypeId: vip.id, quantity: 1, buyerDetails: { name: "B" } });
    await ticketing.purchaseTickets({ userId: ids.buyer }, evC.slug, { ticketTypeId: general.id, quantity: 1, buyerDetails: { name: "B" } });
    const paidOrderId = (await pool.query("SELECT id FROM ticket_orders WHERE event_id=$1 AND ticket_type_id=$2 LIMIT 1", [evC.id, vip.id])).rows[0].id;
    const buyerAfterBuy = await bal(ids.buyerWallet);
    const bizAfterBuy = await bal(ids.bizWallet);
    assert.ok(buyerAfterBuy < buyerStart, "buyer paid for the VIP ticket");
    assert.ok(bizAfterBuy > bizStart, "business received the VIP net");
    ok(`buyer bought 1 paid VIP + 1 free General (buyer R${buyerAfterBuy}, business R${bizAfterBuy})`);

    // Organiser requests cancel; admin approves.
    outbox.length = 0;
    const cancelReq = await ticketing.requestEventChange({ userId: ids.biz }, evC.id, { requestType: "cancel", reason: "Speaker withdrew" });
    const cancelApplied = await ticketing.processEventChangeRequest(cancelReq.id, { action: "approve" }, ADMIN);
    assert.equal(cancelApplied.status, "applied");

    // Event cancelled, tickets invalidated.
    assert.equal((await pool.query("SELECT status FROM events WHERE id=$1", [evC.id])).rows[0].status, "cancelled");
    const validLeft = (await pool.query("SELECT COUNT(*)::int c FROM tickets WHERE event_id=$1 AND status='valid'", [evC.id])).rows[0].c;
    assert.equal(validLeft, 0, "no ticket stays valid after cancel");
    ok("cancel applied: event is cancelled and all tickets invalidated");

    // MONEY DID NOT MOVE on cancel — only a refund request was opened.
    const buyerAfterCancel = await bal(ids.buyerWallet);
    const bizAfterCancel = await bal(ids.bizWallet);
    assert.equal(buyerAfterCancel, buyerAfterBuy, "buyer balance unchanged by the cancel itself");
    assert.equal(bizAfterCancel, bizAfterBuy, "business balance unchanged by the cancel itself");
    const refunds = (await pool.query("SELECT id, status, order_id FROM ticket_refunds WHERE event_id=$1", [evC.id])).rows;
    assert.equal(refunds.length, 1, `exactly one refund request (paid order only), got ${refunds.length}`);
    assert.equal(refunds[0].status, "requested");
    assert.equal(refunds[0].order_id, paidOrderId, "the refund request is for the PAID order");
    ok("cancel moved NO money; opened exactly one refund request, for the paid order only");

    // Buyer was notified.
    assert.ok(outbox.some((m) => /cancelled/i.test(m.subject || "")), "buyer told the event was cancelled");
    ok("ticket holder was notified of the cancellation");

    // Scanning a cancelled event's ticket is refused.
    const someCode = (await pool.query("SELECT ticket_code FROM tickets WHERE event_id=$1 LIMIT 1", [evC.id])).rows[0].ticket_code;
    const scan = await ticketing.scanTicket({ userId: ids.biz }, { ticketCode: someCode });
    assert.equal(scan.valid, false);
    assert.equal(scan.status, "event_cancelled");
    ok("a cancelled event's ticket is refused at the door (event_cancelled)");

    // State machine: you cannot approve a cancelled event.
    assert.ok(await throws(() => ticketing.adminTransitionEvent(evC.id, { action: "approve" }, ADMIN), 409, /cannot approve/i),
      "approving a cancelled event is refused");
    ok("state-machine guard holds: a cancelled event cannot be approved/reinstated");

    // The now-open refund request settles through the guarded path only when
    // admin approves it — and it reverses the sale cleanly: the buyer gets the
    // full subtotal (R100) back, and the business is debited only its net share
    // (R88) plus the small refund fee, NOT the whole subtotal. The commission is
    // reversed from the platform, so the business is never made to pay back money
    // it never received.
    const buyerBeforeRefund = await bal(ids.buyerWallet);
    const bizBeforeRefund = await bal(ids.bizWallet);
    await ticketing.processTicketRefund(refunds[0].id, { action: "approve" }, ADMIN);
    const buyerAfterRefund = await bal(ids.buyerWallet);
    const bizAfterRefund = await bal(ids.bizWallet);
    assert.equal(money(buyerAfterRefund - buyerBeforeRefund), 100, `buyer refunded the full R100 subtotal, got R${money(buyerAfterRefund - buyerBeforeRefund)}`);
    const bizPaid = money(bizBeforeRefund - bizAfterRefund);
    assert.ok(bizPaid < 100, `business must NOT be debited the full subtotal; it paid R${bizPaid} (its net share + fee), not R100+`);
    ok(`refund settles cleanly: buyer +R100, business only -R${bizPaid} (its net share + fee, commission reversed from platform)`);

    console.log("\n" + "=".repeat(78));
    console.log(`  ALL ${passed} CHECKS PASSED — change requests work, and cancel never mishandles money.`);
    console.log("=".repeat(78) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
})();
