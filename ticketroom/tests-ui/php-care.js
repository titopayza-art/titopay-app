// Accounts, guests, onboarding and customer care, in the browser and the API.
// Run after php-walkthrough.js on the same instance (it reuses its accounts):
//   node tests-ui/php-care.js http://127.0.0.1:8600 /path/to/public_html
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1" };
const FAN = { email: "sipho@example.co.za", password: "fan-password-123" };
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const lastMail = (to) => sql("SELECT subject, body FROM message_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", to)[0];
const local = (url) => url.replace(/^https?:\/\/[^/]+/, BASE);

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|422|429)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
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
  return { get: (u) => call("GET", u), post: (u, d) => call("POST", u, d ?? {}), put: (u, d) => call("PUT", u, d) };
}
const anon = (url, data) => fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const signupBody = (email, extra = {}) => ({ fullName: "Test Person", email, password: "a-strong-pass-123", acceptTerms: true, marketingOptIn: false, ...extra });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    // 1. The home-screen app opens the home page; the customer portal welcomes signed-out visitors.
    const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
    assert.equal(manifest.start_url, "/", "saved-to-phone app opens the home page");
    const v = await page(browser, null, { width: 390, height: 844 });
    await v.goto(`${BASE}/account`);
    await v.getByRole("heading", { name: "Your tickets live here" }).waitFor();
    assert.equal(await v.locator("dialog[open]").count(), 0, "no sign-in box forced on the visitor");
    await v.goto(`${BASE}/organisers`);
    await v.getByRole("heading", { name: /Sell tickets, scan people in/ }).waitFor();
    step("home-screen app opens the home page; signed-out portals show a welcome, not a sign-in box");

    // 2. One account per person.
    assert.equal((await anon("/api/auth/register", signupBody(ORG.email))).body.error.code, "email_taken");
    assert.equal((await anon("/api/auth/register", signupBody("NALEDI@example.co.za"))).body.error.code, "email_taken", "case doesn't matter");
    assert.equal((await anon("/api/auth/register", signupBody("jane.doe+tickets@gmail.com"))).status, 201);
    assert.equal((await anon("/api/auth/register", signupBody("janedoe@gmail.com"))).body.error.code, "email_taken", "Gmail dots and +tags are the same inbox");
    assert.equal((await anon("/api/auth/register", signupBody("other@example.co.za", { phone: "082 555 0101" }))).status, 201);
    assert.equal((await anon("/api/auth/register", signupBody("third@example.co.za", { phone: "+27825550101" }))).body.error.code, "phone_taken", "one mobile number, one account");
    step("duplicate accounts refused: same email in any case, Gmail look-alikes, same mobile number");

    // 3. Email must be confirmed before signing in; the link works once as a sign-in.
    const unconf = await anon("/api/auth/login", { email: "other@example.co.za", password: "a-strong-pass-123" });
    assert.equal(unconf.body.error.code, "email_not_verified");
    const bad = await anon("/api/auth/login", { email: "other@example.co.za", password: "wrong-password" });
    assert.equal(bad.body.error.code, "bad_credentials", "wrong password says nothing about the email");
    const token = lastMail("other@example.co.za").body.match(/#\/verify\/(\S+)/)[1];
    const first = await anon("/api/auth/verify-email", { token });
    assert.equal(first.body.signedIn, true);
    assert.equal((await anon("/api/auth/verify-email", { token })).body.signedIn, false, "an old link is not a way back in");
    assert.equal((await anon("/api/auth/login", { email: "other@example.co.za", password: "a-strong-pass-123" })).status, 200);
    step("unconfirmed accounts can't sign in (a fresh link is sent); the link signs in once, never again");

    // 4. Guest orders: private links, nobody else's order, and a password later through "Forgot password".
    const ev = (await (await fetch(`${BASE}/api/public/events`)).json()).events.find((e) => e.title === "Free Jazz in the Park");
    const tt = (await (await fetch(`${BASE}/api/public/events/${ev.slug}`)).json()).ticketTypes[0];
    const g1 = await anon("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: `g1-${Date.now()}`, guest: { fullName: "Guest One", email: "guest.one@example.co.za" } });
    const g2 = await anon("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: `g2-${Date.now()}`, guest: { fullName: "Guest Two", email: "guest.two@example.co.za" } });
    assert.equal(g1.status, 201);
    const view = (ref, k) => fetch(`${BASE}/api/public/orders/${ref}?k=${encodeURIComponent(k)}`);
    assert.equal((await view(g1.body.order.reference, g1.body.accessKey)).status, 200);
    assert.equal((await view(g1.body.order.reference, g2.body.accessKey)).status, 404, "another order's link opens nothing");
    assert.equal((await fetch(`${BASE}/api/public/orders/${g1.body.order.reference}`)).status, 401, "no link, no order");
    assert.equal((await anon("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: `g3-${Date.now()}` })).status, 400, "a guest must give a name and email");
    assert.equal((await anon("/api/auth/login", { email: "guest.one@example.co.za", password: "anything-at-all" })).body.error.code, "bad_credentials", "guest accounts have no password");
    await anon("/api/auth/password/forgot", { email: "guest.one@example.co.za" });
    const resetToken = lastMail("guest.one@example.co.za").body.match(/#\/reset\/(\S+)/)[1];
    assert.equal((await anon("/api/auth/password/reset", { token: resetToken, password: "guest-new-pass-1" })).status, 200);
    const gp = await page(browser, { email: "guest.one@example.co.za", password: "guest-new-pass-1" });
    assert.equal((await (await gp.request.get(`${BASE}/api/me/tickets`)).json()).tickets.length, 1, "the guest's ticket is in the new account");
    step("guest orders: private links only, no cross-order access; a guest can set a password later and finds the ticket there");

    // 5. One-step organiser sign-up from /sell, confirmed, then the setup checklist.
    const n = await page(browser);
    await n.goto(`${BASE}/sell`);
    await n.getByRole("button", { name: "Create an organiser account" }).click();
    const d = n.locator("dialog");
    await d.getByLabel("Organisation or trading name").fill("Durban Beach Fest");
    await d.getByLabel("Your full name").fill("Ayesha Naidoo");
    await d.locator("#os-email").fill("ayesha@example.co.za");
    await d.getByLabel("Password", { exact: true }).fill("organiser-pass-2");
    await d.getByLabel("Confirm password").fill("organiser-pass-2");
    await d.getByRole("checkbox", { name: /I accept the/ }).check();
    assert.equal(await d.locator("#os-email").inputValue(), "ayesha@example.co.za", "email typed in");
    const sent = n.waitForResponse((r) => r.url().endsWith("/api/organiser/signup"));
    await d.getByRole("button", { name: "Create my organiser account" }).click();
    const res = await sent;
    assert.equal(res.status(), 201, `organiser sign-up: ${res.status()} ${(await res.text()).slice(0, 300)}`);
    await d.getByRole("heading", { name: "Check your inbox" }).waitFor();
    await n.goto(`${BASE}/account#/verify/${lastMail("ayesha@example.co.za").body.match(/#\/verify\/(\S+)/)[1]}`);
    await n.getByRole("link", { name: "Open my organiser portal" }).click();
    await n.getByRole("heading", { name: "Get your first event live" }).waitFor();
    assert.equal(await n.locator(".steps-list li.done").count(), 1, "email confirmed; the rest to do");
    await n.locator(".steps-list").getByRole("link", { name: "Create your first event" }).waitFor();
    step("one-step organiser sign-up from /sell; email confirmed; dashboard checklist shows the road to a live event");

    // 6. Customer care passes a question to the organiser, who answers the customer.
    const fan = await page(browser, FAN);
    const f = api(fan);
    const sc = await f.post("/api/public/support", { category: "tickets", subject: "Is there parking at the venue?", body: "Hi, I have tickets for Free Jazz in the Park. Is there safe parking nearby?" });
    assert.equal(sc.status, 201);
    const caseRow = sql("SELECT id, reference FROM support_cases WHERE subject = 'Is there parking at the venue?'")[0];
    const adm = await page(browser, ADMIN);
    await adm.goto(`${BASE}/admin#/support`);
    await adm.locator("tr", { hasText: "Is there parking at the venue?" }).getByRole("button", { name: "Open" }).click();
    const sd = adm.locator("dialog");
    await sd.getByLabel("Events this customer booked").selectOption({ index: 1 });
    await sd.getByLabel("Note for the organiser").fill("Customer asks about parking.");
    await sd.getByRole("button", { name: "Send to organiser" }).click();
    await adm.getByText(/Passed to the organiser/).waitFor();
    assert.match(lastMail("sipho@example.co.za").subject, /Your question is with Soweto Community Arts/);
    const orgMail = sql("SELECT subject FROM message_outbox WHERE subject LIKE 'Customer question for Soweto Community Arts%'");
    assert.equal(orgMail.length, 1, "organiser emailed");
    const o = await page(browser, ORG);
    await o.goto(`${BASE}/organisers#/queries`);
    await o.locator(".sidenav .count", { hasText: "1" }).waitFor();
    await o.getByRole("link", { name: "Open" }).click();
    await o.getByLabel(/Reply to/).fill("Yes, there is secure parking at Thokoza Park, R20 per car. Gates open an hour early.");
    await o.getByRole("button", { name: "Send reply" }).click();
    await o.getByText("Reply emailed to the customer.").waitFor();
    const reply = lastMail("sipho@example.co.za");
    assert.match(reply.body, /secure parking at Thokoza Park/);
    assert.match(reply.body, /Naledi, Soweto Community Arts/);
    assert.equal(sql("SELECT status, handled_by FROM support_cases WHERE id = ?", caseRow.id)[0].status, "resolved");
    // The customer sees the answer in their account.
    await fan.goto(`${BASE}/account#/refunds`);
    await fan.locator("tr", { hasText: "Is there parking" }).getByRole("button", { name: "Replies" }).click();
    await fan.locator("dialog").getByText(/secure parking at Thokoza Park/).waitFor();
    // Organisers only ever see questions passed to them.
    const other = sql("SELECT id FROM organisers WHERE name = 'Durban Beach Fest'")[0];
    assert.equal((await api(n).get(`/api/organiser/${other.id}/queries/${caseRow.id}`)).status, 404, "another organiser can't open it");
    step("customer care passes a question to the right organiser in two clicks; organiser replies from the portal; customer emailed and sees it in their account");

    // 7. No keys or passwords leave the server.
    const cfg = await (await fetch(`${BASE}/api/config`)).text();
    assert.ok(!/sk_(test|live)_|whsec_|password|smtpPass|secret/i.test(cfg), "public config holds no secrets");
    const assets = fs.readdirSync(path.join(ROOT, "assets")).filter((x) => x.endsWith(".js")).map((x) => fs.readFileSync(path.join(ROOT, "assets", x), "utf8")).join("\n");
    assert.ok(!/sk_(test|live)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9+/]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(assets), "no keys in the browser code");
    const ig = await api(adm).get("/api/admin/integrations");
    assert.ok(!JSON.stringify(ig.body).match(/"value":"[^"]*pass/i), "integrations page never returns secret values");
    const support = await page(browser);
    assert.equal((await support.request.get(`${BASE}/api/admin/integrations`)).status(), 401, "integrations need a staff sign-in");
    step("no keys in the public config, the browser code or the integrations page; admin pages need a sign-in");
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("PHP care checks passed.");
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
