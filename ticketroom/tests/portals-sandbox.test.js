// One account, one portal (account types) and the payment sandbox.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const reconciliation = require("../src/modules/finance/reconciliation");

let owner, admin, admin2, finance, fan, ev, A;
before(async () => {
  await h.setup();
  // The first admin is the platform owner.
  admin = await h.user({ roles: ["admin"], name: "Owner Admin" });
  admin2 = await h.user({ roles: ["admin"], name: "Second Admin" });
  finance = await h.user({ roles: ["finance"] });
  owner = await h.user({ name: "Org Owner" });
  fan = await h.user({ name: "Fan Buyer" });
  // Live now, so tickets can be scanned.
  ev = await h.organiserWithEvent(owner, { startsAt: new Date(Date.now() - 3600e3), types: [["GA", 20000, 50]] });
  A = `/api/organiser/${ev.organiser.id}`;
});
after(async () => {
  h.config.payments.provider = "simulated";
  await h.teardown();
});

const anon = () => new h.HttpClient();
const login = (email, portal) => anon().post("/api/auth/login", { email, password: h.PASSWORD, ...(portal ? { portal } : {}) });
const lastMail = (to) => h.one("SELECT subject, body FROM message_outbox WHERE to_address = $1 ORDER BY created_at DESC LIMIT 1", [to]);

// ------------------------------------------------------------------ account types
test("each account signs in on its own portal only; staff are never told apart", async () => {
  assert.equal((await login(fan.user.email, "customer")).status, 200);
  assert.equal((await login(fan.user.email, "site")).status, 200);
  assert.equal((await login(fan.user.email, "scanner")).status, 200);
  const wrong = await login(fan.user.email, "organiser");
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, "wrong_portal");
  assert.equal((await login(owner.user.email, "organiser")).status, 200);
  assert.equal((await login(owner.user.email, "customer")).body.error.code, "wrong_portal");
  // The admin box never says what kind of account an email has.
  const notStaff = await login(fan.user.email, "admin");
  assert.equal(notStaff.status, 401);
  assert.equal(notStaff.body.error.code, "bad_credentials");
  // Staff sign in on the admin portal and nowhere else.
  assert.equal((await login(admin.user.email, "admin")).status, 200);
  for (const portal of ["site", "customer", "organiser", "scanner"]) {
    const r = await login(admin.user.email, portal);
    assert.equal(r.status, 401, portal);
    assert.equal(r.body.error.code, "bad_credentials");
  }
});

test("staff powers belong to staff accounts only; the customer API is for customers", async () => {
  const sneaky = await h.user({ name: "Role Row" });
  await h.db.query("INSERT INTO platform_roles (user_id, role) VALUES ($1,'admin')", [sneaky.user.id]);
  assert.equal((await sneaky.get("/api/admin/dashboard")).status, 403, "a role row on a customer account counts for nothing");
  assert.deepEqual((await sneaky.get("/api/auth/me")).body.user.platformRoles || [], []);
  assert.equal((await owner.get("/api/me/tickets")).status, 403);
  assert.equal((await admin.get("/api/me/tickets")).status, 403);
  assert.equal((await owner.get("/api/me/likes")).status, 200, "liking is open to anyone signed in");
  assert.equal((await fan.get("/api/me/tickets")).status, 200);
});

test("sign-up, forgotten passwords and closing an account follow the account type", async () => {
  const reg = await anon().post("/api/auth/register", { fullName: "Copy Cat", email: owner.user.email, password: "another-pass-123", acceptTerms: true });
  assert.equal(reg.status, 409);
  assert.equal(reg.body.error.code, "email_taken");
  const orgSignup = await anon().post("/api/organiser/signup", { fullName: "Fan Again", email: fan.user.email, password: "another-pass-123", organisation: "Fan Events", acceptTerms: true });
  assert.equal(orgSignup.body.error.code, "email_taken");
  const fresh = await anon().post("/api/organiser/signup", { fullName: "New Org", email: "new.org@test.local", password: "another-pass-123", organisation: "New Org Events", acceptTerms: true });
  assert.equal(fresh.status, 201);
  assert.equal((await h.one("SELECT account_type FROM users WHERE email = 'new.org@test.local'")).account_type, "organiser");
  // Only organiser accounts apply for an organisation.
  const apply = await fan.post("/api/organiser/apply", { name: "Fan Org", contactEmail: "fanorg@test.local" });
  assert.equal(apply.status, 403);
  assert.equal(apply.body.error.code, "not_organiser_account");

  // Staff passwords are never reset from the public sign-in; the answer is the same.
  const before = (await h.one("SELECT count(*)::int AS n FROM message_outbox WHERE to_address = $1", [admin2.user.email])).n;
  const fs = await anon().post("/api/auth/password/forgot", { email: admin2.user.email });
  const fc = await anon().post("/api/auth/password/forgot", { email: fan.user.email });
  assert.equal(fs.status, 200);
  assert.deepEqual(fs.body, fc.body);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM message_outbox WHERE to_address = $1", [admin2.user.email])).n, before);
  assert.match((await lastMail(fan.user.email)).body, /\/account#\/reset\//);

  assert.equal((await admin2.post("/api/auth/me/delete", { password: h.PASSWORD })).status, 403);
  const own = await owner.post("/api/auth/me/delete", { password: h.PASSWORD });
  assert.equal(own.status, 409);
  assert.equal(own.body.error.code, "owns_organisation");
});

test("organiser teams are organiser accounts; scanners never use a staff email", async () => {
  const add = await owner.post(`${A}/members`, { email: "team.mate@test.local", role: "manager" });
  assert.equal(add.status, 201);
  assert.equal(add.body.invited, true);
  assert.equal((await h.one("SELECT account_type FROM users WHERE email = 'team.mate@test.local'")).account_type, "organiser");
  const mail = await lastMail("team.mate@test.local");
  assert.match(mail.subject, /added you to their team/);
  assert.match(mail.body, /\/organisers#\/reset\//);
  const cust = await owner.post(`${A}/members`, { email: fan.user.email, role: "viewer" });
  assert.equal(cust.status, 409);
  assert.equal(cust.body.error.code, "not_organiser_account");
  const st = await owner.post(`${A}/events/${ev.event.id}/staff`, { email: finance.user.email });
  assert.equal(st.status, 409);
  assert.equal(st.body.error.code, "staff_account");
  const scanner = await owner.post(`${A}/events/${ev.event.id}/staff`, { email: "new.scanner@test.local" });
  assert.equal(scanner.body.invited, true);
  assert.equal((await h.one("SELECT account_type FROM users WHERE email = 'new.scanner@test.local'")).account_type, "customer");
  assert.match((await lastMail("new.scanner@test.local")).body, /\/scan#\/reset\//);
});

test("TicketRoom staff never act inside an organisation or at its gate", async () => {
  assert.equal((await admin.get(A)).status, 404);
  assert.equal((await admin.get(`${A}/events`)).status, 404);
  assert.equal((await admin.post("/api/staff/scan", { eventId: ev.event.id, payload: "TR1.x" })).status, 404);
  assert.deepEqual((await admin.get("/api/staff/events")).body.events, []);
});

test("admin: users exclude staff; staff are managed by the owner and admins", async () => {
  const all = (await admin.get("/api/admin/users")).body;
  assert.ok(!all.users.some((u) => u.account_type === "staff"));
  assert.ok(all.counts.customer >= 1 && all.counts.organiser >= 1);
  const orgs = (await admin.get("/api/admin/users?type=organiser")).body.users;
  assert.ok(orgs.length && orgs.every((u) => u.account_type === "organiser"));
  assert.equal((await admin.get(`/api/admin/users/${admin2.user.id}`)).status, 404, "staff are not in All users");
  assert.equal((await admin.post(`/api/admin/users/${admin2.user.id}/status`, { status: "suspended", reason: "testing" })).status, 404);

  const team = (await finance.get("/api/admin/staff")).body.staff;
  assert.equal(team.find((s) => s.id === admin.user.id).owner, true);
  assert.equal(team.find((s) => s.id === admin2.user.id).owner, false);
  // Only the owner changes the owner's account.
  assert.equal((await admin2.put(`/api/admin/staff/${admin.user.id}`, { roles: ["support"] })).status, 403);
  assert.equal((await admin2.post(`/api/admin/staff/${admin.user.id}/reset`)).status, 403);
  // An admin sends a staff member a new-password link to the admin portal.
  const reset = await admin.post(`/api/admin/staff/${finance.user.id}/reset`);
  assert.equal(reset.status, 200);
  const mail = await lastMail(finance.user.email);
  assert.equal(mail.subject, "Choose a new TicketRoom password");
  assert.match(mail.body, /\/admin#\/reset\//);
  assert.equal((await admin.post(`/api/admin/staff/${fan.user.id}/reset`)).status, 404, "customers are not staff");
  assert.equal((await finance.post(`/api/admin/staff/${admin2.user.id}/reset`)).status, 403, "admins only");
});

test("maintenance is enforced on the server for everyone but staff", async () => {
  assert.equal((await admin.put("/api/admin/settings/maintenance", { enabled: true, message: "Back soon" })).status, 200);
  try {
    const r = await login(fan.user.email, "customer");
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "maintenance");
    assert.equal((await login(admin2.user.email, "admin")).status, 200);
    assert.equal((await fan.get("/api/me/tickets")).status, 503);
    assert.equal((await admin.get("/api/admin/dashboard")).status, 200);
    assert.equal((await anon().get("/api/site")).status, 200, "the site settings read stays open");
  } finally {
    await admin.put("/api/admin/settings/maintenance", { enabled: false, message: "Back soon" });
  }
});

// ------------------------------------------------------------------ payment sandbox
let sandboxOrder;
test("an admin switches on the sandbox with their password; checkout shows test mode", async () => {
  assert.equal((await new h.HttpClient().get("/api/config")).body.paymentsTest, false);
  const wrong = await admin.post("/api/admin/integrations/payments/sandbox", { currentPassword: "not-my-password", kind: "ticketroom" });
  assert.equal(wrong.status, 401);
  assert.equal((await finance.post("/api/admin/integrations/payments/sandbox", { currentPassword: h.PASSWORD })).status, 403);
  const on = await admin.post("/api/admin/integrations/payments/sandbox", { currentPassword: h.PASSWORD, kind: "ticketroom" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.match(on.body.message, /sandbox is on/);
  assert.equal(h.config.payments.provider, "sandbox");
  assert.equal((await new h.HttpClient().get("/api/config")).body.paymentsTest, true);
  const integ = (await admin.get("/api/admin/integrations")).body.integrations.find((i) => i.key === "payments");
  assert.equal(integ.environment, "test");
  assert.equal(integ.webhookUrl, null);
  assert.equal(integ.sandbox, "ticketroom");
  assert.equal((await admin.get("/api/admin/dashboard")).body.ops.payments_test, 1);
  assert.equal((await admin.post("/api/admin/integrations/payments/health")).body.ok, true);
});

test("sandbox purchase: decline, retry, approve; the order and tickets are TEST", async () => {
  const r = await h.buy(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const url = r.body.payment.redirectUrl;
  assert.match(url, /^\/pay\?p=[0-9a-f-]{36}&m=sandbox&k=/, "relative, to TicketRoom's own page");
  const q = new URL(url, h.baseUrl).searchParams;
  const id = q.get("p"), k = q.get("k");
  assert.equal((await anon().get(`/api/public/payments/${id}/sandbox?k=bad`)).status, 404);
  const page = await anon().get(`/api/public/payments/${id}/sandbox?k=${encodeURIComponent(k)}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.payment.amountCents, 2 * (20000 + 1000));
  assert.equal(page.body.order.reference, r.body.order.reference);
  // The card is declined: nothing is paid and the order is still waiting.
  const no = await anon().post(`/api/public/payments/${id}/sandbox`, { k, outcome: "failed" });
  assert.equal(no.body.result, "failed");
  assert.match(no.body.returnUrl, new RegExp(`^/orders/${r.body.order.reference}\\?k=`));
  assert.equal((await anon().post(`/api/public/payments/${id}/sandbox`, { k, outcome: "paid" })).body.error.code, "payment_closed");
  assert.equal((await fan.get(`/api/public/orders/${r.body.order.reference}`)).body.order.status, "pending_payment");
  // Try again and approve.
  const again = await fan.post(`/api/public/orders/${r.body.order.reference}/pay`);
  const q2 = new URL(again.body.payment.redirectUrl, h.baseUrl).searchParams;
  const yes = await anon().post(`/api/public/payments/${q2.get("p")}/sandbox`, { k: q2.get("k"), outcome: "paid" });
  assert.equal(yes.body.result, "confirmed");
  const o = await fan.get(`/api/public/orders/${r.body.order.reference}`);
  assert.equal(o.body.order.status, "paid");
  assert.equal(o.body.order.test, true);
  assert.ok(o.body.tickets.length === 2 && o.body.tickets.every((t) => t.test === true));
  assert.ok((await h.ticketsOf(fan)).filter((t) => t.order_reference === r.body.order.reference).every((t) => t.test === true));
  const mail = await h.one("SELECT subject, body FROM message_outbox WHERE to_address = $1 AND subject LIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 1", [fan.user.email, r.body.order.reference]);
  assert.match(mail.subject, /^\[TEST\] /);
  assert.match(mail.body, /This is a TEST order/);
  assert.equal((await h.one("SELECT environment FROM payments WHERE id = $1", [q2.get("p")])).environment, "test");
  sandboxOrder = await h.one("SELECT * FROM orders WHERE reference = $1", [r.body.order.reference]);
  // Nobody outside TicketRoom can notify about a sandbox payment.
  const hook = await fetch(`${h.baseUrl}/api/webhooks/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(hook.status, 400);
});

test("test tickets are refused at the gate, online and offline", async () => {
  const t = (await h.ticketsOf(fan)).find((x) => x.order_reference === sandboxOrder.reference);
  const r = await owner.post("/api/staff/scan", { eventId: ev.event.id, payload: t.qrPayload });
  assert.equal(r.body.outcome, "test_ticket");
  assert.equal((await h.one("SELECT status FROM tickets WHERE id = $1", [t.id])).status, "valid", "not admitted");
  const pack = await owner.get(`/api/staff/events/${ev.event.id}/offline-pack`);
  const row = pack.body.tickets.find((x) => x[0] === t.code);
  assert.equal(row[2], 0);
  assert.equal(row[4], "Test ticket");
});

test("test money stays in test: ledger accounts, out of balances, sales and the ledger check", async () => {
  const code = `organiser_payable:${ev.organiser.id}:${ev.event.id}`;
  const bal = async (c) => Number((await h.one("SELECT COALESCE(SUM(e.amount_cents),0)::bigint AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1", [c])).s);
  assert.equal(await bal(code), 0, "nothing owed to the organiser");
  assert.ok(await bal(`test:${code}`) < 0, "the test ledger has it");
  assert.ok(await bal("test:provider_clearing:sandbox") > 0);
  const li = await reconciliation.ledgerIntegrity();
  assert.equal(li.balanced, true);
  assert.ok(li.testEntries > 0);
  assert.ok(li.clearing.every((c) => c.ok), JSON.stringify(li.clearing));
  assert.ok(!li.clearing.some((c) => c.account.startsWith("test:")));
  const dash = (await admin.get("/api/admin/dashboard")).body;
  assert.equal(Number(dash.sales.gmv_all), 0, "test orders are not sales");
  assert.equal(dash.ops.test_orders, 1);
  const an = (await owner.get(`${A}/events/${ev.event.id}/analytics`)).body;
  assert.equal(Number(an.totals.ticket_revenue_cents), 0);
  assert.equal(an.totals.orders, 0);
  assert.equal(Number((await owner.get(`${A}/dashboard`)).body.totals.revenueCents), 0);
  assert.equal(Number((await owner.get(`${A}/finance`)).body.totalCents), 0);
});

test("a sandbox refund completes at once, in the test ledger", async () => {
  const t = await h.one("SELECT id FROM tickets WHERE order_id = $1 LIMIT 1", [sandboxOrder.id]);
  const rq = await owner.post(`${A}/events/${ev.event.id}/orders/${sandboxOrder.id}/refund`, { reason: "practice refund", ticketIds: [t.id] });
  assert.equal(rq.status, 201, JSON.stringify(rq.body));
  const rf = await h.one("SELECT id, reference FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  const d = await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(d.body.refund.status, "completed");
  assert.equal(d.body.refund.provider_refund_reference, `SANDBOX-${rf.reference}`);
  assert.equal((await reconciliation.ledgerIntegrity()).balanced, true);
  const code = `organiser_payable:${ev.organiser.id}:${ev.event.id}`;
  assert.equal((await h.one("SELECT count(*)::int AS n FROM ledger_accounts WHERE code = $1", [code])).n, 0, "no real organiser account was ever touched");
});

test("live payments cannot be swapped for a test setup", async () => {
  const keep = { provider: h.config.payments.provider, env: h.config.integrations.yoco.env };
  h.config.payments.provider = "yoco"; h.config.integrations.yoco.env = "live";
  try {
    const r = await admin.post("/api/admin/integrations/payments/sandbox", { currentPassword: h.PASSWORD });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "live_mode");
    assert.equal((await new h.HttpClient().get("/api/config")).body.paymentsTest, false);
  } finally {
    h.config.payments.provider = keep.provider; h.config.integrations.yoco.env = keep.env;
  }
});

test("clearing test orders frees their places; switching off returns to the configured provider", async () => {
  // One more test order left unpaid: its held places go back too.
  const pending = await h.buy(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(pending.status, 201);
  const before = await h.one("SELECT quantity_sold, quantity_held FROM ticket_types WHERE id = $1", [ev.ticketTypes[0].id]);
  assert.equal((await admin.post("/api/admin/payments/clear-test", { currentPassword: "wrong-password" })).status, 401);
  const r = await admin.post("/api/admin/payments/clear-test", { currentPassword: h.PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cleared.orders, 2);
  assert.equal(r.body.cleared.tickets, 1, "one test ticket was still valid (the other was refunded)");
  assert.equal(r.body.testOrders, 0);
  const after = await h.one("SELECT quantity_sold, quantity_held FROM ticket_types WHERE id = $1", [ev.ticketTypes[0].id]);
  assert.equal(after.quantity_sold, before.quantity_sold - 1);
  assert.equal(after.quantity_held, before.quantity_held - 1);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM tickets WHERE test AND status = 'valid'")).n, 0);
  assert.equal((await h.one("SELECT status FROM orders WHERE id = $1", [sandboxOrder.id])).status, "cancelled");

  const off = await admin.req("DELETE", "/api/admin/integrations/payments/sandbox", { currentPassword: h.PASSWORD });
  assert.equal(off.status, 200);
  assert.equal(off.body.provider, "simulated");
  assert.equal((await new h.HttpClient().get("/api/config")).body.paymentsTest, false);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM platform_meta WHERE key = 'payments_override'")).n, 0);
  // Real orders again: not test, and they count.
  const live = await h.buyAndPay(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(live.order.status, "paid");
  assert.equal(live.order.test, false);
  const t = live.tickets[0];
  assert.equal(t.test, false);
});

test("PayFast's shared test account is a test setup too, and switches off cleanly", async () => {
  const before = { ...h.config.integrations.payfast };
  const on = await admin.post("/api/admin/integrations/payments/sandbox", { currentPassword: h.PASSWORD, kind: "payfast" });
  assert.equal(on.status, 200);
  assert.equal(h.config.payments.provider, "payfast");
  assert.equal(h.config.integrations.payfast.env, "sandbox");
  assert.match(h.config.integrations.payfast.processUrl, /^https:\/\/sandbox\.payfast\.co\.za\//);
  assert.equal((await new h.HttpClient().get("/api/config")).body.paymentsTest, true);
  const integ = (await admin.get("/api/admin/integrations")).body;
  assert.ok(!JSON.stringify(integ).includes(h.config.integrations.payfast.passphrase), "credentials are never shown");
  assert.equal((await admin.req("DELETE", "/api/admin/integrations/payments/sandbox", { currentPassword: h.PASSWORD })).status, 200);
  assert.equal(h.config.payments.provider, "simulated");
  assert.deepEqual({ ...h.config.integrations.payfast }, before);
});
