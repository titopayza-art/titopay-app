// Browser acceptance test for the PHP (Afrihost) edition, on a FRESH install:
// home page works straight away (no setup screen) → admin signs in with the
// temporary password and changes it → organiser applies → free event → admin approves →
// fan gets tickets → QR shows → gate scan → live count; plus every portal
// page loads without console errors or CSP violations.
//   node tests-ui/php-walkthrough.js http://127.0.0.1:8400 TEMP-PASSWORD /path/to/public_html
// (TEMP-PASSWORD is what the package was built with: TR_ADMIN_PASSWORD.
// The folder lets the test read the emails the site sent, like a real inbox.)
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { verifyOrganiser } = require("./kyc-helper");

const BASE = process.argv[2] || "http://127.0.0.1:8400";
const TEMP = process.argv[3] || "Temp-pass-#2026";
const ROOT = process.argv[4] || "/srv/trtest/public_html";
// The newest email to an address, read from the site's database.
function lastMail(to) {
  const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
  const php = `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare('SELECT subject, body FROM message_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'); $s->execute([$argv[1]]); echo json_encode($s->fetch(PDO::FETCH_ASSOC));`;
  return JSON.parse(execFileSync("php", ["-r", php, to]).toString() || "null");
}
// Open the confirmation link from the email, as the person would.
async function confirmEmail(p, email) {
  const m = lastMail(email);
  const link = m.body.match(/\/(account|organisers)#\/verify\/(\S+)/);
  assert.ok(link, `confirmation email for ${email}`);
  await p.goto(`${BASE}/${link[1]}#/verify/${link[2]}`);
  await p.getByRole("heading", { name: /Welcome to TicketRoom/ }).waitFor();
}
const SHOTS = path.resolve(__dirname, "artifacts", "php");
const problems = [];
let step = 0;
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };

async function page(browser, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, functional: true, analytics: true })); } catch { /* no storage */ } });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|404|409|422|501)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  return p;
}
const shot = (p, name, fullPage = true) => p.screenshot({ path: path.join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage });
async function signUp(p, name, email, password) {
  await p.goto(`${BASE}/`);
  await p.getByRole("button", { name: "Create account" }).first().click();
  const d = p.locator("dialog");
  await d.getByLabel("Full name").fill(name);
  await d.getByRole("textbox", { name: "Email" }).fill(email);
  await d.getByLabel("Password", { exact: true }).fill(password);
  await d.getByLabel("Confirm password").fill(password);
  await d.getByText("I accept the").click();
  await d.getByRole("button", { name: "Create account" }).click();
  await d.getByRole("heading", { name: "Check your inbox" }).waitFor().catch(async (err) => {
    await p.screenshot({ path: path.join(SHOTS, "signup-failed.png") });
    throw new Error(`sign-up did not finish: ${(await d.innerText().catch(() => "")).slice(0, 300)} | ${err.message.split("\n")[0]}`);
  });
  // Not signed in until the email is confirmed.
  assert.equal((await (await p.request.post(`${BASE}/api/auth/login`, { data: { email, password } })).json()).error.code, "email_not_verified");
  await confirmEmail(p, email);
  await p.getByRole("button", { name: "Go to my tickets" }).click();
  await p.getByRole("button", { name: /Sign out/ }).waitFor();
}
async function signIn(p, email, password) {
  const r = await p.request.post(`${BASE}/api/auth/login`, { data: { email, password } });
  assert.equal(r.status(), 200, `login ${email}`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    // 1. The home page is the live site from the first visit.
    const a = await page(browser);
    await a.goto(BASE);
    await a.locator("#footer").getByText(/Reg\. no\. 2026811077 ·/).waitFor();
    assert.equal(await a.getByText("Set up TicketRoom").count(), 0, "no setup screen");
    await shot(a, "home-first-visit");
    // The administrator signs in with the temporary password and is told to change it.
    // Staff sign in on the admin portal only: no "Create account", no "Forgot password".
    await a.goto(`${BASE}/admin`);
    const d = a.locator("dialog");
    await d.getByText("TicketRoom staff only").waitFor();
    assert.equal(await d.getByRole("button", { name: /Create account|Forgot password/ }).count(), 0, "admin sign-in offers no sign-up or reset");
    await d.getByLabel("Email").fill(ADMIN.email);
    await d.getByLabel("Password").fill(TEMP);
    await d.getByRole("button", { name: "Sign in" }).click();
    // Staff land in the admin portal, clearly labelled as such.
    await a.waitForURL(/\/admin/);
    await a.locator(".portal-bar.pb-admin").getByText("Admin portal").waitFor();
    await a.getByText("You're signed in with the temporary password.").waitFor();
    await a.getByRole("link", { name: "Change it now" }).click();
    await a.getByLabel("Current password").fill(TEMP);
    await a.getByLabel("New password", { exact: true }).fill(ADMIN.password);
    await a.getByLabel("Confirm new password").fill(ADMIN.password);
    await a.locator("#pw").getByRole("button").click();
    await a.getByText("Password changed.").waitFor();
    assert.equal(await a.locator(".pw-nag").count(), 0, "reminder gone");
    // Even for staff, the website and other portals never link to the admin portal.
    await a.goto(`${BASE}/`);
    await a.locator("#footer").waitFor();
    assert.equal(await a.locator('#header a[href^="/admin"], #footer a[href^="/admin"]').count(), 0, "no admin link on the website");
    await a.goto(`${BASE}/admin#/site`);
    await a.locator(".portal-bar").getByText("Admin portal").waitFor();
    await a.getByRole("heading", { name: "Site settings" }).waitFor();
    assert.equal(await a.locator(".pw-nag").count(), 0, "reminder stays gone");
    await shot(a, "admin-signed-in");
    for (const [hash, heading] of [["#/", "Overview"], ["#/organisers", "Organiser accounts"], ["#/events", "All events"], ["#/users", "Customers & organisers"], ["#/support", "Support & callbacks"],
      ["#/posters", "Advertising posters"], ["#/assistant", "Assistant"], ["#/emails", "Email templates"], ["#/integrations", "Integrations"], ["#/audit", "Audit log"], ["#/outbox", "Messages"],
      ["#/refunds", "Refunds"], ["#/payouts", "Payouts"], ["#/payments", "Payments & webhooks"], ["#/reconciliation", "Reconciliation"], ["#/ledger", "Ledger"]]) {
      await a.goto(`${BASE}/admin${hash}`);
      await a.getByRole("heading", { name: heading, exact: true }).first().waitFor();
    }
    assert.equal(await a.getByRole("link", { name: /Payouts/ }).isVisible(), true, "finance menu: payments, refunds and payouts are tracked");
    // One account, one portal: a staff account gets no further than a note in the organiser portal.
    await a.goto(`${BASE}/organisers`);
    await a.getByRole("heading", { name: "This portal isn't for this account" }).waitFor();
    assert.equal(await a.locator("#ce").count(), 0, "no organiser form for staff");
    const staffApply = await a.request.post(`${BASE}/api/organiser/apply`, { data: { name: "Should Fail", contactEmail: ADMIN.email }, headers: { "x-csrf-token": (await (await a.request.get(`${BASE}/api/auth/me`)).json()).csrfToken } });
    assert.equal(staffApply.status(), 403, "server refuses staff as organiser");
    await shot(a, "admin-messages");

    // 2. Organiser signs up from the organiser portal (an organiser account), lists a free event.
    const o = await page(browser);
    await o.goto(`${BASE}/organisers`);
    await o.locator(".portal-bar.pb-organiser").getByText("Organiser portal").waitFor();
    await o.getByRole("button", { name: "Start selling" }).first().click();
    const od = o.locator("dialog");
    await od.getByLabel("Organisation or trading name").fill("Soweto Community Arts");
    await od.getByLabel("Your full name").fill("Naledi Dlamini");
    await od.getByLabel("Email").fill("naledi@example.co.za");
    await od.getByLabel("Password", { exact: true }).fill("organiser-pass-1");
    await od.getByLabel("Confirm password").fill("organiser-pass-1");
    await od.getByRole("checkbox", { name: /I accept the/ }).check();
    await od.getByRole("button", { name: "Create my organiser account" }).click();
    await od.getByRole("heading", { name: "Check your inbox" }).waitFor();
    await confirmEmail(o, "naledi@example.co.za");
    await o.getByRole("link", { name: "Open my organiser portal" }).click();
    await o.getByText(/being reviewed/).waitFor();
    await shot(o, "organiser-pending");

    // Admin approves the organiser.
    await a.goto(`${BASE}/admin#/organisers`);
    await a.reload();
    await a.locator("tr", { hasText: "Soweto Community Arts" }).getByRole("button", { name: "Approve" }).click();
    await a.locator("tr", { hasText: "Soweto Community Arts" }).getByRole("button", { name: "Approve" }).waitFor({ state: "detached" });

    await o.reload();
    await o.goto(`${BASE}/organisers#/events/new`);
    await o.getByText("This is a free event").click();
    await o.getByLabel("Event name").fill("Free Jazz in the Park");
    await o.getByLabel("Total capacity").fill("200");
    const pad = (n) => String(n).padStart(2, "0");
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    await o.getByLabel("Starts").fill(local(new Date(Date.now() + 3600e3)));
    await o.getByLabel("Ends").fill(local(new Date(Date.now() + 6 * 3600e3)));
    await o.getByLabel("Venue", { exact: true }).fill("Thokoza Park");
    await o.getByLabel("City", { exact: true }).fill("Soweto");
    await o.getByLabel(/Line up/).fill("19:00 Soweto String Quartet\nThe Brother Moves On\n21:30 Nduduzo Makhathini");
    await o.getByRole("button", { name: "Create draft" }).click();
    // The event's QR code is offered straight away, ready to download.
    const made = o.locator("dialog", { hasText: "Your event is created" });
    await made.getByRole("button", { name: "Download PNG" }).waitFor();
    await shot(o, "event-created-qr", false);
    await made.getByRole("button", { name: "Next: add ticket types" }).click();
    await o.getByText(/Free admission/).first().waitFor();
    await shot(o, "organiser-free-event-tickets");
    // FICA: the organiser sends their ID and signs the terms; TicketRoom approves
    // them (tests-ui/php-verification.js covers this in the portals).
    const orgId = (await (await o.request.get(`${BASE}/api/auth/me`)).json()).user.organisers[0].id;
    await verifyOrganiser(o.request, a.request, BASE, orgId);
    // Preview shows the page as buyers will see it, before it is live.
    const [pv] = await Promise.all([o.context().waitForEvent("page"), o.getByRole("button", { name: "Preview" }).first().click()]);
    await pv.getByText(/Only people with this link can see this page/).waitFor();
    await pv.getByRole("heading", { name: "Free Jazz in the Park" }).waitFor();
    await pv.getByRole("tab", { name: "Line up" }).click();
    await pv.getByRole("link", { name: "Soweto String Quartet" }).waitFor();
    assert.equal((await pv.locator(".lineup-time").first().textContent()).trim(), "19:00");
    assert.match(await pv.locator(".event-facts").textContent(), /SAST/);
    await shot(pv, "organiser-event-preview");
    const draftSlug = new URL(pv.url()).pathname.split("/").pop();
    await pv.close();
    assert.equal((await fetch(`${BASE}/api/public/events/${draftSlug}`)).status, 404, "no preview link, no draft");
    await o.getByRole("button", { name: "Publish" }).click();
    await o.locator("dialog[open]").getByRole("button", { name: "Publish" }).click();
    await o.getByText(/Sent for publishing/).waitFor();

    // Admin publishes it.
    await a.goto(`${BASE}/admin#/events`);
    await a.reload();
    const row = a.locator("tr", { hasText: "Free Jazz in the Park" });
    await row.getByRole("button", { name: "Publish" }).click();
    await a.locator("tr", { hasText: "Free Jazz in the Park" }).getByRole("button", { name: "Publish" }).waitFor({ state: "detached" });

    // 3. A fan finds it and gets free tickets.
    const f = await page(browser);
    await f.goto(BASE);
    await f.locator(".site-banner").waitFor();
    await f.locator(".event-card", { hasText: "Free Jazz in the Park" }).first().click();
    await f.getByRole("heading", { name: "Free Jazz in the Park" }).waitFor();
    await f.getByRole("button", { name: /More Free admission/ }).click();
    await f.getByRole("button", { name: /More Free admission/ }).click();
    await f.getByRole("button", { name: "Continue" }).click();
    // No account needed: the fan checks out as a guest.
    await f.getByRole("heading", { name: "Checkout" }).waitFor();
    await f.getByLabel("Full name").fill("Sipho Fan");
    await f.getByLabel("Email", { exact: true }).fill("sipho@example.co.za");
    await f.getByLabel("Confirm email").fill("sipho@example.co.za");
    await f.getByRole("button", { name: "Get free tickets" }).click();
    await f.getByRole("heading", { name: /You're going/ }).waitFor();
    await f.locator(".t-qr img").first().waitFor();
    assert.equal(await f.locator(".ticket").count(), 2, "both tickets on the order page");
    await shot(f, "fan-order-confirmed");
    // The email carries a private link that opens the same tickets anywhere.
    const conf = lastMail("sipho@example.co.za");
    assert.match(conf.body, /\/orders\/TR-[A-Z0-9]+\?k=/);
    // Later the fan makes an account with the same email; once confirmed, the tickets are in it.
    await f.getByRole("button", { name: "Create my account" }).click();
    const dlg = f.locator("dialog");
    await dlg.getByLabel("Full name").fill("Sipho Fan");
    await dlg.getByRole("textbox", { name: "Email" }).fill("sipho@example.co.za");
    await dlg.getByLabel("Password", { exact: true }).fill("fan-password-123");
    await dlg.getByLabel("Confirm password").fill("fan-password-123");
    await dlg.getByText("I accept the").click();
    await dlg.getByRole("button", { name: "Create account" }).click();
    await dlg.getByRole("heading", { name: "Check your inbox" }).waitFor();
    // The email has booked before, so it gets a choose-your-password link (nobody else can claim the tickets).
    const fin = lastMail("sipho@example.co.za");
    assert.match(fin.subject, /Finish creating/);
    const rl = fin.body.match(/\/account#\/reset\/(\S+)/);
    assert.ok(rl, "finish-account link");
    await f.goto(`${BASE}/account#/reset/${rl[1]}`);
    await f.getByRole("heading", { name: "Choose your password" }).waitFor();
    await f.getByLabel("New password", { exact: true }).fill("fan-password-123");
    await f.getByLabel("Confirm new password").fill("fan-password-123");
    await f.getByRole("button", { name: "Save password" }).click();
    await f.waitForURL(/\/account#\/tickets/);
    await f.locator(".portal-bar.pb-customer").getByText("Customer portal").waitFor();
    await f.locator(".t-qr img").first().waitFor();
    const qrOk = await f.locator(".t-qr img").first().evaluate((img) => img.complete && img.naturalWidth > 0);
    assert.ok(qrOk, "QR image renders");
    await shot(f, "fan-tickets");
    const code = await f.evaluate(async () => (await (await fetch("/api/me/tickets")).json()).tickets[0].code);

    // 4. Gate scanning by the organiser (owner can scan), typed code.
    await o.goto(`${BASE}/scan`);
    await o.getByRole("heading", { name: "Choose event" }).waitFor();
    await o.locator("[data-ev]", { hasText: "Free Jazz in the Park" }).click();
    await o.locator("#mc").waitFor();
    await o.locator("#mc").fill(code);
    await o.getByRole("button", { name: "Check" }).click();
    await o.getByText(/ADMIT/).first().waitFor();
    await shot(o, "scanner-admit", false);
    await o.locator("#mc").fill(code);
    await o.getByRole("button", { name: "Check" }).click();
    await o.getByText(/ALREADY SCANNED/).first().waitFor();

    // Live count in the organiser portal.
    await o.goto(`${BASE}/organisers#/events`);
    await o.locator("#main a[href*='#/events/']:not([href$='/new'])").first().click();
    await o.getByRole("tab", { name: "Gate staff" }).click();
    await o.getByRole("heading", { name: "Live check-ins" }).waitFor();
    // Totals are shared by every gate and refreshed every few seconds.
    await o.waitForFunction(() => document.querySelector("#live .kpi .v")?.textContent.trim() === "1", null, { timeout: 15000 });
    await shot(o, "organiser-live-count");
    for (const hash of ["#/", "#/marketing", "#/team", "#/settings"]) { await o.goto(`${BASE}/organisers${hash}`); await o.waitForTimeout(400); }

    // 5. Public pages and the assistant.
    for (const p of ["/help", "/contact", "/sell", "/legal/terms", "/legal/privacy", "/legal/cookies", "/unsubscribe"]) { await f.goto(BASE + p); await f.locator("#main h1").first().waitFor(); }
    await f.goto(BASE);
    await f.getByRole("button", { name: /Chat with the TicketRoom assistant/ }).click();
    await f.getByRole("button", { name: "How do I list a free event?" }).click();
    await f.locator(".msg.assistant").nth(1).waitFor();
    await shot(f, "assistant", false);
    for (const hash of ["#/tickets", "#/orders", "#/transfers", "#/refunds", "#/settings"]) { await f.goto(`${BASE}/account${hash}`); await f.waitForTimeout(400); }
    // The admin portal is invisible to customers: no link, and /admin is "Page not found".
    assert.equal(await f.locator('a[href^="/admin"]').count(), 0, "no admin link for customers");
    await f.goto(`${BASE}/admin`);
    await f.getByRole("heading", { name: "Page not found" }).waitFor();
    assert.equal(await f.getByText(/admin/i).count(), 0, "nothing says admin");
    assert.equal(await f.getByRole("link", { name: /Wallets/ }).isVisible(), false, "cashless menu hidden");

    // Mobile.
    const m = await page(browser, { width: 390, height: 844 });
    await m.goto(BASE);
    await m.locator(".event-card").first().waitFor();
    await shot(m, "mobile-home", false);
  } catch (err) {
    // Keep a picture of every open page, to see what the test was looking at.
    let i = 0;
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: path.join(SHOTS, `failed-${++i}.png`), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`PHP walkthrough passed (${step} screenshots in ${SHOTS}).`);
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
