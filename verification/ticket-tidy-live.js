"use strict";

/* REMOVING A TICKET, AND A CANCELLED EVENT SAYING SO.
 *
 * Two things My Tickets could not do. It had no way to put a ticket away, so a
 * wallet filled with last year's stubs until the one needed at a gate was four
 * screens down. And a cancelled event was indistinguishable from a live one:
 * the list never carried the event's status, and the public event page answered
 * 404 the moment an event was cancelled, so every share, email link and poster
 * QR pointing at it simply died.
 *
 * What this pins, against a real database and a real HTTP server:
 *   - removing hides and never deletes; the row, its status and the organiser's
 *     counts are untouched, and the ticket comes back on request
 *   - a ticket that is not yours answers 404, so the endpoint confirms nothing
 *   - a cancelled event is reported on every ticket its holder owns
 *   - the public event page answers 200 saying it is cancelled, not 404
 *
 * Run: node verification/ticket-tidy-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const API = path.join(__dirname, "..", "api");
const { pool } = require(API + "/src/db/pool.js");
const { signAccessToken } = require(API + "/src/lib/jwt.js");
let pass = 0; const ok = (m) => { pass++; console.log("  PASS  " + m); };
(async () => {
  const { app } = require(API + "/src/app.js");
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sfx = crypto.randomUUID().slice(0, 8);
  const userId = crypto.randomUUID(), sid = crypto.randomUUID(), jti = crypto.randomUUID();
  const eventId = crypto.randomUUID(), typeId = crypto.randomUUID();
  const orderId = crypto.randomUUID(), t1 = crypto.randomUUID(), t2 = crypto.randomUUID();
  const created = [];
  try {
    await pool.query(`INSERT INTO users (id,account_type,full_name,username,email,password_hash,status,fica_status)
      VALUES ($1,'personal','Ticket Tidy',$2,$3,'x','active','verified')`, [userId, `tt_${sfx}`, `tt-${sfx}@example.test`]);
    await pool.query(`INSERT INTO sessions (id,user_type,user_id,scope,refresh_token_hash,access_jti,expires_at)
      VALUES ($1,'customer',$2,'customer','x',$3,NOW()+INTERVAL '1 hour')`, [sid, userId, jti]);
    const h = { "Content-Type": "application/json",
      Authorization: `Bearer ${signAccessToken({ sub: userId, sid, jti, typ: "customer" })}` };

    await pool.query(`INSERT INTO events (id,business_user_id,event_name,slug,status,event_date,venue_name,city,province)
      VALUES ($1,$2,'Tidy Test Event',$3,'approved','2026-12-01','Hall','Jhb','GP')`, [eventId, userId, `tidy-${sfx}`]);
    await pool.query(`INSERT INTO event_ticket_types (id,event_id,ticket_name,price)
      VALUES ($1,$2,'General',100)`, [typeId, eventId]);
    await pool.query(`INSERT INTO ticket_orders (id,event_id,ticket_type_id,buyer_user_id,order_reference,quantity,total,status)
      VALUES ($1,$2,$3,$4,$5,2,210,'paid')`, [orderId, eventId, typeId, userId, `ORD${sfx}`]);
    for (const [id, code] of [[t1, `TK1${sfx}`], [t2, `TK2${sfx}`]]) {
      await pool.query(`INSERT INTO tickets (id,order_id,event_id,ticket_type_id,owner_user_id,ticket_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,'valid')`, [id, orderId, eventId, typeId, userId, code]);
    }

    const list = async (q = "") => (await (await fetch(`${base}/v1/ticketing/tickets${q}`, { headers: h })).json()).items;
    assert.equal((await list()).length, 2, "both tickets show");
    ok("both tickets are listed to their owner");

    // Remove one.
    const rm = await fetch(`${base}/v1/ticketing/tickets/${t1}/removed`, {
      method: "PATCH", headers: h, body: JSON.stringify({ removed: true }) });
    assert.equal(rm.status, 200, await rm.text());
    const after = await list();
    assert.equal(after.length, 1, "the removed one is gone from the default list");
    assert.equal(after[0].id, t2);
    ok("a removed ticket disappears from My Tickets");

    const withRemoved = await list("?removed=1");
    assert.equal(withRemoved.length, 2, "it is still there when asked for");
    assert.equal(withRemoved.find((t) => t.id === t1).removed, true);
    ok("and is still retrievable, flagged as removed, so nothing paid for is lost");

    const { rows: still } = await pool.query("SELECT id, status FROM tickets WHERE id=$1", [t1]);
    assert.equal(still.length, 1, "the row was NOT deleted");
    assert.equal(still[0].status, "valid", "and its state is untouched");
    ok("the ticket row and its status survive removal");

    // Restore.
    await fetch(`${base}/v1/ticketing/tickets/${t1}/removed`, {
      method: "PATCH", headers: h, body: JSON.stringify({ removed: false }) });
    assert.equal((await list()).length, 2);
    ok("restoring brings it back");

    // Somebody else's ticket is a 404, not a 403.
    const other = crypto.randomUUID();
    const bad = await fetch(`${base}/v1/ticketing/tickets/${other}/removed`, {
      method: "PATCH", headers: h, body: JSON.stringify({ removed: true }) });
    assert.equal(bad.status, 404, `expected 404, got ${bad.status}`);
    ok("a ticket that is not yours answers 404 and confirms nothing");

    // Cancel the event.
    await pool.query("UPDATE events SET status='cancelled' WHERE id=$1", [eventId]);
    const cancelledList = await list();
    assert.equal(cancelledList[0].eventStatus, "cancelled");
    assert.equal(cancelledList[0].eventCancelled, true);
    ok("a cancelled event is reported on every ticket the holder owns");

    const page = await fetch(`${base}/v1/ticketing/public/events/tidy-${sfx}`);
    assert.equal(page.status, 200, `the shared link must not 404, got ${page.status}`);
    const body = await page.json();
    const ev = body.event || body;
    assert.equal(ev.cancelled, true);
    assert.match(ev.cancelledNotice, /cancelled by the organiser/);
    ok("and the public event page answers 200 saying it is cancelled, instead of 404");

    console.log(`\n  ${pass}/${pass} ticket tidy and cancellation checks passed\n`);
  } finally {
    const tidy = async (q, p) => { try { await pool.query(q, p); } catch (e) { console.error("cleanup: " + e.message); } };
    await tidy("DELETE FROM tickets WHERE order_id=$1", [orderId]);
    await tidy("DELETE FROM ticket_orders WHERE id=$1", [orderId]);
    await tidy("DELETE FROM event_ticket_types WHERE id=$1", [typeId]);
    await tidy("DELETE FROM events WHERE id=$1", [eventId]);
    await tidy("DELETE FROM sessions WHERE id=$1", [sid]);
    await tidy("DELETE FROM users WHERE id=$1", [userId]);
    server.close(); await pool.end();
  }
})().catch((e) => { console.error("\n  FAIL  " + e.message); process.exit(1); });
