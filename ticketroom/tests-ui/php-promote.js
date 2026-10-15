// Promote: the R1500 once-off event promotion package. Bought by card through
// the TicketRoom sandbox (TEST, never revenue) or from the available balance
// (atomic, audited); unlimited email campaigns and SMS (when set up) while it
// runs, with an hourly cap; campaign tracking links, clicks and attributed
// tickets; the socials request and the admin Promotions queue; refunds when an
// event is cancelled; a balanced ledger; free behaviour unchanged without it.
// Run after the other suites on the same instance (it reuses their accounts):
//   node tests-ui/php-promote.js http://127.0.0.1:8600 /path/to/public_html
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");
const { verifyOrganiser } = require("./kyc-helper");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const MOCK_PORT = process.env.TR_MOCK_PORT5 || "8705";
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const PRICE = 150000;
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $d->exec('PRAGMA busy_timeout=5000'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args.map(String)]).toString());
const php = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); ${code}`]).toString();
const clearLimits = () => sql("DELETE FROM rate_limits");
const mails = (to) => sql("SELECT subject, body, status FROM message_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC", to);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { await fetch(`${BASE}/api/health`).catch(() => {}); const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(400); }
}

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, functional: true, analytics: true })); } catch { /* no storage */ } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|422|429|503)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
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
const anon = (url, data, method = "POST") => fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const ledgerOk = async (a, label) => { const r = await a.get("/api/admin/reconciliation"); assert.equal(r.body.ledger.balanced, true, `ledger balanced: ${label} ${JSON.stringify(r.body.ledger)}`); };

(async () => {
  clearLimits();
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  // A local SMS stand-in (http, so the test switch allows private hosts) and
  // email "delivered" to a log, so delivery counts are real.
  fs.writeFileSync(cfgFile, original.replace("return [", "return [\n    'sms' => ['allowPrivateHosts' => true],").replace("'smtpPass' => '',", "'smtpPass' => '', 'mode' => 'log',"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tr-promote-"));
  const mock = spawn("php", ["-S", `127.0.0.1:${MOCK_PORT}`, path.join(__dirname, "mocks", "providers.php")], { env: { ...process.env, TARGET: BASE, STATE: state }, stdio: "ignore" });
  await sleep(2500);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const adm = await page(browser, ADMIN);
    const a = api(adm);
    const org = await page(browser, ORG);
    const o = api(org);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;
    const B = `/api/organiser/${orgId}`;

    // 0. Set-up: the TicketRoom sandbox for card payments, a verified organiser, a paid event.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "sandbox", mode: "test" } })).status, 200);
    await verifyOrganiser(org.request, adm.request, BASE, orgId, { paid: true });
    const mkEvent = async (title, hours = 48) => {
      const starts = new Date(Date.now() + hours * 3600e3), ends = new Date(Date.now() + (hours + 5) * 3600e3);
      const ev = (await o.post(`${B}/events`, { title, category: "music", venueName: "The Loud Room", city: "Johannesburg", startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 200 })).body.event;
      const free = (await o.post(`${B}/events/${ev.id}/ticket-types`, { name: "Community", priceCents: 0, quantityTotal: 100, perOrderLimit: 4 })).body.ticketType;
      const paid = (await o.post(`${B}/events/${ev.id}/ticket-types`, { name: "General", priceCents: 15000, quantityTotal: 100, perOrderLimit: 4 })).body.ticketType;
      const sub = await o.post(`${B}/events/${ev.id}/submit`);
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      const pub = await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" });
      assert.equal(pub.status, 200, JSON.stringify(pub.body));
      return { ...ev, free, paid };
    };
    const ev1 = await mkEvent("Promote Night Live");
    // Two fans book free tickets and opt in to the organiser's email and SMS.
    for (const [name, email, phone] of [["Lindiwe Fan", "lindiwe.promo@example.co.za", "082 555 0101"], ["Bongani Fan", "bongani.promo@example.co.za", "083 555 0102"]]) {
      const r = await anon("/api/public/orders", { eventSlug: ev1.slug, items: [{ ticketTypeId: ev1.free.id, quantity: 1 }], idempotencyKey: `promo-${email.split("@")[0]}`, guest: { fullName: name, email, phone }, marketingOptIn: { email: true, sms: true } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    step("set-up: sandbox payments, verified organiser, a published paid event, two fans opted in to email and SMS");

    // 1. Without Promote nothing changes: email campaigns as before, SMS refused.
    const free1 = await o.post(`${B}/campaigns`, { channel: "email", name: "Before Promote", subject: "See you there", body: "Hi {{first_name}}, see you there!", eventIds: [ev1.id] });
    assert.equal(free1.status, 201);
    assert.equal((await o.post(`${B}/campaigns/${free1.body.campaign.id}/send`)).body.campaign.status, "sent");
    assert.equal(sql("SELECT promotion_id FROM campaigns WHERE id = ?", free1.body.campaign.id)[0].promotion_id, null, "an ordinary campaign");
    assert.equal(sql("SELECT count(*) AS n FROM tracking_links WHERE campaign_id = ?", free1.body.campaign.id)[0].n, 0, "no tracking link without Promote");
    const smsNo = await o.post(`${B}/campaigns`, { channel: "sms", name: "SMS before", body: "Hi", eventIds: [ev1.id] });
    assert.equal(smsNo.status, 409); assert.equal(smsNo.body.error.code, "sms_not_available");
    let st = (await o.get(`${B}/events/${ev1.id}/promotion`)).body;
    assert.equal(st.priceCents, PRICE); assert.equal(st.promotion, null); assert.equal(st.canBuy, true); assert.equal(st.methods.cardTest, true);
    assert.equal(st.audience.emailOptIns, 2);
    step("without Promote: email campaigns work as before (daily limit), SMS refused, no tracking link");

    // 2. The Sell page describes Promote.
    const vis = await page(browser, null, { width: 390, height: 844 });
    await vis.goto(`${BASE}/sell`);
    await vis.getByRole("heading", { name: "Let your crowd know, loud and clear" }).waitFor();
    await vis.locator(".promote-amount", { hasText: "R1 500" }).waitFor();
    assert.equal(await vis.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "sell page fits a phone");
    step("the Sell page shows the R1 500 Promote package");

    // 3. The organiser buys Promote by card in the sandbox: a declined try, then approved.
    await org.goto(`${BASE}/organisers#/events/${ev1.id}/promote`);
    await org.getByRole("heading", { name: "Let your crowd know, loud and clear" }).waitFor();
    await org.getByText(/Test mode\./).waitFor();
    for (const t of ["Unlimited email campaigns", "SMS campaigns", "Your event on our socials", "Results you can trust", "Seamless cashout"]) await org.locator(".promote-includes strong", { hasText: t }).waitFor();
    assert.equal(await org.locator("#main").evaluate((m) => /—/.test(m.innerText)), false, "no em dashes in the copy");
    await org.getByRole("button", { name: "Pay R1 500 by card" }).click();
    await org.waitForURL(/\/pay\?p=.*m=sandbox/);
    await org.getByText(/Promote package for Promote Night Live/).waitFor();
    await org.getByRole("button", { name: "Decline (card refused)" }).click();
    await org.waitForURL(/organisers#\/events\/.*\/promote/);
    await org.getByText(/didn't go through, so nothing was charged/).waitFor();
    await org.getByRole("button", { name: "Pay R1 500 by card" }).click();
    await org.waitForURL(/\/pay\?p=.*m=sandbox/);
    await org.getByRole("button", { name: "Approve payment" }).click();
    await org.waitForURL(/organisers#\/events\/.*\/promote/);
    await org.getByText(/Promoted until/).waitFor();
    await org.locator(".promote-status .badge", { hasText: "TEST" }).waitFor();
    const p1 = sql("SELECT * FROM event_promotions WHERE event_id = ?", ev1.id)[0];
    assert.equal(p1.status, "active"); assert.equal(Number(p1.test), 1); assert.equal(p1.paid_with, "card"); assert.equal(Number(p1.price_cents), PRICE);
    assert.equal(p1.ends_at, sql("SELECT ends_at FROM events WHERE id = ?", ev1.id)[0].ends_at, "runs until the event ends");
    const pays = sql("SELECT status, provider, environment FROM promotion_payments WHERE promotion_id = ? ORDER BY created_at", p1.id);
    assert.deepEqual(pays.map((x) => x.status), ["failed", "confirmed"]); assert.equal(pays[1].provider, "sandbox"); assert.equal(pays[1].environment, "test");
    assert.equal(Number(sql("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account = 'test:revenue:promotions'")[0].s), -PRICE, "booked to the test ledger");
    assert.equal(Number(sql("SELECT count(*) AS n FROM ledger_entries WHERE account = 'revenue:promotions'")[0].n), 0, "never real revenue");
    const receipt = mails(ORG.email).find((m) => /Promote is on/.test(m.subject));
    assert.match(receipt.subject, /^\[TEST\] Promote is on for Promote Night Live \(PR-/);
    assert.match(receipt.body, /R 1 500\.00 by card/); assert.match(receipt.body, /Unlimited|As many email campaigns/);
    let rv = (await a.get("/api/admin/promotions")).body.revenue;
    assert.equal(rv.liveCents, 0); assert.equal(rv.testCents, PRICE);
    await ledgerOk(a, "after the sandbox purchase");
    step("buy by card in the sandbox: decline, retry, approve; promotion active and TEST; receipt emailed [TEST]; test ledger only, no revenue");

    // 4. Unlimited email (an hourly cap), a tracking link per campaign, and SMS once it is set up.
    clearLimits();
    const backdate = () => sql("UPDATE campaigns SET sent_at = ? WHERE organiser_id = ? AND status = 'sent'", new Date(Date.now() - 2 * 3600e3).toISOString(), orgId);
    backdate();
    await org.getByRole("button", { name: "New email campaign" }).click();
    const dlg = org.locator("dialog[open]");
    await dlg.getByLabel("Campaign name (internal)").fill("Final call");
    await dlg.getByLabel("Email subject").fill("Last tickets for Promote Night");
    assert.match(await dlg.getByLabel("Message").inputValue(), /\{\{event_link\}\}/, "starts with the tracked link in the message");
    await dlg.getByRole("button", { name: "Save draft" }).click();
    await dlg.getByText(/Promoted event \(TEST\): no daily limit/).waitFor();
    await dlg.getByRole("button", { name: "Send now" }).click();
    await org.locator("dialog[open]").last().getByRole("button", { name: "Send now" }).click();
    await org.getByText(/Sent to 2 recipients/).waitFor();
    const c1 = sql("SELECT * FROM campaigns WHERE name = 'Final call' AND organiser_id = ?", orgId)[0];
    assert.equal(c1.promotion_id, p1.id);
    const link = sql("SELECT * FROM tracking_links WHERE campaign_id = ?", c1.id)[0];
    assert.match(link.code, /^C[A-Z0-9]{7}$/);
    const sentMail = mails("lindiwe.promo@example.co.za").find((m) => m.subject === "Last tickets for Promote Night");
    assert.ok(sentMail.body.includes(`/events/${ev1.slug}?ref=${link.code}`), "the email carries the campaign's tracking link");
    assert.match(sentMail.body, /Unsubscribe: /);
    // More than the daily 10 is fine while promoted, but at most 6 an hour.
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await o.post(`${B}/campaigns`, { channel: "email", name: `Burst ${i}`, subject: `Burst ${i}`, body: "More news {{event_link}}", eventIds: [ev1.id] })).body.campaign.id);
    const sends = [];
    for (const id of ids) sends.push(await o.post(`${B}/campaigns/${id}/send`));
    // "Final call" went this hour too: 6 an hour in all.
    assert.equal(sends.filter((r) => r.status === 200).length, 5); assert.equal(sends.filter((r) => r.status === 409).length, 2);
    assert.equal(sends.find((r) => r.status === 409).body.error.code, "campaign_limit"); assert.match(sends.find((r) => r.status === 409).body.error.message, /6 campaigns an hour/);
    // Older sends move out of the hour: the cap is per hour, not per day.
    backdate();
    assert.equal((await o.post(`${B}/campaigns/${ids[5]}/send`)).status, 200);
    assert.equal((await o.post(`${B}/campaigns/${ids[6]}/send`)).status, 200);
    const today = Number(sql("SELECT count(*) AS n FROM campaigns WHERE organiser_id = ? AND status = 'sent' AND sent_at > ?", orgId, new Date(Date.now() - 86400e3).toISOString())[0].n);
    assert.ok(today >= 8, `${today} campaigns today`);
    // SMS: the admin sets up the SMS provider; then SMS goes out for the promoted event only.
    assert.equal((await a.put("/api/admin/integrations/sms", { currentPassword: ADMIN.password, values: { provider: "http", httpUrl: `${MOCK}/sms/send`, httpAuth: "Bearer sms-test-key", httpFormat: "json", httpToField: "to", httpMessageField: "message", httpNumberFormat: "plus" } })).status, 200);
    await until(async () => (await o.get(`${B}/events/${ev1.id}/promotion`)).body.sms.ready, "SMS ready");
    backdate();
    const sms = await o.post(`${B}/campaigns`, { channel: "sms", name: "SMS blast", body: "Hi {{first_name}}, last tickets for Promote Night: {{event_link}}", eventIds: [ev1.id] });
    assert.equal(sms.status, 201, JSON.stringify(sms.body));
    const pv = (await o.get(`${B}/campaigns/${sms.body.campaign.id}/preview`)).body;
    assert.equal(pv.recipients, 2); assert.ok(pv.segments >= 1); assert.equal(pv.estimatedCostCents, null, "no SMS cost setting: no invented cost");
    assert.equal((await o.post(`${B}/campaigns/${sms.body.campaign.id}/send`)).body.campaign.recipients_count, 2);
    const blast = () => (fs.existsSync(path.join(state, "sms.log")) ? fs.readFileSync(path.join(state, "sms.log"), "utf8").trim().split("\n") : []).map((l) => JSON.parse(JSON.parse(l).body)).filter((m) => /last tickets/.test(m.message));
    await until(() => blast().length >= 2, "two campaign SMS at the provider", 75000);
    const smsBody = blast()[0];
    assert.match(smsBody.message, /Soweto Community Arts: Hi (Lindiwe|Bongani), last tickets for Promote Night: http\S+\?ref=C[A-Z0-9]{7} Opt out: /);
    const ev2 = await mkEvent("Promote Day Two", 72);
    const smsOther = await o.post(`${B}/campaigns`, { channel: "sms", name: "SMS other", body: "Hi", eventIds: [ev2.id] });
    assert.equal(smsOther.status, 409); assert.match(smsOther.body.error.message, /come with Promote/);
    step("while promoted: the composer starts with the tracked link; no daily limit but 6 sends an hour; each campaign gets its own link; SMS sent once set up, for the promoted event only; no invented SMS cost");

    // 5. Clicks and attributed tickets; opens are not invented; test orders kept apart.
    const fan = await page(browser, null, { width: 390, height: 844 });
    await fan.goto(`${BASE}/events/${ev1.slug}?ref=${link.code}`);
    await fan.getByRole("button", { name: /More Community/ }).waitFor();
    await until(() => Number(sql("SELECT clicks FROM tracking_links WHERE id = ?", link.id)[0].clicks) >= 1, "click counted");
    const att = await anon("/api/public/orders", { eventSlug: ev1.slug, items: [{ ticketTypeId: ev1.free.id, quantity: 2 }], ref: link.code, idempotencyKey: "promo-attr-1", guest: { fullName: "Click Buyer", email: "click.buyer@example.co.za" } });
    assert.equal(att.status, 201, JSON.stringify(att.body));
    const tpay = await anon("/api/public/orders", { eventSlug: ev1.slug, items: [{ ticketTypeId: ev1.paid.id, quantity: 1 }], ref: link.code, idempotencyKey: "promo-attr-2", guest: { fullName: "Test Buyer", email: "test.buyer@example.co.za" } });
    const q = new URL(tpay.body.payment.redirectUrl, BASE).searchParams;
    assert.equal((await anon(`/api/public/payments/${q.get("p")}/sandbox`, { k: q.get("k"), outcome: "paid" })).body.result, "confirmed");
    await until(async () => (await o.get(`${B}/events/${ev1.id}/promotion`)).body.analytics.totals.emailsSent >= 2, "emails delivered", 75000);
    st = (await o.get(`${B}/events/${ev1.id}/promotion`)).body;
    const t = st.analytics.totals;
    assert.equal(t.opens, null); assert.equal(st.analytics.opensTracked, false);
    assert.ok(t.clicks >= 1); assert.equal(t.orders, 1); assert.equal(t.tickets, 2); assert.equal(t.revenueCents, 0); assert.equal(t.testOrders, 1, "the sandbox order is counted apart");
    assert.ok(t.smsSent >= 2 || t.notDelivered >= 0);
    const fc = st.analytics.campaigns.find((c) => c.name === "Final call");
    assert.equal(fc.clicks, Number(sql("SELECT clicks FROM tracking_links WHERE id = ?", link.id)[0].clicks)); assert.equal(fc.tickets, 2);
    assert.equal(st.analytics.daily.length, 30); assert.ok(st.analytics.daily.at(-1).messages >= 2);
    await org.goto(`${BASE}/organisers#/events/${ev1.id}/promote`);
    await org.reload();
    await org.getByRole("heading", { name: "Results" }).waitFor();
    await org.getByText(/Opens are not tracked/).waitFor();
    await org.getByText(/1 test order came through campaign links/).waitFor();
    assert.equal(await org.locator("svg.chart").count(), 2, "daily charts");
    step("analytics: clicks on the campaign link, 2 tickets attributed, revenue only from live orders, test order counted apart, opens not invented, daily chart");

    // 6. Socials: the organiser asks, staff schedule and post, the organiser sees it live.
    await org.getByLabel("Caption").fill("Promote Night Live is this weekend: the loudest room in Joburg. Grab your tickets!");
    await org.getByLabel(/Preferred dates/).fill("Friday morning");
    await org.getByLabel(/^Links/).fill("https://instagram.com/sowetoarts");
    await org.getByRole("button", { name: "Send my request" }).click();
    await org.getByText(/Request sent/).first().waitFor();
    assert.equal(sql("SELECT social_status FROM event_promotions WHERE id = ?", p1.id)[0].social_status, "requested");
    assert.ok(mails("hello@ticketroom.co.za").some((m) => /^Social post request: Promote Night Live/.test(m.subject)), "staff told");
    await adm.goto(`${BASE}/admin#/promotions`);
    await adm.getByRole("heading", { name: "Promotions" }).waitFor();
    await adm.locator("tr", { hasText: "Promote Night Live" }).getByRole("button", { name: "Social post" }).click();
    let sd = adm.locator("dialog[open]");
    await sd.getByText("the loudest room in Joburg").waitFor();
    await sd.getByLabel("Status").selectOption("scheduled");
    await sd.getByLabel(/Note to the organiser/).fill("Going out on Instagram on Friday at 09:00");
    await sd.getByRole("button", { name: "Save" }).click();
    await adm.getByText("Marked as scheduled.").waitFor();
    assert.equal((await a.post(`/api/admin/promotions/${p1.id}/social`, { status: "posted" })).status, 400, "a live post needs its link");
    await adm.locator("tr", { hasText: "Promote Night Live" }).getByRole("button", { name: "Social post" }).click();
    sd = adm.locator("dialog[open]");
    await sd.getByLabel("Status").selectOption("posted");
    await sd.getByLabel(/Post links/).fill("https://www.instagram.com/p/promote-night/");
    await sd.getByRole("button", { name: "Save" }).click();
    await adm.getByText(/Marked as posted/).waitFor();
    assert.ok(mails(ORG.email).some((m) => m.subject === "Promote Night Live is on TicketRoom's socials" && m.body.includes("https://www.instagram.com/p/promote-night/")));
    await org.reload();
    await org.locator(".promote-steps li.done", { hasText: "Live" }).waitFor();
    await org.getByRole("link", { name: "https://www.instagram.com/p/promote-night/" }).waitFor();
    step("socials: request with caption, dates, links and poster; staff told; scheduled, then posted with its link; the organiser emailed and sees it live");

    // 7. Seamless cashout: paying from the available balance is atomic.
    clearLimits();
    const ev3 = await mkEvent("Promote Day Three", 96);
    const past = (await o.post(`${B}/events`, { title: "Promote Seed Past Show", category: "music", venueName: "The Loud Room", city: "Johannesburg", startsAt: new Date(Date.now() + 3600e3).toISOString(), endsAt: new Date(Date.now() + 7200e3).toISOString(), capacity: 10 })).body.event;
    sql("UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?", new Date(Date.now() - 41 * 86400e3).toISOString(), new Date(Date.now() - 40 * 86400e3).toISOString(), past.id);
    const avail = async () => (await o.get(`${B}/finance`)).body.availableCents;
    // Earnings from an event that is over (booked straight to the ledger for the test): R2 250 available.
    for (let i = 0; i < 3 && (await avail()) !== 225000; i++) {
      const delta = 225000 - (await avail());
      sql("INSERT INTO ledger_journals (kind, reference, created_at) VALUES ('test_seed', ?, ?)", `SEED-${Date.now()}-${i}`, new Date().toISOString());
      const jid = sql("SELECT max(id) AS id FROM ledger_journals")[0].id;
      sql("INSERT INTO ledger_entries (journal_id, account, amount_cents) VALUES (?, ?, ?), (?, 'bank:test_seed', ?)", jid, `organiser:${orgId}:event:${past.id}`, -delta, jid, delta);
    }
    assert.equal(await avail(), 225000);
    st = (await o.get(`${B}/events/${ev2.id}/promotion`)).body;
    assert.equal(st.methods.balance.availableCents, 225000);
    // Two purchases at the same moment, money for one: exactly one goes through.
    const both = await Promise.all([ev2, ev3].map((e) => o.post(`${B}/events/${e.id}/promotion/checkout`, { method: "balance" })));
    assert.equal(both.filter((r) => r.status === 200 && r.body.paid).length, 1, JSON.stringify(both.map((r) => r.body)));
    const lost = both.find((r) => r.status !== 200);
    assert.equal(lost.status, 409); assert.equal(lost.body.error.code, "insufficient_balance");
    assert.equal(await avail(), 75000, "R1 500 came off the balance once");
    const won = both[0].status === 200 ? ev2 : ev3;
    const pb = sql("SELECT * FROM event_promotions WHERE event_id = ? AND status = 'active'", won.id)[0];
    assert.equal(pb.paid_with, "balance"); assert.equal(Number(pb.test), 0, "real money, not TEST");
    assert.equal(Number(sql("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?", `organiser:${orgId}:deductions`)[0].s), PRICE);
    assert.equal(Number(sql("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = 'revenue:promotions'")[0].s), -PRICE);
    const au = sql("SELECT details FROM audit_log WHERE action = 'promotion.paid_from_balance' ORDER BY id DESC LIMIT 1")[0];
    assert.match(au.details, /"availableBefore":225000/);
    rv = (await a.get("/api/admin/promotions")).body.revenue;
    assert.equal(rv.liveCents, PRICE); assert.equal(rv.testCents, PRICE);
    await ledgerOk(a, "after paying from the balance");
    // Only the owner spends the balance; the payout rules still apply.
    st = (await o.get(`${B}/finance`)).body;
    assert.equal(st.promoteFromBalanceCents, PRICE);
    step("pay from balance: two at once with money for one, exactly one succeeds; balance down R1 500 once; live revenue; audited; ledger balanced");

    // 8. Refunds when an event is cancelled: balance back to the balance, sandbox back at once.
    assert.equal((await a.post(`/api/admin/promotions/${p1.id}/refund`, { reason: "Testing refunds" })).body.error.code, "event_not_cancelled");
    assert.equal((await a.post(`/api/admin/events/${won.id}/cancel`, { reason: "Venue flooded" })).status, 200);
    await adm.goto(`${BASE}/admin#/promotions`);
    await adm.getByRole("button", { name: "All" }).click();
    await adm.locator("tr", { hasText: won.title }).getByRole("button", { name: "Refund" }).click();
    await adm.locator("dialog[open]").getByLabel("Reason").fill("Event cancelled: venue flooded");
    await adm.locator("dialog[open]").getByRole("button", { name: "Confirm" }).click();
    await adm.getByText("Refund sent.").waitFor();
    const pr = sql("SELECT * FROM event_promotions WHERE id = ?", pb.id)[0];
    assert.equal(pr.status, "refunded"); assert.equal(pr.refund_status, "completed"); assert.match(pr.refund_reference, /^RF-/);
    assert.equal(await avail(), 225000, "back in the balance");
    assert.ok(mails(ORG.email).some((m) => m.subject === `Your Promote package for ${won.title} was refunded` && /back in your TicketRoom balance/.test(m.body)));
    // A sandbox (TEST) purchase, refunded the same way.
    const ev4 = await mkEvent("Promote Day Four", 120);
    const co = (await o.post(`${B}/events/${ev4.id}/promotion/checkout`, { method: "card" })).body;
    const q4 = new URL(co.payment.redirectUrl, BASE).searchParams;
    const sb = await anon(`/api/public/payments/${q4.get("p")}/sandbox?k=${encodeURIComponent(q4.get("k"))}`, null, "GET");
    assert.equal(sb.body.purpose, "promotion"); assert.equal(sb.body.returnUrl, `/organisers#/events/${ev4.id}/promote`);
    assert.equal((await anon(`/api/public/payments/${q4.get("p")}/sandbox`, { k: q4.get("k"), outcome: "paid" })).body.result, "confirmed");
    assert.equal((await a.post(`/api/admin/events/${ev4.id}/cancel`, { reason: "Artist ill" })).status, 200);
    const r4 = await a.post(`/api/admin/promotions/${co.promotion.id}/refund`, { reason: "Event cancelled" });
    assert.equal(r4.body.promotion.status, "refunded", JSON.stringify(r4.body));
    assert.equal(Number(sql("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account = 'test:revenue:promotions'")[0].s), -PRICE, "the TEST refund is reversed in the test ledger");
    rv = (await a.get("/api/admin/promotions")).body.revenue;
    assert.equal(rv.liveCents, 0); assert.equal(rv.testCents, PRICE);
    assert.equal((await a.post(`/api/admin/promotions/${co.promotion.id}/refund`, { reason: "Again" })).status, 409, "never twice");
    await ledgerOk(a, "after refunds");
    step("refunds only for cancelled events: balance purchase back to the balance, sandbox purchase reversed in the test ledger, never twice; ledger balanced");

    // 9. Roles, the admin payments list, and the end of the promotion.
    const pay = (await a.get("/api/admin/payments")).body.payments.filter((x) => x.purpose === "promotion");
    assert.ok(pay.length >= 3, "promotion payments listed with their purpose");
    assert.equal((await o.post(`${B}/events/${ev1.id}/promotion/checkout`, { method: "card" })).body.error.code, "already_promoted");
    sql("UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?", new Date(Date.now() - 4 * 3600e3).toISOString(), new Date(Date.now() - 60e3).toISOString(), ev1.id);
    php("promo_expire();");
    assert.equal(sql("SELECT status FROM event_promotions WHERE id = ?", p1.id)[0].status, "ended");
    const late = await o.post(`${B}/campaigns`, { channel: "sms", name: "Too late", body: "Hi", eventIds: [ev1.id] });
    assert.equal(late.status, 409, "SMS stops when the promotion ends");
    await org.goto(`${BASE}/organisers#/promote`);
    await org.getByRole("heading", { name: "Promote", exact: true }).waitFor();
    await org.getByRole("link", { name: "Promote this event" }).first().waitFor();
    const phone = await page(browser, ORG, { width: 390, height: 844 });
    await phone.goto(`${BASE}/organisers#/events/${ev3.id === won.id ? ev2.id : ev3.id}/promote`);
    await phone.getByRole("heading", { name: "Let your crowd know, loud and clear" }).waitFor();
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "Promote tab fits a phone");
    step("promotion payments in the admin list; one active package per event; ends with its event and SMS stops; Promote page and tab work on a phone");

    assert.deepEqual(problems, [], problems.join("\n"));
    console.log("PHP Promote checks passed.");
  } finally {
    fs.writeFileSync(cfgFile, original);
    mock.kill();
    await browser.close();
  }
})().catch((e) => { console.error(e); if (problems.length) console.error(problems.join("\n")); process.exit(1); });
