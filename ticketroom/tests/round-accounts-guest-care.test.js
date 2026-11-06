// One account per person, confirmed emails before sign-in, guest checkout
// with private order links, one-step organiser sign-up, customer questions
// passed to organisers, and the two-person refund rule.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers");
const { emailKey } = require("../src/lib/accounts");

let admin, owner, otherOwner, ev, paidEv, otherOrg;
before(async () => {
  await h.setup();
  admin = await h.user({ roles: ["admin", "support"], name: "Ayanda Admin" });
  owner = await h.user({ name: "Naledi Dlamini" });
  otherOwner = await h.user({ name: "Other Owner" });
  ev = await h.organiserWithEvent(owner, { types: [["Free entry", 0, 100]] });
  paidEv = await h.addEvent(ev.organiser.id, { types: [["GA", 15000, 100]] });
  otherOrg = await h.organiserWithEvent(otherOwner, { types: [["Free", 0, 10]] });
});
after(h.teardown);

const anon = () => new h.HttpClient();
const signup = (email, extra = {}) => anon().post("/api/auth/register", { fullName: "Test Person", email, password: "a-strong-pass-123", acceptTerms: true, ...extra });
const lastMail = async (to) => (await h.db.query("SELECT subject, body FROM message_outbox WHERE lower(to_address) = lower($1) ORDER BY created_at DESC, id DESC LIMIT 1", [to])).rows[0];
const mailCount = async (to) => (await h.one("SELECT count(*)::int AS n FROM message_outbox WHERE lower(to_address) = lower($1)", [to])).n;
const verifyToken = (m) => m.body.match(/#\/verify\/(\S+)/)[1];
const resetToken = (m) => m.body.match(/#\/reset\/(\S+)/)[1];
const guestOrder = (c, event, tt, guest, qty = 1) => c.post("/api/public/orders", { eventSlug: event.slug, items: [{ ticketTypeId: tt.id, quantity: qty }], idempotencyKey: `g-${Math.random().toString(36).slice(2, 12)}`, guest });

test("email keys: case, +tags and Gmail dots are one inbox", () => {
  assert.equal(emailKey(" Jane.Doe+Tickets@GMAIL.com "), "janedoe@gmail.com");
  assert.equal(emailKey("jane.doe@googlemail.com"), "janedoe@gmail.com");
  assert.equal(emailKey("jane.doe+x@example.co.za"), "jane.doe@example.co.za", "dots only matter outside Gmail");
});

test("one account per email and per mobile number; sign-up does not sign in", async () => {
  const reg = await signup("Jane.Doe+tickets@gmail.com");
  assert.equal(reg.status, 201);
  assert.deepEqual(Object.keys(reg.body).sort(), ["email", "message", "needsVerification"]);
  assert.equal(reg.body.needsVerification, true);
  assert.match(reg.body.message, /^We've sent a confirmation link to jane\.doe\+tickets@gmail\.com\./);
  assert.equal(reg.headers.getSetCookie().length, 0, "no session yet");
  assert.equal((await h.one("SELECT email_key FROM users WHERE email = 'jane.doe+tickets@gmail.com'")).email_key, "janedoe@gmail.com");

  for (const dup of ["JANE.DOE+tickets@gmail.com", "janedoe@gmail.com", "j.a.n.e.d.o.e@googlemail.com", "janedoe+other@gmail.com"]) {
    const r = await signup(dup);
    assert.equal(r.status, 409, dup);
    assert.equal(r.body.error.code, "email_taken");
    assert.deepEqual(r.body.error.details, { email: "Already has an account." });
  }
  assert.equal((await signup(owner.user.email.toUpperCase())).body.error.code, "email_taken", "case doesn't matter");

  assert.equal((await signup("phone.one@test.local", { phone: "082 555 0101" })).status, 201);
  const taken = await signup("phone.two@test.local", { phone: "+27825550101" });
  assert.equal(taken.body.error.code, "phone_taken", "one mobile number, one account");
  assert.deepEqual(taken.body.error.details, { phone: "Already on another account." });
});

test("unconfirmed accounts can't sign in; the link signs in once", async () => {
  const email = "confirm.me@test.local";
  assert.equal((await signup(email, { fullName: "Thabo Nkosi" })).status, 201);
  const before = await mailCount(email);
  const c = anon();
  const unconf = await c.post("/api/auth/login", { email, password: "a-strong-pass-123" });
  assert.equal(unconf.status, 403);
  assert.equal(unconf.body.error.code, "email_not_verified");
  assert.equal(await mailCount(email), before + 1, "a fresh link is sent");
  assert.equal((await c.post("/api/auth/login", { email, password: "wrong-password" })).body.error.code, "bad_credentials");
  // Resending is rate-limited (3 an hour per account), quietly.
  for (let i = 0; i < 4; i++) await anon().post("/api/auth/login", { email, password: "a-strong-pass-123" });
  assert.equal(await mailCount(email), before + 3);
  const resend = await anon().post("/api/auth/verify-email/resend", { email: "nobody@test.local" });
  assert.deepEqual(resend.body, { ok: true, message: "If that email is waiting to be confirmed, a new link is on its way." });

  const token = verifyToken(await lastMail(email));
  const first = await c.post("/api/auth/verify-email", { token });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, signedIn: true, accountType: "customer", firstName: "Thabo", tickets: 0, organiser: false });
  assert.equal((await c.get("/api/auth/me")).body.user.email, email, "signed in by the link");
  const again = await anon().post("/api/auth/verify-email", { token });
  assert.equal(again.body.signedIn, false, "an old link is not a way back in");
  assert.equal(again.headers.getSetCookie().length, 0);
  require("../src/lib/ratelimit").reset(); // the 5-tries-per-email login limit is real even in tests
  assert.equal((await anon().post("/api/auth/login", { email, password: "a-strong-pass-123" })).status, 200);
  assert.equal((await anon().post("/api/auth/verify-email", { token: "nonsense.token" })).status, 400);
});

test("guest checkout: private links only, and the tickets follow into a real account", async () => {
  const tt = ev.ticketTypes[0];
  const g1c = anon();
  const g1 = await guestOrder(g1c, ev.event, tt, { fullName: "Guest One", email: "Guest.One@test.local" }, 2);
  const g2 = await guestOrder(anon(), ev.event, tt, { fullName: "Guest Two", email: "guest.two@test.local" });
  assert.equal(g1.status, 201);
  assert.equal(g1.body.order.status, "paid");
  assert.ok(g1.body.accessKey);
  assert.equal(g1c.cookies.size, 0, "a guest is not signed in");

  const ref = g1.body.order.reference;
  const view = (k) => anon().get(`/api/public/orders/${ref}${k === undefined ? "" : `?k=${encodeURIComponent(k)}`}`);
  const ok = await view(g1.body.accessKey);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.guest, true);
  assert.equal(ok.body.email, "guest.one@test.local");
  assert.equal(ok.body.order.buyerName, "Guest One");
  assert.ok(ok.body.order.event.endsAt);
  assert.equal(ok.body.tickets.length, 2);
  const t = ok.body.tickets[0];
  for (const k of ["id", "code", "status", "holder_name", "admitted_at", "ticket_type", "admits", "qrUrl"]) assert.ok(k in t, k);
  assert.equal(t.qrUrl, `/api/public/orders/${ref}/tickets/${t.id}/qr.svg?k=${encodeURIComponent(g1.body.accessKey)}`);
  const svg = await anon().get(t.qrUrl);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(svg.body, /<svg/);

  assert.equal((await view(g2.body.accessKey)).status, 404, "another order's link opens nothing");
  assert.equal((await view("garbage")).status, 404);
  assert.equal((await view()).status, 401, "no link, no order");
  const stranger = await h.user();
  assert.equal((await stranger.get(`/api/public/orders/${ref}`)).status, 404, "signed in, but not the owner");
  assert.equal((await anon().get(`/api/public/orders/${g2.body.order.reference}/tickets/${t.id}/qr.svg?k=${encodeURIComponent(g2.body.accessKey)}`)).status, 404);

  const conf = await lastMail("guest.one@test.local");
  assert.match(conf.body, new RegExp(`View your tickets: ${h.baseUrl.replace(/[.]/g, "\\.")}/orders/${ref}\\?k=`));
  assert.match(conf.body, /Create a free account with this email address/);
  assert.doesNotMatch(conf.body, /Open my tickets:/);

  const noGuest = await anon().post("/api/public/orders", { eventSlug: ev.event.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: "no-guest-123" });
  assert.equal(noGuest.status, 400);
  assert.deepEqual(noGuest.body.error.details, { guest: "Required." });
  assert.equal((await anon().post("/api/auth/login", { email: "guest.one@test.local", password: "anything-at-all" })).body.error.code, "bad_credentials", "guest accounts have no password");

  // A second guest order with the same inbox lands in the same account.
  const again = await guestOrder(anon(), ev.event, tt, { fullName: "Guest One", email: "guest.one+again@test.local" });
  assert.equal(again.status, 201);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM users WHERE email_key = 'guest.one@test.local'")).n, 1);

  // Sign-up with the guest's email: no password is taken from the form; the
  // inbox gets a link to choose one, and the tickets are waiting there.
  const reg = await signup("guest.one@test.local", { fullName: "Guest One", password: "attacker-pass-123" });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.needsVerification, true);
  assert.equal((await anon().post("/api/auth/login", { email: "guest.one@test.local", password: "attacker-pass-123" })).body.error.code, "bad_credentials", "the typed password does nothing yet");
  const finish = await lastMail("guest.one@test.local");
  assert.equal(finish.subject, "Finish creating your TicketRoom account");
  assert.match(finish.body, /You've booked with us before, so your tickets are already waiting/);
  // Organiser sign-up with a guest's email: one email, one account, so it is taken.
  const os = await anon().post("/api/organiser/signup", { fullName: "Someone Else", email: "guest.one@test.local", password: "attacker-pass-123", organisation: "Not Theirs Events", acceptTerms: true });
  assert.equal(os.status, 409);
  assert.equal(os.body.error.code, "email_taken");
  assert.equal((await h.one("SELECT count(*)::int AS n FROM organisers WHERE name = 'Not Theirs Events'")).n, 0, "no organiser for a guest email");
  // "Didn't get the email?" for a guest sends the same kind of link, not a confirmation link.
  await anon().post("/api/auth/verify-email/resend", { email: "guest.one@test.local" });
  const finish2 = await lastMail("guest.one@test.local");
  assert.equal(finish2.subject, "Finish creating your TicketRoom account");
  const fc = anon();
  const done = await fc.post("/api/auth/password/reset", { token: resetToken(finish2), password: "guest-new-pass-1" });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { ok: true, signedIn: true, tickets: 3, accountType: "customer", staff: false, organiser: false });
  await fc.refreshCsrf();
  assert.equal((await fc.get("/api/auth/me")).body.user.email, "guest.one@test.local", "the reset signs them straight in");
  const u = await h.one("SELECT guest, email_verified_at FROM users WHERE email = 'guest.one@test.local'");
  assert.equal(u.guest, false);
  assert.ok(u.email_verified_at);
  assert.equal((await fc.post("/api/auth/login", { email: "guest.one@test.local", password: "guest-new-pass-1" })).status, 200);
  await fc.refreshCsrf();
  assert.equal((await h.ticketsOf(fc)).length, 3, "every guest ticket is in the account");
  assert.equal((await fc.get(`/api/public/orders/${ref}`)).body.guest, false, "the owner opens it without a key");
  assert.equal((await signup("guest.one@test.local")).body.error.code, "email_taken", "now a full account");
});

test("guest paid checkout: the payment page returns to the private link; cancel works with the key", async () => {
  const tt = paidEv.ticketTypes[0];
  const r = await guestOrder(anon(), paidEv.event, tt, { fullName: "Paying Guest", email: "payer@test.local", phone: "083 111 2222" });
  assert.equal(r.status, 201);
  assert.equal(r.body.order.status, "pending_payment");
  assert.ok(r.body.payment.redirectUrl);
  const p = await h.one("SELECT p.checkout_context FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.reference = $1", [r.body.order.reference]);
  assert.match(p.checkout_context.returnUrl, new RegExp(`/orders/${r.body.order.reference}\\?k=.+`));
  const k = decodeURIComponent(p.checkout_context.returnUrl.split("k=")[1]);
  assert.equal((await anon().get(`/api/public/orders/${r.body.order.reference}?k=${encodeURIComponent(k)}`)).status, 200, "the return link opens the order");

  const ref2 = (await guestOrder(anon(), paidEv.event, tt, { fullName: "Paying Guest", email: "payer@test.local" })).body;
  assert.equal((await anon().post(`/api/public/orders/${ref2.order.reference}/cancel`)).status, 401);
  assert.equal((await anon().post(`/api/public/orders/${ref2.order.reference}/cancel?k=${encodeURIComponent(r.body.accessKey)}`)).status, 404, "another order's key");
  const cancel = await anon().post(`/api/public/orders/${ref2.order.reference}/cancel?k=${encodeURIComponent(ref2.accessKey)}`);
  assert.deepEqual(cancel.body, { status: "cancelled" });

  await h.completePayment(r.body.payment.redirectUrl);
  const done = await anon().get(`/api/public/orders/${r.body.order.reference}?k=${encodeURIComponent(r.body.accessKey)}`);
  assert.equal(done.body.order.status, "paid");
  assert.equal(done.body.tickets.length, 1);
  assert.ok(done.body.tickets[0].qrUrl);
});

test("one-step organiser sign-up: unconfirmed account, pending organiser, owner membership", async () => {
  const body = { fullName: "Ayesha Naidoo", email: "ayesha@test.local", password: "organiser-pass-2", organisation: "Durban Beach Fest", acceptTerms: true };
  const r = await anon().post("/api/organiser/signup", body);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { needsVerification: true, email: "ayesha@test.local", message: "We've sent a confirmation link to ayesha@test.local. Open it and your organiser portal is ready." });
  const o = await h.one("SELECT o.*, m.role, u.email_verified_at FROM organisers o JOIN organiser_members m ON m.organiser_id = o.id JOIN users u ON u.id = m.user_id WHERE u.email = 'ayesha@test.local'");
  assert.equal(o.status, "pending");
  assert.equal(o.role, "owner");
  assert.equal(o.contact_email, "ayesha@test.local");
  assert.match(o.ref, /^ORG-/);
  assert.equal(o.email_verified_at, null);
  assert.equal((await anon().post("/api/auth/login", { email: "ayesha@test.local", password: "organiser-pass-2" })).body.error.code, "email_not_verified");
  assert.equal((await anon().post("/api/organiser/signup", { ...body, email: owner.user.email })).body.error.code, "email_taken");
  assert.equal((await anon().post("/api/organiser/signup", { ...body, acceptTerms: false, email: "x@test.local" })).status, 400);
  const c = anon();
  const v = await c.post("/api/auth/verify-email", { token: verifyToken(await lastMail("ayesha@test.local")) });
  assert.equal(v.body.organiser, true);
  assert.equal(v.body.signedIn, true);
  await c.refreshCsrf();
  const dash = await c.get(`/api/organiser/${o.id}/dashboard`);
  assert.equal(dash.status, 200);
  const mine = await owner.get(`/api/organiser/${ev.organiser.id}/dashboard`);
  assert.equal(mine.body.events.find((e) => e.id === ev.event.id).ticket_types, 1);
});

test("guests are treated like new people by team and scanner invites", async () => {
  await guestOrder(anon(), ev.event, ev.ticketTypes[0], { fullName: "Sipho Scanner", email: "sipho.scan@test.local" });
  const add = await owner.post(`/api/organiser/${ev.organiser.id}/members`, { email: "sipho.scan@test.local", role: "viewer" });
  assert.equal(add.status, 409, "a guest's email belongs to a customer account, not an organiser account");
  assert.equal(add.body.error.code, "not_organiser_account");
  const staff = await owner.post(`/api/organiser/${ev.organiser.id}/events/${ev.event.id}/staff`, { email: "sipho.scan@test.local", canScan: true });
  assert.equal(staff.status, 201);
  assert.equal(staff.body.invited, true);
  const inv = await lastMail("sipho.scan@test.local");
  assert.match(inv.subject, /added you as a ticket scanner/);
  assert.equal((await h.one("SELECT count(*)::int AS n FROM users WHERE email_key = 'sipho.scan@test.local'")).n, 1, "the same account, not a second one");
  const c = anon();
  const reset = await c.post("/api/auth/password/reset", { token: resetToken(inv), password: "scanner-pass-1" });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.tickets, 1);
  await c.refreshCsrf();
  assert.equal((await h.ticketsOf(c)).length, 1, "their guest ticket is still there");

  await guestOrder(anon(), ev.event, ev.ticketTypes[0], { fullName: "Team Guest", email: "team.guest@test.local" });
  const t2 = await admin.post("/api/admin/staff", { email: "team.guest@test.local", fullName: "Team Guest", roles: ["support"] });
  assert.equal(t2.status, 409, "staff need their own work email");
  assert.equal(t2.body.error.code, "not_staff_account");
});

test("customer care passes a question to the organiser, who answers the customer", async () => {
  const fan = await h.user({ name: "Sipho Mokoena" });
  await h.buy(fan, ev.event, [{ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }]);
  const sc = await fan.post("/api/public/support", { category: "tickets", subject: "Is there parking at the venue?", body: "Is there safe parking nearby?" });
  assert.equal(sc.status, 201);
  const c = await h.one("SELECT id, reference FROM support_cases WHERE reference = $1", [sc.body.reference]);

  const open = await admin.get(`/api/admin/support/${c.id}`);
  assert.equal(open.status, 200);
  assert.deepEqual(open.body.messages, []);
  assert.equal(open.body.suggestions.length, 1);
  assert.equal(open.body.suggestions[0].organiser_id, ev.organiser.id);
  assert.equal(open.body.suggestions[0].event_id, ev.event.id);
  const found = await admin.get(`/api/admin/support-organisers?q=${encodeURIComponent(ev.organiser.name.slice(0, 6).toLowerCase())}`);
  assert.ok(found.body.organisers.some((o) => o.id === ev.organiser.id));

  const tr = await admin.post(`/api/admin/support/${c.id}/transfer`, { organiserId: ev.organiser.id, eventId: ev.event.id, note: "Customer asks about parking." });
  assert.equal(tr.status, 200);
  assert.equal(tr.body.case.handled_by, "organiser");
  assert.equal(tr.body.case.organiser_name, ev.organiser.name);
  assert.ok(tr.body.case.transferred_at);
  assert.match((await lastMail(fan.user.email)).subject, new RegExp(`^Your question is with ${ev.organiser.name} \\(${c.reference}\\)$`));
  const orgMail = await lastMail("org@test.local");
  assert.equal(orgMail.subject, `Customer question for ${ev.organiser.name} (${c.reference})`);
  assert.match(orgMail.body, /about .*Note from customer care: Customer asks about parking\./s);
  assert.equal((await admin.post(`/api/admin/support/${c.id}/transfer`, { organiserId: ev.organiser.id, eventId: otherOrg.event.id })).status, 400, "the event must be that organiser's");
  const list = (await admin.get("/api/admin/support")).body.cases.find((x) => x.id === c.id);
  assert.equal(list.organiser_name, ev.organiser.name);
  assert.equal(list.handled_by, "organiser");

  const queries = await owner.get(`/api/organiser/${ev.organiser.id}/queries`);
  assert.equal(queries.body.open, 1);
  assert.equal(queries.body.queries[0].event_title, ev.event.title);
  const q = await owner.get(`/api/organiser/${ev.organiser.id}/queries/${c.id}`);
  assert.equal(q.body.query.subject, "Is there parking at the venue?");
  assert.ok(q.body.messages.some((m) => m.body.startsWith("Passed to")));

  // Organisers only ever see questions passed to them.
  assert.equal((await otherOwner.get(`/api/organiser/${otherOrg.organiser.id}/queries/${c.id}`)).status, 404, "another organiser can't open it");
  assert.equal((await otherOwner.post(`/api/organiser/${otherOrg.organiser.id}/queries/${c.id}/reply`, { message: "Hello there" })).status, 404);
  assert.equal((await otherOwner.get(`/api/organiser/${ev.organiser.id}/queries`)).status, 404);

  const reply = await owner.post(`/api/organiser/${ev.organiser.id}/queries/${c.id}/reply`, { message: "Yes, there is secure parking, R20 per car.", resolve: true });
  assert.equal(reply.status, 200);
  const m = await lastMail(fan.user.email);
  assert.equal(m.subject, `Re: Is there parking at the venue? (${c.reference})`);
  // Web cases carry no full name (as in the PHP edition), so the greeting is "Hi there".
  assert.match(m.body, /^Hi there,\n\nYes, there is secure parking, R20 per car\.\n\nNaledi, /);
  assert.match(m.body, new RegExp(`Naledi, ${ev.organiser.name}\\n`));
  assert.equal((await h.one("SELECT status FROM support_cases WHERE id = $1", [c.id])).status, "resolved");

  const mine = await fan.get(`/api/me/support/${c.reference}`);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.messages.map((x) => x.from), ["ticketroom", "organiser"]);
  assert.match(mine.body.messages[1].body, /secure parking/);
  assert.ok(!mine.body.messages.some((x) => /Customer asks about parking/.test(x.body)), "internal notes stay internal");
  assert.equal((await owner.get(`/api/me/support/${c.reference}`)).status, 403, "the customer portal API is for customer accounts");

  // TicketRoom takes it back; the organiser can no longer answer, and can't hand back what isn't theirs.
  assert.equal((await admin.post(`/api/admin/support/${c.id}/take-back`)).body.case.handled_by, "ticketroom");
  // Taken back: the case is no longer the organiser's at all.
  assert.equal((await owner.post(`/api/organiser/${ev.organiser.id}/queries/${c.id}/reply`, { message: "One more thing" })).status, 404);
  const back = await h.one("SELECT organiser_id, event_id FROM support_cases WHERE id = $1", [c.id]);
  assert.deepEqual(back, { organiser_id: null, event_id: null });
  const r2 = await admin.post(`/api/admin/support/${c.id}/reply`, { message: "Anything else we can help with?" });
  assert.equal(r2.status, 200);
  assert.match((await lastMail(fan.user.email)).body, /Ayanda, TicketRoom customer care/);
});

test("refunds: a lone finance person may approve their own request; with two, someone else must", async () => {
  // Only one active finance person exists so far in this file.
  const solo = await h.user({ roles: ["finance", "admin"] });
  const fan = await h.user();
  const bought = await h.buyAndPay(fan, paidEv.event, [{ ticketTypeId: paidEv.ticketTypes[0].id, quantity: 1 }]);
  const orderId = (await h.one("SELECT id FROM orders WHERE reference = $1", [bought.order.reference])).id;
  const refunds = require("../src/modules/finance/refunds");
  const actor = { id: solo.user.id, platformRoles: new Set(["finance", "admin"]), primaryRole: "admin" };
  const rf = await refunds.requestOrderRefund(actor, { orderId, reason: "Asked by customer", includeFees: true });
  const row = (await solo.get("/api/admin/refunds")).body.refunds.find((x) => x.id === rf.id);
  assert.equal(row.mine, false, "nobody else could approve it");
  const own = await solo.post(`/api/admin/refunds/${rf.id}/decide`, { approve: false, note: "Changed my mind" });
  assert.equal(own.status, 200);
  assert.equal(own.body.refund.status, "rejected");

  await h.user({ roles: ["finance"] });
  const rf2 = await refunds.requestOrderRefund(actor, { orderId, reason: "Asked again", includeFees: true });
  assert.equal((await solo.get("/api/admin/refunds")).body.refunds.find((x) => x.id === rf2.id).mine, true);
  const blocked = await solo.post(`/api/admin/refunds/${rf2.id}/decide`, { approve: true });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.message, "You asked for this refund, so someone else in finance must approve it.");
});
