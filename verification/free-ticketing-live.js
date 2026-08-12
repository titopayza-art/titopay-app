"use strict";

// FREE TICKETING, PROVEN AGAINST A REAL DATABASE.
//
// The unit tests hold the gate function to its rule. This proves the whole
// thing end to end on real tables: an unverified business creating a free
// event, that event going live, a customer with ZERO balance getting a free
// ticket, and — the line that matters — no money moving anywhere while it
// happens. Then it proves the other half: the same unverified business is
// refused the moment it asks for a paid ticket.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/free-ticketing-live.js
//
// It seeds its own throwaway accounts and deletes them at the end. No existing
// data is touched. Money figures are read straight from the wallets ledger.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
// Stub the mail TRANSPORT before ticketing-service loads and destructures it,
// so the email test proves the ticket path without a real email provider. Only
// the send is faked; ownership, validation and the address it targets are real.
const notif = require("../api/src/services/notification-service");
const outbox = [];
notif.deliverEmail = async (args) => { outbox.push(args); return { id: `stub-${outbox.length}` }; };
const ticketing = require("../api/src/services/ticketing-service");

const TAG = "freetixlive";
const ids = { businessUser: randomUUID(), buyerUser: randomUUID(), merchant: randomUUID(), bizWallet: randomUUID(), buyerWallet: randomUUID() };

async function balance(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return Number(rows[0]?.available_balance || 0);
}

async function seed() {
  await ticketing.ensureTicketingSchema();
  // An UNVERIFIED business: active and registered, but fica_status pending and
  // no approved merchant verification. Exactly the account the feature is for.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Seminars Ltd','${TAG}_biz','${TAG}_biz@example.invalid','27110000001','x','active',FALSE,'pending')`,
    [ids.businessUser]
  );
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,'${TAG} Seminars Ltd','${TAG}${Date.now().toString().slice(-6)}','active','pending')`,
    [ids.merchant, ids.businessUser]
  );
  // A business wallet exists from registration, but this business is NOT FICA
  // verified — the wallet's existence must not be mistaken for permission.
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`,
    [ids.bizWallet, String(Date.now()).slice(-9), ids.businessUser]
  );
  // A buyer with an EMPTY wallet. If free tickets are truly free, an empty
  // wallet must still be able to claim one.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal','${TAG} Attendee','${TAG}_buyer','${TAG}_buyer@example.invalid','27110000002','x','active',FALSE,'approved')`,
    [ids.buyerUser]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',0,0,'active')`,
    [ids.buyerWallet, String(Date.now() + 1).slice(-9), ids.buyerUser]
  );
}

async function cleanup() {
  // Children first. Everything is tagged or linked to the two seeded users.
  const events = (await pool.query("SELECT id FROM events WHERE business_user_id = $1", [ids.businessUser])).rows.map((r) => r.id);
  for (const eventId of events) {
    await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]);
    await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
  }
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [[ids.businessUser, ids.buyerUser]]).catch(() => {});
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [[ids.bizWallet, ids.buyerWallet]]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[ids.bizWallet, ids.buyerWallet]]);
  await pool.query("DELETE FROM merchants WHERE id = $1", [ids.merchant]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.businessUser, ids.buyerUser]]);
}

const freeEvent = {
  eventName: `${TAG} Fintech Conference`,
  category: "conference",
  description: "A free industry seminar.",
  eventDate: "2027-01-15", startTime: "09:00", endTime: "17:00",
  venueName: "Sandton Convention Centre", fullVenueAddress: "161 Maude St", city: "Johannesburg", province: "Gauteng",
  termsConditions: "Standard terms.", refundPolicy: { summary: "No refunds needed — free event." },
  ticketTypes: [{ ticketName: "Free Seat", price: 0, quantityAvailable: 100 }]
};

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    await seed();
    console.log("\n" + "=".repeat(78));
    console.log("  FREE TICKETING, UNVERIFIED BUSINESS, REAL DATABASE");
    console.log("=".repeat(78));

    // 1. An unverified business creates a FREE event draft.
    const draft = await ticketing.createEventDraft(ids.businessUser, freeEvent);
    assert.ok(draft.id, "free draft should be created");
    ok("unverified business created a free event draft");

    // 2. The same business is REFUSED a paid ticket.
    let paidRefused = false;
    try {
      await ticketing.createEventDraft(ids.businessUser, { ...freeEvent, eventName: `${TAG} Paid`, ticketTypes: [{ ticketName: "VIP", price: 500, quantityAvailable: 10 }] });
    } catch (error) {
      paidRefused = error.statusCode === 403 && /FICA/i.test(error.message);
    }
    assert.ok(paidRefused, "a paid event by an unverified business must be refused with a FICA 403");
    ok("the same business was refused a PAID event (FICA required)");

    // 3. Submit the free event, still unverified.
    await ticketing.submitEvent(ids.businessUser, draft.id);
    const submitted = (await pool.query("SELECT status FROM events WHERE id = $1", [draft.id])).rows[0].status;
    assert.equal(submitted, "submitted", "free event should submit without FICA");
    ok("unverified business submitted the free event for review");

    // Move the event live so tickets can be claimed. Done via SQL because
    // adminTransitionEvent needs a real admin_users FK, and admin approval is
    // not what this harness is proving.
    await pool.query("UPDATE events SET status='approved', approved_at=NOW() WHERE id=$1", [draft.id]);
    const slug = (await pool.query("SELECT slug FROM events WHERE id = $1", [draft.id])).rows[0].slug;

    // 4. The free ticket preview costs nothing.
    const preview = await ticketing.ticketPurchasePreview(slug, { quantity: 2 });
    assert.equal(preview.total, 0, `free ticket total should be 0, was ${preview.total}`);
    assert.equal(preview.buyerFee, 0, `free ticket buyer fee should be 0, was ${preview.buyerFee}`);
    assert.equal(preview.businessNet, 0, "business receives nothing from a free ticket");
    ok(`free ticket preview is R0 (buyer fee R${preview.buyerFee}, was a flat R10 before)`);

    // 5. A buyer with ZERO balance claims two free tickets, and NO money moves.
    const bizBefore = await balance(ids.bizWallet);
    const buyerBefore = await balance(ids.buyerWallet);
    const order = await ticketing.purchaseTickets({ userId: ids.buyerUser }, slug, { quantity: 2, buyerDetails: { name: "Attendee" } });
    const bizAfter = await balance(ids.bizWallet);
    const buyerAfter = await balance(ids.buyerWallet);

    assert.equal(buyerBefore, 0, "buyer started with nothing");
    assert.equal(buyerAfter, 0, "an empty-wallet buyer still pays nothing");
    assert.equal(bizAfter, bizBefore, "the business balance must be unchanged by a free sale");
    ok(`empty-wallet buyer claimed 2 free tickets; buyer R${buyerAfter}, business R${bizAfter} (unchanged)`);

    const ticketCount = (await pool.query("SELECT COUNT(*)::int AS c FROM tickets WHERE order_id = $1", [order.orderId || order.id || order.order?.id])).rows[0]?.c;
    // Some return shapes differ; fall back to counting by event.
    const issued = ticketCount || (await pool.query("SELECT COUNT(*)::int AS c FROM tickets WHERE event_id = $1", [draft.id])).rows[0].c;
    assert.equal(issued, 2, `two valid tickets should exist, found ${issued}`);
    ok(`${issued} valid tickets were issued for a R0 order`);

    // 6. No revenue was recorded for the free sale.
    const revenue = (await pool.query("SELECT COALESCE(SUM(fee_collected),0)::numeric AS f FROM revenue_ledger r JOIN transactions t ON t.id = r.transaction_id WHERE t.user_id = $1", [ids.buyerUser])).rows[0].f;
    assert.equal(Number(revenue), 0, "a free sale must record no revenue");
    ok("no revenue-ledger entry was created for the free sale");

    // 7. Emailing a ticket to yourself and to someone else. The purchase also
    // fires an automatic delivery email, so the self-service ones are told apart
    // by their purpose rather than by counting the whole outbox.
    const ticketCode = (await pool.query("SELECT ticket_code FROM tickets WHERE event_id = $1 LIMIT 1", [draft.id])).rows[0].ticket_code;
    const selfService = () => outbox.filter((e) => e.metadata?.purpose === "ticket_self_service_email");

    outbox.length = 0;
    const toSelf = await ticketing.emailTicketToRecipient({ userId: ids.buyerUser }, ticketCode, "");
    assert.equal(selfService().length, 1, "exactly one self-service email should be sent");
    assert.equal(selfService()[0].to, `${TAG}_buyer@example.invalid`, "an empty destination emails the account owner");
    assert.match(selfService()[0].subject, /Fintech Conference/, "the subject names the event");
    assert.match(selfService()[0].body, new RegExp(ticketCode), "the ticket code is in the email");
    ok(`owner emailed their own ticket (to ${toSelf.sentTo}, address masked in the response)`);

    outbox.length = 0;
    await ticketing.emailTicketToRecipient({ userId: ids.buyerUser }, ticketCode, "friend@example.invalid");
    assert.equal(selfService()[0].to, "friend@example.invalid", "a ticket can be emailed to someone else");
    ok("owner emailed the same ticket to a different person");

    // 8. Someone who does NOT own the ticket cannot email it.
    let blocked = false;
    outbox.length = 0;
    try { await ticketing.emailTicketToRecipient({ userId: ids.businessUser }, ticketCode, ""); }
    catch (error) { blocked = error.statusCode === 404; }
    assert.ok(blocked, "a non-owner must get a 404, and never a sent email");
    assert.equal(selfService().length, 0, "no email is sent for a ticket the caller does not own");
    ok("a non-owner was refused (404) and no email left the system");

    // 9. A malformed destination is rejected, not silently redirected to self.
    let rejected = false;
    outbox.length = 0;
    try { await ticketing.emailTicketToRecipient({ userId: ids.buyerUser }, ticketCode, "not-an-email"); }
    catch (error) { rejected = error.statusCode === 400; }
    assert.ok(rejected, "an invalid email must be a 400");
    assert.equal(selfService().length, 0, "nothing is sent when the address is invalid");
    ok("an invalid destination was rejected (400), nothing sent");

    console.log("\n" + "=".repeat(78));
    console.log(`  ALL ${passed} CHECKS PASSED — free events work without FICA, and stay free.`);
    console.log("=".repeat(78) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
})();
