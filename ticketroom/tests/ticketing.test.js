const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const sim = require("../src/modules/payments/providers/simulated");
const orders = require("../src/modules/orders/service");

let owner, buyer, ev;
before(async () => {
  await h.setup();
  owner = await h.user({ name: "Owner" });
  buyer = await h.user({ name: "Buyer One" });
  ev = await h.organiserWithEvent(owner, { capacity: 10, types: [["GA", 20000, 10], ["VIP", 50000, 5]] });
});
after(h.teardown);

test("paid order issues tickets only after a verified provider webhook", async () => {
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.order.status, "pending_payment");
  // Fee: R3 + 4.5% of R200 = R12 per ticket.
  assert.equal(r.body.order.totalCents, 2 * 20000 + 2 * 1200);
  // Visiting the success page is not proof of payment.
  let o = await buyer.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "pending_payment");
  assert.equal(o.body.tickets.length, 0);
  await h.completePayment(r.body.payment.redirectUrl);
  o = await buyer.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "paid");
  assert.equal(o.body.tickets.length, 2);
  const tt = await h.one("SELECT quantity_sold, quantity_held FROM ticket_types WHERE id = $1", [ev.ticketTypes[0].id]);
  assert.deepEqual([tt.quantity_sold, tt.quantity_held], [2, 0]);
});

test("ledger records the sale as a balanced journal", async () => {
  const sum = await h.one("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM ledger_entries");
  assert.equal(Number(sum.s), 0);
  const j = await h.one("SELECT count(*)::int AS n FROM journals WHERE kind = 'ticket_sale'");
  assert.equal(j.n, 1);
  const fee = await h.one("SELECT -SUM(e.amount_cents)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'platform_fee_revenue'");
  assert.equal(Number(fee.s), 2400);
});

test("order creation is idempotent per key and client prices are ignored", async () => {
  const body = { eventSlug: ev.event.slug, items: [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1, priceCents: 1 }], idempotencyKey: "same-key-123456", totalCents: 1 };
  const a = await buyer.post("/api/public/orders", body);
  const b = await buyer.post("/api/public/orders", body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.body.order.reference, b.body.order.reference);
  assert.equal(a.body.order.totalCents, 20000 + 1200);
  await buyer.post(`/api/public/orders/${a.body.order.reference}/cancel`);
});

test("duplicate webhook delivery is processed once", async () => {
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[1].id, quantity: 1 }]);
  const ref = await h.completePayment(r.body.payment.redirectUrl);
  const { rows } = await h.db.query("SELECT * FROM sim_provider.transactions WHERE reference = $1", [ref]);
  const evtId = (await h.one("SELECT provider_event_id FROM webhook_events WHERE payload->'data'->>'reference' = $1", [ref])).provider_event_id;
  const status = await sim.deliverWebhook(rows[0], evtId);
  assert.equal(status, 200);
  const tickets = await h.one("SELECT count(*)::int AS n FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.reference = $1", [r.body.order.reference]);
  assert.equal(tickets.n, 1);
  const attempts = await h.one("SELECT attempts FROM webhook_events WHERE provider_event_id = $1", [evtId]);
  assert.equal(attempts.attempts, 2);
  // A new event id for the same payment is also harmless.
  await sim.deliverWebhook(rows[0]);
  const again = await h.one("SELECT count(*)::int AS n FROM journals WHERE reference = $1", [r.body.order.reference]);
  assert.equal(again.n, 1);
});

test("forged and replayed webhooks are rejected", async () => {
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const ref = r.body.payment.redirectUrl.split("/").pop();
  const raw = JSON.stringify({ id: "evt_forged_1", type: "payment.succeeded", data: { reference: ref, amount_cents: r.body.order.totalCents } });
  const forged = await fetch(`${h.baseUrl}/api/webhooks/simulated`, { method: "POST", headers: { "content-type": "application/json", "x-sim-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` }, body: raw });
  assert.equal(forged.status, 400);
  const stale = await fetch(`${h.baseUrl}/api/webhooks/simulated`, { method: "POST", headers: { "content-type": "application/json", "x-sim-signature": sim.sign(raw, Math.floor(Date.now() / 1000) - 3600) }, body: raw });
  assert.equal(stale.status, 400);
  const o = await buyer.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "pending_payment");
  const rejected = await h.one("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'rejected'");
  assert.ok(rejected.n >= 2);
  await buyer.post(`/api/public/orders/${r.body.order.reference}/cancel`);
});

test("a provider amount that differs from the order is not accepted as payment", async () => {
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const ref = r.body.payment.redirectUrl.split("/").pop();
  const raw = JSON.stringify({ id: "evt_mismatch_1", type: "payment.succeeded", data: { reference: ref, amount_cents: 100 } });
  const res = await fetch(`${h.baseUrl}/api/webhooks/simulated`, { method: "POST", headers: { "content-type": "application/json", "x-sim-signature": sim.sign(raw) }, body: raw });
  assert.equal(res.status, 200);
  const o = await buyer.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "pending_payment");
  assert.equal(o.body.tickets.length, 0);
  const p = await h.one("SELECT status, failure_reason FROM payments WHERE provider_reference = $1", [ref]);
  assert.equal(p.status, "failed");
  assert.match(p.failure_reason, /amount mismatch/);
  await buyer.post(`/api/public/orders/${r.body.order.reference}/cancel`);
});

test("concurrent checkouts never oversell", async () => {
  const owner2 = await h.user();
  const small = await h.organiserWithEvent(owner2, { capacity: 50, types: [["Tiny", 10000, 5]] });
  const buyers = await Promise.all(Array.from({ length: 20 }, () => h.user()));
  const results = await Promise.all(buyers.map((b) => h.buy(b, small.event, [{ ticketTypeId: small.ticketTypes[0].id, quantity: 1 }])));
  const ok = results.filter((r) => r.status === 201);
  const soldOut = results.filter((r) => r.status === 409 && r.body.error.code === "sold_out");
  assert.equal(ok.length, 5);
  assert.equal(soldOut.length, 15);
  const tt = await h.one("SELECT quantity_sold + quantity_held AS used FROM ticket_types WHERE id = $1", [small.ticketTypes[0].id]);
  assert.equal(tt.used, 5);
  // Pay all five concurrently; exactly five tickets exist.
  await Promise.all(ok.map((r) => h.completePayment(r.body.payment.redirectUrl)));
  const t = await h.one("SELECT count(*)::int AS n FROM tickets WHERE ticket_type_id = $1", [small.ticketTypes[0].id]);
  assert.equal(t.n, 5);
});

test("event capacity caps the sum of ticket types", async () => {
  const o = await h.user();
  const capped = await h.organiserWithEvent(o, { capacity: 3, types: [["A", 10000, 5], ["B", 10000, 5]] });
  const b = await h.user();
  assert.equal((await h.buy(b, capped.event, [{ ticketTypeId: capped.ticketTypes[0].id, quantity: 2 }])).status, 201);
  const r = await h.buy(b, capped.event, [{ ticketTypeId: capped.ticketTypes[1].id, quantity: 2 }]);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "sold_out");
});

test("abandoned checkout expires and releases its reservation", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { capacity: 10, types: [["X", 10000, 2]] });
  const b = await h.user();
  const r = await h.buy(b, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(r.status, 201);
  assert.equal((await h.buy(await h.user(), e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }])).status, 409);
  await h.db.query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE reference = $1", [r.body.order.reference]);
  const expired = await orders.expireDue();
  assert.ok(expired >= 1);
  const tt = await h.one("SELECT quantity_held FROM ticket_types WHERE id = $1", [e.ticketTypes[0].id]);
  assert.equal(tt.quantity_held, 0);
  const st = await h.one("SELECT status FROM orders WHERE reference = $1", [r.body.order.reference]);
  assert.equal(st.status, "expired");
});

test("expiry asks the provider first and keeps a paid order", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { types: [["X", 10000, 10]] });
  const b = await h.user();
  const r = await h.buy(b, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }]);
  // Buyer pays but the webhook never arrives.
  await h.completePayment(r.body.payment.redirectUrl, "approve-silent");
  await h.db.query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE reference = $1", [r.body.order.reference]);
  await orders.expireDue();
  const st = await h.one("SELECT status FROM orders WHERE reference = $1", [r.body.order.reference]);
  assert.equal(st.status, "paid");
});

test("payment arriving after expiry with stock gone becomes paid_unfulfilled with a refund", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { capacity: 10, types: [["Last", 10000, 1]] });
  const late = await h.user();
  const r = await h.buy(late, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }]);
  await h.db.query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE reference = $1", [r.body.order.reference]);
  // The provider has not been paid yet, so expiry proceeds.
  await orders.expireDue();
  const other = await h.user();
  await h.buyAndPay(other, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }]);
  // Now the late buyer completes payment on the stale page.
  await h.completePayment(r.body.payment.redirectUrl);
  const st = await h.one("SELECT id, status FROM orders WHERE reference = $1", [r.body.order.reference]);
  assert.equal(st.status, "paid_unfulfilled");
  const rf = await h.one("SELECT status, requested_by, amount_cents + fee_refund_cents AS total FROM refunds WHERE order_id = $1", [st.id]);
  assert.equal(rf.status, "requested");
  assert.equal(rf.requested_by, null);
  assert.equal(Number(rf.total), 10000 + 750);
  const tt = await h.one("SELECT quantity_sold FROM ticket_types WHERE id = $1", [e.ticketTypes[0].id]);
  assert.equal(tt.quantity_sold, 1);
});

test("promo codes discount correctly and respect max uses", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { types: [["P", 10000, 50]] });
  await h.db.query("INSERT INTO promo_codes (event_id, code, kind, value, max_uses) VALUES ($1,'HALF','percent',50,1)", [e.event.id]);
  const b = await h.user();
  const q = await b.post("/api/public/checkout/quote", { eventSlug: e.event.slug, items: [{ ticketTypeId: e.ticketTypes[0].id, quantity: 2 }], promoCode: "half" });
  assert.equal(q.body.quote.discountCents, 10000);
  assert.equal(q.body.quote.totalCents, 20000 - 10000 + 2 * 750);
  assert.equal((await h.buy(b, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }], { promoCode: "HALF" })).status, 201);
  const second = await h.buy(await h.user(), e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }], { promoCode: "HALF" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "promo_invalid");
});

test("free tickets are issued without a payment and with no fee", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { types: [["Free", 0, 10]] });
  const b = await h.user();
  const r = await h.buy(b, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.order.status, "paid");
  assert.equal(r.body.order.totalCents, 0);
  assert.equal(r.body.payment, null);
  assert.equal((await h.ticketsOf(b)).length, 2);
});

test("sales close when the event is not published", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o);
  await h.db.query("UPDATE events SET status = 'suspended' WHERE id = $1", [e.event.id]);
  const r = await h.buy(await h.user(), e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "sales_closed");
});
