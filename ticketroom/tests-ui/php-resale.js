// Waitlists, TicketRoom Exchange (fair resale) and topping up a friend on
// the PHP edition: joining a waitlist for a sold-out ticket (one tap signed
// in, name and email signed out), offers that hold a ticket for 30 minutes
// and pass to the next person when they run out, listings capped at what the
// seller paid, a resale bought through the sandbox checkout, the old QR code
// scanning RESOLD while the new one works, sellers paid (card or EFT, ledger
// balanced), the organiser's resale switch, free tickets not for sale, and a
// wallet top-up for a friend. Run after php-cashdesk.js on the same instance:
//   node tests-ui/php-resale.js http://127.0.0.1:8600 /path/to/public_html
// Set TR_SHOTS to a folder to save screenshots there (TR_SHOTS=1 saves them
// in tests-ui/artifacts/php/resale-*.png).
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { verifyOrganiser } = require("./kyc-helper");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const FAN = { email: "sipho@example.co.za", password: "fan-password-123", portal: "customer" };
const RUN = require("crypto").randomBytes(4).toString("hex");
const ZANELE = { email: `zanele.rs.${RUN}@example.co.za`, password: "zanele-pass-123", portal: "customer" };
const PIETER = { email: `pieter.rs.${RUN}@example.co.za`, password: "pieter-pass-123", portal: "customer" };
const THANDI = { email: `thandi.rs.${RUN}@example.co.za`, password: "thandi-pass-123", portal: "customer" };
const LINDIWE = `lindiwe.rs.${RUN}@example.co.za`; // no account: joins the waitlist signed out
const SHOTS = process.env.TR_SHOTS && process.env.TR_SHOTS !== "1" ? process.env.TR_SHOTS : path.join(__dirname, "artifacts", "php");
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $d->exec('PRAGMA busy_timeout=5000'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const php = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); ${code}`]).toString();
const one = (q, ...a) => sql(q, ...a)[0];
const num = Number;
const idem = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function shot(p, name) {
  if (!process.env.TR_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // With a dialog open, the visible screen (a full-page shot would cut the dialog off).
  await p.screenshot({ path: path.join(SHOTS, `resale-${name}.png`), fullPage: !(await p.locator("dialog[open], .modal:visible").count()) });
}

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|422|429|503)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) { const r = await p.request.post(`${BASE}/api/auth/login`, { data: creds }); assert.equal(r.status(), 200, `sign in ${creds.email}: ${await r.text()}`); }
  return p;
}
function api(p) {
  let token;
  const call = async (method, url, data) => {
    token ??= (await (await p.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const r = await p.request.fetch(`${BASE}${url}`, { method, data, headers: token ? { "x-csrf-token": token } : {} });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), body };
  };
  return { get: (u) => call("GET", u), post: (u, d) => call("POST", u, d ?? {}), put: (u, d) => call("PUT", u, d), patch: (u, d) => call("PATCH", u, d) };
}
const ledgerOk = async (a, label) => {
  const r = await a.get("/api/admin/reconciliation");
  assert.equal(r.body.ledger.balanced, true, `ledger balanced: ${label} ${JSON.stringify(r.body.ledger)}`);
};
const newUser = (u, name) => php(`if (!user_by_email('${u.email}')) insert('users', ['id' => uuid(), 'email' => '${u.email}', 'email_key' => email_key('${u.email}'), 'full_name' => '${name}', 'password_hash' => hash_secret('${u.password}'), 'status' => 'active', 'account_type' => 'customer', 'email_verified_at' => now_iso(), 'created_at' => now_iso(), 'updated_at' => now_iso()]);`);
const uid = (email) => one("SELECT id FROM users WHERE email = ?", email).id;
const lastMail = (to, like) => sql("SELECT body FROM message_outbox WHERE to_address = ? AND subject LIKE ? ORDER BY created_at DESC LIMIT 1", to, like)[0]?.body;
const offerToken = (to) => /offer=([A-Za-z0-9_-]+)/.exec(lastMail(to, "A ticket for % is yours if you want it") || "")?.[1];
const noSideScroll = async (p, what) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll: ${what}`);
// Pays a sandbox payment the way the /pay page does.
async function sandboxPay(x, payment) {
  const u = new URL(payment.redirectUrl, BASE);
  const r = await x.post(`/api/public/payments/${u.searchParams.get("p")}/sandbox`, { k: u.searchParams.get("k"), outcome: "paid" });
  assert.equal(r.body.result, "confirmed", JSON.stringify(r.body));
}
// A provider's confirmation of a live card payment (as cashless and cash desk tests do).
const confirmLive = (orderRef) => {
  const p = one("SELECT p.provider_reference, p.amount_cents FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.reference = ? ORDER BY p.created_at DESC LIMIT 1", orderRef);
  assert.equal(php(`echo payment_apply('payfast', '${p.provider_reference}', 'paid', ${p.amount_cents});`), "confirmed");
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const adm = await page(browser, ADMIN);
    const a = api(adm);
    const org = await page(browser, ORG);
    const o = api(org);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;
    await verifyOrganiser(org.request, adm.request, BASE, orgId, { paid: true });
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "sandbox", mode: "test" } })).status, 200);
    newUser(ZANELE, "Zanele Khumalo"); newUser(PIETER, "Pieter van Wyk"); newUser(THANDI, "Thandi Mokoena");
    const fan = await page(browser, FAN, { width: 390, height: 844 }); const f = api(fan);
    const zan = await page(browser, ZANELE); const z = api(zan);
    const pie = await page(browser, PIETER, { width: 390, height: 844 }); const pv = api(pie);
    const tha = await page(browser, THANDI, { width: 390, height: 844 }); const t = api(tha);

    // A paid, cashless event with two R150 tickets. Sipho buys both (sandbox): sold out.
    const mkEvent = async (title, extra = {}) => {
      const starts = new Date(Date.now() + 3 * 3600e3), ends = new Date(Date.now() + 9 * 3600e3);
      const ev = (await o.post(`/api/organiser/${orgId}/events`, { title, category: "music", venueName: "Bassline Yard", city: "Johannesburg", startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 300, ...extra })).body.event;
      assert.ok(ev, `event ${title} created`);
      return ev;
    };
    const publish = async (ev) => {
      assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/submit`)).status, 200);
      assert.equal((await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" })).status, 200);
    };
    const ev = await mkEvent(`Exchange Night ${RUN}`, { cashlessEnabled: true });
    const tt = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "General", priceCents: 15000, quantityTotal: 2, perOrderLimit: 2 })).body.ticketType;
    await publish(ev);
    const buy = (await f.post("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 2 }], idempotencyKey: idem("o") })).body;
    await sandboxPay(f, buy.payment);
    const siphoTickets = sql("SELECT * FROM tickets WHERE event_id = ? ORDER BY created_at", ev.id);
    assert.equal(siphoTickets.length, 2);
    assert.equal((await z.post("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: idem("z") })).body.error.code, "sold_out");
    step("a paid event sells out: Sipho has both R150 tickets (sandbox, test tickets)");

    // 1. Waitlist: Pieter joins in one tap on his phone, Lindiwe signed out with her name and email, then Thandi.
    await pie.goto(`${BASE}/events/${ev.slug}`);
    await pie.getByRole("button", { name: "Join the waitlist" }).click();
    await pie.getByText("You're on the waitlist. We'll email you when one comes up.").waitFor();
    await noSideScroll(pie, "event page with waitlist");
    await shot(pie, "1-waitlist-joined");
    const anon = await page(browser, null, { width: 390, height: 844 });
    await anon.goto(`${BASE}/events/${ev.slug}`);
    await anon.getByRole("button", { name: "Join the waitlist" }).click();
    await anon.getByLabel("Your name").fill("Lindiwe Zulu");
    await anon.getByLabel("Email").fill(LINDIWE);
    await shot(anon, "2-waitlist-signed-out");
    await anon.locator("dialog").getByRole("button", { name: "Join the waitlist" }).click();
    await anon.getByText(/number 2 in line/).waitFor();
    assert.equal((await t.post(`/api/public/events/${ev.slug}/waitlist`, { ticketTypeId: tt.id })).body.waitlist.position, 3);
    assert.equal((await t.post(`/api/public/events/${ev.slug}/waitlist`, { ticketTypeId: tt.id })).body.waitlist.already, true, "joining twice keeps the first place");
    assert.ok(lastMail(LINDIWE, "You're on the waitlist for%"), "joining is confirmed by email");
    const other = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "Late", priceCents: 9000, quantityTotal: 10 })).body.ticketType;
    assert.equal((await t.post(`/api/public/events/${ev.slug}/waitlist`, { ticketTypeId: other.id })).body.error.code, "not_sold_out", "no waitlist while tickets are on sale");
    const by = (await o.get(`/api/organiser/${orgId}/events/${ev.id}/analytics`)).body.byType.find((x) => x.id === tt.id);
    assert.equal(num(by.waiting), 3, "the organiser sees the waitlist count");
    await org.goto(`${BASE}/organisers#/events/${ev.id}/tickets`);
    await org.getByText("3 on the waitlist").waitFor();
    await shot(org, "3-organiser-waitlist");
    await pie.goto(`${BASE}/account#/waitlists`);
    await pie.getByText(/Number\s*1\s*in line/).waitFor();
    step("waitlist: one tap signed in, name and email signed out, one place per person, only when sold out; organiser sees 3 waiting; Pieter sees his place");

    // 2. Listing: never above what Sipho paid; free tickets can't be sold.
    const list = (x, ticketId, priceCents, bank) => x.post(`/api/me/tickets/${ticketId}/resale`, { priceCents, ...(bank ? { bank } : {}) });
    const above = await list(f, siphoTickets[0].id, 15100);
    assert.deepEqual([above.status, above.body.error.code], [422, "above_face_value"], "listing above face value rejected");
    const free = await mkEvent(`Free Braai ${RUN}`, { isFree: true });
    await publish(free);
    const freeTt = one("SELECT id FROM ticket_types WHERE event_id = ?", free.id);
    assert.equal((await z.post("/api/public/orders", { eventSlug: free.slug, items: [{ ticketTypeId: freeTt.id, quantity: 1 }], idempotencyKey: idem("f") })).status, 201);
    const freeTicket = one("SELECT t.id FROM tickets t WHERE t.event_id = ? AND t.owner_user_id = ?", free.id, uid(ZANELE.email));
    assert.equal((await list(z, freeTicket.id, 1000)).body.error.code, "free_ticket", "free tickets can be passed on, not sold");
    step("a listing above face value (R151 for a R150 ticket) is refused; free tickets cannot be sold");

    // 3. Sipho lists one ticket from his phone. Pieter (first in line) gets the offer.
    await fan.goto(`${BASE}/account#/tickets`);
    const card = fan.locator(".tk-wrap", { hasText: ev.title }).first();
    await card.getByRole("button", { name: "Sell" }).click();
    await fan.getByText("At most R150.00, what you paid").waitFor();
    await shot(fan, "4-sell-dialog");
    await fan.getByRole("button", { name: "Put it up for resale" }).click();
    await fan.getByText(/Up for resale on TicketRoom Exchange/).first().waitFor();
    await noSideScroll(fan, "tickets with a listing");
    const listing = one("SELECT * FROM resale_listings WHERE event_id = ? ORDER BY created_at DESC LIMIT 1", ev.id);
    assert.deepEqual([listing.status, num(listing.price_cents), listing.payout_method, num(listing.test)], ["offered", 15000, "card", 1], "the waitlist gets first offer; Sipho paid by card, so he is paid back to it");
    const soldTicket = sql("SELECT * FROM tickets WHERE id = ?", listing.ticket_id)[0];
    assert.ok(offerToken(PIETER.email), "Pieter is emailed a private offer link");
    assert.equal((await f.post(`/api/me/tickets/${soldTicket.id}/transfer`, { toEmail: ZANELE.email })).body.error.code, "ticket_listed", "a listed ticket can't be transferred too");
    step("Sipho lists a ticket at R150 on his phone; Pieter, first in line, is offered it");

    // 4. Pieter lets the 30 minutes run out: it passes to Lindiwe.
    php(`q("UPDATE waitlist_entries SET offer_expires_at = ? WHERE status = 'offered' AND user_id = ?", [iso_in(-60), '${uid(PIETER.email)}']); echo waitlist_expire_offers();`);
    assert.equal(one("SELECT status FROM waitlist_entries WHERE user_id = ? AND ticket_type_id = ?", uid(PIETER.email), tt.id).status, "expired");
    const lt = offerToken(LINDIWE);
    assert.ok(lt, "the offer moves on to Lindiwe");
    assert.equal((await pv.get(`/api/public/waitlist/offer?t=${offerToken(PIETER.email)}`)).status, 404, "Pieter's link no longer works");
    step("an offer not taken in 30 minutes passes to the next person in line");

    // 5. Lindiwe (no account) opens her link on her phone and pays in the sandbox.
    await anon.goto(`${BASE}/events/${ev.slug}?offer=${lt}`);
    await anon.getByRole("heading", { name: "Your ticket is held" }).waitFor();
    await anon.getByText(LINDIWE).waitFor();
    await noSideScroll(anon, "offer checkout");
    await shot(anon, "5-offer-held");
    await anon.getByRole("button", { name: "Pay R160.00" }).click();
    await anon.getByRole("button", { name: "Approve payment" }).click();
    await anon.getByRole("heading", { name: "You're going" }).waitFor();
    await shot(anon, "6-resale-bought");
    const sold = one("SELECT * FROM resale_listings WHERE id = ?", listing.id);
    const oldT = one("SELECT * FROM tickets WHERE id = ?", soldTicket.id);
    const newT = one("SELECT * FROM tickets WHERE id = ?", sold.new_ticket_id);
    const buyerOrder = one("SELECT * FROM orders WHERE id = ?", sold.held_order_id);
    assert.deepEqual([sold.status, oldT.status, oldT.revoked_reason], ["sold", "revoked", "resold"], "the seller's ticket is voided");
    assert.notEqual(newT.code, oldT.code, "the buyer gets a new code");
    assert.deepEqual([newT.owner_user_id, num(newT.test), newT.status, num(buyerOrder.test), num(buyerOrder.total_cents), num(buyerOrder.fee_cents)], [uid(LINDIWE), 1, "valid", 1, 16000, 1000], "test order stays test; buyer paid R150 + R10 booking fee");
    const payout = one("SELECT * FROM resale_payouts WHERE listing_id = ?", listing.id);
    assert.deepEqual([payout.method, payout.status, num(payout.amount_cents), num(payout.test)], ["card", "paid", 15000, 1], "sandbox: Sipho is paid back to his card at once");
    const origPay = one("SELECT refunded_cents, status FROM payments WHERE order_id = ?", soldTicket.order_id);
    assert.deepEqual([num(origPay.refunded_cents), origPay.status], [15000, "partially_refunded"], "the refund is on Sipho's own payment");
    assert.equal(num(one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account = 'test:resale:sellers'").s), 0, "nothing left owed to sellers (test ledger)");
    assert.ok(lastMail(FAN.email, "[TEST] Your ticket for % has sold"), "Sipho is told it sold");
    await ledgerOk(a, "after a sandbox resale");
    step("Lindiwe pays R160 through the sandbox: Sipho's ticket voided, a new ticket with a new code for her, Sipho paid R150 back to his card, ledger balanced");

    // 6. At the gate: the old code (or a screenshot of it) scans RESOLD; the new code is the real one.
    const oldPayload = php(`echo qr_payload(row('SELECT * FROM tickets WHERE id = ?', ['${oldT.id}']));`);
    const scan = (payload) => o.post("/api/staff/scan", { eventId: ev.id, payload });
    const r1 = await scan(oldPayload);
    assert.equal(r1.body.outcome, "resold", JSON.stringify(r1.body));
    assert.equal((await scan(oldT.code)).body.outcome, "resold", "typed old code too");
    assert.equal((await scan(newT.code)).body.outcome, "test_ticket", "the new code is recognised (a sandbox ticket never opens the gate)");
    const scanner = await page(browser, ORG, { width: 390, height: 844 });
    await scanner.goto(`${BASE}/scan`);
    const pick = scanner.locator("[data-ev]", { hasText: ev.title });
    await Promise.race([pick.waitFor(), scanner.locator("#mc").waitFor()]);
    if (await pick.count()) await pick.click();
    await scanner.locator("#mc").fill(oldT.code);
    await scanner.getByRole("button", { name: "Check" }).click();
    await scanner.locator(".verdict.no .big", { hasText: "RESOLD" }).waitFor();
    await shot(scanner, "7-scanner-resold");
    const pack = (await o.get(`/api/staff/events/${ev.id}/offline-pack`)).body.tickets.find((x) => x[0] === oldT.code);
    assert.equal(pack[4], "Resold", "offline phones know it was resold too");
    step("scanner: the old code shows a red RESOLD (QR and typed, online and in the offline list); the new code is a different, live ticket");

    // 7. A refund frees a place: Thandi (next in line) gets a held ticket nobody else can buy.
    php(`$o = row('SELECT * FROM orders WHERE id = ?', ['${soldTicket.order_id}']); $r = refund_create($o, null, ['${siphoTickets[1].id}'], false, 'customer', 'Cannot attend'); refund_process($r['id']);`);
    assert.equal(one("SELECT status FROM tickets WHERE id = ?", siphoTickets[1].id).status, "refunded");
    assert.equal(one("SELECT status FROM waitlist_entries WHERE user_id = ? AND ticket_type_id = ?", uid(THANDI.email), tt.id).status, "offered");
    assert.equal((await z.post("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: idem("z2") })).body.error.code, "sold_out", "the held place is not for sale to others");
    const tk = offerToken(THANDI.email);
    await tha.goto(`${BASE}/events/${ev.slug}?offer=${tk}`);
    await tha.getByRole("heading", { name: "Your ticket is held" }).waitFor();
    await tha.getByRole("button", { name: "Pay R160.00" }).click();
    await tha.getByRole("button", { name: "Approve payment" }).click();
    await tha.getByRole("heading", { name: "You're going" }).waitFor();
    const thandiTicket = one("SELECT * FROM tickets WHERE event_id = ? AND owner_user_id = ? AND status = 'valid'", ev.id, uid(THANDI.email));
    assert.ok(thandiTicket, "Thandi has her ticket");
    assert.equal(one("SELECT status FROM waitlist_entries WHERE user_id = ? AND ticket_type_id = ?", uid(THANDI.email), tt.id).status, "claimed");
    step("a refunded ticket goes to the waitlist: Thandi's place is held for her (sold out to everyone else) and she buys it from her link");

    // 8. The organiser switches resale off: listings come down and new ones are refused.
    assert.equal((await list(t, thandiTicket.id, 12000)).status, 201, "Thandi lists hers below face value");
    assert.equal((await o.patch(`/api/organiser/${orgId}/events/${ev.id}`, { resaleEnabled: false })).body.event.resale_enabled, false);
    assert.equal(one("SELECT status FROM resale_listings WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1", thandiTicket.id).status, "closed", "switching off takes listings down");
    assert.equal((await list(t, thandiTicket.id, 12000)).body.error.code, "resale_disabled", "organiser resale switch off blocks listing");
    await org.goto(`${BASE}/organisers#/events/${ev.id}/details`);
    const sw = org.getByLabel(/Allow fan resale on TicketRoom Exchange/);
    await sw.waitFor();
    assert.equal(await sw.isChecked(), false, "the switch shows off in the event details");
    assert.ok(sql("SELECT 1 FROM audit_log WHERE action = 'resale.closed' AND entity_id = ?", ev.id).length, "audited");
    step("the organiser's resale switch: off takes listings down and blocks new ones");

    // 9. Real money (live mode, simulated provider confirmations): card payout by hand (PayFast), EFT payout through finance.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "payfast", mode: "live", payfastMerchantId: "10000100", payfastMerchantKey: "46f0cd694581a" } })).status, 200);
    const live = await mkEvent(`Exchange Live ${RUN}`);
    const ltt = (await o.post(`/api/organiser/${orgId}/events/${live.id}/ticket-types`, { name: "Standing", priceCents: 10000, quantityTotal: 10, perOrderLimit: 4 })).body.ticketType;
    await publish(live);
    const zo = (await z.post("/api/public/orders", { eventSlug: live.slug, items: [{ ticketTypeId: ltt.id, quantity: 2 }], idempotencyKey: idem("zl") })).body;
    confirmLive(zo.order.reference);
    const [zt1, zt2] = sql("SELECT * FROM tickets WHERE event_id = ? AND owner_user_id = ? ORDER BY created_at", live.id, uid(ZANELE.email));
    assert.equal(num(zt1.test), 0, "live ticket");
    const l1 = (await list(z, zt1.id, 8000)).body.listing;
    assert.deepEqual([l1.status, l1.payoutMethod], ["active", "card"]);
    const po = await pv.post(`/api/public/resale/${l1.id}/orders`, { idempotencyKey: idem("pl") });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    assert.equal(po.body.order.totalCents, 9000, "R80 + R10 booking fee");
    assert.equal((await z.post(`/api/me/resale/${l1.id}/cancel`)).body.error.code, "listing_held", "can't take it off while someone pays");
    confirmLive(po.body.order.reference);
    const l1row = one("SELECT * FROM resale_listings WHERE id = ?", l1.id);
    const pieterLive = one("SELECT * FROM tickets WHERE id = ?", l1row.new_ticket_id);
    const lscan = (payload) => o.post("/api/staff/scan", { eventId: live.id, payload });
    assert.equal((await lscan(zt1.code)).body.outcome, "resold", "old code scans RESOLD");
    assert.equal((await lscan(php(`echo qr_payload(row('SELECT * FROM tickets WHERE id = ?', ['${pieterLive.id}']));`))).body.outcome, "admitted", "new code admits");
    let lp = one("SELECT * FROM resale_payouts WHERE listing_id = ?", l1.id);
    assert.deepEqual([lp.method, lp.status, lp.provider, num(lp.test)], ["card", "manual_pending", "payfast", 0], "PayFast refunds are done by finance in the PayFast dashboard");
    await ledgerOk(a, "live resale, seller not paid yet");
    assert.equal((await a.post(`/api/admin/resale-payouts/${lp.id}/mark-paid`, { reference: "PF-REFUND-RS1" })).body.payout.status, "paid");
    await ledgerOk(a, "live card payout");
    // EFT: a ticket that came by transfer is paid out by EFT (it was not bought with the seller's card).
    assert.equal((await z.post(`/api/me/tickets/${zt2.id}/transfer`, { toEmail: THANDI.email })).status, 201);
    const claimTok = /claim\/([A-Za-z0-9_-]+)/.exec(lastMail(THANDI.email, "%sent you a ticket%"))[1];
    assert.equal((await t.post("/api/me/transfers/claim", { token: claimTok })).status, 200);
    assert.equal((await list(t, zt2.id, 10000)).body.error.code, "bank_needed", "no card to pay back to: bank details needed");
    const l2 = (await list(t, zt2.id, 10000, { accountHolder: "Thandi Mokoena", bankName: "Capitec", branchCode: "470010", accountNumber: "1122334455" })).body.listing;
    assert.equal(l2.payoutMethod, "eft");
    const guestBuy = await (await anon.request.post(`${BASE}/api/public/resale/${l2.id}/orders`, { data: { idempotencyKey: idem("g"), guest: { fullName: "Lindiwe Zulu", email: LINDIWE } } })).json();
    confirmLive(guestBuy.order.reference);
    lp = one("SELECT * FROM resale_payouts WHERE listing_id = ?", l2.id);
    assert.deepEqual([lp.method, lp.status, num(lp.amount_cents)], ["eft", "requested", 10000], "seller payout record in the EFT queue");
    assert.ok(!fs.readFileSync(path.join(dataDir, "ticketroom.sqlite")).includes("1122334455"), "bank account stored encrypted");
    await adm.goto(`${BASE}/admin#/refunds`);
    await adm.getByRole("heading", { name: "Resale payouts" }).waitFor();
    await adm.locator("tr", { hasText: lp.reference }).getByRole("button", { name: "Approve" }).click();
    await adm.locator("tr", { hasText: lp.reference }).getByRole("button", { name: "Mark paid" }).waitFor();
    await shot(adm, "8-admin-resale-payouts");
    assert.equal((await a.post(`/api/admin/resale-payouts/${lp.id}/reveal-account`)).body.accountNumber, "1122334455");
    assert.equal((await a.post(`/api/admin/resale-payouts/${lp.id}/mark-paid`, { reference: "FNB-RESALE-01" })).body.payout.status, "paid");
    assert.ok(lastMail(THANDI.email, "Your resale money for % is on its way"));
    assert.equal(num(one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account = 'resale:sellers'").s), 0, "every seller paid");
    const orgFin = (await o.get(`/api/organiser/${orgId}/events/${live.id}/analytics`)).body.totals;
    assert.equal(num(orgFin.ticket_revenue_cents), 20000, "resales don't count as new sales for the organiser");
    await ledgerOk(a, "live EFT payout");
    const audits = num(one("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'resale.%' OR action LIKE 'waitlist.%'").n);
    assert.ok(audits >= 15, `every step audited (${audits})`);
    step("live money: old code RESOLD, new code admits; card payout by hand for PayFast; EFT payout approved and paid by finance; organiser sales unchanged; ledger balanced; audited");

    // 10. Top up a friend (sandbox): unknown email offers an invite; Pieter gets R100 from Thandi.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "sandbox", mode: "test" } })).status, 200);
    await tha.goto(`${BASE}/account#/wallet/${ev.id}`);
    await tha.getByRole("radio", { name: "For a friend" }).click();
    await tha.getByLabel("Your friend's email").fill(`nobody.${RUN}@example.co.za`);
    await tha.getByLabel("Amount (R)").fill("100");
    await tha.getByRole("button", { name: "Top up", exact: true }).click();
    await tha.getByRole("button", { name: /Send an invite to/ }).click();
    await tha.getByText("Invite sent.").waitFor();
    await shot(tha, "9-friend-invite");
    assert.ok(lastMail(`nobody.${RUN}@example.co.za`, "%wants to top up your wallet%"), "invite emailed");
    await tha.getByLabel("Your friend's email").fill(PIETER.email);
    await tha.getByRole("button", { name: "Top up", exact: true }).click();
    await tha.getByRole("button", { name: "Approve payment" }).click();
    await tha.waitForURL(/\/account#\/wallet\//);
    await tha.getByText("Top-up for Pieter van Wyk").waitFor();
    await noSideScroll(tha, "wallet with a friend top-up");
    await shot(tha, "10-friend-topup");
    assert.equal(num(one("SELECT test_balance_cents FROM cashless_wallets WHERE user_id = ? AND event_id = ?", uid(PIETER.email), ev.id).test_balance_cents), 10000, "Pieter's balance");
    assert.equal(sql("SELECT 1 FROM cashless_wallets WHERE user_id = ? AND event_id = ? AND test_balance_cents > 0", uid(THANDI.email), ev.id).length, 0, "Thandi's own balance untouched");
    await pie.goto(`${BASE}/account#/wallet/${ev.id}`);
    await pie.getByText("Top-up from Thandi Mokoena").waitFor();
    assert.ok(lastMail(PIETER.email, "[TEST] Thandi Mokoena topped up your balance%"), "Pieter is emailed");
    assert.equal((await t.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 5000, idempotencyKey: idem("me"), friendEmail: THANDI.email })).body.error.code, "friend_is_you");
    await ledgerOk(a, "after a friend top-up");
    step("top up a friend: unknown email gets an invite; Pieter's balance gets R100 from Thandi, both see it in their activity and get an email");
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("PHP waitlist, resale and friend top-up checks passed.");
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
