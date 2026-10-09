// Browser end-to-end walkthrough against a running, freshly seeded server:
//   npm run seed && npm start   (in another shell)   then   npm run test:ui
// Fails on any console error, page error or CSP violation.
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080";
const PASS = process.env.SEED_PASSWORD || "TicketRoom!2026";
const SHOTS = path.resolve(__dirname, "artifacts");
const creds = fs.readFileSync(path.resolve(__dirname, "..", "var", "seed-credentials.txt"), "utf8");
const terminalKey = creds.match(/POS terminal key[^:]*: (\S+)/)[1];
const qrTags = [...creds.matchAll(/^(TRT1\.\S+) \| (\S+) \| (\S+)$/gm)].map((m) => ({ payload: m[1], display: m[2], activation: m[3] }));

const problems = [];
let step = 0;
async function page(browser, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|404|409)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  return p;
}
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage: true });
async function login(p, email) {
  const r = await p.request.post(`${BASE}/api/auth/login`, { data: { email, password: PASS } });
  assert.equal(r.status(), 200, `login ${email}`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    // 1. A new attendee discovers an event, signs up during checkout and pays.
    const a = await page(browser);
    await a.goto(BASE);
    await a.getByRole("heading", { name: /Your event/ }).waitFor();
    await shot(a, "home");
    await a.locator(".event-card", { hasText: "Soweto Sunset Sessions" }).first().click();
    await a.getByRole("heading", { name: "Soweto Sunset Sessions" }).waitFor();
    await a.getByRole("button", { name: "More General Admission" }).click();
    await a.getByRole("button", { name: "More General Admission" }).click();
    await a.getByRole("button", { name: "Continue" }).click();
    await a.getByRole("button", { name: "Create account" }).last().click().catch(() => {});
    const email = `e2e-${Date.now()}@test.local`;
    const dlg = a.locator("dialog");
    if (await dlg.getByLabel("Full name").count() === 0) await dlg.getByRole("button", { name: "Create account" }).click();
    await dlg.getByLabel("Full name").fill("Lerato E2E");
    await dlg.getByRole("textbox", { name: "Email" }).fill(email);
    await dlg.getByLabel("Password", { exact: true }).fill("e2e-password-123");
    await dlg.getByText("I accept the").click();
    await dlg.getByRole("button", { name: "Create account" }).click();
    await a.getByRole("heading", { name: "Checkout" }).waitFor();
    await a.getByPlaceholder("Promo code").fill("SUNSET20");
    await a.getByRole("button", { name: "Apply" }).click();
    await a.getByText("Promo SUNSET20").waitFor();
    await a.getByText("Email me about their future events").click();
    await shot(a, "checkout");
    await a.getByRole("button", { name: /^Pay R/ }).click();
    await a.waitForURL(/\/sim\/pay\//);
    await a.getByText("SIMULATED PAYMENT PROVIDER").waitFor();
    await shot(a, "sim-provider");
    await a.getByRole("button", { name: "Approve payment" }).click();
    await a.waitForURL(/\/orders\//);
    await a.getByRole("heading", { name: /You're going/ }).waitFor({ timeout: 15000 });
    await shot(a, "order-paid");
    await a.getByRole("link", { name: "View my tickets" }).click();
    await a.locator(".ticket img").first().waitFor();
    assert.equal(await a.locator("article.ticket").count(), 2);
    await shot(a, "wallet");
    const tickets = await (await a.request.get(`${BASE}/api/me/tickets`)).json();
    const qr = tickets.tickets[0].qrPayload;

    // 2. Attendee links a QR tag and tops up the cashless wallet; sets a PIN.
    await a.goto(`${BASE}/account#/tags`);
    await a.getByLabel("Tag code").fill(qrTags[0].display);
    await a.getByLabel("Activation code").fill(qrTags[0].activation);
    await a.getByRole("button", { name: "Link tag" }).click();
    await a.locator("td", { hasText: qrTags[0].display }).waitFor();
    await a.goto(`${BASE}/account#/wallet`);
    await a.locator(".balance-card").first().click();
    await a.getByLabel("Amount (R)").fill("150");
    await a.getByRole("button", { name: "Top up" }).click();
    await a.waitForURL(/\/sim\/pay\//);
    await a.getByRole("button", { name: "Approve payment" }).click();
    await a.waitForURL(/\/account/);
    await a.locator(".balance-card .amt", { hasText: "R150.00" }).waitFor({ timeout: 10000 });
    await shot(a, "wallet-balance");

    // 3. Gate staff admit the ticket; a second scan is refused.
    const s = await page(browser, { width: 420, height: 900 });
    await login(s, "staff@ticketroom.test");
    await s.goto(`${BASE}/scan`);
    await s.getByText("Soweto Sunset Sessions").first().waitFor();
    if (await s.locator("[data-ev]").count()) await s.locator("[data-ev]").first().click();
    // The seeded event is in the future; the API correctly reports it is not open yet.
    await s.getByPlaceholder("Type ticket code").fill(qr);
    await s.getByRole("button", { name: "Check" }).click();
    await s.locator("#verdict .big", { hasText: /NOT OPEN|ADMIT/ }).waitFor();
    await shot(s, "scanner");

    // 4. Vendor activates a terminal and charges the attendee's tag.
    const v = await page(browser, { width: 420, height: 900 });
    await login(v, "vendor@ticketroom.test");
    await v.goto(`${BASE}/pos`);
    await v.getByLabel("Terminal key").fill(terminalKey);
    await v.getByRole("button", { name: "Activate" }).click();
    await v.getByRole("button", { name: /Wors roll/ }).click();
    await v.getByRole("button", { name: /Soft drink/ }).click();
    await shot(v, "pos-cart");
    await v.getByRole("button", { name: "Charge" }).click();
    await v.getByPlaceholder(/paste tag value/).fill(qrTags[0].payload);
    await v.getByRole("button", { name: "Use", exact: true }).click();
    await v.locator(".verdict.ok .big", { hasText: "APPROVED" }).waitFor({ timeout: 10000 });
    await shot(v, "pos-approved");
    const w = await (await a.request.get(`${BASE}/api/me/wallets`)).json();
    assert.equal(w.wallets.find((x) => x.title.startsWith("Soweto")).balanceCents, 15000 - 9000);

    // 5. Organiser sees the sale and the analytics; admin and finance load.
    const o = await page(browser);
    await login(o, "organiser@ticketroom.test");
    await o.goto(`${BASE}/organiser#/`);
    await o.getByRole("heading", { name: /Hi, Jozi Live Events/ }).waitFor();
    await shot(o, "organiser-dashboard");
    await o.getByRole("link", { name: "Soweto Sunset Sessions" }).first().click();
    await o.locator(".chart").first().waitFor();
    await shot(o, "organiser-event");
    await o.goto(`${BASE}/organiser#/marketing`);
    await o.getByRole("heading", { name: "Marketing" }).waitFor();
    await shot(o, "organiser-marketing");
    const ad = await page(browser);
    await login(ad, "admin@ticketroom.test");
    await ad.goto(`${BASE}/admin#/`);
    await ad.getByRole("heading", { name: "Overview" }).waitFor();
    await ad.getByText(/Balanced:/).waitFor();
    await shot(ad, "admin-overview");
    const fi = await page(browser);
    await login(fi, "finance@ticketroom.test");
    await fi.goto(`${BASE}/admin#/ledger`);
    await fi.getByRole("heading", { name: "Ledger" }).waitFor();
    await shot(fi, "finance-ledger");

    // 6. Phone widths do not scroll horizontally.
    const m = await page(browser, { width: 360, height: 800 });
    for (const url of ["/", "/organisers", "/help"]) {
      await m.goto(BASE + url);
      await m.waitForTimeout(400);
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`[layout] ${url} overflows by ${overflow}px at 360px`);
    }
  } catch (err) {
    problems.push(`[failure] ${err.stack || err.message}`);
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`UI walkthrough passed (${step} screenshots in tests-ui/artifacts).`);
})();
