// Browser acceptance test for the PHP (Afrihost) edition, on a FRESH install:
// home page works straight away (no setup screen) → admin signs in with the
// temporary password and changes it → organiser applies → free event → admin approves →
// fan gets tickets → QR shows → gate scan → live count; plus every portal
// page loads without console errors or CSP violations.
//   node tests-ui/php-walkthrough.js http://127.0.0.1:8400 TEMP-PASSWORD
// (TEMP-PASSWORD is what the package was built with: TR_ADMIN_PASSWORD.)
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8400";
const TEMP = process.argv[3] || "Temp-pass-#2026";
const SHOTS = path.resolve(__dirname, "artifacts", "php");
const problems = [];
let step = 0;
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026" };

async function page(browser, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
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
  await d.getByText("I accept the").click();
  await d.getByRole("button", { name: "Create account" }).click();
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
    await a.goto(`${BASE}/signin`);
    const d = a.locator("dialog");
    await d.getByLabel("Email").fill(ADMIN.email);
    await d.getByLabel("Password").fill(TEMP);
    await d.getByRole("button", { name: "Sign in" }).click();
    // Staff land in the admin portal, clearly labelled as such.
    await a.waitForURL(/\/admin/);
    await a.locator(".portal-bar.pb-admin").getByText("Admin portal").waitFor();
    await a.getByText("You're signed in with the temporary password.").waitFor();
    await a.getByRole("link", { name: "Change it now" }).click();
    await a.getByLabel("Current password").fill(TEMP);
    await a.getByLabel("New password").fill(ADMIN.password);
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
    for (const [hash, heading] of [["#/", "Overview"], ["#/organisers", "Organiser accounts"], ["#/events", "All events"], ["#/users", "All users"], ["#/support", "Support & callbacks"],
      ["#/posters", "Advertising posters"], ["#/assistant", "Assistant"], ["#/emails", "Email templates"], ["#/integrations", "Integrations"], ["#/audit", "Audit log"], ["#/outbox", "Messages"]]) {
      await a.goto(`${BASE}/admin${hash}`);
      await a.getByRole("heading", { name: heading, exact: true }).first().waitFor();
    }
    assert.equal(await a.getByRole("link", { name: /Payouts/ }).isVisible(), false, "finance menu hidden");
    // The staff account is never offered the organiser sign-up form.
    await a.goto(`${BASE}/organisers`);
    await a.getByRole("heading", { name: "This is the organiser portal" }).waitFor();
    assert.equal(await a.locator("#ce").count(), 0, "no organiser form for staff");
    const staffApply = await a.request.post(`${BASE}/api/organiser/apply`, { data: { name: "Should Fail", contactEmail: ADMIN.email }, headers: { "x-csrf-token": (await (await a.request.get(`${BASE}/api/auth/me`)).json()).csrfToken } });
    assert.equal(staffApply.status(), 403, "server refuses staff as organiser");
    await shot(a, "admin-messages");

    // 2. Organiser signs up, applies, lists a free event.
    const o = await page(browser);
    await signUp(o, "Naledi Dlamini", "naledi@example.co.za", "organiser-pass-1");
    await o.goto(`${BASE}/organisers`);
    await o.locator(".portal-bar.pb-organiser").getByText("Organiser portal").waitFor();
    await o.getByLabel("Organisation or trading name").fill("Soweto Community Arts");
    await o.getByRole("button", { name: "Submit for review" }).click();
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
    await o.getByRole("button", { name: "Create draft" }).click();
    await o.getByText(/Free admission/).first().waitFor();
    await shot(o, "organiser-free-event-tickets");
    await o.getByRole("button", { name: "Submit for approval" }).click();
    await o.getByText("Submitted for approval.").waitFor();

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
    const dlg = f.locator("dialog");
    await dlg.getByRole("button", { name: "Create account" }).click().catch(() => {});
    if (await dlg.getByLabel("Full name").count() === 0) await dlg.getByRole("button", { name: "Create account" }).click();
    await dlg.getByLabel("Full name").fill("Sipho Fan");
    await dlg.getByRole("textbox", { name: "Email" }).fill("sipho@example.co.za");
    await dlg.getByLabel("Password", { exact: true }).fill("fan-password-123");
    await dlg.getByText("I accept the").click();
    await dlg.getByRole("button", { name: "Create account" }).click();
    await f.getByRole("heading", { name: "Checkout" }).waitFor();
    await f.getByRole("button", { name: "Get free tickets" }).click();
    await f.getByRole("heading", { name: /You're going/ }).waitFor();
    await shot(f, "fan-order-confirmed");
    await f.goto(`${BASE}/account#/tickets`);
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
    await o.getByRole("tab", { name: "Staff" }).click();
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
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`PHP walkthrough passed (${step} screenshots in ${SHOTS}).`);
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
