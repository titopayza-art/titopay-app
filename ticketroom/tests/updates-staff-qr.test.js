// Subscribe to updates, the admin team (staff and roles), QR codes, and the
// abuse guards added with them.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");

let admin, support, owner, fan, anon, ev;
before(async () => {
  await h.setup();
  admin = await h.user({ roles: ["admin"], name: "Thuso Admin" });
  support = await h.user({ roles: ["support"] });
  owner = await h.user({ name: "Naledi Owner" });
  fan = await h.user({ name: "Sipho Fan" });
  anon = new h.HttpClient();
  await anon.refreshCsrf();
  ev = await h.organiserWithEvent(owner, { types: [["Free entry", 0, 100]] });
});
after(() => h.teardown());

const lastMailTo = async (to) => h.one("SELECT * FROM message_outbox WHERE to_address = $1 ORDER BY created_at DESC LIMIT 1", [to]);

test("subscribe: double opt-in, the same answer for everyone, and one-click unsubscribe", async () => {
  const email = "reader@test.local";
  const r = await anon.post("/api/site/subscribe", { email, source: "footer" });
  assert.equal(r.status, 200);
  assert.equal((await h.one("SELECT status FROM newsletter_subscribers WHERE email = $1", [email])).status, "pending");
  const mail = await lastMailTo(email);
  assert.match(mail.subject, /Confirm your TicketRoom updates/);
  const token = decodeURIComponent(mail.body.match(/subscribe\?t=(\S+)/)[1]);
  assert.equal((await anon.post("/api/site/subscribe/confirm", { token })).status, 200);
  assert.equal((await h.one("SELECT status FROM newsletter_subscribers WHERE email = $1", [email])).status, "subscribed");
  // Subscribing again looks exactly like a new sign-up.
  const again = await anon.post("/api/site/subscribe", { email });
  const fresh = await anon.post("/api/site/subscribe", { email: "someone-new@test.local" });
  assert.equal(again.body.message.replace(email, "X"), fresh.body.message.replace("someone-new@test.local", "X"));
  assert.equal((await anon.post("/api/site/subscribe/confirm", { token: "nonsense" })).status, 400);

  // An update reaches confirmed subscribers only, with a working unsubscribe link.
  assert.equal((await support.post("/api/admin/subscribers/send", { subject: "Hello", message: "News for you.", test: false })).status, 403);
  const test1 = await admin.post("/api/admin/subscribers/send", { subject: "This month", message: "Hi there,\n\nNew events.", test: true });
  assert.equal(test1.body.to, admin.user.email);
  const sent = await admin.post("/api/admin/subscribers/send", { subject: "This month", message: "Hi there,\n\nNew events.", test: false });
  assert.equal(sent.body.recipients, 1);
  const update = await lastMailTo(email);
  assert.equal(update.kind, "marketing");
  const unsub = decodeURIComponent(update.body.match(/unsubscribe\?t=(\S+)/)[1]);
  assert.equal((await anon.post("/api/public/unsubscribe", { token: unsub })).status, 200);
  assert.equal((await h.one("SELECT status FROM newsletter_subscribers WHERE email = $1", [email])).status, "unsubscribed");
  const list = await support.get("/api/admin/subscribers");
  assert.equal(list.body.counts.unsubscribed, 1);
  const csv = await support.get("/api/admin/subscribers?format=csv");
  assert.match(csv.body, /reader@test\.local/);
});

test("staff and roles: admins add people with chosen roles; nobody changes their own", async () => {
  const add = await admin.post("/api/admin/staff", { fullName: "Ayanda Khumalo", email: "ayanda@test.local", roles: ["support"] });
  assert.equal(add.status, 201);
  assert.equal(add.body.invited, true);
  assert.match((await lastMailTo("ayanda@test.local")).body, /as Support[\s\S]*account#\/reset\//);
  const fanAdded = await admin.post("/api/admin/staff", { fullName: "Sipho Fan", email: fan.user.email, roles: ["finance", "support"] });
  assert.equal(fanAdded.body.invited, false);
  const team = (await support.get("/api/admin/staff")).body.staff;
  const ayanda = team.find((s) => s.email === "ayanda@test.local");
  assert.deepEqual(ayanda.roles, ["support"]);
  assert.equal((await support.post("/api/admin/staff", { fullName: "X Y", email: "x@test.local", roles: ["admin"] })).status, 403);
  assert.equal((await admin.put(`/api/admin/staff/${admin.user.id}`, { roles: [] })).status, 403);
  assert.equal((await admin.put(`/api/admin/staff/${ayanda.id}`, { roles: ["support", "finance"] })).status, 200);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM platform_roles WHERE user_id = $1", [ayanda.id])).n, 2);
  assert.equal((await admin.put(`/api/admin/staff/${ayanda.id}`, { roles: [] })).status, 200);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM platform_roles WHERE user_id = $1", [ayanda.id])).n, 0);
  assert.equal((await admin.post("/api/admin/staff", { fullName: "No Roles", email: "none@test.local", roles: [] })).status, 422);
});

test("QR codes: organisers get one for their event page; admins make any; unreadable colours are refused", async () => {
  const A = `/api/organiser/${ev.organiser.id}/events/${ev.event.id}`;
  const q = await owner.get(`${A}/qr`);
  assert.equal(q.status, 200);
  assert.match(q.body.url, new RegExp(`/events/${ev.event.slug}$`));
  assert.match(q.body.svg, /^<svg[\s\S]*<\/svg>\s*$/);
  const stranger = await h.user({ name: "Stranger" });
  assert.equal((await stranger.get(`${A}/qr`)).status, 404);
  const made = await support.post("/api/admin/qr", { text: "https://wa.me/27768847372?text=Hi", dark: "#0b1a33", light: "#ffffff", ecc: "H" });
  assert.equal(made.status, 200);
  assert.doesNotMatch(made.body.svg, /wa\.me/);
  assert.equal((await support.post("/api/admin/qr", { text: "x", dark: "#eeeeee", light: "#ffffff" })).status, 422);
  assert.equal((await stranger.post("/api/admin/qr", { text: "x" })).status, 403);
});

test("free tickets: the per-person limit counts every order, so one account cannot take them all", async () => {
  const tt = ev.ticketTypes[0];
  assert.equal((await h.buy(fan, ev.event, [{ ticketTypeId: tt.id, quantity: 6 }])).status, 201);
  const more = await h.buy(fan, ev.event, [{ ticketTypeId: tt.id, quantity: 6 }]);
  assert.equal(more.status, 409);
  assert.equal(more.body.error.code, "limit_exceeded");
  assert.equal((await h.buy(fan, ev.event, [{ ticketTypeId: tt.id, quantity: 4 }])).status, 201);
});

test("organisers waiting for approval cannot invite people; live-event edits alert the team", async () => {
  const applicant = await h.user({ name: "New Organiser" });
  const ap = await applicant.post("/api/organiser/apply", { name: "Pending Promotions", contactEmail: "pending@test.local" });
  assert.equal(ap.status, 201);
  const orgId = ap.body.organiser.id;
  const pend = await h.addEvent(orgId, { types: [["GA", 0, 10]] });
  await h.db.query("UPDATE events SET status = 'draft' WHERE id = $1", [pend.event.id]);
  const staff = await applicant.post(`/api/organiser/${orgId}/events/${pend.event.id}/staff`, { email: "victim@test.local" });
  assert.equal(staff.status, 409);
  assert.equal(staff.body.error.code, "organiser_not_approved");
  assert.equal((await h.one("SELECT count(*)::int AS n FROM users WHERE email = 'victim@test.local'")).n, 0);
  assert.equal((await applicant.post(`/api/organiser/${orgId}/members`, { email: fan.user.email, role: "viewer" })).status, 409);

  const before = (await h.one("SELECT count(*)::int AS n FROM message_outbox WHERE subject LIKE '[TicketRoom] Live event edited%'")).n;
  const edit = await owner.patch(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}`, { title: "A completely different show" });
  assert.equal(edit.status, 200);
  const after = (await h.one("SELECT count(*)::int AS n FROM message_outbox WHERE subject LIKE '[TicketRoom] Live event edited%'")).n;
  assert.equal(after, before + 1);
});
