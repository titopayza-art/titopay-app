const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const audit = require("../src/lib/audit");
const outbox = require("../src/modules/messaging/outbox");
const marketing = require("../src/modules/marketing/service");
const { verifyLink } = require("../src/lib/crypto");

let owner, finance, finance2, admin, ev, buyers;
const A = () => `/api/organiser/${ev.organiser.id}`;
before(async () => {
  await h.setup();
  owner = await h.user({ name: "Owner" });
  finance = await h.user({ roles: ["finance"] });
  finance2 = await h.user({ roles: ["finance"] });
  admin = await h.user({ roles: ["admin"] });
  ev = await h.organiserWithEvent(owner, { types: [["GA", 20000, 100]] });
  buyers = [];
  for (let i = 0; i < 3; i++) {
    const b = await h.user({ name: `Buyer ${i}`, phone: `+2782000000${i}` });
    await h.buyAndPay(b, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }], { marketingOptIn: { email: i < 2, sms: i === 0 } });
    buyers.push(b);
  }
});
after(h.teardown);

test("partial ticket refund: approve -> provider refund -> tickets void -> ledger", async () => {
  const [t1] = await h.ticketsOf(buyers[0]);
  const o = await h.one("SELECT id, total_cents FROM orders WHERE user_id = $1", [buyers[0].user.id]);
  const rq = await owner.post(`${A()}/events/${ev.event.id}/orders/${o.id}/refund`, { reason: "can't attend", ticketIds: [t1.id], includeFees: true });
  assert.equal(rq.status, 201);
  assert.equal(rq.body.refund.amountCents, 20000 + 1000);
  // The same ticket can't be refunded twice while one is open.
  assert.equal((await owner.post(`${A()}/events/${ev.event.id}/orders/${o.id}/refund`, { reason: "again", ticketIds: [t1.id] })).status, 409);
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  const d = await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(d.body.refund.status, "completed");
  const after = await h.one("SELECT status, refunded_cents FROM orders WHERE id = $1", [o.id]);
  assert.equal(after.status, "partially_refunded");
  assert.equal(Number(after.refunded_cents), 21000);
  const tk = await h.one("SELECT status FROM tickets WHERE id = $1", [t1.id]);
  assert.equal(tk.status, "refunded");
  const sold = await h.one("SELECT quantity_sold FROM ticket_types WHERE id = $1", [ev.ticketTypes[0].id]);
  assert.equal(sold.quantity_sold, 5);
});

test("a failed provider refund can be retried without paying twice", async () => {
  const o = await h.one("SELECT id FROM orders WHERE user_id = $1", [buyers[1].user.id]);
  const rq = await owner.post(`${A()}/events/${ev.event.id}/orders/${o.id}/refund`, { reason: "dup charge" });
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  // Make the provider refuse the first attempt.
  const pay = await h.one("SELECT provider_reference FROM payments WHERE order_id = $1", [o.id]);
  await h.db.query("UPDATE sim_provider.transactions SET status = 'failed' WHERE reference = $1", [pay.provider_reference]);
  const first = await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(first.status, 502);
  assert.equal((await h.one("SELECT status FROM refunds WHERE id = $1", [rf.id])).status, "failed");
  await h.db.query("UPDATE sim_provider.transactions SET status = 'paid' WHERE reference = $1", [pay.provider_reference]);
  const retry = await finance.post(`/api/admin/refunds/${rf.id}/retry`);
  assert.equal(retry.body.refund.status, "completed");
  await finance.post(`/api/admin/refunds/${rf.id}/retry`); // a stray extra retry
  const n = await h.one("SELECT count(*)::int AS n, SUM(amount_cents)::bigint AS s FROM sim_provider.refunds WHERE transaction_ref = $1", [pay.provider_reference]);
  assert.equal(n.n, 1);
});

test("payout availability waits for the event to end plus the hold period", async () => {
  const fin = await owner.get(`${A()}/finance`);
  assert.ok(fin.body.totalCents > 0);
  assert.equal(fin.body.availableCents, 0);
  // Bank details are checked first; availability is 0 until the event has ended + hold.
  assert.equal((await owner.post(`${A()}/payouts`, { amountCents: 10000 })).body.error.code, "no_bank_details");
});

test("payouts: bank details required, maker-checker approval, EFT recorded in the ledger", async () => {
  await h.db.query("UPDATE events SET starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' WHERE id = $1", [ev.event.id]);
  assert.equal((await owner.post(`${A()}/payouts`, { amountCents: 10000 })).body.error.code, "no_bank_details");
  await owner.put(`${A()}/bank`, { bankName: "FNB", accountHolder: "Org", accountNumber: "62000001234", branchCode: "250655" });
  const fin = (await owner.get(`${A()}/finance`)).body;
  assert.equal(fin.availableCents, fin.totalCents);
  assert.equal((await owner.post(`${A()}/payouts`, { amountCents: fin.availableCents + 1 })).status, 409);
  const p = await owner.post(`${A()}/payouts`, { amountCents: fin.availableCents });
  assert.equal(p.status, 201);
  assert.equal((await owner.post(`${A()}/payouts`, { amountCents: 10000 })).status, 409); // one in flight
  assert.equal((await admin.post(`/api/admin/payouts/${p.body.payout.id}/decide`, { approve: true })).status, 403);
  assert.equal((await finance.post(`/api/admin/payouts/${p.body.payout.id}/mark-paid`, { bankReference: "EFT123" })).status, 409);
  assert.equal((await finance.post(`/api/admin/payouts/${p.body.payout.id}/decide`, { approve: true })).body.payout.status, "approved");
  const reveal = await finance.post(`/api/admin/payouts/${p.body.payout.id}/reveal-account`);
  assert.equal(reveal.body.accountNumber, "62000001234");
  const paid = await finance2.post(`/api/admin/payouts/${p.body.payout.id}/mark-paid`, { bankReference: "FNB-EFT-778" });
  assert.equal(paid.body.payout.status, "paid");
  const after = (await owner.get(`${A()}/finance`)).body;
  assert.equal(after.totalCents, 0);
  const logged = await h.one("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('payout.paid','bank_account.revealed')");
  assert.equal(logged.n, 2);
});

test("a payout cannot be approved by the person who requested it", async () => {
  const both = await h.user({ roles: ["finance"] });
  await h.db.query("INSERT INTO organiser_members (organiser_id, user_id, role) VALUES ($1,$2,'finance')", [ev.organiser.id, both.user.id]);
  const b = await h.user();
  await h.db.query("UPDATE events SET status = 'published' WHERE id = $1", [ev.event.id]);
  const e2 = await h.addEvent(ev.organiser.id, { startsAt: new Date(Date.now() - 20 * 864e5), types: [["GA", 20000, 10]] });
  await h.db.query("UPDATE events SET starts_at = now() + interval '1 day', ends_at = now() + interval '2 days' WHERE id = $1", [e2.event.id]);
  await h.buyAndPay(b, e2.event, [{ ticketTypeId: e2.ticketTypes[0].id, quantity: 1 }]);
  await h.db.query("UPDATE events SET starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' WHERE id = $1", [e2.event.id]);
  const p = await both.post(`${A()}/payouts`, { amountCents: 10000 });
  assert.equal(p.status, 201);
  assert.equal((await both.post(`/api/admin/payouts/${p.body.payout.id}/decide`, { approve: true })).status, 403);
});

test("reconciliation matches clean data and flags every kind of discrepancy", async () => {
  const from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 864e5).toISOString();
  const clean = await finance.post("/api/admin/reconciliation", { provider: "simulated", from, to });
  assert.equal(clean.status, 201, JSON.stringify(clean.body));
  assert.equal(clean.body.run.summary.exceptions, 0);
  assert.ok(clean.body.run.summary.matched >= 4);
  // Build a provider CSV that disagrees with us.
  const pays = (await h.db.query("SELECT provider_reference, amount_cents, refunded_cents FROM payments WHERE status IN ('confirmed','partially_refunded','refunded') ORDER BY created_at")).rows;
  const lines = ["reference,amount_cents,status,refunded_cents"];
  lines.push(`${pays[0].provider_reference},${pays[0].amount_cents + 100},paid,${pays[0].refunded_cents}`);   // amount mismatch
  lines.push("SIM-UNKNOWN0001,5000,paid,0");                                                                // we have no record
  for (const p of pays.slice(2)) lines.push(`${p.provider_reference},${p.amount_cents},paid,${p.refunded_cents}`); // pays[1] missing at provider
  const run = await finance.post("/api/admin/reconciliation", { provider: "simulated", from, to, csv: lines.join("\n") });
  const items = (await finance.get(`/api/admin/reconciliation/${run.body.run.id}`)).body.items;
  const outcome = (o) => items.filter((i) => i.outcome === o).length;
  assert.equal(outcome("amount_mismatch"), 1);
  assert.equal(outcome("missing_internal"), 1);
  assert.equal(outcome("missing_provider"), 1);
  const item = items.find((i) => i.outcome === "missing_internal");
  assert.equal((await finance.post(`/api/admin/reconciliation/items/${item.id}/resolve`, { note: "Provider test txn, confirmed with provider support" })).status, 200);
});

test("tampering with the audit log outside the application is detected", async () => {
  assert.equal((await audit.verifyChain()).ok, true);
  // The table owner can disable triggers; production must run the app as a
  // non-owner role (docs/SECURITY.md). Even so, the chain exposes the edit.
  await h.db.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only");
  await h.db.query("UPDATE audit_log SET details = '{\"amountCents\":1}' WHERE action = 'payout.paid'");
  await h.db.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only");
  const r = await audit.verifyChain();
  assert.equal(r.ok, false);
  assert.ok(r.brokenAt);
});

// ------------------------------------------------------------------ marketing
test("campaign audience is only buyers who opted in for that organiser and channel", async () => {
  const s = await owner.get(`${A()}/marketing/audience`);
  assert.equal(s.body.emailOptIns, 2);
  assert.equal(s.body.smsOptIns, 1);
  // A buyer of another organiser who opted in there is not included.
  const other = await h.user();
  const evB = await h.organiserWithEvent(await h.user());
  await h.buyAndPay(other, evB.event, [{ ticketTypeId: evB.ticketTypes[0].id, quantity: 1 }], { marketingOptIn: { email: true } });
  assert.equal((await owner.get(`${A()}/marketing/audience`)).body.emailOptIns, 2);
});

test("sending a campaign queues one message per recipient with opt-out, never twice", async () => {
  const c = await owner.post(`${A()}/campaigns`, { channel: "email", name: "Next show", subject: "We're back", body: "Hi {{first_name}}, new dates are out!" });
  assert.equal(c.status, 201);
  const sent = await owner.post(`${A()}/campaigns/${c.body.campaign.id}/send`, {});
  assert.equal(sent.body.campaign.recipients_count, 2);
  assert.equal((await owner.post(`${A()}/campaigns/${c.body.campaign.id}/send`, {})).status, 409);
  const msgs = (await h.db.query("SELECT * FROM message_outbox WHERE campaign_id = $1", [c.body.campaign.id])).rows;
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => /Unsubscribe: http/.test(m.body) && /powered by TitoPay/.test(m.body)));
  assert.ok(msgs.some((m) => m.body.startsWith("Hi Buyer, new dates")));
});

test("unsubscribing is honoured even for messages already queued", async () => {
  const c = await owner.post(`${A()}/campaigns`, { channel: "email", name: "Reminder", subject: "Reminder", body: "Doors open at six." });
  await owner.post(`${A()}/campaigns/${c.body.campaign.id}/send`, {});
  const msg = await h.one("SELECT body FROM message_outbox WHERE campaign_id = $1 AND user_id = $2", [c.body.campaign.id, buyers[0].user.id]);
  const token = msg.body.match(/unsubscribe\?t=([^\s]+)/)[1];
  assert.equal(verifyLink(token).o, ev.organiser.id);
  assert.equal((await new h.HttpClient().post("/api/public/unsubscribe", { token })).status, 200);
  assert.equal((await new h.HttpClient().post("/api/public/unsubscribe", { token: token.slice(0, -2) + "xx" })).status, 400);
  await outbox.deliverBatch(500);
  const st = await h.one("SELECT status FROM message_outbox WHERE campaign_id = $1 AND user_id = $2", [c.body.campaign.id, buyers[0].user.id]);
  assert.equal(st.status, "suppressed");
  const other = await h.one("SELECT status FROM message_outbox WHERE campaign_id = $1 AND user_id = $2", [c.body.campaign.id, buyers[1].user.id]);
  assert.equal(other.status, "sent");
  assert.equal((await owner.get(`${A()}/marketing/audience`)).body.emailOptIns, 1);
});

test("SMS campaigns are length-checked and costed by segment", async () => {
  assert.equal(marketing.smsSegments("a".repeat(160)), 1);
  assert.equal(marketing.smsSegments("a".repeat(161)), 2);
  assert.equal(marketing.smsSegments("🎉 party"), 1);
  assert.equal(marketing.smsSegments("🎉".repeat(40)), 2);
  assert.equal((await owner.post(`${A()}/campaigns`, { channel: "sms", name: "Long", body: "x".repeat(301) })).status, 400);
  const c = await owner.post(`${A()}/campaigns`, { channel: "sms", name: "Short", body: "Tickets for the next show go on sale Friday 10am." });
  const pv = await owner.get(`${A()}/campaigns/${c.body.campaign.id}/preview`);
  assert.equal(pv.body.recipients, 1);
  assert.ok(pv.body.estimatedCostCents > 0);
  assert.match(pv.body.preview.body, /Opt out: http/);
});

test("unapproved organisers cannot send marketing", async () => {
  const o2 = await h.user();
  const ap = await o2.post("/api/organiser/apply", { name: "Pending Org", contactEmail: "p@test.local" });
  const c = await o2.post(`/api/organiser/${ap.body.organiser.id}/campaigns`, { channel: "email", name: "Spam", subject: "x", body: "x" });
  const r = await o2.post(`/api/organiser/${ap.body.organiser.id}/campaigns/${c.body.campaign.id}/send`, {});
  assert.equal(r.body.error.code, "organiser_not_approved");
});

// ------------------------------------------------------------------ accounts / POPIA
test("registration, password reset and session revocation", async () => {
  const c = new h.HttpClient();
  const reg = await c.post("/api/auth/register", { fullName: "New Person", email: "New.Person@Test.Local", password: "long-enough-pass", acceptTerms: true });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, "new.person@test.local");
  assert.equal((await new h.HttpClient().post("/api/auth/register", { fullName: "Dup", email: "new.person@test.local", password: "long-enough-pass", acceptTerms: true })).status, 409);
  assert.equal((await new h.HttpClient().post("/api/auth/register", { fullName: "Short", email: "s@test.local", password: "short", acceptTerms: true })).status, 422);
  const f = await new h.HttpClient().post("/api/auth/password/forgot", { email: "new.person@test.local" });
  const token = f.headers.get("x-dev-reset-token");
  assert.ok(token);
  const ghost = await new h.HttpClient().post("/api/auth/password/forgot", { email: "ghost@test.local" });
  assert.deepEqual(ghost.body, f.body);
  assert.equal((await new h.HttpClient().post("/api/auth/password/reset", { token, password: "a-brand-new-password" })).status, 200);
  assert.equal((await new h.HttpClient().post("/api/auth/password/reset", { token, password: "again-new-password" })).status, 400);
  assert.equal((await c.get("/api/auth/me")).body.user, null); // old session revoked
});

test("data export and account deletion (POPIA)", async () => {
  const b = buyers[2];
  const exp = await b.get("/api/auth/me/export");
  assert.equal(exp.status, 200);
  assert.equal(exp.body.profile.email, b.user.email);
  assert.ok(exp.body.orders.length >= 1);
  // The event has ended (earlier test), so deletion is allowed; records stay, identity goes.
  assert.equal((await b.post("/api/auth/me/delete", { password: "wrong" })).status, 401);
  const live = await h.user();
  const evLive = await h.organiserWithEvent(await h.user());
  await h.buyAndPay(live, evLive.event, [{ ticketTypeId: evLive.ticketTypes[0].id, quantity: 1 }]);
  assert.equal((await live.post("/api/auth/me/delete", { password: h.PASSWORD })).body.error.code, "has_live_tickets");
  assert.equal((await b.post("/api/auth/me/delete", { password: h.PASSWORD })).status, 200);
  const u = await h.one("SELECT email, full_name, phone, status FROM users WHERE id = $1", [b.user.id]);
  assert.equal(u.status, "deleted");
  assert.equal(u.full_name, "Deleted user");
  assert.equal(u.phone, null);
  const ord = await h.one("SELECT buyer_email, total_cents FROM orders WHERE user_id = $1", [b.user.id]);
  assert.equal(ord.buyer_email, "deleted@invalid.ticketroom");
  assert.ok(ord.total_cents > 0);
  assert.equal((await new h.HttpClient().post("/api/auth/login", { email: b.user.email, password: h.PASSWORD })).status, 401);
});
