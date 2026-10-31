const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const tagsSvc = require("../src/modules/tags/service");

let owner, staff, fan, ev, other, admin;
before(async () => {
  await h.setup();
  owner = await h.user();
  staff = await h.user({ name: "Gate Staff" });
  fan = await h.user({ name: "Fan" });
  admin = await h.user({ roles: ["admin"] });
  // Event is live: started an hour ago.
  ev = await h.organiserWithEvent(owner, { startsAt: new Date(Date.now() - 3600e3), types: [["GA", 10000, 50]], cashless: true });
  other = await h.addEvent(ev.organiser.id, { startsInDays: 0, types: [["GA", 10000, 50]] });
  await h.db.query("INSERT INTO event_staff (event_id, user_id, can_scan, can_manage_tags) VALUES ($1,$2,true,true)", [ev.event.id, staff.user.id]);
  await h.buyAndPay(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 3 }]);
});
after(h.teardown);

const scan = (c, body) => c.post("/api/staff/scan", { eventId: ev.event.id, ...body });

test("a valid ticket is admitted exactly once", async () => {
  const [t] = await h.ticketsOf(fan);
  const first = await scan(staff, { payload: t.qrPayload });
  assert.equal(first.body.outcome, "admitted");
  const second = await scan(staff, { payload: t.qrPayload });
  assert.equal(second.body.outcome, "already_used");
  assert.ok(second.body.admittedAt);
});

test("simultaneous scans of one ticket at two gates admit once", async () => {
  const t = (await h.ticketsOf(fan)).find((x) => x.status === "valid");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => scan(staff, { payload: t.qrPayload, gate: `G${i}` })));
  assert.equal(results.filter((r) => r.body.outcome === "admitted").length, 1);
  assert.equal(results.filter((r) => r.body.outcome === "already_used").length, 7);
  const log = await h.one("SELECT count(*)::int AS n FROM admission_log WHERE ticket_id = $1", [t.id]);
  assert.equal(log.n, 8);
});

test("altered or guessed QR payloads are rejected", async () => {
  const t = (await h.ticketsOf(fan)).find((x) => x.status === "valid");
  const tampered = t.qrPayload.replace(/\.1\./, ".2.");
  assert.equal((await scan(staff, { payload: tampered })).body.outcome, "invalid");
  assert.equal((await scan(staff, { payload: "TR1.ABCDEFGHJK.1.AAAAAAAAAAAAAAAAAAAAAA" })).body.outcome, "invalid");
  assert.equal((await scan(staff, { payload: "https://evil.example/qr" })).body.outcome, "invalid");
});

test("a ticket for another event is refused", async () => {
  const b = await h.user();
  await h.buyAndPay(b, other.event, [{ ticketTypeId: other.ticketTypes[0].id, quantity: 1 }]);
  const [t] = await h.ticketsOf(b);
  assert.equal((await scan(staff, { payload: t.qrPayload })).body.outcome, "wrong_event");
});

test("people who are not event staff cannot scan", async () => {
  const t = (await h.ticketsOf(fan)).find((x) => x.status === "valid");
  const r = await scan(fan, { payload: t.qrPayload });
  assert.equal(r.status, 404);
  const still = (await h.ticketsOf(fan)).find((x) => x.id === t.id);
  assert.equal(still.status, "valid");
});

test("transfer moves the ticket and kills the sender's QR", async () => {
  // Use a future event: transfers close at the start time.
  const fut = await h.addEvent(ev.organiser.id, { startsInDays: 5, types: [["GA", 10000, 10]] });
  await h.db.query("INSERT INTO event_staff (event_id, user_id) VALUES ($1,$2)", [fut.event.id, staff.user.id]);
  const sender = await h.user({ name: "Sender" });
  const receiver = await h.user({ name: "Receiver" });
  await h.buyAndPay(sender, fut.event, [{ ticketTypeId: fut.ticketTypes[0].id, quantity: 1 }]);
  const [t] = await h.ticketsOf(sender);
  const oldQr = t.qrPayload;
  const tr = await sender.post(`/api/me/tickets/${t.id}/transfer`, { toEmail: receiver.user.email });
  assert.equal(tr.status, 201);
  // A second transfer while one is pending is refused.
  assert.equal((await sender.post(`/api/me/tickets/${t.id}/transfer`, { toEmail: "x@test.local" })).status, 409);
  // The sender cannot accept their own transfer.
  assert.equal((await sender.post("/api/me/transfers/claim", { token: tr.body.transfer.devClaimToken })).status, 400);
  const claim = await receiver.post("/api/me/transfers/claim", { token: tr.body.transfer.devClaimToken });
  assert.equal(claim.status, 200);
  assert.equal((await h.ticketsOf(sender)).length, 0);
  const [mine] = await h.ticketsOf(receiver);
  assert.notEqual(mine.qrPayload, oldQr);
  assert.equal(mine.holder_name, "Receiver");
  // Claim link is single-use.
  assert.equal((await receiver.post("/api/me/transfers/claim", { token: tr.body.transfer.devClaimToken })).status, 409);
  // Move the event into its admission window and scan both copies.
  await h.db.query("UPDATE events SET starts_at = now() - interval '1 hour', ends_at = now() + interval '3 hours' WHERE id = $1", [fut.event.id]);
  const old = await staff.post("/api/staff/scan", { eventId: fut.event.id, payload: oldQr });
  assert.equal(old.body.outcome, "invalid");
  assert.equal((await staff.post("/api/staff/scan", { eventId: fut.event.id, payload: mine.qrPayload })).body.outcome, "admitted");
});

test("reissuing a QR invalidates the previous one", async () => {
  const t = (await h.ticketsOf(fan)).find((x) => x.status === "valid");
  const r = await admin.post(`/api/admin/tickets/${t.id}/reissue`, { reason: "screenshot leaked" });
  assert.equal(r.status, 200);
  assert.equal((await scan(staff, { payload: t.qrPayload })).body.outcome, "invalid");
  const fresh = (await h.ticketsOf(fan)).find((x) => x.id === t.id);
  assert.equal((await scan(staff, { payload: fresh.qrPayload })).body.outcome, "admitted");
});

// ------------------------------------------------------------------ tags
let batch;
test("admin can mint a QR tag batch; raw tokens are not stored", async () => {
  const r = await admin.post("/api/admin/tag-batches", { tagType: "qr_tag", mode: "generate", quantity: 6, eventId: ev.event.id });
  assert.equal(r.status, 201);
  batch = r.body.tags;
  assert.equal(batch.length, 6);
  const token = batch[0].payload.split(".")[1];
  const leak = await h.one("SELECT count(*)::int AS n FROM tags WHERE token_hash = $1 OR display_code = $1 OR activation_code_hash = $2", [token, batch[0].activationCode]);
  assert.equal(leak.n, 0);
  assert.equal((await fan.post("/api/admin/tag-batches", { tagType: "qr_tag", mode: "generate", quantity: 1 })).status, 403);
});

test("attendee links a tag with code + activation code; duplicates are refused", async () => {
  const t = batch[0];
  const bad = await fan.post("/api/me/tags/link", { displayCode: t.displayCode, activationCode: "ZZZZZZ", eventId: ev.event.id });
  assert.equal(bad.status, 409);
  const ok = await fan.post("/api/me/tags/link", { displayCode: t.displayCode, activationCode: t.activationCode, eventId: ev.event.id });
  assert.equal(ok.status, 201);
  // Same tag, another attendee.
  const thief = await h.user();
  await h.buyAndPay(thief, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const steal = await thief.post("/api/me/tags/link", { displayCode: t.displayCode, activationCode: t.activationCode, eventId: ev.event.id });
  assert.equal(steal.status, 409);
  assert.equal(steal.body.error.code, "tag_unavailable");
  // Second active tag for the same attendee and event.
  const second = await fan.post("/api/me/tags/link", { displayCode: batch[1].displayCode, activationCode: batch[1].activationCode, eventId: ev.event.id });
  assert.equal(second.body.error.code, "tag_already_linked");
});

test("linking requires a ticket for the event", async () => {
  const noTicket = await h.user();
  const r = await noTicket.post("/api/me/tags/link", { displayCode: batch[2].displayCode, activationCode: batch[2].activationCode, eventId: ev.event.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "no_ticket");
});

test("activation code guessing locks the tag", async () => {
  const guesser = await h.user();
  await h.buyAndPay(guesser, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  for (let i = 0; i < 5; i++) await guesser.post("/api/me/tags/link", { displayCode: batch[3].displayCode, activationCode: `AAAAA${i}`.slice(0, 6), eventId: ev.event.id });
  const r = await guesser.post("/api/me/tags/link", { displayCode: batch[3].displayCode, activationCode: batch[3].activationCode, eventId: ev.event.id });
  assert.equal(r.body.error.code, "tag_locked");
});

test("a linked tag admits its ticket at the gate", async () => {
  const r = await scan(staff, { tagInput: batch[0].payload });
  assert.ok(["admitted", "already_used"].includes(r.body.outcome));
});

test("staff desk links NFC wristbands by scanning ticket + tag; replacement keeps the person", async () => {
  const nfc = await admin.post("/api/admin/tag-batches", { tagType: "nfc_wristband", mode: "generate", quantity: 2, eventId: ev.event.id });
  const desker = await h.user({ name: "Desk Person" });
  await h.buyAndPay(desker, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const [t] = await h.ticketsOf(desker);
  const link = await staff.post("/api/staff/tags/link", { eventId: ev.event.id, ticketPayload: t.qrPayload, tagInput: nfc.body.tags[0].payload });
  assert.equal(link.status, 201);
  assert.equal(link.body.holderName, "Desk Person");
  const rep = await staff.post("/api/staff/tags/replace", { eventId: ev.event.id, oldTagId: link.body.tagId, newTagInput: nfc.body.tags[1].payload });
  assert.equal(rep.status, 200);
  const old = await tagsSvc.resolve(h.db, nfc.body.tags[0].payload);
  const nw = await tagsSvc.resolve(h.db, nfc.body.tags[1].payload);
  assert.equal(old.status, "replaced");
  assert.equal(nw.status, "active");
  assert.equal(nw.user_id, desker.user.id);
  // Fans without desk rights cannot link tags.
  assert.equal((await fan.post("/api/staff/tags/link", { eventId: ev.event.id, ticketPayload: t.qrPayload, tagInput: batch[4].payload })).status, 404);
});

test("imported chip UIDs are registered as identifier-only", async () => {
  const r = await admin.post("/api/admin/tag-batches", { tagType: "nfc_card", mode: "import", uids: ["04A1B2C3D4E5F6", "04:a1:b2:c3:d4:e5:f7"], eventId: ev.event.id });
  assert.equal(r.status, 201);
  assert.ok(r.body.tags.every((t) => t.securityLevel === "uid_only"));
  const bad = await admin.post("/api/admin/tag-batches", { tagType: "nfc_card", mode: "import", uids: ["not-a-uid"] });
  assert.equal(bad.status, 400);
  assert.equal(tagsSvc.normalise("04 A1 B2 C3 D4 E5 F6").value, "04A1B2C3D4E5F6");
  assert.equal(tagsSvc.normalise("garbage"), null);
});
