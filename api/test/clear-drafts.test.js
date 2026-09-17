"use strict";

// CLEARING A DRAFT, ON EVERY SURFACE THAT HAS ONE.
//
// The rule these tests pin is one sentence, and it is the same sentence in six
// places: you may clear something you own that has never been used - no money
// in or out, nobody else involved, nothing depending on it.
//
// WHAT THESE TESTS ARE ACTUALLY FOR. The easy half - "clearing a fresh draft
// works" - would pass on a plain DELETE with no rules in it at all. It is the
// REFUSALS that carry the whole value here, because the failure this feature
// invites is a customer tidying up their screen and taking a record with them:
// a stokvel somebody contributed to, an event with tickets sold, a product
// with a month of stock takes behind it. So every surface below is tested in
// pairs, and the refusing half of each pair is the one that matters.
//
// Each refusal is also checked for its 409 and its `not_a_draft` code, because
// the screens read the message straight out of the API. A refusal that came
// back as a 500 with a foreign-key violation in it would still "refuse", and
// would be useless to the person reading it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const { pool } = require("../src/db/pool");
const { assertClearable, blocker, countReferences } = require("../src/lib/clearable");

const TAG = "cleardraft";
const created = [];

async function seedUser(accountType = "business") {
  const id = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE)`,
    [id, accountType, `${TAG} ${suffix}`, `${TAG}_${suffix}`,
      `${TAG}_${suffix}@example.invalid`, `2782${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  created.push(id);
  return { userId: id, accountType, profileLocked: false };
}

// Every refusal is the same shape, so it is asserted in one place: a 409, the
// machine-readable code the screens branch on, and a sentence that names both
// the reason and the way out.
async function refuses(fn, { mentions, alternative }) {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "the clear should have been refused");
  assert.equal(error.statusCode, 409, `a refusal is a 409, got ${error.statusCode}: ${error.message}`);
  assert.equal(error.details?.code || error.code, "not_a_draft",
    `a refusal carries the not_a_draft code, got ${JSON.stringify(error.details || error.code)}`);
  for (const phrase of [].concat(mentions)) {
    assert.match(error.message, phrase, `the refusal should say why: ${error.message}`);
  }
  assert.match(error.message, alternative,
    `a refusal must say what to do instead: ${error.message}`);
  return error;
}

test.after(async () => {
  for (const id of created) {
    await pool.query("DELETE FROM audit_logs WHERE actor_id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
  }
  await pool.end();
});

/* ====================================================== the rule itself */

test("a refusal names EVERY reason, not just the first one it found", () => {
  // A customer told "this has members" who removes them and is then told "it
  // has contributions" has been sent round a loop that could have been one
  // sentence. This is that decision, pinned.
  let thrown = null;
  try {
    assertClearable("stokvel", [
      "R250.00 has already been contributed",
      blocker(2, "somebody else has joined", "{count} other people have joined"),
      null,
      blocker(1, "a withdrawal has been requested", "{count} withdrawals have been requested")
    ], "Close it instead.");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.equal(thrown.message,
    "This stokvel cannot be cleared because R250.00 has already been contributed, "
    + "2 other people have joined and a withdrawal has been requested. Close it instead.");
  assert.equal(thrown.details.reasons.length, 3, "the reasons travel separately too");
});

test("no blockers means no exception, and a zero count is not a blocker", () => {
  assert.equal(blocker(0, "somebody joined"), null);
  assert.equal(blocker(1, "somebody joined", "{count} joined"), "somebody joined");
  assert.equal(blocker(4, "somebody joined", "{count} joined"), "4 joined");
  assert.doesNotThrow(() => assertClearable("thing", [null, null], "Close it."));
});

test("countReferences REFUSES a table or column that is not a plain identifier", async () => {
  // The table and column are interpolated, because an identifier cannot be a
  // bound parameter. This guard is what keeps that structural rather than a
  // promise: no caller can reach a request value into that position, even by
  // accident, because anything that is not a bare identifier is refused before
  // a query is built.
  for (const bad of ["users; DROP TABLE users", "users WHERE 1=1", "'users'", "users--", ""]) {
    await assert.rejects(
      () => countReferences(pool, bad, "id", randomUUID()),
      /not a plain identifier/,
      `"${bad}" must be refused as a table name`);
    await assert.rejects(
      () => countReferences(pool, "users", bad, randomUUID()),
      /not a plain identifier/,
      `"${bad}" must be refused as a column name`);
  }
});

test("countReferences binds its extra conditions rather than interpolating them", async () => {
  // The first version of this helper took only the SQL for the extra condition
  // and the first caller wrote a user id straight into the string. This proves
  // the value goes through the driver: a "value" made entirely of SQL comes
  // back as no matches, not as executed SQL.
  const user = await seedUser("personal");
  const same = await countReferences(pool, "users", "id", user.userId,
    "AND account_type = $2", ["personal"]);
  assert.equal(same, 1);
  const injected = await countReferences(pool, "users", "id", user.userId,
    "AND account_type = $2", ["personal' OR '1'='1"]);
  assert.equal(injected, 0, "the injection attempt is just a string that matches nothing");
});

/* ============================================================== stokvel */

test("a stokvel nobody joined and nobody paid into is cleared", async () => {
  const svc = require("../src/services/stockvel-service");
  const chair = await seedUser("personal");
  const group = await svc.createGroup(chair.userId, { name: "Empty Stokvel", contributionAmount: 100 });

  const result = await svc.clearDraftGroup(chair.userId, group.id);
  assert.deepEqual(result, { cleared: true });

  const { rows } = await pool.query("SELECT 1 FROM stockvel_groups WHERE id = $1", [group.id]);
  assert.equal(rows.length, 0, "the group is gone, not merely marked closed");
});

test("A STOKVEL SOMEBODY ELSE JOINED IS NOT A DRAFT", async () => {
  const svc = require("../src/services/stockvel-service");
  const chair = await seedUser("personal");
  const joiner = await seedUser("personal");
  const group = await svc.createGroup(chair.userId, { name: "Joined Stokvel", contributionAmount: 100 });
  await svc.joinByCode(joiner.userId, group.invite_code);

  await refuses(() => svc.clearDraftGroup(chair.userId, group.id), {
    mentions: /somebody else has joined/,
    alternative: /Close it instead/
  });
  const { rows } = await pool.query("SELECT 1 FROM stockvel_groups WHERE id = $1", [group.id]);
  assert.equal(rows.length, 1, "and the refusal left it exactly where it was");
});

test("only the person who started a stokvel may clear it", async () => {
  const svc = require("../src/services/stockvel-service");
  const chair = await seedUser("personal");
  const joiner = await seedUser("personal");
  const group = await svc.createGroup(chair.userId, { name: "Not Yours", contributionAmount: 50 });
  await svc.joinByCode(joiner.userId, group.invite_code);

  await assert.rejects(() => svc.clearDraftGroup(joiner.userId, group.id), (error) => {
    assert.equal(error.statusCode, 403);
    assert.match(error.message, /Only the person who created this stokvel/);
    return true;
  });
});

/* ====================================================== TitoPro listing */

test("a TitoPro listing that never went live is cleared", async () => {
  const profiles = require("../src/services/titopro-profile-service");
  const pro = await seedUser("personal");
  await profiles.saveProfile(pro, { professions: ["plumber"], headline: "Draft listing", city: "Durban" });

  assert.deepEqual(await profiles.clearDraftProfile(pro), { cleared: true });
  const { rows } = await pool.query("SELECT 1 FROM titopro_profiles WHERE user_id = $1", [pro.userId]);
  assert.equal(rows.length, 0);
});

test("clearing a listing that does not exist is not an error", async () => {
  // Somebody pressing clear twice, or on a screen that was already stale,
  // should not meet a failure for something that is already true.
  const profiles = require("../src/services/titopro-profile-service");
  const nobody = await seedUser("personal");
  const result = await profiles.clearDraftProfile(nobody);
  assert.equal(result.cleared, false);
});

test("A LISTING THAT HAS BEEN LIVE IS NOT A DRAFT AGAIN", async () => {
  const profiles = require("../src/services/titopro-profile-service");
  const pro = await seedUser("personal");
  await profiles.saveProfile(pro, { professions: ["plumber"], headline: "Was live", city: "Durban" });
  // Straight to the state, rather than through publishProfile: publishing needs
  // FICA verification, which is tested where it belongs. What is under test
  // here is that published_at alone ends the draft, even after a pause.
  await pool.query(
    "UPDATE titopro_profiles SET status = 'paused', published_at = NOW() WHERE user_id = $1",
    [pro.userId]);

  await refuses(() => profiles.clearDraftProfile(pro), {
    mentions: /has been live on TitoPro before/,
    alternative: /Pause it instead/
  });
});

test("A LISTING TITOPAY TOOK DOWN CANNOT BE TIDIED AWAY BY THE PERSON TAKEN DOWN", async () => {
  // This is the hole worth closing: clearing the row would erase the record of
  // WHY it came down, and the person with the strongest motive to do that is
  // the one holding the clear button.
  const profiles = require("../src/services/titopro-profile-service");
  const pro = await seedUser("personal");
  await profiles.saveProfile(pro, { professions: ["plumber"], headline: "Taken down", city: "Durban" });
  await pool.query(
    `UPDATE titopro_profiles SET status = 'suspended', admin_action = 'suspended',
            admin_reason = 'complaint' WHERE user_id = $1`, [pro.userId]);

  await refuses(() => profiles.clearDraftProfile(pro), {
    mentions: /TitoPay has taken it down/,
    alternative: /Pause it instead/
  });
  const { rows } = await pool.query(
    "SELECT admin_reason FROM titopro_profiles WHERE user_id = $1", [pro.userId]);
  assert.equal(rows[0].admin_reason, "complaint", "the reason it came down survives");
});

/* ============================================================ Book */

test("a Book service nobody booked is cleared, and one with a booking is not", async () => {
  const catalogue = require("../src/services/book-catalogue-service");
  const owner = await seedUser("business");
  const venueId = randomUUID();
  await pool.query(
    `INSERT INTO book_venues (id, business_user_id, slug, name, category, status, auto_confirm, published_at)
     VALUES ($1,$2,$3,'Clear Test','restaurant','published',TRUE, NOW())`,
    [venueId, owner.userId, `clear-${randomUUID().slice(0, 8)}`]);

  const unused = await catalogue.createService(owner, venueId, { name: "Never booked", durationMinutes: 60 });
  const booked = await catalogue.createService(owner, venueId, { name: "Booked once", durationMinutes: 60 });
  await pool.query(
    `INSERT INTO book_bookings (id, reference, venue_id, service_id, starts_at, ends_at,
                                party_size, customer_name, status)
     VALUES ($1,$2,$3,$4, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 2, 'A Customer', 'confirmed')`,
    [randomUUID(), `BK-${randomUUID().slice(0, 8)}`, venueId, booked.id]);

  assert.deepEqual(await catalogue.clearDraftService(owner, venueId, unused.id), { cleared: true });

  await refuses(() => catalogue.clearDraftService(owner, venueId, booked.id), {
    mentions: /a customer has booked it/,
    alternative: /Switch it off instead/
  });

  // AND THE BOOKING STILL KNOWS WHAT IT WAS FOR. book_bookings.service_id is
  // ON DELETE SET NULL, so a deletion that slipped through would succeed and
  // silently blank the service out of the customer's appointment. That is the
  // actual damage the refusal above prevents, so it is asserted rather than
  // assumed.
  const { rows } = await pool.query("SELECT service_id FROM book_bookings WHERE service_id = $1", [booked.id]);
  assert.equal(rows.length, 1, "the booking still points at its service");

  await pool.query("DELETE FROM book_bookings WHERE venue_id = $1", [venueId]);
  await pool.query("DELETE FROM book_venues WHERE id = $1", [venueId]);
});

test("a Book resource a service still uses is not cleared", async () => {
  const catalogue = require("../src/services/book-catalogue-service");
  const owner = await seedUser("business");
  const venueId = randomUUID();
  await pool.query(
    `INSERT INTO book_venues (id, business_user_id, slug, name, category, status, auto_confirm)
     VALUES ($1,$2,$3,'Resource Test','salon','draft',TRUE)`,
    [venueId, owner.userId, `clear-${randomUUID().slice(0, 8)}`]);

  const spare = await catalogue.createResource(owner, venueId, { name: "Spare chair", capacity: 1 });
  const inUse = await catalogue.createResource(owner, venueId, { name: "Main chair", capacity: 1 });
  await catalogue.createService(owner, venueId,
    { name: "Cut", durationMinutes: 30, resourceIds: [inUse.id] });

  assert.deepEqual(await catalogue.clearDraftResource(owner, venueId, spare.id), { cleared: true });

  // Removing it would take the link with it and leave the service with nothing
  // to be booked into, with no visible reason why. That is the business's
  // decision to make deliberately, not a side effect of tidying up.
  await refuses(() => catalogue.clearDraftResource(owner, venueId, inUse.id), {
    mentions: /a service still uses it/,
    alternative: /take it off those services first/
  });

  await pool.query("DELETE FROM book_venues WHERE id = $1", [venueId]);
});

/* =========================================================== event draft */

test("an event draft is cleared, and one already sent for approval is not", async () => {
  const ticketing = require("../src/services/ticketing-service");
  const owner = await seedUser("business");
  await ticketing.ensureTicketingSchema();

  const makeEvent = async (status) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO events (id, business_user_id, status, slug, event_name, event_date)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE + 30)`,
      [id, owner.userId, status, `clear-${randomUUID().slice(0, 8)}`, `${status} event`]);
    return id;
  };

  const draft = await makeEvent("draft");
  assert.deepEqual(await ticketing.clearDraftEvent(owner, draft), { cleared: true });
  assert.equal((await pool.query("SELECT 1 FROM events WHERE id = $1", [draft])).rows.length, 0);

  // Every status past 'draft' is somebody's decision - a reviewer's approval, a
  // rejection, a cancellation - and none of them is cleared away by the
  // organiser they were about.
  for (const status of ["submitted", "under_review", "approved", "rejected", "cancelled"]) {
    const event = await makeEvent(status);
    await refuses(() => ticketing.clearDraftEvent(owner, event), {
      mentions: /already been sent to TitoPay for approval/,
      alternative: /Cancel it instead/
    });
    await pool.query("DELETE FROM events WHERE id = $1", [event]);
  }
});

test("AN EVENT WITH A TICKET ORDER AGAINST IT IS NEVER CLEARED", async () => {
  const ticketing = require("../src/services/ticketing-service");
  const owner = await seedUser("business");
  const buyer = await seedUser("personal");
  await ticketing.ensureTicketingSchema();

  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, status, slug, event_name, event_date)
     VALUES ($1,$2,'draft',$3,'Sold draft', CURRENT_DATE + 30)`,
    [eventId, owner.userId, `clear-${randomUUID().slice(0, 8)}`]);
  const typeId = randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, quantity_sold)
     VALUES ($1,$2,'General',100,50,1)`, [typeId, eventId]);
  await pool.query(
    `INSERT INTO ticket_orders (id, order_reference, event_id, ticket_type_id, buyer_user_id,
                                quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,$5,1,100,100,'paid')`,
    [randomUUID(), `TO-${randomUUID().slice(0, 8)}`, eventId, typeId, buyer.userId]);

  await refuses(() => ticketing.clearDraftEvent(owner, eventId), {
    mentions: /somebody has ordered a ticket/,
    alternative: /Cancel it instead/
  });

  await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]);
  await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
});

test("one organiser cannot clear another organiser's draft", async () => {
  const ticketing = require("../src/services/ticketing-service");
  const owner = await seedUser("business");
  const stranger = await seedUser("business");
  await ticketing.ensureTicketingSchema();

  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, status, slug, event_name, event_date)
     VALUES ($1,$2,'draft',$3,'Someone elses', CURRENT_DATE + 30)`,
    [eventId, owner.userId, `clear-${randomUUID().slice(0, 8)}`]);

  await assert.rejects(() => ticketing.clearDraftEvent(stranger, eventId), (error) => {
    assert.equal(error.statusCode, 404, "another business's event is simply not found");
    return true;
  });
  assert.equal((await pool.query("SELECT 1 FROM events WHERE id = $1", [eventId])).rows.length, 1);
  await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
});

/* =============================================================== product */

test("a product that was never sold is cleared, and one that was is not", async () => {
  const products = require("../src/services/business-products-service");
  const owner = await seedUser("business");

  const unused = await products.createProduct(owner.userId, { name: "Typed twice", price: 10 });
  const counted = await products.createProduct(owner.userId, { name: "Real stock", price: 10, openingStock: 5 });

  // The opening movement is written by createProduct itself. It is part of
  // typing the product in, not something that happened to it afterwards, so it
  // must NOT count as history.
  assert.deepEqual(await products.clearDraftProduct(owner.userId, counted.id), { cleared: true },
    "opening stock alone does not make a product used");

  await products.recordStockMovement(owner.userId, unused.id,
    { type: "restock", quantity: 3 });
  await refuses(() => products.clearDraftProduct(owner.userId, unused.id), {
    mentions: /stock has been counted or adjusted/,
    alternative: /Archive it instead/
  });
});

test("the sale itself is the blocker the product rule is for", async () => {
  const products = require("../src/services/business-products-service");
  const owner = await seedUser("business");
  const sold = await products.createProduct(owner.userId, { name: "Sold item", price: 25, openingStock: 10 });

  await pool.query(
    `INSERT INTO business_stock_movements (id, product_id, business_user_id, movement_type, quantity_change, quantity_after)
     VALUES ($1,$2,$3,'sale',-1,9)`,
    [randomUUID(), sold.id, owner.userId]);

  await refuses(() => products.clearDraftProduct(owner.userId, sold.id), {
    mentions: /it has been sold once/,
    alternative: /Archive it instead/
  });
});

test("the product list says which products the screen may offer to clear", async () => {
  // The sale screen shows Clear only where this flag is true, so that a
  // destructive button is never offered where it would only ever refuse.
  const products = require("../src/services/business-products-service");
  const owner = await seedUser("business");
  const fresh = await products.createProduct(owner.userId, { name: "Fresh", price: 5 });
  const used = await products.createProduct(owner.userId, { name: "Used", price: 5, openingStock: 2 });
  await products.recordStockMovement(owner.userId, used.id, { type: "restock", quantity: 1 });

  const list = await products.listProducts(owner.userId);
  assert.equal(list.find((item) => item.id === fresh.id).canClear, true);
  assert.equal(list.find((item) => item.id === used.id).canClear, false);
});
