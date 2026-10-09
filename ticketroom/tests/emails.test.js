const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const automated = require("../src/modules/messaging/automated");
const { toHtml } = require("../src/modules/messaging/html");
const templates = require("../src/modules/messaging/templates");

let admin, owner;
before(async () => { await h.setup(); admin = await h.user({ roles: ["admin"] }); owner = await h.user({ name: "Owner" }); });
after(() => h.teardown());

const mails = async (to) => (await h.db.query("SELECT subject, body FROM message_outbox WHERE to_address = $1 ORDER BY created_at", [to])).rows;

test("free ticket confirmation does not mention payment", async () => {
  const ev = await h.organiserWithEvent(owner, { types: [["Free admission", 0, 100]] });
  const fan = await h.user({ name: "Lerato Mokoena" });
  const o = await h.buy(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }]);
  assert.equal(o.body.order.status, "paid");
  const [m] = await mails(fan.user.email);
  assert.match(m.subject, /free tickets/i);
  assert.match(m.body, /^Hi Lerato,/);
  assert.doesNotMatch(m.body, /Payment received|R0/);
});

test("day-before and starting-soon reminders go to each holder once", async () => {
  const tomorrow = await h.organiserWithEvent(owner, { types: [["Free", 0, 100]], startsAt: new Date(Date.now() + 20 * 3600e3) });
  const tonight = await h.addEvent(tomorrow.organiser.id, { types: [["Free", 0, 100]], startsAt: new Date(Date.now() + 2 * 3600e3) });
  const far = await h.addEvent(tomorrow.organiser.id, { types: [["Free", 0, 100]], startsAt: new Date(Date.now() + 5 * 864e5) });
  const fan = await h.user({ name: "Sipho" });
  await h.buy(fan, tomorrow.event, [{ ticketTypeId: tomorrow.ticketTypes[0].id, quantity: 3 }]);
  await h.buy(fan, tonight.event, [{ ticketTypeId: tonight.ticketTypes[0].id, quantity: 1 }]);
  await h.buy(fan, far.event, [{ ticketTypeId: far.ticketTypes[0].id, quantity: 1 }]);
  const n1 = await automated.reminders();
  const n2 = await automated.reminders();
  assert.equal(n1, 2);
  assert.equal(n2, 0, "never sent twice");
  const r = (await mails(fan.user.email)).filter((m) => /^(Tomorrow|Starting soon)/.test(m.subject));
  assert.equal(r.length, 2);
  assert.ok(r.some((m) => m.subject === `Tomorrow: ${tomorrow.event.title}` && /You have 3 tickets/.test(m.body)));
  assert.ok(r.some((m) => m.subject.startsWith("Starting soon") && /Turn your screen brightness up/.test(m.body)));
  // switched off in admin -> nothing sent
  await admin.put("/api/admin/settings/emails", { reminderDayBefore: false, reminderSoon: false, abandonedCheckout: true, abandonedDelayHours: 1 });
  const fan2 = await h.user();
  await h.buy(fan2, tomorrow.event, [{ ticketTypeId: tomorrow.ticketTypes[0].id, quantity: 1 }]);
  assert.equal(await automated.reminders(), 0);
  await admin.put("/api/admin/settings/emails", { reminderDayBefore: true, reminderSoon: true, abandonedCheckout: true, abandonedDelayHours: 1 });
});

test("abandoned checkout: one nudge, not after booking, not after unsubscribe", async () => {
  const ev = await h.organiserWithEvent(owner, { types: [["GA", 15000, 100]] });
  const mk = async (u) => {
    const o = await h.buy(u, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
    await h.db.query("UPDATE orders SET status = 'expired', created_at = now() - interval '2 hours' WHERE reference = $1", [o.body.order.reference]);
    await h.db.query("UPDATE ticket_types SET quantity_held = 0 WHERE id = $1", [ev.ticketTypes[0].id]);
  };
  const a = await h.user({ name: "Abandoner" }); await mk(a);
  const booked = await h.user(); await mk(booked); await h.buyAndPay(booked, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const optedOut = await h.user(); await mk(optedOut);
  await optedOut.put("/api/auth/me/consents", { channel: "email", granted: false });
  assert.equal(await automated.abandonedCheckouts(), 1);
  assert.equal(await automated.abandonedCheckouts(), 0);
  const [m] = (await mails(a.user.email)).filter((x) => /Still want to go/.test(x.subject));
  assert.ok(m);
  assert.match(m.body, new RegExp(`/events/${ev.event.slug}`));
  assert.match(m.body, /Unsubscribe: http.*unsubscribe\?t=/);
  assert.equal((await mails(booked.user.email)).filter((x) => /Still want to go/.test(x.subject)).length, 0);
  assert.equal((await mails(optedOut.user.email)).filter((x) => /Still want to go/.test(x.subject)).length, 0);
});

test("organisers are emailed on approval and when their event is published or sent back", async () => {
  const o = await h.user({ name: "Naledi Dlamini" });
  const app = await o.post("/api/organiser/apply", { name: "Soweto Arts", contactEmail: "arts@test.local" });
  await admin.post(`/api/admin/organisers/${app.body.organiser.id}/status`, { status: "approved" });
  const ev = await o.post(`/api/organiser/${app.body.organiser.id}/events`, { title: "Free Jazz", category: "music", venueName: "Park", city: "Soweto", startsAt: new Date(Date.now() + 864e5 * 9).toISOString(), endsAt: new Date(Date.now() + 864e5 * 9 + 3600e3).toISOString(), capacity: 50, isFree: true });
  await o.post(`/api/organiser/${app.body.organiser.id}/events/${ev.body.event.id}/submit`);
  await admin.post(`/api/admin/events/${ev.body.event.id}/status`, { action: "reject", reason: "Add a poster" });
  await o.post(`/api/organiser/${app.body.organiser.id}/events/${ev.body.event.id}/submit`);
  await admin.post(`/api/admin/events/${ev.body.event.id}/status`, { action: "publish" });
  const subjects = (await mails(o.user.email)).map((m) => m.subject);
  assert.ok(subjects.includes("Soweto Arts is approved on TicketRoom"));
  assert.ok(subjects.includes("Changes needed before Free Jazz can go live"));
  assert.ok(subjects.includes("Your event is live: Free Jazz"));
});

test("cancelling an event emails ticket holders and voids free tickets", async () => {
  const ev = await h.organiserWithEvent(owner, { types: [["Free", 0, 100]] });
  const fan = await h.user();
  await h.buy(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  assert.equal((await admin.post(`/api/admin/events/${ev.event.id}/cancel`, { reason: "Venue flooded" })).status, 200);
  const m = (await mails(fan.user.email)).find((x) => x.subject === `Cancelled: ${ev.event.title}`);
  assert.match(m.body, /Venue flooded/);
  assert.match(m.body, /free tickets have been cancelled/);
  assert.equal((await h.ticketsOf(fan)).filter((t) => t.status === "valid").length, 0);
});

test("admin can list, preview and test-send every email", async () => {
  const r = await admin.get("/api/admin/emails");
  assert.ok(r.body.emails.length >= 18);
  for (const e of r.body.emails) {
    assert.ok(e.subject && e.body, e.key);
    assert.doesNotMatch(e.body + e.subject, /undefined|NaN|\[object/, e.key);
    assert.doesNotMatch(e.body, /TitoPay/, e.key);
  }
  const p = await admin.get("/api/admin/emails/eventReminderDay/preview");
  assert.equal(p.status, 200);
  assert.match(p.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.match(p.body, /TICKET<span[^>]*>ROOM/);
  const t = await admin.post("/api/admin/emails/checkoutAbandoned/test");
  assert.equal(t.body.to, admin.user.email);
  const outsider = await h.user();
  assert.equal((await outsider.get("/api/admin/emails")).status, 403);
});

test("HTML rendering: buttons, bullets, escaping", () => {
  const m = templates.eventReminder({ name: "<b>X</b>", event: { title: "A & B", starts_at: new Date().toISOString(), venue_name: "V", city: "C", transfers_enabled: true }, ticketCount: 1, soon: false });
  const html = toHtml(m.subject, m.body);
  assert.match(html, /<a href="[^"]+\/account#\/tickets"[^>]*>Open your tickets<\/a>/);
  assert.match(html, /<li[^>]*>Turn your screen brightness up/);
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>X<\/b>/);
  assert.match(html, /A &amp; B/);
});
