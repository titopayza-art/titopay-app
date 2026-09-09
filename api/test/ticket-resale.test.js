"use strict";

// TICKET RESALE: SOMEBODY WHO CANNOT GO SELLS TO SOMEBODY WHO CAN.
//
// Resale is the piece of ticketing that is a MONEY path, so it is held to the
// money rules rather than the feature rules. Three questions decide whether it
// is safe, and every test here is one of them:
//
//   1. Can a buyer pay and not get the ticket, or get the ticket and not pay?
//      No — and not because the code is careful. The buyer's wallet, the
//      seller's wallet and the ticket's owner are all in one database, so the
//      debit, the credit and the change of ownership are ONE TRANSACTION. They
//      commit together or not at all. This is also why there is no escrow: an
//      escrow exists to bridge an interval between paying and receiving, and
//      here there is no interval to bridge. Nothing is held, so nothing can be
//      stranded by a release that never runs.
//
//   2. Can one ticket be sold to two people? No. The listing row is locked FOR
//      UPDATE before anything settles, and a unique partial index allows one
//      open listing per ticket. The second buyer is told it has gone, and
//      their money is untouched.
//
//   3. Can resale become touting? No. A ticket may never be listed above what
//      was actually paid for it, checked when it is listed AND again when it
//      is bought, so a listing cannot outlive the rule that allowed it.
//
// The organiser's transfer_allowed setting gates resale exactly as it gates
// gifting. An organiser who said a ticket stays with its buyer said that about
// money changing hands especially.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { pool } = require("../src/db/pool");
const ticketing = require("../src/services/ticketing-service");

async function makeUser(name, balance = 0) {
  const id = crypto.randomUUID();
  const tag = "rs-" + id.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash, email, status)
     VALUES ($1,'personal',$2,$3,'x',$4,'active')`,
    [id, name, tag, tag + "@example.test"]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, available_balance, status)
     VALUES ($1,$2,'personal','ZAR',$3,'active')`,
    [crypto.randomUUID(), id, balance]);
  return id;
}

const balanceOf = async (userId) =>
  Number((await pool.query("SELECT available_balance FROM wallets WHERE user_id = $1", [userId])).rows[0].available_balance);

const ownerOf = async (ticketId) =>
  (await pool.query("SELECT owner_user_id FROM tickets WHERE id = $1", [ticketId])).rows[0].owner_user_id;

// One event, one paid ticket in a holder's account: the smallest world in
// which a resale can be attempted.
async function makeSoldTicket({ organiserId, ownerId, price = 200, transferAllowed = true, status = "valid" }) {
  await ticketing.ensureTicketingSchema();
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, slug, event_name, category, venue_name, event_date, status)
     VALUES ($1,$2,$3,'Resale Show','music','Test Arena',CURRENT_DATE + 30,'approved')`,
    [eventId, organiserId, "resale-" + eventId.slice(0, 8)]);
  const typeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, transfer_allowed)
     VALUES ($1,$2,'General Admission',$3,100,$4)`,
    [typeId, eventId, price, transferAllowed]);
  const orderId = crypto.randomUUID();
  // subtotal / quantity is the face value the cap is drawn from, so it is set
  // to what one ticket actually cost.
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,$5,1,$6,$6,'paid')`,
    [orderId, eventId, typeId, ownerId, "RS-" + orderId.slice(0, 8), price]);
  const ticketId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ticketId, orderId, eventId, typeId, ownerId,
      String(Math.floor(1000000 + Math.random() * 8999999)), status]);
  return { eventId, typeId, orderId, ticketId };
}

async function cleanup(eventId, userIds) {
  await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM ticket_listings WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => null);
  for (const id of userIds || []) {
    await pool.query("DELETE FROM event_audit_logs WHERE actor_id = $1", [id]).catch(() => null);
    await pool.query("DELETE FROM notifications WHERE user_id = $1", [id]).catch(() => null);
    await pool.query(
      "DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [id]).catch(() => null);
    await pool.query("DELETE FROM transactions WHERE user_id = $1", [id]).catch(() => null);
    await pool.query("DELETE FROM wallets WHERE user_id = $1", [id]).catch(() => null);
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => null);
  }
}

test("a ticket sells: the money moves both ways and the ticket moves once", async () => {
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const buyer = await makeUser("Buyer", 500);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    const listing = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 180 });
    assert.equal(listing.status, "open");
    assert.equal(listing.price, 180);

    const purchase = await ticketing.buyTicketListing({ userId: buyer }, listing.id);
    assert.equal(purchase.price, 180);

    // The buyer paid exactly what the listing said. No fee appeared at the
    // last step: TitoPay's commission comes off the seller's side.
    assert.equal(await balanceOf(buyer), 320, "500 less the 180 on the listing");
    // The seller received the price less the 10% resale commission.
    assert.equal(await balanceOf(seller), 162, "180 less R18 commission");
    assert.equal(await ownerOf(ticketId), buyer, "and the ticket is the buyer's");

    const { rows } = await pool.query(
      "SELECT status, buyer_user_id FROM ticket_listings WHERE id = $1", [listing.id]);
    assert.equal(rows[0].status, "sold");
    assert.equal(rows[0].buyer_user_id, buyer);

    // THE LEDGER BALANCES. Asserted rather than reasoned about: what left the
    // buyer must equal what reached the seller plus what TitoPay took, to the
    // cent. If those ever differ the platform is either funding the gap or
    // quietly keeping it, and both are the kind of error that only shows up in
    // a month-end reconciliation.
    const { rows: postings } = await pool.query(
      `SELECT entry_type, SUM(amount)::numeric AS total
         FROM wallet_ledger WHERE reference LIKE $1 GROUP BY entry_type ORDER BY entry_type`,
      [purchase.reference + "%"]);
    const byType = Object.fromEntries(postings.map((r) => [r.entry_type, Number(r.total)]));
    assert.equal(byType.debit, 180, "the buyer's side");
    assert.equal(byType.credit, 180, "the seller's 162 plus TitoPay's 18");
  } finally {
    await cleanup(eventId, [organiser, seller, buyer]);
  }
});

test("THE SELLER CAN SEE THE MONEY THEY WERE PAID, not just a changed balance", async () => {
  // A wallet posting moves a balance silently. Every reporting query in the
  // app reads the transactions table WHERE user_id = the reader, so a sale
  // written only as the buyer's debit would credit the seller's balance and
  // leave their activity and their statement saying nothing about why the
  // number went up. Both sides are written.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const buyer = await makeUser("Buyer", 500);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    const listing = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 200 });
    await ticketing.buyTicketListing({ userId: buyer }, listing.id);

    const { rows } = await pool.query(
      "SELECT direction, amount, fee, total, service_code FROM transactions WHERE user_id = $1", [seller]);
    assert.equal(rows.length, 1, "the seller has a transaction of their own");
    assert.equal(rows[0].direction, "credit");
    assert.equal(rows[0].service_code, "ticket_resale");
    assert.equal(Number(rows[0].total), 180, "what actually reached them, after commission");

    const { rows: buyerRows } = await pool.query(
      "SELECT direction, total FROM transactions WHERE user_id = $1", [buyer]);
    assert.equal(buyerRows.length, 1);
    assert.equal(buyerRows[0].direction, "debit");
    assert.equal(Number(buyerRows[0].total), 200);
  } finally {
    await cleanup(eventId, [organiser, seller, buyer]);
  }
});

test("TWO BUYERS AT ONCE: one gets the ticket, the other keeps their money", async () => {
  // The question resale has to answer. Both buyers can afford it, both press
  // at the same moment, and there is one ticket.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const first = await makeUser("First", 500);
  const second = await makeUser("Second", 500);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    const listing = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 200 });

    const results = await Promise.allSettled([
      ticketing.buyTicketListing({ userId: first }, listing.id),
      ticketing.buyTicketListing({ userId: second }, listing.id)
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one buyer succeeded");
    assert.equal(lost.length, 1, "and exactly one was refused");
    assert.equal(lost[0].reason.statusCode, 409);
    assert.match(lost[0].reason.message, /already been sold/i);

    // The loser paid nothing. Not "was refunded" — never debited at all.
    const winnerIsFirst = results[0].status === "fulfilled";
    const loser = winnerIsFirst ? second : first;
    const winner = winnerIsFirst ? first : second;
    assert.equal(await balanceOf(loser), 500, "the refused buyer's money never moved");
    assert.equal(await balanceOf(winner), 300);
    assert.equal(await ownerOf(ticketId), winner);
    assert.equal(await balanceOf(seller), 180, "the seller was paid once, not twice");

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ticket_listings WHERE ticket_id = $1 AND status = 'sold'", [ticketId]);
    assert.equal(rows[0].n, 1);
  } finally {
    await cleanup(eventId, [organiser, seller, first, second]);
  }
});

test("a ticket cannot be listed above what was paid for it", async () => {
  // Resale exists so somebody who cannot go gets their money back. Above face
  // value the platform would be running a touting market on its own rails.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    await assert.rejects(
      () => ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 400 }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /more than the R 200\.00 that was paid/i,
          "the refusal names the actual ceiling rather than saying no");
        return true;
      });
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM ticket_listings WHERE ticket_id = $1", [ticketId]);
    assert.equal(rows[0].n, 0, "nothing was listed");

    // At face value exactly, it is allowed.
    const ok = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 200 });
    assert.equal(ok.price, 200);
  } finally {
    await cleanup(eventId, [organiser, seller]);
  }
});

test("the organiser's transfer setting blocks resale, not just gifting", async () => {
  // An organiser who said a ticket stays with the person who bought it said
  // that about money changing hands especially — a non-transferable ticket
  // being sold on is the exact thing that setting exists to prevent.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const { eventId, ticketId } = await makeSoldTicket({
    organiserId: organiser, ownerId: seller, price: 200, transferAllowed: false });
  try {
    await assert.rejects(
      () => ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 100 }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /cannot be resold/i);
        assert.match(error.message, /organiser/i);
        return true;
      });
  } finally {
    await cleanup(eventId, [organiser, seller]);
  }
});

test("a ticket already scanned in at the gate cannot be sold", async () => {
  // Somebody is inside the venue on it. Selling it would take money for
  // an entry that has already been used.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const { eventId, ticketId } = await makeSoldTicket({
    organiserId: organiser, ownerId: seller, price: 200, status: "scanned" });
  try {
    await assert.rejects(
      () => ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 100 }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /already been scanned/i);
        return true;
      });
  } finally {
    await cleanup(eventId, [organiser, seller]);
  }
});

test("a stranger cannot list someone else's ticket", async () => {
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const stranger = await makeUser("Stranger", 0);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    await assert.rejects(
      () => ticketing.listTicketForResale({ userId: stranger }, ticketId, { price: 100 }),
      (error) => {
        // 404, matching the rest of the service: the refusal declines to
        // confirm that the ticket exists.
        assert.equal(error.statusCode, 404);
        return true;
      });
    assert.equal(await ownerOf(ticketId), seller);
  } finally {
    await cleanup(eventId, [organiser, seller, stranger]);
  }
});

test("one open listing per ticket, enforced by the database", async () => {
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 150 });
    await assert.rejects(
      () => ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 100 }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /already listed/i);
        return true;
      });

    // Cancelling frees the ticket to be listed again, at a new price.
    const { rows: open } = await pool.query(
      "SELECT id FROM ticket_listings WHERE ticket_id = $1 AND status = 'open'", [ticketId]);
    await ticketing.cancelTicketListing({ userId: seller }, open[0].id);
    const relisted = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 100 });
    assert.equal(relisted.price, 100);
  } finally {
    await cleanup(eventId, [organiser, seller]);
  }
});

test("a buyer who cannot afford it moves nothing at all", async () => {
  // Not "is refunded". The refusal happens inside the transaction, so no
  // partial state exists at any point: no debit, no credit, no owner change.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const buyer = await makeUser("Buyer", 50);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    const listing = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 200 });
    await assert.rejects(
      () => ticketing.buyTicketListing({ userId: buyer }, listing.id),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /Insufficient balance/i);
        return true;
      });
    assert.equal(await balanceOf(buyer), 50);
    assert.equal(await balanceOf(seller), 0);
    assert.equal(await ownerOf(ticketId), seller, "the ticket did not move");
    const { rows } = await pool.query("SELECT status FROM ticket_listings WHERE id = $1", [listing.id]);
    assert.equal(rows[0].status, "open", "and the listing is still for sale");
    const { rows: tx } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = ANY($1)", [[buyer, seller]]);
    assert.equal(tx[0].n, 0, "no transaction row was written by the failed attempt");
  } finally {
    await cleanup(eventId, [organiser, seller, buyer]);
  }
});

test("a seller cannot buy their own listing", async () => {
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 500);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    const listing = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 200 });
    await assert.rejects(
      () => ticketing.buyTicketListing({ userId: seller }, listing.id),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /your own listing/i);
        return true;
      });
    assert.equal(await balanceOf(seller), 500, "no money went in a circle through the commission");
  } finally {
    await cleanup(eventId, [organiser, seller]);
  }
});

test("gifting a listed ticket withdraws the listing", async () => {
  // The sale would refuse anyway, because buying re-checks that the seller
  // still owns the ticket. But an offer standing against a ticket that has
  // left the seller's account advertises something nobody can buy.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const friend = await makeUser("Friend", 0);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    const listing = await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 200 });
    const { rows: codeRows } = await pool.query("SELECT ticket_code FROM tickets WHERE id = $1", [ticketId]);
    await ticketing.claimTicketByCode({ userId: friend }, codeRows[0].ticket_code, {});

    const { rows } = await pool.query("SELECT status FROM ticket_listings WHERE id = $1", [listing.id]);
    assert.equal(rows[0].status, "cancelled");
    assert.equal(await ownerOf(ticketId), friend);
  } finally {
    await cleanup(eventId, [organiser, seller, friend]);
  }
});

test("the listing browse does not name the seller", async () => {
  // A resale runs on the platform's rails. It is not an introduction between
  // two customers, and a public list of who is selling what is a privacy leak
  // with no purpose.
  const organiser = await makeUser("Organiser");
  const seller = await makeUser("Seller", 0);
  const { eventId, ticketId } = await makeSoldTicket({ organiserId: organiser, ownerId: seller, price: 200 });
  try {
    await ticketing.listTicketForResale({ userId: seller }, ticketId, { price: 150 });
    const items = await ticketing.browseTicketListings(eventId);
    assert.equal(items.length, 1);
    assert.equal(items[0].price, 150);
    const serialised = JSON.stringify(items[0]);
    assert.ok(!/Seller/.test(serialised), "the seller's name is not in the listing");
    assert.ok(!serialised.includes(seller) || !("sellerName" in items[0]),
      "no seller identity beyond the id the service needs internally");
    assert.equal("ticketCode" in items[0], false,
      "and the ticket code is not published — it is what claims the ticket");
  } finally {
    await cleanup(eventId, [organiser, seller]);
  }
});
