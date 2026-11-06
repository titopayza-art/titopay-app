const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const h = require("./helpers");
const { createMockServices } = require("../scripts/mock-services");
const outbox = require("../src/modules/messaging/outbox");

let mock, mockUrl, mockServer, owner, finance, admin, buyer, ev, A;
const i = h.config.integrations;

before(async () => {
  await h.setup();
  mock = createMockServices({ ticketroomUrl: h.baseUrl });
  mockServer = mock.app.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockUrl = `http://127.0.0.1:${mockServer.address().port}`;
  i.titopay.baseUrl = `${mockUrl}/titopay`; i.titopay.enabled = true;
  i.yoco.baseUrl = `${mockUrl}/yoco`;
  i.payfast.processUrl = `${mockUrl}/payfast/eng/process`; i.payfast.validateUrl = `${mockUrl}/payfast/eng/query/validate`;
  i.bulksms.baseUrl = `${mockUrl}/bulksms/v1`; i.clickatell.baseUrl = `${mockUrl}/clickatell`;
  owner = await h.user({ name: "Owner" });
  finance = await h.user({ roles: ["finance"] });
  admin = await h.user({ roles: ["admin"] });
  buyer = await h.user({ name: "Wallet Buyer", phone: "+27821112222" });
  ev = await h.organiserWithEvent(owner, { types: [["GA", 20000, 100]], cashless: true });
  A = `/api/organiser/${ev.organiser.id}`;
});
after(async () => { h.config.payments.provider = "simulated"; await new Promise((r) => mockServer.close(r)); await h.teardown(); });

const balanceOf = async (code) => Number((await h.one("SELECT COALESCE(SUM(e.amount_cents),0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [code])).s);

// ------------------------------------------------------------------ fees
test("consumer pays R10 per paid ticket; organiser pays 5% of ticket revenue", async () => {
  const b = await h.user();
  const o = await h.buyAndPay(b, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(o.order.totalCents, 40000 + 2000);
  assert.equal(o.order.feeCents, 2000);
  assert.equal(-(await balanceOf(`organiser_payable:${ev.organiser.id}:${ev.event.id}`)), 38000);
  assert.equal(-(await balanceOf("organiser_commission_revenue")), 2000);
  assert.equal(-(await balanceOf("platform_fee_revenue")), 2000);
  const an = await owner.get(`${A}/events/${ev.event.id}/analytics`);
  assert.equal(Number(an.body.totals.ticket_revenue_cents), 40000);
  assert.equal(an.body.totals.organiser_fee_cents, 2000);
  assert.equal(Number(an.body.totals.payableCents), 38000);
});

test("refunds return the commission pro rata and exactly in total", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { types: [["Odd", 3333, 10]] });
  const b = await h.user();
  await h.buyAndPay(b, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 3 }]);
  const order = await h.one("SELECT id, organiser_fee_cents FROM orders WHERE user_id = $1", [b.user.id]);
  assert.equal(Number(order.organiser_fee_cents), Math.round(9999 * 0.05));
  const tks = await h.ticketsOf(b);
  for (const t of tks) {
    const rq = await o.post(`/api/organiser/${e.organiser.id}/events/${e.event.id}/orders/${order.id}/refund`, { reason: "one by one", ticketIds: [t.id] });
    const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
    assert.equal((await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).body.refund.status, "completed");
  }
  const sum = await h.one("SELECT SUM(organiser_fee_cents)::bigint AS s FROM refunds WHERE order_id = $1", [order.id]);
  assert.equal(Number(sum.s), Number(order.organiser_fee_cents));
  assert.equal(await balanceOf(`organiser_payable:${e.organiser.id}:${e.event.id}`), 0);
});

test("admins can set a negotiated commission per organiser", async () => {
  const o = await h.user();
  const e = await h.organiserWithEvent(o, { types: [["GA", 10000, 10]] });
  assert.equal((await o.post(`/api/admin/organisers/${e.organiser.id}/commission`, { commissionBps: 300 })).status, 403);
  assert.equal((await admin.post(`/api/admin/organisers/${e.organiser.id}/commission`, { commissionBps: 300 })).status, 200);
  const b = await h.user();
  await h.buyAndPay(b, e.event, [{ ticketTypeId: e.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(Number((await h.one("SELECT organiser_fee_cents FROM orders WHERE user_id = $1", [b.user.id])).organiser_fee_cents), 300);
});

// ------------------------------------------------------------------ free events
test("organisers can set up free events: no payment, no fees, prices locked at R0", async () => {
  const start = new Date(Date.now() + 5 * 864e5);
  const r = await owner.post(`${A}/events`, { title: "Community Braai Day", category: "food", venueName: "Park", city: "Soweto", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3600e3).toISOString(), capacity: 200, isFree: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.event.is_free, true);
  const d = await owner.get(`${A}/events/${r.body.event.id}`);
  assert.equal(d.body.ticketTypes.length, 1);
  assert.equal(d.body.ticketTypes[0].price_cents, 0);
  assert.equal(d.body.ticketTypes[0].quantity_total, 200);
  const paid = await owner.post(`${A}/events/${r.body.event.id}/ticket-types`, { name: "VIP", priceCents: 5000, quantityTotal: 10 });
  assert.equal(paid.status, 409);
  assert.equal(paid.body.error.code, "free_event");
  assert.equal((await owner.post(`${A}/events/${r.body.event.id}/ticket-types`, { name: "Kids", priceCents: 0, quantityTotal: 50 })).status, 201);
  await owner.post(`${A}/events/${r.body.event.id}/submit`);
  await admin.post(`/api/admin/events/${r.body.event.id}/status`, { action: "publish" });
  const pub = await h.HttpClient.prototype.get.call(Object.assign(new h.HttpClient()), `/api/public/events?free=1`);
  assert.ok(pub.body.events.some((e) => e.id === r.body.event.id && e.is_free));
  const b = await h.user();
  const order = await h.buy(b, { slug: r.body.event.slug }, [{ ticketTypeId: d.body.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(order.body.order.status, "paid");
  assert.equal(order.body.order.totalCents, 0);
  assert.equal(order.body.payment, null);
  const o2 = await h.one("SELECT fee_cents, organiser_fee_cents FROM orders WHERE reference = $1", [order.body.order.reference]);
  assert.deepEqual([Number(o2.fee_cents), Number(o2.organiser_fee_cents)], [0, 0]);
  await assert.rejects(h.db.query("UPDATE ticket_types SET price_cents = 100 WHERE event_id = $1", [r.body.event.id]), /free event/);
});

// ------------------------------------------------------------------ TitoPay wallet
let linkId;
test("linking a TitoPay wallet: OTP, wrong code, encrypted token", async () => {
  const pm = await buyer.get("/api/me/payment-methods");
  assert.equal(pm.body.titopayAvailable, true);
  const start = await buyer.post("/api/me/payment-methods/titopay/link", { phone: "082 111 2222" });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  assert.match(start.body.sentTo, /^\+2782\*+22$/);
  const wrong = await buyer.post("/api/me/payment-methods/titopay/confirm", { linkRequestId: start.body.linkRequestId, otp: "000000" });
  assert.equal(wrong.body.error.code, "otp_incorrect");
  const ok = await buyer.post("/api/me/payment-methods/titopay/confirm", { linkRequestId: start.body.linkRequestId, otp: start.body.devOtp });
  assert.equal(ok.status, 201);
  linkId = ok.body.link.id;
  const row = await h.one("SELECT token_enc FROM wallet_links WHERE id = $1", [linkId]);
  assert.doesNotMatch(row.token_enc, /wtk_/);
  assert.equal((await buyer.post("/api/me/payment-methods/titopay/link", { phone: "0821112222" })).body.error.code, "wallet_already_linked");
});

test("paying with the TitoPay wallet waits for approval in the TitoPay app", async () => {
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }], { paymentMethod: "titopay_wallet" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.payment.redirectUrl, null);
  assert.equal(r.body.payment.awaitingApproval, true);
  let o = await buyer.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "pending_payment");
  const p = [...mock.state.payments.values()].find((x) => x.status === "pending_approval");
  await mock.decide(p, true);
  o = await buyer.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "paid");
  assert.equal(o.body.payment.method, "titopay_wallet");
  assert.equal(mock.state.wallets.get("+27821112222").balanceCents, 100000 - 21000);
  assert.ok(await balanceOf("provider_clearing:titopay") > 0);
});

test("a declined wallet payment issues nothing; refunds go back to the wallet", async () => {
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }], { paymentMethod: "titopay_wallet" });
  await mock.decide([...mock.state.payments.values()].find((x) => x.status === "pending_approval"), false);
  assert.equal((await buyer.get(`/api/public/orders/${r.body.order.reference}`)).body.payment.status, "failed");
  // Refund the earlier paid wallet order.
  const order = await h.one("SELECT o.id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.user_id = $1 AND p.method = 'titopay_wallet' AND o.status = 'paid'", [buyer.user.id]);
  const rq = await owner.post(`${A}/events/${ev.event.id}/orders/${order.id}/refund`, { reason: "changed plans", includeFees: true });
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  assert.equal((await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).body.refund.status, "completed");
  assert.equal(mock.state.wallets.get("+27821112222").balanceCents, 100000);
});

test("TitoPay webhooks must be signed; topping up a cashless balance from the wallet works", async () => {
  const raw = JSON.stringify({ id: "evt_forged", type: "payment.completed", data: { paymentId: "tpp_x", amountCents: 1 } });
  const forged = await fetch(`${h.baseUrl}/api/webhooks/titopay`, { method: "POST", headers: { "content-type": "application/json", "x-titopay-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}` }, body: raw });
  assert.equal(forged.status, 400);
  await h.buyAndPay(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const t = await buyer.post(`/api/me/wallets/${ev.event.id}/topups`, { amountCents: 5000, idempotencyKey: "wallet-topup-1", paymentMethod: "titopay_wallet" });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  await mock.decide([...mock.state.payments.values()].find((x) => x.status === "pending_approval"), true);
  assert.equal((await buyer.get(`/api/me/wallets/${ev.event.id}`)).body.balanceCents, 5000);
});

test("after unlinking, the wallet cannot be charged", async () => {
  assert.equal((await buyer.del(`/api/me/payment-methods/${linkId}`)).body.remote, "revoked");
  const r = await h.buy(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }], { paymentMethod: "titopay_wallet" });
  assert.equal(r.body.error.code, "wallet_not_linked");
});

// ------------------------------------------------------------------ card gateways
test("Yoco: hosted checkout, signed webhook, API refund", async () => {
  h.config.payments.provider = "yoco";
  const b = await h.user();
  const r = await h.buy(b, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.payment.redirectUrl, /\/yoco\/pay\/ch_/);
  const page = await fetch(r.body.payment.redirectUrl.replace(/\/yoco\/pay\//, "/yoco/pay/") + "/ok", { method: "POST", redirect: "manual" });
  assert.equal(page.status, 303);
  const o = await b.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "paid");
  const order = await h.one("SELECT id FROM orders WHERE reference = $1", [r.body.order.reference]);
  const rq = await owner.post(`${A}/events/${ev.event.id}/orders/${order.id}/refund`, { reason: "yoco refund" });
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  const done = await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(done.body.refund.status, "completed");
  assert.match(done.body.refund.provider_refund_reference, /^rf_/);
  const health = await admin.post("/api/admin/integrations/payments/health");
  assert.equal(health.body.ok, true, JSON.stringify(health.body));
  const bad = await fetch(`${h.baseUrl}/api/webhooks/yoco`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }, body: "{}" });
  assert.equal(bad.status, 400);
});

test("PayFast: signed hand-off form, validated ITN, manual refund completion", async () => {
  h.config.payments.provider = "payfast";
  const b = await h.user({ name: "Pay Fast" });
  const r = await h.buy(b, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  assert.match(r.body.payment.redirectUrl, /\/pay\/payfast\//);
  const handoff = await b.get(new URL(r.body.payment.redirectUrl).pathname);
  assert.equal(handoff.status, 200);
  assert.match(handoff.headers.get("content-security-policy"), new RegExp(`form-action 'self' ${mockUrl.replace(/\./g, "\\.")}`));
  const fields = [...handoff.body.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))]);
  assert.ok(fields.find(([k]) => k === "signature"));
  assert.equal(fields.find(([k]) => k === "amount")[1], "210.00");
  const proc = await fetch(i.payfast.processUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const html = await proc.text();
  assert.doesNotMatch(html, /Signature mismatch/);
  const action = html.match(/action="(\/payfast\/complete\/[^"]+\/COMPLETE)"/)[1];
  await fetch(mockUrl + action, { method: "POST", redirect: "manual" });
  assert.equal((await b.get(`/api/public/orders/${r.body.order.reference}`)).body.order.status, "paid");
  // A forged ITN (signature recomputed with a changed amount) is refused by PayFast's validate step.
  const payfast = require("../src/modules/payments/providers/payfast");
  const forged = [["m_payment_id", "00000000-0000-0000-0000-000000000000"], ["pf_payment_id", "1"], ["payment_status", "COMPLETE"], ["amount_gross", "1.00"], ["merchant_id", i.payfast.merchantId]];
  const res = await fetch(`${h.baseUrl}/api/webhooks/payfast`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams([...forged, ["signature", payfast.sign(forged)]]).toString() });
  assert.equal(res.status, 400);
  // PayFast refunds are completed by finance in the PayFast dashboard.
  const order = await h.one("SELECT id FROM orders WHERE reference = $1", [r.body.order.reference]);
  const rq = await owner.post(`${A}/events/${ev.event.id}/orders/${order.id}/refund`, { reason: "payfast refund", includeFees: true });
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  const d = await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(d.body.refund.status, "manual_pending");
  assert.equal((await h.one("SELECT status FROM orders WHERE id = $1", [order.id])).status, "paid");
  const done = await finance.post(`/api/admin/refunds/${rf.id}/complete-manually`, { providerReference: "PF-REFUND-123" });
  assert.equal(done.body.refund.status, "completed");
  assert.equal((await h.one("SELECT status FROM orders WHERE id = $1", [order.id])).status, "refunded");
  h.config.payments.provider = "simulated";
});

// ------------------------------------------------------------------ SMS
test("SMS is delivered through BulkSMS or Clickatell, and failures are retried", async () => {
  const send = async (provider, to) => {
    h.config.messaging.smsProvider = provider;
    await h.db.withTx((c) => outbox.enqueue(c, { channel: "sms", to, body: `Hello from ${provider}`, kind: "transactional" }));
    await outbox.deliverBatch(100);
    return h.one("SELECT status, provider, provider_message_id, last_error FROM message_outbox WHERE to_address = $1 ORDER BY created_at DESC LIMIT 1", [to]);
  };
  const a = await send("bulksms", "+27830000001");
  assert.equal(a.status, "sent");
  assert.ok(a.provider_message_id);
  const c = await send("clickatell", "+27830000002");
  assert.equal(c.status, "sent");
  assert.ok(mock.state.sms.some((m) => m.gateway === "clickatell" && m.to === "27830000002"));
  mock.state.fail.sms = true;
  const f = await send("bulksms", "+27830000003");
  assert.equal(f.status, "queued");
  assert.match(f.last_error, /503/);
  mock.state.fail.sms = false;
  await outbox.deliverBatch(100);
  assert.equal((await h.one("SELECT status FROM message_outbox WHERE to_address = '+27830000003'")).status, "sent");
  h.config.messaging.smsProvider = "log";
});

test("integration status shows environments and never exposes credentials", async () => {
  const r = await admin.get("/api/admin/integrations");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.defaults, { bookingFeeCents: 1000, bookingFeeBps: 0, organiserCommissionBps: 500 });
  const text = JSON.stringify(r.body);
  for (const secret of [i.yoco.secretKey, i.titopay.clientSecret, i.titopay.webhookSecret, i.payfast.passphrase]) assert.ok(!text.includes(secret));
  assert.ok(r.body.integrations.find((x) => x.key === "titopay").calls > 0);
  assert.equal((await buyer.get("/api/admin/integrations")).status, 403);
  const calls = await h.one("SELECT count(*)::int AS n FROM integration_calls WHERE integration = 'titopay' AND operation = 'create_payment'");
  assert.ok(calls.n >= 3);
});

test("with no card gateway configured, paid sales are refused before stock is held; free tickets still work", async () => {
  h.config.payments.provider = "none";
  const b = await h.user();
  const before = await h.one("SELECT quantity_held FROM ticket_types WHERE id = $1", [ev.ticketTypes[0].id]);
  const r = await h.buy(b, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "payments_not_configured");
  assert.equal((await h.one("SELECT quantity_held FROM ticket_types WHERE id = $1", [ev.ticketTypes[0].id])).quantity_held, before.quantity_held);
  assert.equal((await new h.HttpClient().get("/api/config")).body.cardPaymentsEnabled, false);
  const o = await h.user();
  const free = await h.organiserWithEvent(o, { types: [["Free", 0, 10]] });
  assert.equal((await h.buy(b, free.event, [{ ticketTypeId: free.ticketTypes[0].id, quantity: 1 }])).body.order.status, "paid");
  h.config.payments.provider = "simulated";
});

test("production refuses mock or sandbox integrations", () => {
  const base = { ...process.env, NODE_ENV: "production", DATABASE_URL: "postgres://x/y", QR_SIGNING_KEY: "a".repeat(64), TAG_PEPPER: "b".repeat(64), DATA_ENCRYPTION_KEY: "c".repeat(64), LINK_SIGNING_KEY: "d".repeat(64), SIM_PROVIDER_WEBHOOK_SECRET: "e".repeat(64), TITOPAY_WALLET_ENABLED: "false" };
  const load = (env) => { try { execFileSync(process.execPath, ["-e", "require('./src/config')"], { env: { ...base, ...env }, stdio: "pipe" }); return "ok"; } catch (e) { return String(e.stderr); } };
  assert.match(load({ PAYMENT_PROVIDER: "yoco", YOCO_ENV: "mock", YOCO_SECRET_KEY: "sk_test_x", YOCO_WEBHOOK_SECRET: "whsec_x" }), /never allowed in production/);
  assert.match(load({ PAYMENT_PROVIDER: "yoco", YOCO_ENV: "sandbox", YOCO_SECRET_KEY: "sk_test_x", YOCO_WEBHOOK_SECRET: "whsec_x" }), /Production needs "live"/);
  assert.match(load({ PAYMENT_PROVIDER: "simulated" }), /refused in production/);
  assert.equal(load({ PAYMENT_PROVIDER: "yoco", YOCO_ENV: "live", YOCO_SECRET_KEY: "sk_live_x", YOCO_WEBHOOK_SECRET: "whsec_x" }), "ok");
});
