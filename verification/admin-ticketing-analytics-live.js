"use strict";

/* THE CONSOLE'S TICKETING METRICS, PROVEN AT THE PATH THE CONSOLE CALLS.
 *
 * The dashboard showed R0.00 and 0/0 while real paid orders sat in the
 * database, because the console fetches /v1/admin/ticketing/analytics and the
 * handler was only registered at /v1/ticketing/admin/analytics. This harness
 * boots the real Express app against the sandbox database and proves:
 *
 *   1. The console's path answers 200 with the fields the metric cards read,
 *      for a seeded admin whose role holds the "ticketing" permission.
 *   2. The same admin gets 404 on a junk path under the same mount — so
 *      check 1 is a real route, not a catch-all. (Unauthenticated probes
 *      cannot tell the two apart: the mount gates before matching, so every
 *      path answers 401 without a token.)
 *   3. adminTicketingAnalytics() counts a seeded paid order: gross, platform
 *      revenue, tickets issued and scanned all move by exactly the amounts
 *      seeded. Counted before-and-after, so leftover rows from other
 *      harnesses cannot fake a pass.
 *
 * Run: POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
 *        node verification/admin-ticketing-analytics-live.js
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
const { adminTicketingAnalytics, ensureTicketingSchema } = require(path.join(API, "src", "services", "ticketing-service.js"));

let passed = 0;
function ok(label) { passed++; console.log(`  PASS  ${label}`); }

async function httpChecks() {
  const { app } = require(path.join(API, "src", "app.js"));
  const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // A real admin, a real session. The router gates the whole /v1/admin mount
  // before matching paths, so an unauthenticated probe answers 401 for
  // registered and missing routes alike — only an authenticated call can
  // tell "route exists" from "the 404 the console was swallowing".
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const accessJti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1, 'Analytics Harness Admin', $2, $3, 'coo', 'x', 'active')`,
    [adminId, `analytics_admin_${suffix}`, `analytics-admin-${suffix}@example.test`]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1, 'admin', $2, 'admin', 'x', $3, NOW() + INTERVAL '1 hour')`,
    [sessionId, adminId, accessJti]
  );
  const token = signAccessToken({ sub: adminId, sid: sessionId, jti: accessJti, typ: "admin" });
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const response = await fetch(`${base}/v1/admin/ticketing/analytics`, { headers });
    assert.equal(response.status, 200, `the console's path must answer, got ${response.status}`);
    const body = await response.json();
    assert.ok(body.analytics && body.analytics.totals, "the payload carries analytics.totals");
    for (const field of ["gross", "platformRevenue", "ticketsIssued", "ticketsScanned"]) {
      assert.ok(field in body.analytics.totals, `totals carries ${field} — the console's cards read it`);
    }
    ok("GET /v1/admin/ticketing/analytics answers 200 for a ticketing-permitted admin, with the fields the cards read");

    const junk = await fetch(`${base}/v1/admin/ticketing/definitely-not-a-route`, { headers });
    assert.equal(junk.status, 404, "a junk path must still 404, or the check above proves nothing");
    ok("the same admin gets 404 on a junk path — the analytics route is real, not a catch-all");
  } finally {
    server.close();
    await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [adminId]);
  }
}

async function countingCheck() {
  await ensureTicketingSchema();
  const before = (await adminTicketingAnalytics()).totals;

  const suffix = crypto.randomUUID().slice(0, 8);
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (id, username, email, full_name, account_type, status, password_hash)
     VALUES (gen_random_uuid(), $1, $2, 'Analytics Harness', 'business', 'active', 'x')
     RETURNING id`,
    [`analytics_harness_${suffix}`, `analytics-harness-${suffix}@example.test`]
  );
  const cleanup = { events: [], orders: [], tickets: [], userId: user.id };
  try {
    const { rows: [event] } = await pool.query(
      `INSERT INTO events (id, business_user_id, event_name, slug, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'approved', NOW(), NOW())
       RETURNING id`,
      [user.id, `Analytics Proof ${suffix}`, `analytics-proof-${suffix}`]
    );
    cleanup.events.push(event.id);

    const { rows: [ticketType] } = await pool.query(
      `INSERT INTO event_ticket_types (id, event_id, ticket_name, price)
       VALUES (gen_random_uuid(), $1, 'General', 100)
       RETURNING id`,
      [event.id]
    );

    // One paid order: total R230 = R200 subtotal + R30 buyer fee, commission
    // R10, net R190 to the organiser. Two tickets, one scanned.
    const { rows: [order] } = await pool.query(
      `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity,
                                  subtotal, buyer_fee, business_commission, business_net, total,
                                  status, delivery_status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 2, 200, 30, 10, 190, 230, 'paid', 'queued', NOW())
       RETURNING id`,
      [event.id, ticketType.id, user.id, `AH-${suffix}`]
    );
    cleanup.orders.push(order.id);

    for (const status of ["valid", "scanned"]) {
      const { rows: [ticket] } = await pool.query(
        `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [order.id, event.id, ticketType.id, user.id, `AH-${suffix}-${status}`, status]
      );
      cleanup.tickets.push(ticket.id);
    }

    const after = (await adminTicketingAnalytics()).totals;
    assert.equal(after.orders, before.orders + 1, "one more paid order");
    assert.equal(Number(after.gross) - Number(before.gross), 230, "gross moves by the order total");
    assert.equal(Number(after.platformRevenue) - Number(before.platformRevenue), 40, "platform revenue = buyer fee + commission");
    assert.equal(after.ticketsIssued, before.ticketsIssued + 2, "two more tickets issued");
    assert.equal(after.ticketsScanned, before.ticketsScanned + 1, "one more ticket scanned");
    ok("a seeded paid order moves gross +R230, platform revenue +R40, tickets +2 issued +1 scanned");
  } finally {
    if (cleanup.tickets.length) await pool.query("DELETE FROM tickets WHERE id = ANY($1)", [cleanup.tickets]);
    if (cleanup.orders.length) await pool.query("DELETE FROM ticket_orders WHERE id = ANY($1)", [cleanup.orders]);
    if (cleanup.events.length) {
      await pool.query("DELETE FROM event_ticket_types WHERE event_id = ANY($1)", [cleanup.events]);
      await pool.query("DELETE FROM events WHERE id = ANY($1)", [cleanup.events]);
    }
    await pool.query("DELETE FROM users WHERE id = $1", [cleanup.userId]);
  }
}

(async () => {
  try {
    await httpChecks();
    await countingCheck();
    console.log(`\n${passed}/3 checks passed.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  }
})();
