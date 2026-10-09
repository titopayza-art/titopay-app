const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const migrate = require("../src/db/migrate");
const audit = require("../src/lib/audit");

let ownerA, ownerB, evA, evB, fan, admin, support, finance, marketingA;
before(async () => {
  await h.setup();
  ownerA = await h.user(); ownerB = await h.user(); fan = await h.user();
  admin = await h.user({ roles: ["admin"] }); support = await h.user({ roles: ["support"] }); finance = await h.user({ roles: ["finance"] });
  evA = await h.organiserWithEvent(ownerA); evB = await h.organiserWithEvent(ownerB);
  marketingA = await h.user();
  await h.db.query("INSERT INTO organiser_members (organiser_id, user_id, role) VALUES ($1,$2,'marketing')", [evA.organiser.id, marketingA.user.id]);
  await h.buyAndPay(fan, evA.event, [{ ticketTypeId: evA.ticketTypes[0].id, quantity: 1 }]);
});
after(h.teardown);

test("organisers cannot see or touch another organiser's data", async () => {
  const A = `/api/organiser/${evA.organiser.id}`;
  for (const p of ["", "/dashboard", "/finance", "/members", "/refunds", "/campaigns", `/events/${evA.event.id}`, `/events/${evA.event.id}/orders`, `/events/${evA.event.id}/attendees`, `/events/${evA.event.id}/analytics`, `/events/${evA.event.id}/vendors`]) {
    const r = await ownerB.get(A + p);
    assert.equal(r.status, 404, `GET ${p} leaked: ${r.status}`);
  }
  // B's organiser id with A's event id.
  assert.equal((await ownerB.get(`/api/organiser/${evB.organiser.id}/events/${evA.event.id}`)).status, 404);
  assert.equal((await ownerB.patch(`${A}/events/${evA.event.id}`, { title: "Hijacked" })).status, 404);
  assert.equal((await ownerB.post(`${A}/payouts`, { amountCents: 10000 })).status, 404);
  assert.equal((await ownerB.post(`/api/organiser/${evB.organiser.id}/campaigns`, { channel: "email", name: "Steal list", subject: "x", body: "x", eventIds: [evA.event.id] })).status, 400);
});

test("member roles are enforced inside an organisation", async () => {
  const A = `/api/organiser/${evA.organiser.id}`;
  assert.equal((await marketingA.get(`${A}/campaigns`)).status, 200);
  assert.equal((await marketingA.post(`${A}/payouts`, { amountCents: 10000 })).status, 403);
  assert.equal((await marketingA.put(`${A}/bank`, { bankName: "FNB", accountHolder: "X", accountNumber: "123456789", branchCode: "250655" })).status, 403);
  assert.equal((await marketingA.post(`${A}/members`, { email: fan.user.email, role: "manager" })).status, 403);
  const o = await h.one("SELECT id FROM orders WHERE event_id = $1 LIMIT 1", [evA.event.id]);
  assert.equal((await marketingA.post(`${A}/events/${evA.event.id}/orders/${o.id}/refund`, { reason: "nope" })).status, 403);
  assert.equal((await marketingA.get(`${A}`)).body.organiser.bank, null);
});

test("attendees cannot reach staff, admin or other people's tickets", async () => {
  for (const p of ["/api/admin/dashboard", "/api/admin/users", "/api/admin/refunds", "/api/admin/audit"]) assert.equal((await fan.get(p)).status, 403, p);
  const t = (await h.ticketsOf(fan))[0];
  const stranger = await h.user();
  assert.equal((await stranger.get(`/api/me/tickets/${t.id}/qr.svg`)).status, 404);
  assert.equal((await stranger.post(`/api/me/tickets/${t.id}/transfer`, { toEmail: "me@test.local" })).status, 404);
  const ord = await h.one("SELECT reference FROM orders WHERE user_id = $1", [fan.user.id]);
  assert.equal((await stranger.get(`/api/public/orders/${ord.reference}`)).status, 404);
});

test("financial approvals are separated from technical administration", async () => {
  const o = await h.one("SELECT id FROM orders WHERE event_id = $1 AND status = 'paid' LIMIT 1", [evA.event.id]);
  const rq = await ownerA.post(`/api/organiser/${evA.organiser.id}/events/${evA.event.id}/orders/${o.id}/refund`, { reason: "customer request" });
  assert.equal(rq.status, 201);
  const rf = await h.one("SELECT id FROM refunds WHERE reference = $1", [rq.body.refund.reference]);
  assert.equal((await admin.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).status, 403);
  assert.equal((await support.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).status, 403);
  assert.equal((await ownerA.post(`/api/organiser/${evA.organiser.id}/refunds/${rf.id}/decide`, { approve: true })).status, 404);
  assert.equal((await support.post(`/api/admin/users/${fan.user.id}/roles`, { role: "admin", grant: true })).status, 403);
  assert.equal((await admin.post(`/api/admin/users/${admin.user.id}/roles`, { role: "finance", grant: true })).status, 403);
  assert.equal((await admin.post("/api/admin/reconciliation", { provider: "simulated", from: new Date(0).toISOString(), to: new Date().toISOString() })).status, 403);
});

test("a finance officer cannot approve their own refund request", async () => {
  const both = await h.user({ roles: ["finance", "admin"] });
  const b = await h.user();
  await h.buyAndPay(b, evA.event, [{ ticketTypeId: evA.ticketTypes[0].id, quantity: 1 }]);
  await both.post(`/api/admin/events/${evA.event.id}/cancel`, { reason: "Venue flooded" });
  const rf = await h.one("SELECT r.id FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.user_id = $1", [b.user.id]);
  const self = await both.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true });
  assert.equal(self.status, 403);
  // And the database refuses it even if the application check were bypassed.
  await assert.rejects(h.db.query("UPDATE refunds SET decided_by = requested_by, status = 'approved' WHERE id = $1", [rf.id]), /check constraint/);
  assert.equal((await finance.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).body.refund.status, "completed");
});

test("state-changing requests need the session CSRF token and JSON", async () => {
  const noToken = await fan.req("PATCH", "/api/auth/me", { fullName: "CSRF Victim" }, { csrf: false });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error.code, "csrf_failed");
  const form = await fan.req("POST", "/api/auth/me/pin", "pin=4826&password=x", { contentType: "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
  const loginForm = await new h.HttpClient().req("POST", "/api/auth/login", "email=a@b.c&password=x", { contentType: "application/x-www-form-urlencoded" });
  assert.equal(loginForm.status, 415);
});

test("uploads accept only real images, by content not by header", async () => {
  const A = `/api/organiser/${evA.organiser.id}/uploads`;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await ownerA.req("POST", A, undefined, { raw: svg, contentType: "image/svg+xml" })).status, 415);
  const html = Buffer.from("<html><script>alert(1)</script></html>");
  assert.equal((await ownerA.req("POST", A, undefined, { raw: html, contentType: "image/png" })).status, 400);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const ok = await ownerA.req("POST", A, undefined, { raw: png, contentType: "image/png" });
  assert.equal(ok.status, 201);
  const served = await fetch(`${h.baseUrl}/media/${ok.body.uploadId}`);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("content-security-policy"), /sandbox/);
  assert.equal((await ownerB.req("POST", A, undefined, { raw: png, contentType: "image/png" })).status, 404);
  const big = Buffer.concat([png, Buffer.alloc(2.5 * 1024 * 1024)]);
  assert.equal((await ownerA.req("POST", A, undefined, { raw: big, contentType: "image/png" })).status, 413);
});

test("security headers are set and errors do not leak internals", async () => {
  const r = await fetch(`${h.baseUrl}/`);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-powered-by"), null);
  const bad = await fan.get("/api/public/orders/%27%3B%20DROP%20TABLE%20orders");
  assert.equal(bad.status, 404);
  const malformed = await fan.req("POST", "/api/public/checkout/quote", "{not json", {});
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(JSON.stringify(malformed.body), /stack|node_modules|SyntaxError/);
});

test("login failures are generic and lock the account after repeated attempts", async () => {
  const c = new h.HttpClient();
  const unknown = await c.post("/api/auth/login", { email: "nobody@test.local", password: "whatever-123" });
  const wrong = await c.post("/api/auth/login", { email: fan.user.email, password: "wrong-password-1" });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  const target = await h.user();
  for (let i = 0; i < 5; i++) await c.post("/api/auth/login", { email: target.user.email, password: "wrong-password-x" });
  const locked = await c.post("/api/auth/login", { email: target.user.email, password: h.PASSWORD });
  assert.equal(locked.status, 423);
});

test("passwords, PINs and tokens are never stored or logged in clear", async () => {
  const u = await h.one("SELECT password_hash FROM users WHERE id = $1", [fan.user.id]);
  assert.match(u.password_hash, /^scrypt\$/);
  const s = await h.one("SELECT token_hash FROM sessions WHERE user_id = $1 LIMIT 1", [fan.user.id]);
  assert.equal(s.token_hash.length, 64);
  assert.ok(![...fan.cookies.values()].includes(s.token_hash));
  assert.deepEqual(audit.scrub({ password: "x", nested: { pin: "1234", ok: 1 }, accountNumber: "1" }), { password: "[redacted]", nested: { pin: "[redacted]", ok: 1 }, accountNumber: "[redacted]" });
  await ownerA.put(`/api/organiser/${evA.organiser.id}/bank`, { bankName: "FNB", accountHolder: "Org A", accountNumber: "62000001234", branchCode: "250655" });
  const bank = await h.one("SELECT bank_account_enc, bank_account_last4 FROM organisers WHERE id = $1", [evA.organiser.id]);
  assert.doesNotMatch(bank.bank_account_enc, /62000001234/);
  assert.equal(bank.bank_account_last4, "1234");
});

test("ledger and audit trail are append-only at the database level", async () => {
  await assert.rejects(h.db.query("UPDATE ledger_entries SET amount_cents = amount_cents + 1"), /append-only/);
  await assert.rejects(h.db.query("DELETE FROM journals"), /append-only/);
  await assert.rejects(h.db.query("DELETE FROM audit_log"), /append-only/);
  await assert.rejects(h.db.query("TRUNCATE ledger_entries"), /append-only/);
  await assert.rejects(h.db.withTx(async (c) => {
    const { rows } = await c.query("INSERT INTO journals (kind, reference, idempotency_key) VALUES ('test','x','unbalanced-1') RETURNING id");
    const a = await c.query("SELECT id FROM ledger_accounts LIMIT 1");
    await c.query("INSERT INTO ledger_entries (journal_id, account_id, amount_cents) VALUES ($1,$2,500)", [rows[0].id, a.rows[0].id]);
  }), /unbalanced/);
  const chain = await audit.verifyChain();
  assert.equal(chain.ok, true);
  assert.ok(chain.checked > 5);
});

test("migrations revert and re-apply cleanly", async () => {
  const before = (await h.db.query("SELECT name FROM tr_meta.migrations ORDER BY name")).rows.map((r) => r.name);
  assert.deepEqual(before, migrate.list());
  await h.db.close();
  await migrate.down(before.length, { log: () => {} });
  const tables = await h.one("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('tr','sim_provider')");
  assert.equal(tables.n, 0);
  await migrate.up({ log: () => {} });
  const after = await h.one("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'tr'");
  assert.ok(after.n > 30);
});
