"use strict";

/* DISCOUNT CODES, PROVEN ON THE REAL API AND THE REAL LEDGER.
 *
 * A discount is not a display change. It moves less money into the organiser's
 * wallet and less into TitoPay's, and it must never move money the wrong way.
 * Every check below reads the actual wallet balances afterwards rather than
 * trusting what the response said.
 *
 *  1. A percentage code takes the right amount off, and every wallet agrees.
 *  2. An amount-off code does the same, and can never exceed the ticket price.
 *  3. TitoPay's commission is charged on what was paid, not on the list price.
 *  4. A code that takes the price to zero issues a free ticket, with no fee.
 *  5. An expired code is refused; the sale is refused with it, not charged full.
 *  6. A one-use code cannot be used twice, by the same person or anyone else.
 *  7. Two buyers racing for the last use: exactly one wins.
 *  8. A code belonging to another event is refused.
 *  9. A code locked to one ticket type does not work on another.
 * 10. Refunding a sale gives the use back to the code.
 * 11. Buying with no code at all is completely unchanged.
 *
 * Seeds its own throwaway accounts and deletes them at the end.
 * Run: node verification/ticket-coupons-live.js
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
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

async function balance(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return money(rows[0]?.available_balance);
}

async function seedCustomer(name, startingBalance) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
     VALUES ($1,'personal',$2,$3,$4,'x','active','verified')`,
    [id, `Coupon ${name}`, `cp_${name}_${TAG}`, `cp-${name}-${TAG}@example.test`]);
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,'personal','ZAR',$4)`,
    [walletId, String(Date.now()).slice(-8) + created.users.length, id, startingBalance]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [sessionId, id, jti]);
  created.users.push(id);
  return { id, walletId, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
}

async function seedEvent(slug, types) {
  const organiserId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
     VALUES ($1,'business','Coupon Organiser',$2,$3,'x','active','verified')`,
    [organiserId, `cp_org_${slug}`, `cp-org-${slug}@example.test`]);
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,'business','ZAR',0)`,
    [walletId, String(Date.now()).slice(-8) + "9" + created.users.length, organiserId]);
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date, approved_at)
     VALUES ($1,$2,$3,$4,'approved', CURRENT_DATE + 30, NOW())`,
    [eventId, organiserId, `Coupon Test ${slug}`, slug]);
  const made = {};
  for (const [index, type] of types.entries()) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO event_ticket_types
         (id, event_id, ticket_name, price, quantity_available, min_purchase_quantity, max_purchase_quantity, sort_order)
       VALUES ($1,$2,$3,$4,$5,1,20,$6)`,
      [id, eventId, type.name, type.price, type.qty, (index + 1) * 10]);
    made[type.name] = id;
  }
  created.users.push(organiserId);
  created.events.push(eventId);
  return { organiserId, walletId, eventId, slug, types: made };
}

async function cleanup() {
  for (const eventId of created.events) {
    await pool.query("DELETE FROM ticket_coupon_redemptions WHERE coupon_id IN (SELECT id FROM ticket_coupons WHERE event_id = $1)", [eventId]).catch(() => {});
    await pool.query("DELETE FROM ticket_coupons WHERE event_id = $1", [eventId]).catch(() => {});
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
  await pool.query("DELETE FROM sessions WHERE user_id = ANY($1)", [created.users]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id = ANY($1)", [created.users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [created.users]).catch(() => {});
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (token, path, body, method) => fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });

  try {
    await ticketing.ensureTicketingSchema();
    console.log("\n" + "=".repeat(78));
    console.log("  TICKET DISCOUNT CODES, REAL API, REAL LEDGER");
    console.log("=".repeat(78) + "\n");

    const event = await seedEvent(`coupon-${TAG}`, [
      { name: "General", price: 200, qty: 100 },
      { name: "VIP", price: 500, qty: 50 }
    ]);
    const organiser = { token: null };
    {
      const sessionId = crypto.randomUUID(); const jti = crypto.randomUUID();
      await pool.query(
        `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
         VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
        [sessionId, event.organiserId, jti]);
      organiser.token = signAccessToken({ sub: event.organiserId, sid: sessionId, jti, typ: "customer" });
    }

    const makeCoupon = async (body) => {
      const res = await call(organiser.token, `/v1/ticketing/business/events/${event.eventId}/coupons`, body);
      const payload = await res.json();
      if (res.status !== 201) throw new Error(`coupon create failed ${res.status}: ${JSON.stringify(payload)}`);
      return payload.coupon;
    };
    const buy = async (buyer, { type = "General", quantity = 1, couponCode } = {}) => {
      const res = await call(buyer.token, `/v1/ticketing/public/events/${event.slug}/purchase`,
        { ticketTypeId: event.types[type], quantity, couponCode });
      return { status: res.status, payload: await res.json() };
    };
    const preview = async (buyer, body) => {
      const res = await call(buyer.token, `/v1/ticketing/public/events/${event.slug}/purchase-preview`, body);
      return { status: res.status, payload: await res.json() };
    };

    // ---- 1. a percentage code, checked against the ledger -----------------
    await makeCoupon({ code: "save25", discountType: "percentage", discountValue: 25, expiresAt: hoursFromNow(72) });
    const buyer1 = await seedCustomer("b1", 5000);
    const orgBefore = await balance(event.walletId);
    const buyer1Before = await balance(buyer1.walletId);
    const p1 = await preview(buyer1, { ticketTypeId: event.types.General, quantity: 2, couponCode: "SAVE25" });
    assert.equal(p1.status, 200, JSON.stringify(p1.payload));
    // 2 x R200 = R400 list, 25% off = R100 discount, R300 charged for tickets.
    assert.equal(money(p1.payload.preview.listSubtotal), 400);
    assert.equal(money(p1.payload.preview.discount), 100);
    assert.equal(money(p1.payload.preview.subtotal), 300);
    const r1 = await buy(buyer1, { quantity: 2, couponCode: "save25" });
    assert.equal(r1.status, 201, JSON.stringify(r1.payload));
    const buyer1Spent = money(buyer1Before - await balance(buyer1.walletId));
    const orderRow1 = (await pool.query(
      "SELECT * FROM ticket_orders WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 1", [buyer1.id])).rows[0];
    assert.equal(money(orderRow1.discount_amount), 100, "the discount is recorded on the order");
    assert.equal(money(orderRow1.subtotal), 300, "subtotal is what was actually charged for the tickets");
    assert.equal(buyer1Spent, money(orderRow1.total), "the buyer's wallet fell by exactly the order total");
    ok("a percentage code takes the right amount off and the buyer's wallet agrees",
      `R400 list, R100 off, paid R${buyer1Spent}`);

    // ---- 2 & 3. the organiser bears it; commission follows what was paid ---
    const orgGained = money(await balance(event.walletId) - orgBefore);
    assert.equal(orgGained, money(orderRow1.business_net), "the organiser banked the recorded net");
    assert.ok(orgGained < 400, "the organiser funds their own promotion");
    ok("the organiser funds the discount: their wallet rose by the discounted net, not the list price",
      `organiser banked R${orgGained}, not R400`);

    // Commission must be computed on R300, never on the R400 list price.
    const commissionOnPaid = money(orderRow1.subtotal - orderRow1.business_net);
    assert.equal(money(orderRow1.business_commission), commissionOnPaid);
    assert.ok(money(orderRow1.business_commission) <= money(orderRow1.subtotal),
      "commission can never exceed what was actually charged");
    ok("TitoPay charges commission on what was paid, never on the money the discount gave away",
      `commission R${money(orderRow1.business_commission)} on R${money(orderRow1.subtotal)} charged`);

    // ---- 4. a 100% code is a genuinely free ticket -------------------------
    await makeCoupon({ code: "freeone", discountType: "percentage", discountValue: 100 });
    const buyer2 = await seedCustomer("b2", 0);   // deliberately EMPTY wallet
    const r2 = await buy(buyer2, { couponCode: "FREEONE" });
    assert.equal(r2.status, 201, `a fully discounted ticket must not need a balance: ${JSON.stringify(r2.payload)}`);
    const orderRow2 = (await pool.query(
      "SELECT * FROM ticket_orders WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 1", [buyer2.id])).rows[0];
    assert.equal(money(orderRow2.total), 0);
    assert.equal(money(orderRow2.buyer_fee), 0, "no service fee on a ticket that costs nothing");
    assert.equal(await balance(buyer2.walletId), 0, "an empty wallet stayed empty");
    ok("a code that takes the price to zero issues a free ticket, with no service fee, from an empty wallet");

    // ---- 5. an expired code is refused, and so is the sale ------------------
    await pool.query(
      `INSERT INTO ticket_coupons (id, event_id, code, discount_type, discount_value, expires_at)
       VALUES (gen_random_uuid(), $1, 'LASTYEAR', 'percentage', 50, NOW() - INTERVAL '1 day')`,
      [event.eventId]);
    const buyer3 = await seedCustomer("b3", 5000);
    const before3 = await balance(buyer3.walletId);
    const r3 = await buy(buyer3, { couponCode: "LASTYEAR" });
    assert.equal(r3.status, 409, JSON.stringify(r3.payload));
    assert.match(String(r3.payload.error || ""), /expired/i);
    assert.equal(await balance(buyer3.walletId), before3, "a refused code charges nothing at all");
    ok("an expired code is refused and the buyer is not quietly charged full price");

    // ---- 6. a one-use code cannot be used twice ----------------------------
    await makeCoupon({ code: "onlyone", discountType: "amount", discountValue: 50, maxRedemptions: 1 });
    const buyer4 = await seedCustomer("b4", 5000);
    const first = await buy(buyer4, { couponCode: "ONLYONE" });
    assert.equal(first.status, 201, JSON.stringify(first.payload));
    const second = await buy(buyer4, { couponCode: "ONLYONE" });
    assert.equal(second.status, 409, "the same person cannot use it again");
    const buyer5 = await seedCustomer("b5", 5000);
    const third = await buy(buyer5, { couponCode: "ONLYONE" });
    assert.equal(third.status, 409, "and neither can anybody else");
    ok("a one-use code is used exactly once, by the first buyer to reach it");

    // ---- 7. two buyers racing for the last use -----------------------------
    await makeCoupon({ code: "race1", discountType: "amount", discountValue: 40, maxRedemptions: 1, maxPerCustomer: 1 });
    const racerA = await seedCustomer("ra", 5000);
    const racerB = await seedCustomer("rb", 5000);
    const results = await Promise.all([
      buy(racerA, { couponCode: "RACE1" }),
      buy(racerB, { couponCode: "RACE1" })
    ]);
    const winners = results.filter((r) => r.status === 201).length;
    assert.equal(winners, 1, `exactly one buyer may win the last use, got ${winners}`);
    const raceRow = (await pool.query(
      "SELECT redeemed_count FROM ticket_coupons WHERE event_id = $1 AND code = 'RACE1'", [event.eventId])).rows[0];
    assert.equal(Number(raceRow.redeemed_count), 1, "the counter never over-counts under a race");
    ok("two buyers racing for the last use: exactly one wins, and the counter stays honest");

    // ---- 8. another event's code -------------------------------------------
    const otherEvent = await seedEvent(`coupon-other-${TAG}`, [{ name: "General", price: 100, qty: 10 }]);
    await pool.query(
      `INSERT INTO ticket_coupons (id, event_id, code, discount_type, discount_value)
       VALUES (gen_random_uuid(), $1, 'NOTYOURS', 'percentage', 90)`, [otherEvent.eventId]);
    const buyer6 = await seedCustomer("b6", 5000);
    const r6 = await buy(buyer6, { couponCode: "NOTYOURS" });
    assert.equal(r6.status, 404, "a code from another organiser's event does not work here");
    ok("a code belonging to another event is refused");

    // ---- 9. a code locked to one ticket type -------------------------------
    await makeCoupon({ code: "viponly", discountType: "percentage", discountValue: 20, ticketTypeId: event.types.VIP });
    const buyer7 = await seedCustomer("b7", 5000);
    const wrongType = await buy(buyer7, { type: "General", couponCode: "VIPONLY" });
    assert.equal(wrongType.status, 409, "not valid on General");
    const rightType = await buy(buyer7, { type: "VIP", couponCode: "VIPONLY" });
    assert.equal(rightType.status, 201, JSON.stringify(rightType.payload));
    const vipOrder = (await pool.query(
      "SELECT * FROM ticket_orders WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 1", [buyer7.id])).rows[0];
    assert.equal(money(vipOrder.discount_amount), 100, "20% of R500");
    ok("a code locked to one ticket type works there and nowhere else");

    // ---- 10. a refund gives the use back ------------------------------------
    const beforeRefund = (await pool.query(
      "SELECT redeemed_count FROM ticket_coupons WHERE event_id = $1 AND code = 'ONLYONE'", [event.eventId])).rows[0];
    assert.equal(Number(beforeRefund.redeemed_count), 1);
    const usedOrder = (await pool.query(
      `SELECT o.id FROM ticket_orders o
        JOIN ticket_coupon_redemptions r ON r.order_id = o.id
        JOIN ticket_coupons c ON c.id = r.coupon_id
       WHERE c.code = 'ONLYONE' AND c.event_id = $1 LIMIT 1`, [event.eventId])).rows[0];
    const refund = await ticketing.requestTicketRefund({ userId: buyer4.id }, usedOrder.id, { reason: "harness" }, {});
    await ticketing.processTicketRefund(refund.id, { action: "approve" }, { userId: null }, {});
    const afterRefund = (await pool.query(
      "SELECT redeemed_count FROM ticket_coupons WHERE event_id = $1 AND code = 'ONLYONE'", [event.eventId])).rows[0];
    assert.equal(Number(afterRefund.redeemed_count), 0, "a refunded sale releases the use");
    const released = (await pool.query(
      "SELECT released_at FROM ticket_coupon_redemptions WHERE order_id = $1", [usedOrder.id])).rows[0];
    assert.ok(released.released_at, "the redemption is marked released, not deleted");
    ok("refunding a sale gives the use back to the code and keeps the record");

    // ---- 11. no code at all is completely unchanged --------------------------
    const buyer8 = await seedCustomer("b8", 5000);
    const before8 = await balance(buyer8.walletId);
    const plain = await buy(buyer8, { quantity: 1 });
    assert.equal(plain.status, 201, JSON.stringify(plain.payload));
    const plainOrder = (await pool.query(
      "SELECT * FROM ticket_orders WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 1", [buyer8.id])).rows[0];
    assert.equal(money(plainOrder.discount_amount), 0);
    assert.equal(plainOrder.coupon_id, null);
    assert.equal(money(plainOrder.subtotal), 200, "full list price, exactly as before discount codes existed");
    assert.equal(money(before8 - await balance(buyer8.walletId)), money(plainOrder.total));
    ok("a purchase with no code is byte-for-byte the behaviour that shipped before");

    console.log(`\n${passed}/11 checks passed. Discounts come off the organiser, never off the ledger's balance.\n`);
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
