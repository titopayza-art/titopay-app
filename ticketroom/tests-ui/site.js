// Browser walkthrough of the website features: banner, assistant, callback,
// legal pages, unsubscribe, and the back-office controls for them.
//   npm run seed && npm start   (in another shell)   then   node tests-ui/site.js
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080";
const PASS = process.env.SEED_PASSWORD || "TicketRoom!2026";
const SHOTS = path.resolve(__dirname, "artifacts", "site");
const problems = [];
let step = 0;
async function page(browser, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|404|409)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  return p;
}
const shot = (p, name, fullPage = true) => p.screenshot({ path: path.join(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`), fullPage });
const login = async (p, email) => assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: { email, password: PASS } })).status(), 200);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    // Banner and assistant on the home page.
    const a = await page(browser);
    await a.goto(BASE);
    const banner = a.locator(".site-banner");
    await banner.waitFor();
    assert.match(await banner.innerText(), /FREE events/);
    await shot(a, "home-banner", false);
    await a.getByRole("button", { name: /Chat with the TicketRoom assistant/ }).click();
    await a.getByRole("button", { name: "How do I list a free event?" }).click();
    await a.locator(".msg.assistant").nth(1).waitFor();
    await a.locator("#chat-in").fill("I need to talk to a person");
    await a.locator("#chat-in").press("Enter");
    await a.locator(".msg.assistant [data-cbq]").last().waitFor();
    await shot(a, "assistant", false);
    await a.locator(".msg.assistant [data-cbq]").last().click();
    const d = a.locator("dialog");
    await d.getByLabel("Full name").fill("Thabo Visitor");
    await d.getByLabel("Phone number").fill("082 555 0000");
    await d.getByLabel("Email").fill("thabo@test.local");
    await shot(a, "callback-dialog", false);
    await d.getByRole("button", { name: "Request callback" }).click();
    await d.getByText(/Your reference is/).waitFor();
    await d.getByRole("button", { name: "Done" }).click();
    // Dismiss the banner for this visit.
    await a.getByRole("button", { name: "Hide announcement" }).click();
    await a.reload(); await a.locator("#grid .event-card").first().waitFor();
    assert.equal(await a.locator(".site-banner").count(), 0);

    // Legal pages.
    for (const [doc, title] of [["terms-of-use", "Terms of Use"], ["terms", "Terms and Conditions"], ["privacy", "Privacy Policy"], ["cookies", "Cookie Policy"], ["paia", "PAIA and POPIA Manual"]]) {
      await a.goto(`${BASE}/legal/${doc}`);
      await a.getByRole("heading", { level: 1, name: title }).waitFor();
      assert.ok(await a.getByText("Version 1.0 · Effective 9 October 2026").count());
      if (doc !== "paia") await a.getByRole("heading", { name: /Important clauses/ }).waitFor();
      await shot(a, `legal-${doc}`, doc === "terms");
    }
    await a.goto(`${BASE}/privacy`);
    await a.getByRole("heading", { level: 1, name: "Privacy Policy" }).waitFor();
    assert.equal(new URL(a.url()).pathname, "/legal/privacy");

    // Contact page callback form and unsubscribe-by-email.
    await a.goto(`${BASE}/contact?topic=advertising`);
    assert.equal(await a.getByLabel("Topic").inputValue(), "advertising");
    await a.getByLabel("Full name").fill("Ad Buyer");
    await a.getByLabel("Phone number").fill("0215550000");
    await a.getByLabel("Email").fill("ads@test.local");
    await a.getByLabel("How can we help?").fill("We'd like to advertise our festival.");
    await a.getByRole("button", { name: "Request callback" }).click();
    await a.getByText(/we've got it/i).waitFor();
    await shot(a, "contact");
    await a.goto(`${BASE}/unsubscribe`);
    await a.getByLabel("Email").fill("fan@ticketroom.test");
    await a.getByRole("button", { name: "Send unsubscribe link" }).click();
    await a.getByText(/we've sent a link/).waitFor();
    await a.goto(`${BASE}/sell`);
    await a.getByText(/open for free event listings/).waitFor();
    await shot(a, "sell");

    // Mobile layout.
    const m = await page(browser, { width: 390, height: 844 });
    await m.goto(BASE);
    await m.locator(".site-banner").waitFor();
    await m.getByRole("button", { name: /Chat with the TicketRoom assistant/ }).click();
    await m.locator(".chat-panel").waitFor();
    await shot(m, "mobile-assistant", false);

    // Back office: site settings, posters, assistant, integrations, support.
    const ad = await page(browser);
    await login(ad, "admin@ticketroom.test");
    await ad.goto(`${BASE}/admin#/site`);
    await ad.getByRole("heading", { name: /Maintenance mode/ }).waitFor();
    await shot(ad, "admin-site-settings");
    await ad.locator("#f-bn").getByText("Show the banner").click();
    await ad.getByRole("button", { name: "Save banner" }).click();
    await ad.getByText("Banner saved.").waitFor();
    const site1 = await (await ad.request.get(`${BASE}/api/site`)).json();
    assert.equal(site1.banner, null);
    await ad.locator("#f-bn").getByText("Show the banner").click();
    await ad.getByRole("button", { name: "Save banner" }).click();
    await ad.getByText("Banner saved.").waitFor();
    await ad.getByRole("button", { name: "Turn maintenance ON" }).click();
    await ad.locator("dialog").getByRole("button", { name: "Turn on" }).click();
    await ad.getByText("Maintenance mode is ON.").waitFor();
    const v = await page(browser);
    const before = problems.length;
    const res = await v.goto(BASE);
    problems.splice(before); // the 503 for the maintenance page is expected
    assert.equal(res.status(), 503);
    await shot(v, "maintenance-page", false);
    await ad.getByRole("button", { name: "Turn maintenance OFF" }).click();
    await ad.getByText(/site is live/).waitFor();
    assert.equal((await v.goto(BASE)).status(), 200);
    await ad.goto(`${BASE}/admin#/posters`);
    await ad.getByRole("heading", { name: "Advertising posters" }).waitFor();
    await shot(ad, "admin-posters");
    await ad.goto(`${BASE}/admin#/assistant`);
    await ad.getByRole("heading", { name: "Assistant" }).waitFor();
    await shot(ad, "admin-assistant");
    await ad.goto(`${BASE}/admin#/integrations`);
    await ad.getByRole("heading", { name: "Integrations" }).waitFor();
    await shot(ad, "admin-integrations");
    await ad.goto(`${BASE}/admin#/support`);
    await ad.getByText("Ad Buyer").first().waitFor();
    await shot(ad, "admin-support");

    // Organiser: staff tab with live count; account: payment methods + unsubscribe all.
    const o = await page(browser);
    await login(o, "organiser@ticketroom.test");
    await o.goto(`${BASE}/organisers#/events`);
    await o.locator("#main a[href*='#/events/']:not([href$='/new'])").first().click();
    await o.getByRole("tab", { name: "Staff" }).click();
    await o.getByRole("heading", { name: "Live check-ins" }).waitFor();
    await o.locator(".kpi").first().waitFor();
    await shot(o, "organiser-staff-live");
    const f = await page(browser);
    await login(f, "fan@ticketroom.test");
    await f.goto(`${BASE}/account#/payment-methods`);
    await f.getByRole("heading", { name: "Payment methods" }).waitFor();
    await shot(f, "account-payment-methods");
    await f.goto(`${BASE}/account#/settings`);
    await f.getByRole("button", { name: "Unsubscribe from all marketing" }).click();
    await f.locator("dialog").getByRole("button", { name: "Confirm" }).click();
    await f.getByText(/unsubscribed from all marketing/).waitFor();
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`Site walkthrough passed (${step} screenshots in ${SHOTS}).`);
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
