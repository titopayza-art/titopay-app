// Event and organiser IDs, target age groups, ticket kinds (people per
// ticket) and gate passes for crew and guests.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const qr = require("../src/modules/tickets/qr");

let admin, owner, fan, stranger, live, soon, pendingOrg, pendingEvent;
before(async () => {
  await h.setup();
  admin = await h.user({ roles: ["admin"] });
  owner = await h.user({ name: "Naledi Owner" });
  fan = await h.user({ name: "Lerato Mokoena" });
  stranger = await h.user({ name: "Stranger" });
  // Live: started an hour ago, room for 10 people.
  live = await h.organiserWithEvent(owner, { startsAt: new Date(Date.now() - 3600e3), capacity: 10, types: [["Free entry", 0, 100]] });
  // Starts in 30 hours: outside the ticket window (12h), inside the pass window (48h).
  soon = await h.addEvent(live.organiser.id, { startsAt: new Date(Date.now() + 30 * 3600e3) });
});
after(h.teardown);

const ORG = () => `/api/organiser/${live.organiser.id}`;
const EV = (e = live) => `${ORG()}/events/${e.event.id}`;
const scan = (eventId, payload) => owner.post("/api/staff/scan", { eventId, payload });
const eventBody = (extra = {}) => ({ title: `Event ${Math.random().toString(36).slice(2, 8)}`, category: "music", venueName: "Hall", city: "Soweto",
  startsAt: new Date(Date.now() + 20 * 864e5).toISOString(), endsAt: new Date(Date.now() + 20 * 864e5 + 4 * 3600e3).toISOString(), capacity: 100, ...extra });
const publish = (id) => h.db.query("UPDATE events SET status = 'published' WHERE id = $1", [id]);

test("organisers and events get short IDs; admins find them by ID or name", async () => {
  const ap = await owner.post("/api/organiser/apply", { name: "Thokoza Sound Collective", contactEmail: "thokoza@test.local" });
  assert.equal(ap.status, 201);
  pendingOrg = ap.body.organiser;
  const org = (await owner.get(`/api/organiser/${pendingOrg.id}`)).body.organiser;
  assert.match(org.ref, /^ORG-[2-9A-HJ-NP-TV-Z]{6}$/);

  const created = await owner.post(`/api/organiser/${pendingOrg.id}/events`, eventBody({ title: "Sunset Sessions Thokoza" }));
  assert.equal(created.status, 201);
  pendingEvent = created.body.event;
  assert.match(pendingEvent.ref, /^EV-[2-9A-HJ-NP-TV-Z]{6}$/);
  assert.equal((await owner.get(`/api/organiser/${pendingOrg.id}/events`)).body[0].ref, pendingEvent.ref);
  assert.equal((await owner.get(`/api/organiser/${pendingOrg.id}/events/${pendingEvent.id}`)).body.event.ref, pendingEvent.ref);

  // Admin search: by ID (any case), by organiser ID, by title, by contact email.
  const byRef = (await admin.get(`/api/admin/events?q=${pendingEvent.ref.toLowerCase()}`)).body.events;
  assert.deepEqual(byRef.map((e) => e.id), [pendingEvent.id]);
  assert.equal(byRef[0].organiser_ref, org.ref);
  assert.equal(byRef[0].ref, pendingEvent.ref);
  assert.deepEqual((await admin.get(`/api/admin/events?q=${org.ref}`)).body.events.map((e) => e.id), [pendingEvent.id]);
  assert.deepEqual((await admin.get("/api/admin/events?q=sunset%20sessions")).body.events.map((e) => e.id), [pendingEvent.id]);
  assert.equal((await admin.get("/api/admin/events?q=EV-ZZZZZZ")).body.events.length, 0);
  assert.equal((await admin.get("/api/admin/events?q=%25")).body.events.length, 0);
  const orgs = (await admin.get(`/api/admin/organisers?q=${org.ref.toLowerCase()}`)).body.organisers;
  assert.deepEqual(orgs.map((o) => o.id), [pendingOrg.id]);
  assert.equal(orgs[0].ref, org.ref);
  assert.deepEqual((await admin.get("/api/admin/organisers?q=THOKOZA@test")).body.organisers.map((o) => o.id), [pendingOrg.id]);
  assert.ok((await admin.get("/api/admin/organisers")).body.organisers.length >= 2);

  // The public event page shows both IDs.
  await publish(pendingEvent.id);
  const pub = (await fan.get(`/api/public/events/${pendingEvent.slug}`)).body.event;
  assert.equal(pub.ref, pendingEvent.ref);
  assert.equal(pub.organiser_ref, org.ref);
  const listed = (await fan.get("/api/public/events")).body.events.find((e) => e.id === pendingEvent.id);
  assert.equal(listed.organiser_ref, org.ref);
});

test("age groups: stored as a list, 'all' wins, 18+ events cannot target children, and the ?age filter", async () => {
  const A = `${ORG()}/events`;
  const adults = await owner.post(A, eventBody({ ageGroups: ["25_34", "18_24"], ageRestriction: "18+" }));
  assert.equal(adults.status, 201);
  assert.equal(adults.body.event.age_groups, "18_24,25_34");
  const everyone = await owner.post(A, eventBody({ ageGroups: ["kids", "all"] }));
  assert.equal(everyone.body.event.age_groups, "all");
  const kids = await owner.post(A, eventBody({ ageGroups: ["kids", "families"] }));
  assert.equal(kids.body.event.age_groups, "kids,families");

  const clash = await owner.post(A, eventBody({ ageGroups: ["teens"], ageRestriction: "Strictly 18 +" }));
  assert.equal(clash.status, 400);
  assert.ok(clash.body.error.details.ageGroups);
  assert.equal((await owner.post(A, eventBody({ ageGroups: ["toddlers"] }))).status, 422);
  assert.equal((await owner.post(A, eventBody({ ageGroups: Array(9).fill("all") }))).status, 422);

  // PATCH: the existing restriction still applies; an empty list clears the groups.
  const P = `${A}/${adults.body.event.id}`;
  assert.equal((await owner.patch(P, { ageGroups: ["kids"] })).status, 400);
  assert.equal((await owner.patch(P, { ageGroups: ["kids"], ageRestriction: "All welcome" })).body.event.age_groups, "kids");
  assert.equal((await owner.patch(P, { ageGroups: ["18_24"], ageRestriction: "21+" })).body.event.age_groups, "18_24");
  assert.equal((await owner.patch(P, { title: "Renamed only" })).body.event.age_groups, "18_24");
  assert.equal((await owner.patch(P, { ageGroups: [] })).body.event.age_groups, null);
  assert.equal((await owner.patch(P, { ageGroups: ["25_34"] })).body.event.age_groups, "25_34");

  for (const e of [adults, everyone, kids]) await publish(e.body.event.id);
  const ids = async (age) => (await fan.get(`/api/public/events?age=${age}`)).body.events.map((e) => e.id);
  const young = await ids("25_34");
  assert.ok(young.includes(adults.body.event.id));
  assert.ok(young.includes(everyone.body.event.id), "an all-ages event matches every group");
  assert.ok(!young.includes(kids.body.event.id));
  const fam = await ids("families");
  assert.ok(fam.includes(kids.body.event.id) && fam.includes(everyone.body.event.id) && !fam.includes(adults.body.event.id));
  // "5_34" is not a key, so it filters nothing (and never matches part of "25_34").
  assert.ok((await ids("5_34")).includes(kids.body.event.id));
  const one = (await fan.get(`/api/public/events/${adults.body.event.slug}`)).body.event;
  assert.equal(one.age_groups, "25_34");
});

test("couple tickets: admit two, count two places, and cannot change once sold", async () => {
  const T = `${EV()}/ticket-types`;
  assert.equal((await owner.post(T, { name: "Mystery", priceCents: 0, quantityTotal: 10, kind: "unicorn" })).status, 422);
  assert.equal((await owner.post(T, { name: "Big table", priceCents: 0, quantityTotal: 1, kind: "table", admits: 21 })).status, 422);
  const couple = (await owner.post(T, { name: "Couple", priceCents: 0, quantityTotal: 10, kind: "couple" })).body.ticketType;
  assert.equal(couple.kind, "couple");
  assert.equal(couple.admits, 2);
  const student = (await owner.post(T, { name: "Student", priceCents: 0, quantityTotal: 10, kind: "student" })).body.ticketType;
  assert.equal(student.admits, 1);
  const plain = (await owner.post(T, { name: "Plain", priceCents: 0, quantityTotal: 10 })).body.ticketType;
  assert.equal(plain.kind, "general");
  const custom = (await owner.post(T, { name: "Squad", priceCents: 0, quantityTotal: 10, kind: "group", admits: 6 })).body.ticketType;
  assert.equal(custom.admits, 6);
  // Nobody has bought the squad ticket, so its size can still change.
  assert.equal((await owner.patch(`${T}/${custom.id}`, { admits: 5 })).body.ticketType.admits, 5);
  await owner.patch(`${T}/${custom.id}`, { status: "hidden" });

  const pubTypes = (await fan.get(`/api/public/events/${live.event.slug}`)).body.ticketTypes;
  assert.equal(pubTypes.find((t) => t.id === couple.id).admits, 2);
  assert.equal(pubTypes.find((t) => t.id === couple.id).kind, "couple");

  // Capacity is 10 people: 2 couples (4 people) fit, then 4 more couples (8) do not, 3 more (6) do.
  await h.buyAndPay(fan, live.event, [{ ticketTypeId: couple.id, quantity: 2 }]);
  const tooMany = await h.buy(fan, live.event, [{ ticketTypeId: couple.id, quantity: 4 }]);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.code, "sold_out");
  await h.buyAndPay(fan, live.event, [{ ticketTypeId: couple.id, quantity: 3 }]);
  assert.equal((await h.buy(fan, live.event, [{ ticketTypeId: student.id, quantity: 1 }])).status, 409);

  const mine = await h.ticketsOf(fan);
  assert.equal(mine.length, 5);
  assert.equal(mine[0].ticket_kind, "couple");
  assert.equal(mine[0].admits, 2);
  assert.equal(mine[0].event_ref, live.event.ref ?? null);

  const first = await scan(live.event.id, mine[0].qrPayload);
  assert.equal(first.body.outcome, "admitted");
  assert.equal(first.body.admits, 2);
  assert.equal(first.body.ticketType, "Couple · Admit 2");
  const again = await scan(live.event.id, mine[0].qrPayload);
  assert.equal(again.body.outcome, "already_used");
  assert.equal(again.body.ticketType, "Couple · Admit 2");

  // The gate counts people.
  const stats = (await owner.get(`/api/staff/events/${live.event.id}/stats`)).body;
  assert.equal(stats.admitted, 2);
  assert.equal(stats.issued, 10);

  const locked = await owner.patch(`${T}/${couple.id}`, { admits: 3 });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error.code, "admits_locked");
  assert.equal((await owner.patch(`${T}/${couple.id}`, { admits: 2, name: "Couple pass" })).status, 200);
  // Capacity cannot drop below the people already holding tickets.
  assert.equal((await owner.patch(EV(), { capacity: 9 })).body.error.code, "capacity_below_sold");

  const byType = (await owner.get(`${EV()}/analytics`)).body.byType.find((t) => t.id === couple.id);
  assert.equal(byType.kind, "couple");
  assert.equal(byType.admits, 2);
});

test("gate passes: issue, view, scan, re-enter, single entry, reissue, revoke, offline pack", async () => {
  const P = `${EV()}/passes`;
  // Single pass with an email: sent from hello@, so the organiser must be approved.
  const one = await owner.post(P, { holderName: "Sipho Crew", email: "Sipho@Test.local", role: "crew", accessNote: "Stage door" });
  assert.equal(one.status, 201);
  assert.equal(one.body.pass.reentry, true);
  assert.equal(one.body.pass.email, "sipho@test.local");
  assert.equal(one.body.pass.roleLabel, "Crew");
  assert.equal(one.body.pass.scans, 0);
  const mail = await h.one("SELECT * FROM message_outbox WHERE to_address = 'sipho@test.local' ORDER BY created_at DESC LIMIT 1");
  assert.equal(mail.subject, `Your gate pass for ${live.event.title}`);
  assert.ok(mail.body.includes(one.body.url));
  assert.match(mail.body, /Crew pass for .* in and out as often as you need/s);
  assert.equal((await owner.post(P, { holderName: "X", role: "crew" })).status, 422);
  assert.equal((await owner.post(P, { holderName: "Xolani", role: "roadie" })).status, 422);

  // A pending organiser can issue passes, but not email them.
  const PP = `/api/organiser/${pendingOrg.id}/events/${pendingEvent.id}/passes`;
  const pendingMail = await owner.post(PP, { holderName: "Guest One", email: "guest@test.local", role: "guest" });
  assert.equal(pendingMail.status, 409);
  assert.equal(pendingMail.body.error.code, "organiser_not_approved");
  const pendingPlain = await owner.post(PP, { holderName: "Guest One", role: "guest" });
  assert.equal(pendingPlain.status, 201);
  assert.equal((await owner.post(`${PP}/bulk`, { role: "guest", people: [{ holderName: "Guest Two", email: "g2@test.local" }] })).body.error.code, "organiser_not_approved");

  // Bulk: one-entry media passes.
  const bulk = await owner.post(`${P}/bulk`, { role: "media", reentry: false, people: [{ holderName: "Ayanda Press" }, { holderName: "Thabo Radio" }, { holderName: "Zanele Photo" }] });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.body.passes.length, 3);
  assert.ok(bulk.body.passes.every((p) => p.pass.reentry === false && /\/pass\?t=/.test(p.url)));
  assert.equal((await owner.post(`${P}/bulk`, { role: "media", people: [] })).status, 422);
  assert.equal((await owner.post(`${P}/bulk`, { role: "media", people: Array.from({ length: 201 }, (_, i) => ({ holderName: `Person ${i}` })) })).status, 422);

  const list = (await owner.get(P)).body;
  assert.equal(list.passes.length, 4);
  assert.equal(list.roles.all_access, "All access");
  const codes = new Set(list.passes.map((g) => g.code));
  assert.equal((await h.one("SELECT count(*)::int AS n FROM tickets WHERE code = ANY($1)", [[...codes]])).n, 0);

  // The holder's private link shows the pass and its QR code.
  const token = (url) => new URL(url).searchParams.get("t");
  const anon = new h.HttpClient();
  const view = await anon.get(`/api/public/pass?t=${token(one.body.url)}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.pass.holderName, "Sipho Crew");
  assert.equal(view.body.pass.role, "Crew");
  assert.equal(view.body.pass.status, "active");
  assert.equal(view.body.pass.used, false);
  assert.equal(view.body.event.title, live.event.title);
  assert.match(view.body.svg, /^<svg/);
  assert.equal((await anon.get("/api/public/pass?t=short")).status, 404);
  assert.equal((await anon.get(`/api/public/pass?t=${"A".repeat(32)}`)).status, 404);
  const detail = await owner.get(`${P}/${one.body.pass.id}`);
  assert.match(detail.body.svg, /^<svg/);
  assert.equal(detail.body.pass.code, one.body.pass.code);

  // Re-entry: in and out as often as needed.
  const crew = { code: one.body.pass.code, qr_version: 1 };
  for (let i = 0; i < 3; i++) {
    const r = await scan(live.event.id, qr.passPayloadFor(crew));
    assert.equal(r.body.outcome, "admitted");
    assert.equal(r.body.pass, true);
    assert.equal(r.body.reentry, true);
    assert.equal(r.body.ticketType, "Gate pass · Crew · Stage door");
    assert.equal(r.body.holderName, "Sipho Crew");
  }
  assert.equal((await h.one("SELECT scans FROM gate_passes WHERE id = $1", [one.body.pass.id])).scans, 3);

  // Single entry: five gates at once, exactly one gets in.
  const [press, radio, photo] = bulk.body.passes.map((p) => p.pass);
  const results = await Promise.all(Array.from({ length: 5 }, () => scan(live.event.id, qr.passPayloadFor({ code: press.code, qr_version: 1 }))));
  assert.equal(results.filter((r) => r.body.outcome === "admitted").length, 1);
  assert.equal(results.filter((r) => r.body.outcome === "already_used").length, 4);
  assert.equal(results.find((r) => r.body.outcome === "admitted").body.reentry, false);
  assert.equal((await anon.get(`/api/public/pass?t=${token(bulk.body.passes[0].url)}`)).body.pass.used, true);

  // Forged signatures and a pass dressed up as a ticket are refused.
  const good = qr.passPayloadFor({ code: radio.code, qr_version: 1 });
  const forged = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
  assert.equal((await scan(live.event.id, forged)).body.outcome, "invalid");
  assert.equal((await scan(live.event.id, `TR1.${good.slice(4)}`)).body.outcome, "invalid");
  assert.equal((await scan(live.event.id, qr.passPayloadFor({ code: radio.code, qr_version: 2 }))).body.outcome, "invalid");

  // A typed pass code works too (as if the QR would not read).
  const typed = await scan(live.event.id, `${photo.code.slice(0, 5).toLowerCase()}-${photo.code.slice(5)}`);
  assert.equal(typed.body.outcome, "admitted");
  assert.equal(typed.body.pass, true);
  assert.equal(typed.body.ticketType, "Gate pass · Media");

  // Passes work from two days before (setup), tickets only from 12 hours before.
  const early = await owner.post(`${EV(soon)}/passes`, { holderName: "Build Crew", role: "crew", reentry: false });
  const earlyPayload = qr.passPayloadFor({ code: early.body.pass.code, qr_version: 1 });
  assert.equal((await scan(live.event.id, earlyPayload)).body.outcome, "wrong_event");
  assert.equal((await scan(soon.event.id, early.body.pass.code)).body.outcome, "admitted");
  assert.equal((await scan(soon.event.id, earlyPayload)).body.outcome, "already_used");
  assert.equal((await scan(soon.event.id, "ABCDEFGHJK")).body.outcome, "event_not_live");

  // Reissue: new link and QR; the old ones stop working.
  const re = await owner.post(`${P}/${one.body.pass.id}/reissue`);
  assert.equal(re.status, 200);
  assert.notEqual(re.body.url, one.body.url);
  assert.equal((await anon.get(`/api/public/pass?t=${token(one.body.url)}`)).status, 404);
  assert.equal((await anon.get(`/api/public/pass?t=${token(re.body.url)}`)).status, 200);
  assert.equal((await scan(live.event.id, qr.passPayloadFor(crew))).body.outcome, "invalid");
  assert.equal((await scan(live.event.id, qr.passPayloadFor({ code: crew.code, qr_version: 2 }))).body.outcome, "admitted");
  assert.equal((await h.one("SELECT count(*)::int AS n FROM message_outbox WHERE to_address = 'sipho@test.local'")).n, 2);

  // Revoke: the gate says so and the link shows a cancelled pass.
  const rv = await owner.post(`${P}/${radio.id}/revoke`);
  assert.equal(rv.body.pass.status, "revoked");
  assert.equal((await scan(live.event.id, good)).body.outcome, "revoked");
  assert.equal((await scan(live.event.id, radio.code)).body.outcome, "revoked");
  const gone = await anon.get(`/api/public/pass?t=${token(bulk.body.passes[1].url)}`);
  assert.equal(gone.body.pass.status, "revoked");
  assert.equal(gone.body.svg, null);
  assert.equal((await owner.get(`${P}/${radio.id}`)).body.svg, null);
  assert.equal((await owner.post(`${P}/${radio.id}/reissue`)).body.error.code, "pass_revoked");

  // Outsiders see nothing.
  assert.equal((await stranger.get(P)).status, 404);
  assert.equal((await stranger.post(P, { holderName: "Gate Crasher", role: "all_access" })).status, 404);
  assert.equal((await stranger.get(`${P}/${one.body.pass.id}`)).status, 404);
  assert.equal((await stranger.post(`${P}/${one.body.pass.id}/revoke`)).status, 404);
  assert.equal((await owner.get(`/api/organiser/${pendingOrg.id}/events/${pendingEvent.id}/passes/${one.body.pass.id}`)).status, 404);

  // Scanner phones get passes in the offline pack.
  const pack = (await owner.get(`/api/staff/events/${live.event.id}/offline-pack`)).body;
  assert.equal(pack.full, true);
  const row = (code) => pack.tickets.find((t) => t[0] === code);
  assert.deepEqual(row(crew.code), [crew.code, 2, 1, "Sipho C.", "Gate pass · Crew · Stage door", 1]);
  assert.deepEqual(row(press.code), [press.code, 1, 2, "Ayanda P.", "Gate pass · Media", 0]);
  assert.deepEqual(row(radio.code), [radio.code, 1, 0, "Thabo R.", "Gate pass · Media", 0]);
  const couple = pack.tickets.filter((t) => t[4] === "Couple pass · Admit 2");
  assert.equal(couple.length, 5);
  assert.deepEqual(couple.map((t) => t[3]), Array(5).fill("Lerato M."));
  assert.equal(couple.filter((t) => t[2] === 2).length, 1);
  const later = (await owner.get(`/api/staff/events/${live.event.id}/offline-pack?since=${encodeURIComponent(new Date(Date.now() + 60e3).toISOString())}`)).body;
  assert.equal(later.full, false);
  assert.equal(later.tickets.length, 0);

  // The scanner's recent list names pass holders.
  const recent = (await owner.get(`/api/staff/events/${live.event.id}/stats`)).body.recent;
  assert.ok(recent.some((x) => x.holder_name === "Sipho Crew"));
  assert.ok(recent.some((x) => x.holder_name === "Zanele Photo"));
});
