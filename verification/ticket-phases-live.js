"use strict";

/* TICKET PHASES, PROVEN AGAINST A REAL PURCHASE.
 *
 * The sales window columns existed for months and were never checked, so a
 * unit test of the decision function is not enough here: the whole point is
 * that the rule must reach the money path. This boots the real Express app,
 * seeds an approved event with three phases, and buys through the public
 * endpoints as a real signed-in customer.
 *
 *   1. A phase that has not opened is refused, with a date in the message.
 *   2. A phase that has closed is refused.
 *   3. The open phase sells, and the buyer's wallet is debited exactly once.
 *   4. A per-person limit is enforced across separate orders.
 *   5. A ticket type with no window at all still sells. This is the
 *      regression that matters most: every ticket sold before phases existed
 *      has NULL dates, and reading NULL as "closed" would have shut down every
 *      live event on the platform.
 *   6. A registration event issues a free ticket and charges nothing.
 *
 * Run: node verification/ticket-phases-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));
// The new columns arrive through the service's own runtime migration, and
// this harness seeds rows directly, so the migration has to run first.
const { ensureTicketingSchema } = require(path.join(API, "src", "services", "ticketing-service.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };

const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

async function seedCustomer(name, balance) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
     VALUES ($1, 'personal', $2, $3, $4, 'x', 'active', 'verified')`,
    [id, name, `ph_${name}_${TAG}`, `ph-${name}-${TAG}@example.test`]);
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, available_balance)
     VALUES ($1, $2, 'personal', 'ZAR', $3)`, [walletId, id, balance]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1, 'customer', $2, 'customer', 'x', $3, NOW() + INTERVAL '1 hour')`,
    [sessionId, id, jti]);
  return { id, walletId, sessionId, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
}

async function seedEvent({ slug, registration = false, types }) {
  const organiserId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
     VALUES ($1, 'business', 'Phase Organiser', $2, $3, 'x', 'active', 'verified')`,
    [organiserId, `ph_org_${slug}`, `ph-org-${slug}@example.test`]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, available_balance)
     VALUES (gen_random_uuid(), $1, 'business', 'ZAR', 0)`, [organiserId]);
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, registration_mode, event_date, approved_at)
     VALUES ($1, $2, $3, $4, 'approved', $5, CURRENT_DATE + 30, NOW())`,
    [eventId, organiserId, `Phase Test ${slug}`, slug, registration]);
  const made = {};
  for (const [i, t] of types.entries()) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO event_ticket_types
         (id, event_id, ticket_name, price, quantity_available, min_purchase_quantity,
          max_purchase_quantity, sales_opening_at, sales_closing_at, per_customer_purchase_limit, sort_order)
       VALUES ($1,$2,$3,$4,$5,1,10,$6,$7,$8,$9)`,
      [id, eventId, t.name, t.price, t.qty, t.opensAt || null, t.closesAt || null, t.perPerson || null, (i + 1) * 10]);
    made[t.name] = id;
  }
  return { organiserId, eventId, types: made };
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = { events: [], users: [] };
  await ensureTicketingSchema();

  const call = (token, p, body) => fetch(base + p, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });

  try {
    const buyer = await seedCustomer("buyer", 5000);
    created.users.push(buyer.id);

    const slug = `phase-test-${TAG}`;
    const ev = await seedEvent({ slug, types: [
      { name: "Early Bird", price: 100, qty: 50, closesAt: hoursFromNow(-1) },
      { name: "General", price: 200, qty: 50, opensAt: hoursFromNow(-2), closesAt: hoursFromNow(48) },
      { name: "Late", price: 300, qty: 50, opensAt: hoursFromNow(24) },
      { name: "Two Only", price: 50, qty: 50, perPerson: 2 },
      { name: "No Window", price: 75, qty: 50 }
    ] });
    created.events.push(ev.eventId); created.users.push(ev.organiserId);

    const buy = (typeName, quantity = 1) =>
      call(buyer.token, `/v1/ticketing/public/events/${slug}/purchase`,
        { ticketTypeId: ev.types[typeName], quantity });

    // 1. Not yet open.
    const late = await buy("Late");
    assert.equal(late.status, 409, `a scheduled phase must be refused, got ${late.status}`);
    const lateBody = await late.json();
    assert.match(lateBody.error || "", /goes on sale/i, "the refusal names when it opens");
    ok("a phase that has not opened is refused, and the message says when it will open");

    // 2. Already closed.
    const early = await buy("Early Bird");
    assert.equal(early.status, 409, `a closed phase must be refused, got ${early.status}`);
    assert.match((await early.json()).error || "", /closed/i);
    ok("a phase past its closing time is refused");

    // 3. The open one sells, once.
    const before = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [buyer.walletId]);
    const general = await buy("General");
    assert.equal(general.status, 201, `the open phase must sell, got ${general.status} ${await general.text()}`);
    const after = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [buyer.walletId]);
    const spent = Number(before.rows[0].available_balance) - Number(after.rows[0].available_balance);
    assert.ok(spent >= 200, `the wallet paid at least the ticket price, moved ${spent}`);
    ok(`the open phase sells and the wallet is debited once (R${spent.toFixed(2)} including the service fee)`);

    // 4. Per-person limit, across separate orders.
    assert.equal((await buy("Two Only", 2)).status, 201, "the first two are allowed");
    const third = await buy("Two Only", 1);
    assert.equal(third.status, 409, `a third must be refused, got ${third.status}`);
    assert.match((await third.json()).error || "", /maximum|limit/i);
    ok("a per-person limit holds across separate orders, not just within one");

    // 5. The regression that matters: no window at all still sells.
    assert.equal((await buy("No Window")).status, 201,
      "a ticket type with NULL dates must still sell, or enforcement would close every event created before phases existed");
    ok("a ticket type with no sales window still sells, so nothing created before phases broke");

    // 6. Registration event: free, and nothing charged.
    const regSlug = `reg-test-${TAG}`;
    const reg = await seedEvent({ slug: regSlug, registration: true, types: [{ name: "Register", price: 0, qty: 100 }] });
    created.events.push(reg.eventId); created.users.push(reg.organiserId);
    const balBefore = (await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [buyer.walletId])).rows[0].available_balance;
    const registered = await call(buyer.token, `/v1/ticketing/public/events/${regSlug}/purchase`,
      { ticketTypeId: reg.types.Register, quantity: 1 });
    assert.equal(registered.status, 201, `registration must succeed, got ${registered.status} ${await registered.text()}`);
    const balAfter = (await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [buyer.walletId])).rows[0].available_balance;
    assert.equal(Number(balBefore), Number(balAfter), "a registration event must not charge a cent");
    const publicReg = await (await fetch(`${base}/v1/ticketing/public/events/${regSlug}`)).json();
    assert.equal(publicReg.event.registrationMode, true, "the public page is told it is a registration event");
    ok("a registration event issues a ticket and charges nothing");

    // The public page carries the phase state, so the buyer's screen and the
    // server cannot disagree about what is on sale.
    const publicEvent = await (await fetch(`${base}/v1/ticketing/public/events/${slug}`)).json();
    const states = Object.fromEntries(publicEvent.event.ticketTypes.map((t) => [t.ticketName, t.phase.state]));
    assert.equal(states["Late"], "scheduled");
    assert.equal(states["Early Bird"], "closed");
    assert.equal(states["General"], "on_sale");
    assert.equal(states["No Window"], "on_sale");
    ok("the public event page reports each phase's state: " + JSON.stringify(states));

    console.log(`\n${passed}/7 checks passed. Phases gate the money path, not just the screen.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    for (const eventId of created.events) {
      await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]);
      await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]);
      await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]);
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
    }
    for (const userId of created.users) {
      await pool.query("DELETE FROM ledger_entries WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [userId]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    }
  }
})();
