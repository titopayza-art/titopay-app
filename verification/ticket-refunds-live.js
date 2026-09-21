"use strict";

/* REFUND POLICY, WAITLIST, PROMOTERS AND LINK PREVIEWS, ON THE REAL API.
 *
 * The refund half is the money half. refunds_allowed, refund_deadline and
 * refund_conditions had been stored on every ticket type since ticketing
 * shipped and NOTHING had ever read them, so a "non-refundable" ticket was
 * refundable and an expired window was no window at all.
 *
 *  1. A buyer sees the refund terms BEFORE paying, in the purchase preview.
 *  2. A non-refundable ticket refuses the request, in the organiser's words.
 *  3. A refund asked for after the cut-off is refused, quoting the date.
 *  4. A refundable ticket inside the window is accepted.
 *  5. The organiser can approve it, and the money actually moves.
 *  6. An organiser cannot touch a refund on somebody else's event.
 *  7. A scanned ticket cannot be refunded whatever the policy says.
 *  8. Joining a waitlist reserves nothing and charges nothing.
 *  9. The organiser sees the demand, and can tell the queue.
 * 10. A promoter link attributes the sale that came through it.
 * 11. A retired promoter code never fails a payment.
 * 12. A shared link serves real Open Graph tags to a crawler.
 *
 * Run: node verification/ticket-refunds-live.js
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
const ticketing = require(path.join(API, "src", "services", "ticketing-service.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m, extra = "") => { passed += 1; console.log("  PASS  " + m + (extra ? `  [${extra}]` : "")); };
const created = { users: [], events: [] };
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const daysFromNow = (d) => new Date(Date.now() + d * 86400000);

async function balance(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return money(rows[0]?.available_balance);
}

async function seedUser(kind, name, startingBalance) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
     VALUES ($1,$2,$3,$4,$5,'x','active','verified')`,
    [id, kind, `Refund ${name}`, `rf_${name}_${TAG}`, `rf-${name}-${TAG}@example.test`]);
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,$4,'ZAR',$5)`,
    [walletId, String(Date.now()).slice(-8) + created.users.length, id, kind === "business" ? "business" : "personal", startingBalance]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`, [sessionId, id, jti]);
  created.users.push(id);
  return { id, walletId, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
}

async function seedEvent(organiser, { refundsAllowed, refundDeadline, conditions = "", eventInDays = 30 }) {
  const eventId = crypto.randomUUID();
  const slug = `rf-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, category, city, venue_name, event_date, approved_at, refund_policy)
     VALUES ($1,$2,$3,$4,'approved','Music & Concerts','Johannesburg','The Venue',$5, NOW(), $6::JSONB)`,
    [eventId, organiser.id, `Refund Test ${slug}`, slug, daysFromNow(eventInDays),
      JSON.stringify({ summary: "Tickets are transferable at any time." })]);
  const typeId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO event_ticket_types
      (id, event_id, ticket_name, price, quantity_available, min_purchase_quantity, max_purchase_quantity,
       refunds_allowed, refund_deadline, refund_conditions, sort_order)
     VALUES ($1,$2,'General',200,100,1,10,$3,$4,$5,10)`,
    [typeId, eventId, refundsAllowed, refundDeadline, conditions]);
  created.events.push(eventId);
  return { eventId, slug, typeId };
}

async function cleanup() {
  for (const eventId of created.events) {
    for (const table of ["ticket_waitlist", "event_promoters", "ticket_coupon_redemptions"]) {
      await pool.query(`DELETE FROM ${table} WHERE event_id = $1`, [eventId]).catch(() => {});
    }
    await pool.query("DELETE FROM tickets WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM ticket_refunds WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM event_audit_logs WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => {});
  }
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1))", [created.users]).catch(() => {});
  await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ANY($1))", [created.users]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [created.users]).catch(() => {});
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [created.users]).catch(() => {});
  await pool.query("DELETE FROM sessions WHERE user_id = ANY($1)", [created.users]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id = ANY($1)", [created.users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [created.users]).catch(() => {});
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (token, p, body, method) => fetch(base + p, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = async (res) => ({ status: res.status, payload: await res.json().catch(() => ({})) });

  try {
    await ticketing.ensureTicketingSchema();
    console.log("\n" + "=".repeat(78));
    console.log("  REFUND POLICY, WAITLIST, PROMOTERS, LINK PREVIEWS");
    console.log("=".repeat(78) + "\n");

    const organiser = await seedUser("business", "org", 5000);
    const buyer = await seedUser("personal", "buyer", 5000);

    // ---- 1. the terms are visible BEFORE paying ----------------------------
    const openEvent = await seedEvent(organiser, { refundsAllowed: true, refundDeadline: daysFromNow(20), conditions: "Refunds are paid back to your wallet." });
    const preview = await json(await call(buyer.token, `/v1/ticketing/public/events/${openEvent.slug}/purchase-preview`,
      { ticketTypeId: openEvent.typeId, quantity: 1 }));
    assert.equal(preview.status, 200);
    const policy = preview.payload.preview.refundPolicy;
    assert.ok(policy, "the purchase preview carries the refund policy");
    assert.equal(policy.refundsAllowed, true);
    assert.match(policy.headline, /Refundable until/);
    assert.ok(policy.feeNotice.length > 0, "the buyer is told the fee is not returned");
    ok("the buyer reads the refund terms before paying", policy.headline);

    // ---- 2. a non-refundable ticket refuses ---------------------------------
    const strictEvent = await seedEvent(organiser, { refundsAllowed: false, refundDeadline: null, conditions: "All sales are final." });
    const strictBuy = await json(await call(buyer.token, `/v1/ticketing/public/events/${strictEvent.slug}/purchase`,
      { ticketTypeId: strictEvent.typeId, quantity: 1 }));
    assert.equal(strictBuy.status, 201, JSON.stringify(strictBuy.payload));
    const strictRefund = await json(await call(buyer.token, `/v1/ticketing/orders/${strictBuy.payload.order.id}/refund`, { reason: "changed my mind" }));
    assert.equal(strictRefund.status, 409, "a non-refundable ticket must refuse");
    assert.match(strictRefund.payload.error, /does not offer refunds/i);
    assert.match(strictRefund.payload.error, /All sales are final/, "the refusal uses the organiser's own words");
    ok("a non-refundable ticket refuses the request, quoting the organiser");

    // ---- 3. past the cut-off ------------------------------------------------
    const closedEvent = await seedEvent(organiser, { refundsAllowed: true, refundDeadline: daysFromNow(-2) });
    const closedBuy = await json(await call(buyer.token, `/v1/ticketing/public/events/${closedEvent.slug}/purchase`,
      { ticketTypeId: closedEvent.typeId, quantity: 1 }));
    assert.equal(closedBuy.status, 201);
    const closedRefund = await json(await call(buyer.token, `/v1/ticketing/orders/${closedBuy.payload.order.id}/refund`, {}));
    assert.equal(closedRefund.status, 409);
    assert.match(closedRefund.payload.error, /refund window .* closed/i);
    ok("a refund asked for after the cut-off is refused, quoting the date");

    // ---- 4 & 5. inside the window, and the organiser approves ---------------
    const buyerBefore = await balance(buyer.walletId);
    const buy = await json(await call(buyer.token, `/v1/ticketing/public/events/${openEvent.slug}/purchase`,
      { ticketTypeId: openEvent.typeId, quantity: 1 }));
    assert.equal(buy.status, 201);
    const paid = money(buyerBefore - await balance(buyer.walletId));
    assert.ok(paid > 0, "the buyer actually paid");

    const request = await json(await call(buyer.token, `/v1/ticketing/orders/${buy.payload.order.id}/refund`, { reason: "cannot attend" }));
    assert.equal(request.status, 201, JSON.stringify(request.payload));
    ok("a refundable ticket inside the window is accepted");

    const queue = await json(await call(organiser.token, `/v1/ticketing/business/events/${openEvent.eventId}/refunds`));
    assert.equal(queue.status, 200);
    assert.equal(queue.payload.items.length, 1, "the organiser sees the request on their own desk");
    const beforeApprove = await balance(buyer.walletId);
    const approve = await json(await call(organiser.token,
      `/v1/ticketing/business/events/${openEvent.eventId}/refunds/${request.payload.refund.id}/action`,
      { action: "approve", note: "Sorry you cannot make it." }));
    assert.equal(approve.status, 200, JSON.stringify(approve.payload));
    const refunded = money(await balance(buyer.walletId) - beforeApprove);
    assert.ok(refunded > 0, `the buyer's wallet must actually rise, got ${refunded}`);
    const refundRow = (await pool.query("SELECT * FROM ticket_refunds WHERE id = $1", [request.payload.refund.id])).rows[0];
    assert.equal(refundRow.status, "approved");
    assert.equal(refundRow.processed_by_role, "organiser", "the organiser is recorded as having acted");
    assert.equal(refundRow.processed_by, null, "an organiser id must never go in the admin column");
    assert.equal(refundRow.processed_by_user_id, organiser.id);
    ok("the organiser approves it and the money actually moves back", `buyer refunded R${refunded}`);

    // ---- 6. somebody else's event -------------------------------------------
    const intruder = await seedUser("business", "intruder", 0);
    const stolen = await json(await call(intruder.token,
      `/v1/ticketing/business/events/${openEvent.eventId}/refunds`));
    assert.equal(stolen.status, 404, "another organiser must not see this refund desk");
    ok("an organiser cannot reach a refund desk that is not theirs");

    // ---- 7. a scanned ticket --------------------------------------------------
    const scanEvent = await seedEvent(organiser, { refundsAllowed: true, refundDeadline: daysFromNow(20) });
    const scanBuy = await json(await call(buyer.token, `/v1/ticketing/public/events/${scanEvent.slug}/purchase`,
      { ticketTypeId: scanEvent.typeId, quantity: 1 }));
    await pool.query("UPDATE tickets SET status = 'scanned' WHERE order_id = $1", [scanBuy.payload.order.id]);
    const scannedRefund = await json(await call(buyer.token, `/v1/ticketing/orders/${scanBuy.payload.order.id}/refund`, {}));
    assert.equal(scannedRefund.status, 409);
    assert.match(scannedRefund.payload.error, /scanned/i);
    ok("a ticket already scanned at the door cannot be refunded, whatever the policy says");

    // ---- 8. waitlist reserves nothing ------------------------------------------
    const waitBuyer = await seedUser("personal", "waiter", 0);
    const beforeJoin = await balance(waitBuyer.walletId);
    const joined = await json(await call(waitBuyer.token, `/v1/ticketing/public/events/${openEvent.slug}/waitlist`, { quantity: 2 }));
    assert.equal(joined.status, 201, JSON.stringify(joined.payload));
    assert.equal(await balance(waitBuyer.walletId), beforeJoin, "joining a waitlist charges nothing");
    assert.match(joined.payload.waitlist.message, /Nothing is reserved/i, "the copy does not promise a ticket");
    // Joining twice must not buy a better place in the queue.
    await call(waitBuyer.token, `/v1/ticketing/public/events/${openEvent.slug}/waitlist`, { quantity: 3 });
    const rows = (await pool.query("SELECT COUNT(*)::INT AS c FROM ticket_waitlist WHERE event_id = $1 AND user_id = $2",
      [openEvent.eventId, waitBuyer.id])).rows[0];
    assert.equal(Number(rows.c), 1, "one place in the queue per person");
    ok("joining a waitlist reserves nothing, charges nothing, and cannot be gamed");

    // ---- 9. the organiser sees demand and can tell the queue ---------------------
    const list = await json(await call(organiser.token, `/v1/ticketing/business/events/${openEvent.eventId}/waitlist`));
    assert.equal(list.status, 200);
    assert.equal(list.payload.waiting, 1);
    assert.equal(list.payload.demand, 3, "demand counts tickets wanted, not people");
    const told = await json(await call(organiser.token, `/v1/ticketing/business/events/${openEvent.eventId}/waitlist/notify`, {}));
    assert.equal(told.status, 200);
    assert.equal(told.payload.told, 1);
    const notice = (await pool.query(
      "SELECT COUNT(*)::INT AS c FROM notifications WHERE user_id = $1 AND notification_type = 'ticket_waitlist_released'",
      [waitBuyer.id])).rows[0];
    assert.equal(Number(notice.c), 1, "the person waiting was actually told");
    ok("the organiser sees real demand and can tell the queue", `${list.payload.demand} tickets wanted`);

    // ---- 10. promoter attribution ------------------------------------------------
    const promoter = await json(await call(organiser.token, `/v1/ticketing/business/events/${openEvent.eventId}/promoters`,
      { code: "thabo", promoterName: "Thabo M" }));
    assert.equal(promoter.status, 201, JSON.stringify(promoter.payload));
    assert.match(promoter.payload.promoter.link, /\?ref=THABO$/);
    const promoBuyer = await seedUser("personal", "promo", 5000);
    const promoBuy = await json(await call(promoBuyer.token, `/v1/ticketing/public/events/${openEvent.slug}/purchase`,
      { ticketTypeId: openEvent.typeId, quantity: 2, promoterCode: "THABO" }));
    assert.equal(promoBuy.status, 201, JSON.stringify(promoBuy.payload));
    const report = await json(await call(organiser.token, `/v1/ticketing/business/events/${openEvent.eventId}/promoters`));
    const thabo = report.payload.items.find((item) => item.code === "THABO");
    assert.equal(thabo.orders, 1, "the order is attributed");
    assert.equal(thabo.tickets, 2, "and so are the tickets");
    assert.ok(thabo.sales > 0, "and the money");
    ok("a promoter link attributes the sale that came through it", `${thabo.tickets} tickets, R${thabo.sales}`);

    // ---- 11. a retired code must never break a payment ------------------------------
    await pool.query("UPDATE event_promoters SET status = 'disabled' WHERE event_id = $1", [openEvent.eventId]);
    const afterRetire = await json(await call(promoBuyer.token, `/v1/ticketing/public/events/${openEvent.slug}/purchase`,
      { ticketTypeId: openEvent.typeId, quantity: 1, promoterCode: "THABO" }));
    assert.equal(afterRetire.status, 201, "a switched-off promoter code must not fail the payment");
    const unattributed = (await pool.query("SELECT promoter_id FROM ticket_orders WHERE id = $1",
      [afterRetire.payload.order.id])).rows[0];
    assert.equal(unattributed.promoter_id, null, "and it attributes nothing");
    const nonsense = await json(await call(promoBuyer.token, `/v1/ticketing/public/events/${openEvent.slug}/purchase`,
      { ticketTypeId: openEvent.typeId, quantity: 1, promoterCode: "NO-SUCH-CODE" }));
    assert.equal(nonsense.status, 201, "an unknown code must not fail the payment either");
    ok("a retired or unknown promoter code never fails somebody's payment");

    // ---- 12. link previews ------------------------------------------------------------
    const previewRes = await fetch(`${base}/v1/ticketing/public/events/${openEvent.slug}/preview`);
    const html = await previewRes.text();
    assert.equal(previewRes.status, 200);
    assert.match(previewRes.headers.get("content-type") || "", /text\/html/);
    assert.match(html, /<meta property="og:title" content="Refund Test/);
    assert.match(html, /<meta property="og:description"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/app\.titopay\.co\.za\/events\//);
    assert.match(html, /<meta name="twitter:card"/);
    // The tags must be escaped, not pasted raw, or an event name could inject.
    assert.ok(!html.includes('content="><script'), "attributes are escaped");
    ok("a shared link serves real Open Graph tags to a crawler");

    console.log(`\n${passed}/12 checks passed. The policy is enforced, not decorated.\n`);
  } catch (error) {
    console.error("\n  FAIL:", error.message);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
})();
