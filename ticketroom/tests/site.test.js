const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const settings = require("../src/modules/site/settings");

let admin, support, owner, ev, A, anon;
before(async () => {
  delete process.env.ANTHROPIC_API_KEY; // knowledge-base answers only
  await h.setup();
  admin = await h.user({ roles: ["admin"] });
  support = await h.user({ roles: ["support"] });
  owner = await h.user({ name: "Owner" });
  ev = await h.organiserWithEvent(owner, { types: [["GA", 10000, 100]] });
  A = `/api/organiser/${ev.organiser.id}`;
  anon = new h.HttpClient(); await anon.refreshCsrf();
});
after(() => h.teardown());

test("site info: banner on by default with free-events message, hours and hello@ email", async () => {
  const r = await anon.get("/api/site");
  assert.equal(r.status, 200);
  assert.match(r.body.banner.text, /free events/i);
  assert.match(r.body.banner.text, /paid tickets are coming soon/i);
  assert.equal(r.body.support.email, "hello@ticketroom.co.za");
  assert.equal(r.body.support.responseTime, "24–48 hours");
  assert.deepEqual(r.body.hours.week.mon, { open: "09:00", close: "17:00" });
  assert.equal(r.body.hours.week.sat, null);
  assert.equal(r.body.hours.week.sun, null);
  assert.equal(r.body.maintenance, null);
});

test("business hours: weekdays 9–5 open, weekends and public holidays closed", () => {
  const s = settings.DEFAULTS.hours;
  const at = (iso) => settings.hoursStatus(s, new Date(iso));
  assert.equal(at("2026-10-14T10:00:00+02:00").openNow, true);        // Wednesday
  assert.equal(at("2026-10-14T08:59:00+02:00").openNow, false);
  assert.equal(at("2026-10-14T17:00:00+02:00").openNow, false);
  assert.equal(at("2026-10-17T11:00:00+02:00").openNow, false);       // Saturday
  assert.equal(at("2026-10-17T11:00:00+02:00").nextOpen.day, "mon");
  const xmas = at("2026-12-25T11:00:00+02:00");                        // Friday, Christmas
  assert.equal(xmas.openNow, false);
  assert.equal(xmas.holiday, "Christmas Day");
  assert.equal(xmas.nextOpen.date, "2026-12-28");
});

test("only admins change settings; banner can be removed and comes back", async () => {
  assert.equal((await support.put("/api/admin/settings/banner", { enabled: false, text: "x" })).status, 403);
  assert.equal((await owner.put("/api/admin/settings/banner", { enabled: false, text: "x" })).status, 403);
  const off = await admin.put("/api/admin/settings/banner", { enabled: false, text: "We're currently open for listing FREE events. Paid tickets are coming soon." });
  assert.equal(off.status, 200);
  assert.equal((await anon.get("/api/site")).body.banner, null);
  await admin.put("/api/admin/settings/banner", { enabled: true, text: "Paid tickets launch soon", linkText: "Sell", linkUrl: "/sell" });
  assert.equal((await anon.get("/api/site")).body.banner.text, "Paid tickets launch soon");
  assert.equal((await admin.put("/api/admin/settings/banner", { enabled: true, text: "x", linkUrl: "javascript:alert(1)" })).status, 422);
  const log = await h.one("SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.banner_updated'");
  assert.ok(log.n >= 2);
});

test("hours are editable, validated, and drive the public status", async () => {
  const bad = await admin.put("/api/admin/settings/hours", { week: { mon: { open: "17:00", close: "09:00" } }, holidays: [] });
  assert.equal(bad.status, 400);
  const week = { mon: { open: "08:00", close: "16:00" }, tue: null, wed: null, thu: null, fri: null, sat: { open: "10:00", close: "13:00" }, sun: null };
  const ok = await admin.put("/api/admin/settings/hours", { week, holidays: [{ date: "2026-12-24", name: "Christmas Eve" }], note: "Custom" });
  assert.equal(ok.status, 200);
  const s = await anon.get("/api/site");
  assert.deepEqual(s.body.hours.week.sat, { open: "10:00", close: "13:00" });
  assert.equal(s.body.hours.note, "Custom");
  await admin.put("/api/admin/settings/hours", settings.DEFAULTS.hours);
});

test("maintenance mode: visitors blocked, staff and webhooks still work", async () => {
  assert.equal((await admin.put("/api/admin/settings/maintenance", { enabled: true, message: "Upgrading <tonight>" })).status, 200);
  const page = await anon.get("/");
  assert.equal(page.status, 503);
  assert.match(page.body, /Upgrading &#60;tonight&#62;/);
  assert.doesNotMatch(page.body, /TitoPay/);
  assert.equal((await anon.get("/api/public/events")).status, 503);
  assert.equal((await anon.get("/api/health")).status, 200);
  assert.equal((await anon.get("/api/site")).body.maintenance.message, "Upgrading <tonight>");
  assert.equal((await admin.get("/api/public/events")).status, 200);   // staff bypass
  assert.equal((await owner.get("/api/public/events")).status, 503);   // organisers are visitors here
  assert.equal((await admin.put("/api/admin/settings/maintenance", { enabled: false, message: "x" })).status, 200);
  assert.equal((await anon.get("/api/public/events")).status, 200);
});

test("callback request opens a case due in 48h and emails hello@ and the customer", async () => {
  const bad = await anon.post("/api/site/callback", { fullName: "A", phone: "nope", email: "x", message: "" });
  assert.equal(bad.status, 422);
  const r = await anon.post("/api/site/callback", { fullName: "Lerato Mokoena", phone: "082 555 1234", email: "lerato@test.local", topic: "tickets", message: "My QR code won't load", preferredTime: "mornings" });
  assert.equal(r.status, 201);
  assert.match(r.body.reference, /^CB/);
  const c = await h.one("SELECT *, extract(epoch FROM due_at - created_at)/3600 AS hours FROM support_cases WHERE reference = $1", [r.body.reference]);
  assert.equal(c.phone, "+27825551234");
  assert.equal(Math.round(c.hours), 48);
  assert.equal(c.category, "tickets");
  const land = await anon.post("/api/site/callback", { fullName: "Office", phone: "021 555 0000", email: "o@test.local", message: "Landline please" });
  assert.equal(land.status, 201);
  const mails = (await h.db.query("SELECT to_address, subject, body FROM message_outbox WHERE body LIKE '%' || $1 || '%' OR subject LIKE '%' || $1 || '%'", [r.body.reference])).rows;
  assert.ok(mails.some((m) => m.to_address === "hello@ticketroom.co.za"));
  assert.ok(mails.some((m) => m.to_address === "lerato@test.local" && /24–48 hours/.test(m.body)));
  const list = await support.get("/api/admin/support");
  assert.ok(list.body.cases.some((x) => x.reference === r.body.reference && x.overdue === false));
});

test("assistant answers from the knowledge base, offers callbacks, records feedback", async () => {
  const a = await anon.post("/api/site/chat", { message: "How do I transfer my ticket to a friend?" });
  assert.equal(a.status, 200);
  assert.equal(a.body.source, "kb");
  assert.match(a.body.text, /transfer/i);
  const p = await anon.post("/api/site/chat", { message: "I want to speak to a real person" });
  assert.equal(p.body.callback, true);
  assert.match(p.body.text, /callback/i);
  const f = await anon.post("/api/site/chat", { message: "qwerty zxcvb" });
  assert.equal(f.body.source, "fallback");
  assert.equal(f.body.callback, true);
  assert.equal((await anon.post(`/api/site/chat/${a.body.id}/feedback`, { helpful: true })).status, 200);
  const chats = await support.get("/api/admin/chats?filter=unanswered");
  assert.ok(chats.body.chats.some((c) => c.question === "qwerty zxcvb"));
  assert.ok(chats.body.stats.helpful >= 1);
  // A new article is used straight away.
  const art = await support.post("/api/admin/kb", { question: "Do you sell gift vouchers?", answer: "Gift vouchers are not available yet.", keywords: ["voucher", "gift"] });
  assert.equal(art.status, 201);
  const v = await anon.post("/api/site/chat", { message: "can I buy a gift voucher" });
  assert.match(v.body.text, /Gift vouchers are not available/);
  // Off switch.
  await admin.put("/api/admin/settings/chatbot", { enabled: false, aiEnabled: false, greeting: "hi" });
  assert.equal((await anon.post("/api/site/chat", { message: "hello" })).status, 503);
  await admin.put("/api/admin/settings/chatbot", { enabled: true, aiEnabled: true, greeting: "hi" });
});

test("advertising posters: admin creates, public sees only live ones, clicks counted", async () => {
  const p = await admin.post("/api/admin/posters", { title: "Summer Fest", subtitle: "Sponsored", linkUrl: "https://example.com" });
  assert.equal(p.status, 201);
  await admin.post("/api/admin/posters", { title: "Future", startsAt: new Date(Date.now() + 864e5).toISOString() });
  const bad = await admin.post("/api/admin/posters", { title: "Evil", linkUrl: "javascript:alert(1)" });
  assert.equal(bad.status, 422);
  assert.equal((await support.post("/api/admin/posters", { title: "Nope" })).status, 403);
  let site = await anon.get("/api/site");
  assert.deepEqual(site.body.posters.map((x) => x.title), ["Summer Fest"]);
  await anon.post(`/api/site/posters/${p.body.poster.id}/click`);
  assert.equal((await h.one("SELECT clicks FROM ad_posters WHERE id = $1", [p.body.poster.id])).clicks, 1);
  await admin.patch(`/api/admin/posters/${p.body.poster.id}`, { active: false });
  site = await anon.get("/api/site");
  assert.equal(site.body.posters.length, 0);
});

test("unsubscribe from everything: by email link and from the account", async () => {
  const fan = await h.user({ name: "Fan" });
  await fan.put("/api/auth/me/consents", { organiserId: ev.organiser.id, channel: "email", granted: true });
  await fan.put("/api/auth/me/consents", { channel: "email", granted: true });
  const same = await anon.post("/api/site/unsubscribe-request", { email: "nobody@test.local" });
  const r = await anon.post("/api/site/unsubscribe-request", { email: fan.user.email });
  assert.equal(r.body.message, same.body.message); // no account enumeration
  const mail = await h.one("SELECT body FROM message_outbox WHERE to_address = $1 AND body LIKE '%unsubscribe?t=%' ORDER BY created_at DESC LIMIT 1", [fan.user.email]);
  const token = decodeURIComponent(mail.body.match(/unsubscribe\?t=([^\s]+)/)[1]);
  const u = await anon.post("/api/public/unsubscribe", { token });
  assert.equal(u.status, 200);
  assert.equal(u.body.all, true);
  const { consents } = (await fan.get("/api/auth/me/consents")).body;
  assert.ok(consents.every((c) => !c.granted));
  // Account route
  await fan.put("/api/auth/me/consents", { organiserId: ev.organiser.id, channel: "sms", granted: true });
  const all = await fan.post("/api/auth/me/consents/unsubscribe-all");
  assert.ok(all.body.consents.every((c) => !c.granted));
});

test("organisers invite scanner staff by email and see a live check-in count", async () => {
  ev = { organiser: ev.organiser, ...(await h.addEvent(ev.organiser.id, { types: [["GA", 10000, 100]], startsAt: new Date(Date.now() - 3600e3) })) };
  const inv = await owner.post(`${A}/events/${ev.event.id}/staff`, { email: "gate1@test.local", fullName: "Gate One", canScan: true });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.invited, true);
  const mail = await h.one("SELECT subject, body FROM message_outbox WHERE to_address = 'gate1@test.local'");
  assert.match(mail.body, /account#\/reset\//);
  const existing = await h.user({ name: "Existing Staff" });
  const add = await owner.post(`${A}/events/${ev.event.id}/staff`, { email: existing.user.email });
  assert.equal(add.body.invited, false);
  // the existing staff member scans one ticket
  const buyer = await h.user();
  await h.buyAndPay(buyer, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }]);
  const [t] = await h.ticketsOf(buyer);
  const scan = await existing.post("/api/staff/scan", { eventId: ev.event.id, payload: t.qrPayload });
  assert.equal(scan.body.outcome, "admitted");
  const live = await owner.get(`${A}/events/${ev.event.id}/checkins/live`);
  assert.equal(live.status, 200);
  assert.equal(live.body.admitted, 1);
  assert.equal(live.body.issued, 2);
  assert.equal(live.body.last15min, 1);
  assert.equal(live.body.scanners[0].full_name, "Existing Staff");
  assert.ok([403, 404].includes((await buyer.get(`${A}/events/${ev.event.id}/checkins/live`)).status));
});

test("legal and site pages are served", async () => {
  for (const p of ["/legal/terms-of-use", "/legal/terms", "/legal/privacy", "/legal/cookies", "/legal/paia", "/privacy", "/cookies", "/terms", "/help", "/contact", "/sell", "/unsubscribe"]) {
    const r = await anon.get(p);
    assert.equal(r.status, 200, p);
  }
  const js = await anon.get("/assets/legal.js");
  assert.equal(js.status, 200);
  for (const s of ["Terms of Use", "Terms and Conditions", "Privacy Policy", "Cookie Policy", "Information Regulator", "R10", "5%", "hello@ticketroom.co.za"]) assert.ok(js.body.includes(s), s);
  assert.ok(!/division of TitoPay|powered by TitoPay/i.test(js.body));
});
