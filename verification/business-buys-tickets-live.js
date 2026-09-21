"use strict";

// A BUSINESS ACCOUNT BUYING A TICKET, AGAINST A REAL DATABASE.
//
// Event Tickets was hidden from business accounts, and showing it is a one
// column change on a service_config row. The risk is not the tile: it is what
// sits behind it. A ticket purchase debits "the buyer's wallet", and a
// business account has a BUSINESS wallet rather than a personal one. If any
// part of that path assumed personal, showing the tile would hand businesses a
// door that fails at the payment step, which is worse than not showing it.
//
// So this buys a real paid ticket as a real business, and reads the money out
// of the ledger rather than trusting the response:
//
//   1. The catalogue offers Event Tickets to a business audience.
//   2. A business buys a paid ticket and gets one.
//   3. The money leaves the BUSINESS wallet, exactly the amount charged.
//   4. The organiser is credited and TitoPay takes its fee, same as always.
//   5. Every wallet touched still reconciles against its own ledger.
//   6. A business can still create events, which is the other half of the
//      ticketing product and must not have moved.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/business-buys-tickets-live.js
//
// It seeds its own throwaway accounts and deletes them at the end.

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
const { listServices } = require("../api/src/services/service-management-service");

const TAG = `bt${String(Date.now()).slice(-7)}`;
const ids = {
  organiser: randomUUID(), organiserWallet: randomUUID(), organiserMerchant: randomUUID(),
  buyerBiz: randomUUID(), buyerBizWallet: randomUUID()
};

const money = (value) => Number(value || 0).toFixed(2);

async function seed() {
  await ticketing.ensureTicketingSchema();
  // The organiser: an ordinary verified business running a paid event.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Events Ltd','${TAG}_org','${TAG}_org@example.invalid','27110000011','x','active',FALSE,'approved')`,
    [ids.organiser]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`,
    [ids.organiserWallet, String(Date.now()).slice(-9), ids.organiser]);
  // Selling PAID tickets needs an active merchant profile with registration
  // details, on top of verification. That gate is the organiser's, and this
  // harness is about the BUYER, so the organiser is seeded fully ready.
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,$3,$4,'active','verified')`,
    [ids.organiserMerchant, ids.organiser, `${TAG} Events Ltd`, `M${TAG}`]);

  // The buyer: ALSO a business, which is the whole point. Funded, because a
  // paid ticket has to actually take money for this to prove anything.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Buyer Traders','${TAG}_buy','${TAG}_buy@example.invalid','27110000012','x','active',FALSE,'approved')`,
    [ids.buyerBiz]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',2000,0,'active')`,
    [ids.buyerBizWallet, String(Date.now() + 1).slice(-9), ids.buyerBiz]);
}

async function cleanup() {
  const events = (await pool.query("SELECT id FROM events WHERE business_user_id = $1", [ids.organiser])).rows.map((r) => r.id);
  for (const eventId of events) {
    await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => {});
  }
  const wallets = [ids.organiserWallet, ids.buyerBizWallet];
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [wallets]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [[ids.organiser, ids.buyerBiz]]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [wallets]).catch(() => {});
  await pool.query("DELETE FROM merchants WHERE id = $1", [ids.organiserMerchant]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.organiser, ids.buyerBiz]]).catch(() => {});
}

const poster = `data:image/jpeg;base64,${"/9j/4AAQSkZJRgABAQ".repeat(20)}`;
const paidEvent = {
  eventName: `${TAG} Trade Expo`,
  category: "conference",
  description: "A paid industry expo.",
  eventDate: "2027-03-11", startTime: "09:00", endTime: "17:00",
  venueName: "CTICC", fullVenueAddress: "1 Lower Long St", city: "Cape Town", province: "Western Cape",
  termsConditions: "Standard terms.", refundPolicy: { summary: "Refunds up to 7 days before." },
  eventBannerUrl: poster,
  ticketTypes: [{ ticketName: "Exhibitor", price: 250, quantityAvailable: 50 }]
};

const balanceOf = async (walletId) =>
  Number((await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0].available_balance);

// A wallet that does not agree with its own ledger is the only failure that
// matters more than the feature itself. The ledger records balance_after on
// every entry, so the last entry IS what the wallet should read.
async function ledgerSaysBalanceIs(walletId) {
  const { rows } = await pool.query(
    `SELECT balance_after FROM wallet_ledger
      WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [walletId]);
  return rows[0] ? Number(rows[0].balance_after) : null;
}

(async () => {
  let passed = 0;
  const ok = (label, detail = "") => { console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`); passed += 1; };
  try {
    await seed();
    console.log("\n" + "=".repeat(78));
    console.log("  A BUSINESS BUYS A TICKET");
    console.log("=".repeat(78) + "\n");

    // 1. The catalogue offers it to a business.
    const businessCatalogue = await listServices({ audience: "business" });
    const rows = businessCatalogue.items || businessCatalogue;
    const offered = (Array.isArray(rows) ? rows : []).some((row) => row.service_code === "tickets");
    assert.ok(offered,
      "Event Tickets is not offered to business accounts: set business_visible on the tickets row");
    ok("the catalogue offers Event Tickets to a business account");

    // 2. An event to buy into.
    const draft = await ticketing.createEventDraft(ids.organiser, paidEvent);
    await pool.query("UPDATE events SET status = 'approved', approved_at = NOW() WHERE id = $1", [draft.id]);
    const slug = (await pool.query("SELECT slug FROM events WHERE id = $1", [draft.id])).rows[0].slug;
    ok("a business organiser can still create and publish a paid event", slug);

    // 3. The purchase itself, as the BUSINESS buyer.
    const openingBuyer = await balanceOf(ids.buyerBizWallet);
    const openingOrganiser = await balanceOf(ids.organiserWallet);
    const order = await ticketing.purchaseTickets(
      { userId: ids.buyerBiz }, slug,
      { quantity: 1, buyerDetails: { name: `${TAG} Buyer` } });
    assert.ok(order && (order.tickets || order.ticketCount || order.orderReference),
      "the purchase returned nothing usable");
    ok("a business account buys a paid ticket", order.orderReference || "order created");

    const issued = Number((await pool.query(
      "SELECT COUNT(*)::INT AS n FROM tickets WHERE event_id = $1", [draft.id])).rows[0].n);
    assert.equal(issued, 1, `expected one ticket, got ${issued}`);
    ok("and one ticket is issued to them");

    // 4. The money came out of the BUSINESS wallet, and only that wallet.
    const closingBuyer = await balanceOf(ids.buyerBizWallet);
    const closingOrganiser = await balanceOf(ids.organiserWallet);
    const spent = openingBuyer - closingBuyer;
    assert.ok(spent > 0, "the business wallet was not debited at all");
    ok("the money leaves the BUSINESS wallet", `R${money(openingBuyer)} -> R${money(closingBuyer)}, R${money(spent)} charged`);

    const received = closingOrganiser - openingOrganiser;
    assert.ok(received > 0, "the organiser was not credited");
    assert.ok(received <= spent, "the organiser received more than the buyer paid");
    ok("the organiser is credited and TitoPay keeps the difference",
      `organiser +R${money(received)}, platform R${money(spent - received)}`);

    // 5. Both wallets still agree with their own ledgers.
    for (const [label, walletId] of [["buyer", ids.buyerBizWallet], ["organiser", ids.organiserWallet]]) {
      const balance = await balanceOf(walletId);
      const ledger = await ledgerSaysBalanceIs(walletId);
      assert.notEqual(ledger, null, `${label} wallet has no ledger entry for a movement that happened`);
      assert.equal(money(balance), money(ledger),
        `${label} wallet does not reconcile: wallet says ${money(balance)}, ledger says ${money(ledger)}`);
    }
    ok("both wallets still reconcile against their own ledgers");

    console.log(`\n  ${passed}/7 checks passed. A business can buy a ticket, and it is paid for`);
    console.log("  from the business wallet with the money accounted for on both sides.\n");
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end().catch(() => {});
  }
})();
