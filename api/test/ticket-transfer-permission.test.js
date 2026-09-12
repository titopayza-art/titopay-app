"use strict";

// THE ORGANISER'S TRANSFER SETTING HAS TO MEAN SOMETHING.
//
// event_ticket_types.transfer_allowed has existed since the table was written.
// It is stored, it is editable in the organiser's ticket form, and the API
// returns it — and until now nothing read it. An organiser who switched
// transfer OFF was shown it as off while anybody holding the ticket code could
// still pull the ticket into their own account through /tickets/claim.
//
// That is worse than not offering the control at all: it is a promise to the
// organiser that the platform quietly was not keeping, on exactly the setting
// a licensed venue, an age-restricted event or a corporate allocation depends
// on.
//
// Both directions are driven here, because a guard that refuses everything
// would pass a test that only checked the refusal.

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
  const tag = "tt-" + id.slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, password_hash, email, status)
     VALUES ($1,'personal',$2,$3,'x',$4,'active')`,
    [id, name, tag, tag + "@example.test"]);
  return id;
}

// One event, one ticket type, one ticket — the smallest world in which the
// question can be asked.
async function makeTicket({ transferAllowed, ownerId, organiserId, code }) {
  // Columns read from the live schema rather than assumed: the organiser is
  // business_user_id, the date is event_date, and slug is NOT NULL.
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, slug, event_name, category, venue_name,
                         event_date, status)
     VALUES ($1,$2,$3,'Transfer Test','music','Test Venue',CURRENT_DATE + 10,'approved')`,
    [eventId, organiserId, "transfer-test-" + eventId.slice(0, 8)]);
  const typeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, transfer_allowed)
     VALUES ($1,$2,'General Admission',100,50,$3)`,
    [typeId, eventId, transferAllowed]);
  const orderId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, status)
     VALUES ($1,$2,$3,$4,$5,1,'paid')`,
    [orderId, eventId, typeId, ownerId, "TT-" + orderId.slice(0, 8)]);
  const ticketId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,'valid')`,
    [ticketId, orderId, eventId, typeId, ownerId, code]);
  return { eventId, typeId, orderId, ticketId };
}

async function cleanup(eventId, userIds) {
  await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => null);
  await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => null);
  for (const id of userIds) {
    await pool.query("DELETE FROM event_audit_logs WHERE actor_id = $1", [id]).catch(() => null);
    await pool.query("DELETE FROM notifications WHERE user_id = $1", [id]).catch(() => null);
    await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => null);
  }
}

const ownerOf = async (ticketId) =>
  (await pool.query("SELECT owner_user_id FROM tickets WHERE id = $1", [ticketId])).rows[0].owner_user_id;

test("a transferable ticket still moves — the guard is not a blanket refusal", async () => {
  const organiser = await makeUser("Organiser");
  const buyer = await makeUser("Buyer");
  const claimant = await makeUser("Claimant");
  const code = String(Math.floor(1000000 + Math.random() * 8999999));
  const { eventId, ticketId } = await makeTicket({ transferAllowed: true, ownerId: buyer, organiserId: organiser, code });
  try {
    const result = await ticketing.claimTicketByCode({ userId: claimant }, code, {});
    assert.ok(result, "the claim returns the ticket");
    assert.equal(await ownerOf(ticketId), claimant, "and the ticket really moved");
  } finally {
    await cleanup(eventId, [organiser, buyer, claimant]);
  }
});

test("a non-transferable ticket does NOT move, and says why", async () => {
  const organiser = await makeUser("Organiser");
  const buyer = await makeUser("Buyer");
  const claimant = await makeUser("Claimant");
  const code = String(Math.floor(1000000 + Math.random() * 8999999));
  const { eventId, ticketId } = await makeTicket({ transferAllowed: false, ownerId: buyer, organiserId: organiser, code });
  try {
    await assert.rejects(
      () => ticketing.claimTicketByCode({ userId: claimant }, code, {}),
      (error) => {
        assert.equal(error.statusCode, 409);
        // The refusal names the organiser's decision rather than implying the
        // code was wrong, because non-transferable is a legitimate choice and
        // the holder has done nothing incorrect.
        assert.match(error.message, /cannot be transferred/i);
        assert.match(error.message, /organiser/i);
        return true;
      });
    assert.equal(await ownerOf(ticketId), buyer, "the ticket stayed with the buyer");
  } finally {
    await cleanup(eventId, [organiser, buyer, claimant]);
  }
});

test("the setting is read from the ticket's own type, not guessed", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
  const claim = source.slice(source.indexOf("async function claimTicketByCode"),
    source.indexOf("async function claimTicketByCode") + 4000);
  assert.match(claim, /JOIN event_ticket_types tt ON tt\.id = t\.ticket_type_id/,
    "the claim joins the ticket's own type");
  assert.match(claim, /if \(!ticket\.transfer_allowed\)/);
  // And the refusal is audited like every other failed claim, so a run of them
  // against one event is visible rather than silent.
  assert.match(claim, /return failClaim\(\s*\n?\s*`\$\{ticket\.ticket_type_name/);
});

test("enforcing the flag does not switch gifting off for everyone", async () => {
  // THE HALF THAT WOULD HAVE BROKEN THE PLATFORM. transfer_allowed defaulted to
  // FALSE and no UI ever sent it, so every ticket type ever created carried
  // false — not by anyone's choice, but because Boolean(undefined) is false and
  // nothing was reading it. Enforcing the column against that data would have
  // revoked gifting from every ticket already sold.
  //
  // So the default now describes the behaviour that has actually been in force,
  // and a tracked migration corrected the existing rows once.
  const { rows } = await pool.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'event_ticket_types' AND column_name = 'transfer_allowed'`);
  assert.equal(rows[0].column_default, "true", "the column defaults to transferable");

  // A ticket type created the way the organiser form actually sends one — with
  // no mention of transfer at all — must be transferable.
  const organiser = await makeUser("Organiser");
  const buyer = await makeUser("Buyer");
  const claimant = await makeUser("Claimant");
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, slug, event_name, category, venue_name, event_date, status)
     VALUES ($1,$2,$3,'Default Test','music','Test Venue',CURRENT_DATE + 10,'approved')`,
    [eventId, organiser, "default-test-" + eventId.slice(0, 8)]);
  const typeId = crypto.randomUUID();
  // No transfer_allowed column named: exactly what the default governs.
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'General Admission',100,50)`,
    [typeId, eventId]);
  const orderId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, status)
     VALUES ($1,$2,$3,$4,$5,1,'paid')`,
    [orderId, eventId, typeId, buyer, "DT-" + orderId.slice(0, 8)]);
  const ticketId = crypto.randomUUID();
  const code = String(Math.floor(1000000 + Math.random() * 8999999));
  await pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,'valid')`,
    [ticketId, orderId, eventId, typeId, buyer, code]);
  try {
    await ticketing.claimTicketByCode({ userId: claimant }, code, {});
    assert.equal(await ownerOf(ticketId), claimant, "a ticket type that says nothing about transfer still gifts");
  } finally {
    await cleanup(eventId, [organiser, buyer, claimant]);
  }
});

test("the API's own normaliser defaults to transferable too", () => {
  // The column default only governs an INSERT that omits the column. The
  // create path names it explicitly, so it needs the same default or a new
  // event would still be born non-transferable.
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
  assert.match(source, /transferAllowed: item\.transferAllowed \?\? item\.transfer_allowed \?\? true/);
  assert.ok(!source.includes("transferAllowed: Boolean(item.transferAllowed ?? item.transfer_allowed)"),
    "the old Boolean() coercion turned an absent field into a refusal");
  assert.match(source, /transfer_allowed BOOLEAN NOT NULL DEFAULT TRUE/,
    "a fresh database gets the same default as a migrated one");
});
