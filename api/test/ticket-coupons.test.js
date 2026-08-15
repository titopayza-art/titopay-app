"use strict";

// DISCOUNT CODES, PINNED.
//
// The end-to-end behaviour is proven against real wallets in
// verification/ticket-coupons-live.js. These contracts stop the parts that
// would be expensive to get wrong from drifting: the arithmetic, whose money
// funds the promotion, and the rule that the code is re-checked under a lock
// before anybody is charged.

process.env.NODE_ENV = "test";
// Requiring the ticketing service pulls in the config module, which refuses to
// load without these. Nothing here talks to a database or signs a real token.
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const TICKETING = read("src", "services", "ticketing-service.js");
const ROUTES = read("src", "routes", "ticketing.routes.js");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");
const { couponDiscountFor, normalizeCouponCode } = require("../src/services/ticketing-service");

test("a percentage takes a percentage, an amount takes an amount", () => {
  assert.equal(couponDiscountFor({ discount_type: "percentage", discount_value: 25 }, 400), 100);
  assert.equal(couponDiscountFor({ discount_type: "percentage", discount_value: 100 }, 400), 400);
  assert.equal(couponDiscountFor({ discount_type: "amount", discount_value: 50 }, 400), 50);
});

test("a discount can never exceed the ticket price, or go negative", () => {
  // The one that would hand money to a buyer if it were ever wrong.
  assert.equal(couponDiscountFor({ discount_type: "amount", discount_value: 500 }, 100), 100);
  assert.equal(couponDiscountFor({ discount_type: "percentage", discount_value: 250 }, 100), 100);
  assert.equal(couponDiscountFor({ discount_type: "amount", discount_value: 50 }, 0), 0);
  assert.equal(couponDiscountFor({ discount_type: "amount", discount_value: -50 }, 100), 0);
  assert.equal(couponDiscountFor({ discount_type: "percentage", discount_value: -10 }, 100), 0);
});

test("a code is whatever the person typed off the poster", () => {
  assert.equal(normalizeCouponCode(" summer25 "), "SUMMER25");
  assert.equal(normalizeCouponCode("save-10"), "SAVE-10");
  assert.equal(normalizeCouponCode("dr;op--table"), "DROP--TABLE");
  assert.equal(normalizeCouponCode(""), "");
  assert.equal(normalizeCouponCode(null), "");
});

test("the discount comes off the subtotal, so the organiser funds it", () => {
  // Fees are computed on the DISCOUNTED subtotal. If this ever reverts to the
  // list price, TitoPay would be charging commission on money the organiser
  // gave away and never received.
  assert.match(TICKETING, /subtotal = money\(listSubtotal - discount\)/);
  assert.match(TICKETING, /businessCommission = isFree \? 0 :[\s\S]{0,120}ticket_business_commission", subtotal/);
  assert.match(TICKETING, /buyerFee = isFree \? 0 :[\s\S]{0,120}ticket_buyer_service_fee", subtotal/);
  assert.match(TICKETING, /businessNet = money\(subtotal - businessCommission\)/);
});

test("a fully discounted ticket is free on the same terms as a free ticket", () => {
  // isFree is what suppresses the flat buyer fee; a 100% code must land in it.
  assert.match(TICKETING, /const isFree = subtotal <= 0/);
});

test("the code is re-resolved under a row lock inside the purchase", () => {
  const fn = TICKETING.slice(TICKETING.indexOf("async function purchaseTickets("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.match(body, /resolveCoupon\(client, \{[\s\S]{0,320}lock: true/,
    "the purchase must resolve the coupon on the transaction client, with a lock");
  assert.match(TICKETING, /lock \? " FOR UPDATE" : ""/);
  // ...and the redemption is taken in that same transaction as the money.
  assert.match(body, /UPDATE ticket_coupons[\s\S]{0,120}redeemed_count = redeemed_count \+ 1/);
  assert.match(body, /INSERT INTO ticket_coupon_redemptions/);
});

test("a buyer is never charged more than the screen showed", () => {
  const fn = TICKETING.slice(TICKETING.indexOf("async function purchaseTickets("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  assert.match(body, /if \(total > money\(preview\.total\)\)/,
    "the purchase must refuse rather than charge above the previewed total");
});

test("the money written to the order is the locked figure, never the preview's", () => {
  const fn = TICKETING.slice(TICKETING.indexOf("async function purchaseTickets("));
  const body = fn.slice(0, fn.indexOf("\nasync function "));
  const insert = body.slice(body.indexOf("INSERT INTO ticket_orders"));
  const values = insert.slice(0, insert.indexOf("));"));
  for (const stale of ["preview.subtotal", "preview.total", "preview.buyerFee", "preview.businessNet", "preview.businessCommission"]) {
    assert.ok(!values.includes(stale), `${stale} must not reach the order row`);
  }
  assert.match(values, /discount/);
});

test("a refunded sale gives the use back to the code", () => {
  assert.match(TICKETING, /UPDATE ticket_coupon_redemptions[\s\S]{0,140}released_at = NOW\(\)/);
  assert.match(TICKETING, /redeemed_count = GREATEST\(0, redeemed_count - 1\)/,
    "the counter can never be driven below zero");
});

test("the schema is additive, so orders written before this stay valid", () => {
  assert.match(TICKETING, /CREATE TABLE IF NOT EXISTS ticket_coupons/);
  assert.match(TICKETING, /CREATE TABLE IF NOT EXISTS ticket_coupon_redemptions/);
  assert.match(TICKETING, /ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS coupon_id UUID;/);
  assert.match(TICKETING, /ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC\(18,2\) NOT NULL DEFAULT 0;/);
  // One meaning per code per event, enforced by the database rather than by a
  // read-then-write that two organisers could interleave.
  assert.match(TICKETING, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_coupons_event_code/);
  // One redemption row per order, so a retry cannot double-count a code.
  assert.match(TICKETING, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_coupon_redemptions_order/);
});

test("every organiser coupon route is owner-scoped", () => {
  for (const route of [
    'router\\.get\\("/business/events/:id/coupons"',
    'router\\.post\\("/business/events/:id/coupons"',
    'router\\.put\\("/business/events/:id/coupons/:couponId"',
    'router\\.delete\\("/business/events/:id/coupons/:couponId"'
  ]) {
    assert.match(ROUTES, new RegExp(route), `${route} exists`);
  }
  // Each one resolves the event through requireEventOwner, which 404s on an
  // event the caller does not own.
  // Checked per route rather than by counting matches inside a slice: the
  // slice widened the moment other organiser routes were added between them.
  for (const marker of [
    'router.get("/business/events/:id/coupons"',
    'router.post("/business/events/:id/coupons"',
    'router.put("/business/events/:id/coupons/:couponId"',
    'router.delete("/business/events/:id/coupons/:couponId"'
  ]) {
    const start = ROUTES.indexOf(marker);
    assert.ok(start > -1, `${marker} exists`);
    const handler = ROUTES.slice(start, ROUTES.indexOf("\n});", start));
    assert.match(handler, /requireEventOwner\(req\)/, `${marker} goes through requireEventOwner`);
  }
});

test("a code that did not apply never travels to the payment call", () => {
  // The app sends only what the preview confirmed. Sending an unapplied code
  // would refuse the whole purchase at the till.
  assert.match(APP, /couponCode: context\.appliedCode \|\| undefined/);
  assert.match(APP, /appliedCode = preview\.couponCode \|\| null/);
  // The buyer's field is optional and clearly marked so.
  assert.match(APP, /name="couponCode"/);
  assert.match(APP, /Discount code <span class="muted">\(optional\)<\/span>/);
});

test("the organiser's door exists and says whose money funds the discount", () => {
  // The door was renamed to Promotions when promoter links joined discount
  // codes under it, rather than adding a seventh tile to the hub.
  assert.match(APP, /key: "coupons", label: "Promotions"/);
  assert.match(APP, /function ticketingCouponsSection/);
  assert.match(APP, /function refreshEventCouponList/);
  // The option labels shortened when the unit moved inside the field: the
  // select now says Percentage or Rand amount, and the field itself carries
  // the % or R, so the label no longer has to repeat it.
  assert.match(APP, /<option value="percentage">Percentage<\/option>/);
  assert.match(APP, /<option value="amount">Rand amount<\/option>/);
  assert.match(APP, /data-coupon-affix/, "the unit is shown inside the value field");
  assert.match(APP, /name="expiresAt"/);
  // Wording tightened from "it is funded by you" when the intro was cut from
  // five lines to one. The promise the test guards is unchanged: the screen
  // must say plainly whose money pays for the discount.
  assert.ok(APP.includes("You fund the discount"),
    "the screen states that the organiser funds the promotion");
});

test("no customer-facing coupon copy uses an em dash", () => {
  const section = APP.slice(APP.indexOf("function ticketingCouponsSection"), APP.indexOf("function ticketingVendorsSection"));
  assert.ok(!section.includes("—"), "em dashes are not used in customer-facing text");
});
