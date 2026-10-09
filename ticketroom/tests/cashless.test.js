const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const recon = require("../src/modules/finance/reconciliation");

let owner, admin, finance, cashier, fan, ev, vendor, terminalKey, products, tag, otherVendorKey;
const pos = (c, p, body, key = terminalKey) => c.req(body === undefined ? "GET" : "POST", p, body, { headers: { "x-terminal-key": key } });
const sale = (c, items, extra = {}) => pos(c, "/api/pos/sales", { items, tagInput: tag.payload, idempotencyKey: `s-${Math.random().toString(36).slice(2, 12)}`, ...extra });
const balance = async (c) => (await c.get(`/api/me/wallets/${ev.event.id}`)).body.balanceCents;

async function topUp(c, cents, action = "approve") {
  const r = await c.post(`/api/me/wallets/${ev.event.id}/topups`, { amountCents: cents, idempotencyKey: `t-${Math.random().toString(36).slice(2, 12)}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await h.completePayment(r.body.payment.redirectUrl, action);
  return r;
}

before(async () => {
  await h.setup();
  owner = await h.user({ name: "Owner" });
  admin = await h.user({ roles: ["admin"] });
  finance = await h.user({ roles: ["finance"] });
  cashier = await h.user({ name: "Cashier" });
  fan = await h.user({ name: "Fan" });
  ev = await h.organiserWithEvent(owner, { cashless: true, startsAt: new Date(Date.now() - 3600e3), types: [["GA", 10000, 100]] });
  const v = await owner.post(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/vendors`, { name: "Grill", commissionBps: 1000 });
  vendor = v.body.vendor;
  await owner.post(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/vendors/${vendor.id}/members`, { email: cashier.user.email, role: "cashier" });
  const t = await owner.post(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/vendors/${vendor.id}/terminals`, { label: "Till 1" });
  terminalKey = t.body.terminal.terminalKey;
  for (const [name, price] of [["Burger", 3000], ["Drink", 1500], ["Feast", 25000]]) await owner.post(`/api/pos/vendors/${vendor.id}/products`, { name, priceCents: price });
  products = (await pos(cashier, "/api/pos/context")).body.products;
  // A second vendor with its own terminal.
  const v2 = await owner.post(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/vendors`, { name: "Bar" });
  otherVendorKey = (await owner.post(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/vendors/${v2.body.vendor.id}/terminals`, { label: "Bar till" })).body.terminal.terminalKey;
  // Fan has a ticket and an active QR tag.
  await h.buyAndPay(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const b = await admin.post("/api/admin/tag-batches", { tagType: "qr_tag", mode: "generate", quantity: 3, eventId: ev.event.id });
  tag = b.body.tags[0];
  assert.equal((await fan.post("/api/me/tags/link", { displayCode: tag.displayCode, activationCode: tag.activationCode, eventId: ev.event.id })).status, 201);
});
after(h.teardown);

const P = (name) => products.find((p) => p.name === name).id;

test("top-up credits the balance only after the provider confirms", async () => {
  const r = await fan.post(`/api/me/wallets/${ev.event.id}/topups`, { amountCents: 10000, idempotencyKey: "topup-pending-1" });
  assert.equal(await balance(fan), 0);
  await h.completePayment(r.body.payment.redirectUrl, "decline");
  assert.equal(await balance(fan), 0);
  const st = await h.one("SELECT status FROM wallet_topups WHERE reference = $1", [r.body.topup.reference]);
  assert.equal(st.status, "failed");
  await topUp(fan, 10000);
  assert.equal(await balance(fan), 10000);
});

test("top-up limits and ticket requirement are enforced", async () => {
  assert.equal((await fan.post(`/api/me/wallets/${ev.event.id}/topups`, { amountCents: 100, idempotencyKey: "too-small-1" })).body.error.code, "topup_limits");
  const stranger = await h.user();
  assert.equal((await stranger.post(`/api/me/wallets/${ev.event.id}/topups`, { amountCents: 5000, idempotencyKey: "no-ticket-1" })).body.error.code, "no_ticket");
});

test("a POS sale charges server prices, not client prices, and posts commission", async () => {
  const r = await sale(cashier, [{ productId: P("Burger"), quantity: 2, priceCents: 1 }], { totalCents: 1 });
  assert.equal(r.body.status, "confirmed");
  assert.equal(r.body.totalCents, 6000);
  assert.equal(await balance(fan), 4000);
  const vendorOwed = await h.one("SELECT -SUM(e.amount_cents)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [`vendor_payable:${vendor.id}`]);
  assert.equal(Number(vendorOwed.s), 5400);
});

test("the same request key never charges twice; a different body with that key is refused", async () => {
  const key = "dup-key-0001";
  const items = [{ productId: P("Drink"), quantity: 1 }];
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => sale(cashier, items, { idempotencyKey: key })));
  for (const r of [a, b, c]) { assert.equal(r.status, 200); assert.equal(r.body.status, "confirmed"); }
  assert.equal(new Set([a, b, c].map((r) => r.body.reference)).size, 1);
  assert.equal(await balance(fan), 2500);
  const lookup = await pos(cashier, `/api/pos/sales/by-key/${key}`);
  assert.equal(lookup.body.reference, a.body.reference);
  const clash = await sale(cashier, [{ productId: P("Burger"), quantity: 1 }], { idempotencyKey: key });
  assert.equal(clash.status, 409);
  assert.equal((await pos(cashier, "/api/pos/sales/by-key/never-sent-key")).body.status, "not_found");
});

test("insufficient balance is declined and nothing is posted", async () => {
  const before = await h.one("SELECT count(*)::int AS n FROM journals");
  const r = await sale(cashier, [{ productId: P("Burger"), quantity: 1 }]);
  assert.equal(r.body.status, "declined");
  assert.equal(r.body.declineReason, "insufficient_funds");
  assert.equal(await balance(fan), 2500);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM journals")).n, before.n);
});

test("concurrent spending can never overdraw the balance", async () => {
  await topUp(fan, 7500); // balance 10 000
  const results = await Promise.all(Array.from({ length: 12 }, () => sale(cashier, [{ productId: P("Burger"), quantity: 1 }])));
  const ok = results.filter((r) => r.body.status === "confirmed").length;
  assert.equal(ok, 3);
  assert.equal(results.filter((r) => r.body.declineReason === "insufficient_funds").length, 9);
  assert.equal(await balance(fan), 1000);
});

test("purchases above the PIN threshold need the attendee's PIN, with lockout", async () => {
  await topUp(fan, 50000);
  let r = await sale(cashier, [{ productId: P("Feast"), quantity: 1 }]);
  assert.equal(r.body.declineReason, "pin_not_set");
  assert.equal((await fan.post("/api/auth/me/pin", { pin: "1234", password: h.PASSWORD })).status, 400);
  assert.equal((await fan.post("/api/auth/me/pin", { pin: "4826", password: h.PASSWORD })).status, 200);
  r = await sale(cashier, [{ productId: P("Feast"), quantity: 1 }]);
  assert.equal(r.body.declineReason, "pin_required");
  r = await sale(cashier, [{ productId: P("Feast"), quantity: 1 }], { pin: "0000" });
  assert.equal(r.body.declineReason, "pin_incorrect");
  r = await sale(cashier, [{ productId: P("Feast"), quantity: 1 }], { pin: "4826" });
  assert.equal(r.body.status, "confirmed");
  for (let i = 0; i < 5; i++) await sale(cashier, [{ productId: P("Feast"), quantity: 1 }], { pin: "1111" });
  r = await sale(cashier, [{ productId: P("Feast"), quantity: 1 }], { pin: "4826" });
  assert.equal(r.body.declineReason, "pin_locked");
  await h.db.query("UPDATE users SET pin_locked_until = NULL, pin_failed_attempts = 0 WHERE id = $1", [fan.user.id]);
});

test("a tag reported lost stops paying immediately", async () => {
  const tags = (await fan.get("/api/me/tags")).body.tags;
  assert.equal((await fan.post(`/api/me/tags/${tags[0].id}/lost`)).status, 200);
  const r = await sale(cashier, [{ productId: P("Drink"), quantity: 1 }]);
  assert.equal(r.body.declineReason, "tag_lost");
  // Replacement at the desk: balance follows the person, not the tag.
  const staff = owner; // organiser owners can run the desk
  const nb = (await admin.post("/api/admin/tag-batches", { tagType: "nfc_wristband", mode: "generate", quantity: 1, eventId: ev.event.id })).body.tags[0];
  const before = await balance(fan);
  assert.equal((await staff.post("/api/staff/tags/replace", { eventId: ev.event.id, oldTagId: tags[0].id, newTagInput: nb.payload })).status, 200);
  const ok = await pos(cashier, "/api/pos/sales", { items: [{ productId: P("Drink"), quantity: 1 }], tagInput: nb.payload, idempotencyKey: "after-replace-1" });
  assert.equal(ok.body.status, "confirmed");
  assert.equal(await balance(fan), before - 1500);
  tag = nb;
});

test("UID-only tags are refused for payment by default", async () => {
  const u = await h.user();
  await h.buyAndPay(u, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const imp = (await admin.post("/api/admin/tag-batches", { tagType: "nfc_card", mode: "import", uids: ["04AABBCCDDEEFF"], eventId: ev.event.id })).body.tags[0];
  assert.equal((await u.post("/api/me/tags/link", { displayCode: imp.displayCode, activationCode: imp.activationCode, eventId: ev.event.id })).status, 201);
  const r = await pos(cashier, "/api/pos/sales", { items: [{ productId: P("Drink"), quantity: 1 }], tagInput: "UID:04AABBCCDDEEFF", idempotencyKey: "uid-only-1" });
  assert.equal(r.body.declineReason, "tag_not_payment_enabled");
});

test("terminal and cashier must belong to the same vendor", async () => {
  assert.equal((await cashier.post("/api/pos/sales", { items: [{ productId: P("Drink"), quantity: 1 }], tagInput: tag.payload, idempotencyKey: "no-terminal-1" })).status, 401);
  assert.equal((await pos(cashier, "/api/pos/context", undefined, otherVendorKey)).status, 403);
  assert.equal((await pos(fan, "/api/pos/context")).status, 403);
  assert.equal((await pos(cashier, "/api/pos/context", undefined, "trk_forged")).status, 401);
  // A product id from another vendor cannot be sold here.
  const barProducts = await h.one("SELECT id FROM vendors WHERE name = 'Bar'");
  const p = await h.one("INSERT INTO products (vendor_id, name, price_cents) VALUES ($1,'Beer',100) RETURNING id", [barProducts.id]);
  assert.equal((await sale(cashier, [{ productId: p.id, quantity: 1 }])).status, 400);
});

test("suspended terminals cannot transact", async () => {
  const t = await h.one("SELECT id FROM terminals WHERE vendor_id = $1", [vendor.id]);
  await owner.patch(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/terminals/${t.id}`, { status: "suspended" });
  assert.equal((await sale(cashier, [{ productId: P("Drink"), quantity: 1 }])).status, 403);
  await owner.patch(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/terminals/${t.id}`, { status: "active" });
});

test("POS refunds need a second person and reverse the exact journal", async () => {
  const s = await sale(cashier, [{ productId: P("Drink"), quantity: 2 }]);
  assert.equal(s.body.status, "confirmed");
  const before = await balance(fan);
  const rq = await pos(cashier, `/api/pos/sales/${s.body.id}/refund`, { reason: "wrong order" });
  assert.equal(rq.status, 201);
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  // The cashier who asked cannot approve; a non-member cannot either.
  assert.equal((await cashier.post(`/api/organiser/${ev.organiser.id}/refunds/${rf.id}/decide`, { approve: true })).status, 404);
  assert.equal((await admin.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).status, 403);
  const ok = await owner.post(`/api/organiser/${ev.organiser.id}/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.refund.status, "completed");
  assert.equal(await balance(fan), before + 3000);
  // A second refund on the same sale is refused.
  assert.equal((await pos(cashier, `/api/pos/sales/${s.body.id}/refund`, { reason: "again" })).status, 409);
});

test("unused balance is refunded to the funding top-ups via the provider", async () => {
  const bal = await balance(fan);
  assert.ok(bal > 0);
  const r = await fan.post(`/api/me/wallets/${ev.event.id}/refund`);
  assert.equal(r.status, 201);
  assert.equal((await fan.post(`/api/me/wallets/${ev.event.id}/refund`)).status, 409);
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [r.body.refund.reference]);
  const d = await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.refund.status, "completed");
  assert.equal(await balance(fan), 0);
  const simRefunded = await h.one("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM sim_provider.refunds WHERE idempotency_key LIKE $1", [`refund:${rf.id}%`]);
  assert.equal(Number(simRefunded.s), bal);
});

test("the ledger balances and provider clearing matches captured money", async () => {
  const integrity = await recon.ledgerIntegrity();
  assert.equal(integrity.balanced, true);
  assert.ok(integrity.clearing.length >= 1);
  for (const c of integrity.clearing) assert.equal(c.ok, true, JSON.stringify(c));
});
