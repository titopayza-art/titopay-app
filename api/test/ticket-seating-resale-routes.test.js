"use strict";

// SEATING AND RESALE, OVER THE WIRE.
//
// The services are tested elsewhere, in depth. This proves the part a person
// actually meets: the routes are mounted, they answer, and the ownership scope
// holds at the HTTP layer rather than only inside the service.
//
// That distinction has teeth. A service function can be perfectly guarded and
// still be reachable unguarded if the route forgets to pass the caller, or
// passes the wrong id, or sits behind a mount that never receives the request.
// Every check below is driven with a real token over a real socket.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");
const ticketing = require("../src/services/ticketing-service");

const TAG = "seatroute";
const organiser = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const stranger = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const buyer = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
let server;
let baseUrl;
let eventId;
let typeId;

async function ensureRevenueWallet() {
  const { rows } = await pool.query("SELECT id FROM wallets WHERE kind='revenue' AND user_id IS NULL LIMIT 1");
  if (rows[0]) return;
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, available_balance, reserved_balance, currency)
     VALUES ($1, NULL, 'revenue', 0, 0, 'ZAR')`, [randomUUID()]);
}

async function seed(user, accountType, balance) {
  const suffix = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE)`,
    [user.id, accountType, `${TAG} ${suffix}`, `${TAG}_${suffix}`,
      `${TAG}_${suffix}@example.invalid`, `2782${Math.floor(1000000 + Math.random() * 8999999)}`]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, available_balance, reserved_balance, currency)
     VALUES ($1,$2,$3,$4,0,'ZAR')`,
    [randomUUID(), user.id, accountType === "business" ? "business" : "personal", balance]);
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [user.session, user.id, user.jti]);
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function cleanup() {
  if (eventId) {
    await pool.query("DELETE FROM event_audit_logs WHERE event_id=$1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM ticket_listings WHERE event_id=$1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM tickets WHERE event_id=$1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_seats WHERE event_id=$1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM ticket_orders WHERE event_id=$1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_ticket_types WHERE event_id=$1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id=$1", [eventId]).catch(() => {});
  }
  for (const u of [organiser, stranger, buyer]) {
    await pool.query("DELETE FROM event_audit_logs WHERE actor_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query(
      "DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [u.id]).catch(() => {});
    await pool.query(
      "DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [u.id]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id=$1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]).catch(() => {});
  }
}

test.before(async () => {
  await ticketing.ensureTicketingSchema();
  await ensureRevenueWallet();
  await cleanup();
  await seed(organiser, "business", 0);
  await seed(stranger, "personal", 0);
  await seed(buyer, "personal", 1000);
  eventId = randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, slug, event_name, category, venue_name, event_date, status)
     VALUES ($1,$2,$3,'Route Seating Show','music','Test Arena',CURRENT_DATE + 30,'approved')`,
    [eventId, organiser.id, "route-seat-" + eventId.slice(0, 8)]);
  typeId = randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'Grand Tier',250,500)`, [typeId, eventId]);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
  await pool.end();
});

function call(method, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("an organiser lays out a section over HTTP and reads it back", async () => {
  const created = await call("POST", `/v1/ticketing/business/events/${eventId}/seating`, organiser.token,
    { section: "Block A", rows: ["A", "B"], seatsPerRow: 10, ticketTypeId: typeId });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.seating.seatsCreated, 20);

  const read = await call("GET", `/v1/ticketing/business/events/${eventId}/seating`, organiser.token);
  assert.equal(read.status, 200);
  const readBody = await read.json();
  assert.deepEqual(readBody.sections, [{ section: "Block A", total: 20, available: 20 }]);
});

test("the seating routes refuse a stranger, over the wire", async () => {
  // The service is guarded, but a route that forgot to pass the caller would
  // reach that guard with nobody in it. Both verbs are driven.
  const write = await call("POST", `/v1/ticketing/business/events/${eventId}/seating`, stranger.token,
    { section: "Hostile", rows: ["Z"], seatsPerRow: 50 });
  assert.equal(write.status, 404, "a stranger cannot lay seats on someone else's event");

  const read = await call("GET", `/v1/ticketing/business/events/${eventId}/seating`, stranger.token);
  assert.equal(read.status, 404, "nor read how full it is, which is the organiser's commercial information");

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM event_seats WHERE event_id=$1", [eventId]);
  assert.equal(rows[0].n, 20, "still only the organiser's own twenty seats");
});

test("seating needs a signed-in caller at all", async () => {
  const anonymous = await call("GET", `/v1/ticketing/business/events/${eventId}/seating`, null);
  assert.equal(anonymous.status, 401);
});

test("the whole resale journey works over HTTP", async () => {
  // List, browse, buy - the three requests the app makes, in order.
  const orderId = randomUUID();
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,$5,1,250,250,'paid')`,
    [orderId, eventId, typeId, stranger.id, "RT-" + orderId.slice(0, 8)]);
  const ticketId = randomUUID();
  await pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,'valid')`,
    [ticketId, orderId, eventId, typeId, stranger.id, String(Math.floor(1000000 + Math.random() * 8999999))]);

  const listed = await call("POST", `/v1/ticketing/tickets/${ticketId}/listing`, stranger.token, { price: 200 });
  assert.equal(listed.status, 201);
  const listing = (await listed.json()).listing;
  assert.equal(listing.price, 200);

  // Both refusals answer with the status that matches the complaint, never a
  // 500: the difference between "you asked for something not allowed" and
  // "the platform broke". The price is checked first, so an over-priced
  // relist is answered about its price, and a fairly priced one about the
  // listing that already stands.
  const overPriced = await call("POST", `/v1/ticketing/tickets/${ticketId}/listing`, stranger.token, { price: 900 });
  assert.equal(overPriced.status, 400);
  assert.match((await overPriced.json()).error || "", /more than the R 250\.00 that was paid/i);

  const again = await call("POST", `/v1/ticketing/tickets/${ticketId}/listing`, stranger.token, { price: 150 });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error || "", /already listed/i);

  const browse = await call("GET", `/v1/ticketing/events/${eventId}/listings`, buyer.token);
  assert.equal(browse.status, 200);
  const items = (await browse.json()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].price, 200);

  const bought = await call("POST", `/v1/ticketing/listings/${listing.id}/buy`, buyer.token, {});
  assert.equal(bought.status, 200);

  const { rows: owner } = await pool.query("SELECT owner_user_id FROM tickets WHERE id=$1", [ticketId]);
  assert.equal(owner[0].owner_user_id, buyer.id, "the ticket really moved");
  const { rows: wallets } = await pool.query(
    "SELECT available_balance FROM wallets WHERE user_id=$1", [buyer.id]);
  assert.equal(Number(wallets[0].available_balance), 800, "1000 less the 200 on the listing");

  // And it is gone from the board, so nobody else is offered it.
  const after = await call("GET", `/v1/ticketing/events/${eventId}/listings`, buyer.token);
  assert.deepEqual((await after.json()).items, []);
});

test("a stranger cannot list a ticket that is not theirs, over the wire", async () => {
  const orderId = randomUUID();
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,$5,1,250,250,'paid')`,
    [orderId, eventId, typeId, buyer.id, "RX-" + orderId.slice(0, 8)]);
  const ticketId = randomUUID();
  await pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,'valid')`,
    [ticketId, orderId, eventId, typeId, buyer.id, String(Math.floor(1000000 + Math.random() * 8999999))]);

  const response = await call("POST", `/v1/ticketing/tickets/${ticketId}/listing`, stranger.token, { price: 100 });
  assert.equal(response.status, 404);
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ticket_listings WHERE ticket_id=$1", [ticketId]);
  assert.equal(rows[0].n, 0);
});
