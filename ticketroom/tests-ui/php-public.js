// Public pages: cookie consent, the contact form for customers and event
// organisers, Trending artists and the event page tabs.
// Run after php-walkthrough.js on the same instance:
//   node tests-ui/php-public.js http://127.0.0.1:8600 /srv/trtest/public_html
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);

(async () => {
  sql("DELETE FROM rate_limits");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));

    // 1. Cookie consent: asked once, optional groups off until chosen.
    await p.goto(BASE);
    const banner = p.locator(".cookie-banner");
    await banner.getByText("We value your privacy").waitFor();
    await banner.getByRole("button", { name: "Customise" }).click();
    const d = p.locator("dialog[open]");
    await d.getByText("Always active", { exact: true }).waitFor();
    assert.equal(await d.getByRole("checkbox", { name: "Functional" }).isChecked(), false, "optional cookies start off");
    await d.locator(".switch", { has: p.getByRole("checkbox", { name: "Analytics" }) }).click();
    await d.getByRole("button", { name: "Save my preferences" }).click();
    await banner.waitFor({ state: "detached" });
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("tr_consent")));
    assert.equal(saved.functional, false); assert.equal(saved.analytics, true);
    await p.reload();
    await p.locator("#grid .event-card").first().waitFor();
    assert.equal(await p.locator(".cookie-banner").count(), 0, "not asked again");
    await p.getByRole("button", { name: "Cookie settings" }).click();
    await p.locator("dialog[open]").getByRole("button", { name: "Reject all" }).click();
    assert.equal((await p.evaluate(() => JSON.parse(localStorage.getItem("tr_consent")))).analytics, false);
    step("cookie consent: banner once, Customise with Necessary always active, saved choice respected, changeable from the footer");

    // 1b. Country: South Africa available, the rest of SADC coming soon (with updates for that country).
    await p.goto(BASE);
    await p.locator(".head-country").click();
    const cd = p.locator("dialog[open]");
    assert.equal(await cd.locator(".country-row").count(), 16, "all 16 SADC countries");
    assert.equal(await cd.locator(".country-row", { hasText: "South Africa" }).getByText("Available").count(), 1);
    assert.equal(await cd.getByText("Coming soon").count(), 15);
    if (process.env.TR_SHOTS) await p.screenshot({ path: path.join(process.env.TR_SHOTS, "country-picker.png") });
    await cd.locator(".country-row", { hasText: "Botswana" }).click();
    await cd.getByRole("heading", { name: "TicketRoom is coming to Botswana" }).waitFor();
    await cd.getByPlaceholder("Your email address").fill("kagiso.bw@example.co.bw");
    await cd.getByRole("button", { name: "Subscribe" }).click();
    await cd.locator(".sub-done").waitFor();
    assert.equal(sql("SELECT source FROM newsletter_subscribers WHERE email = 'kagiso.bw@example.co.bw'")[0].source, "country:BW");
    await cd.getByRole("button", { name: "Browse South African events" }).click();
    assert.equal(await p.locator("dialog[open]").count(), 0);
    assert.equal(await p.getByText("Prices are in South African rand").count(), 0);
    step("country picker: 16 SADC countries, South Africa available, others coming soon with updates for that country");

    // 2. Trending artists and search by artist.
    await p.goto(BASE);
    const artist = p.locator("[data-artist='Soweto String Quartet']");
    await artist.waitFor();
    await artist.click();
    await p.locator(".event-card", { hasText: "Free Jazz in the Park" }).first().waitFor();
    assert.equal(await p.locator("#q").inputValue(), "Soweto String Quartet");
    step("Trending artists from event line-ups; tapping one finds their events");

    // 3. Event page: category badge, SAST, Info / Line up / Venue tabs.
    await p.locator(".event-card", { hasText: "Free Jazz in the Park" }).first().click();
    await p.locator(".cat-badge").waitFor();
    assert.match(await p.locator(".event-facts").textContent(), /SAST/);
    await p.getByRole("tab", { name: "Line up" }).click();
    await p.locator("#panel-lineup .headliner").getByText("Soweto String Quartet").waitFor();
    await p.getByRole("tab", { name: "Venue" }).click();
    await p.locator("#panel-venue").getByText("Thokoza Park").waitFor();
    assert.ok(await p.locator("#panel-info").isHidden());
    await p.getByRole("link", { name: /Get free tickets|Buy tickets/ }).click();
    step("event page: category, SAST times, Info / Line up / Venue tabs, buy button goes to the tickets");

    // 4. Contact: Customer and Event organiser tabs.
    await p.goto(`${BASE}/contact`);
    await p.getByRole("tab", { name: "Customer" }).waitFor();
    await p.getByLabel("Name", { exact: true }).fill("Thandi Mokoena");
    await p.getByLabel("Email", { exact: true }).fill("thandi.contact@example.co.za");
    await p.getByLabel(/^Event/).fill("Free Jazz in the Park");
    await p.getByLabel("Type of query").selectOption("tickets");
    await p.getByLabel(/Order reference or wristband/).fill("tr-abcd1234");
    await p.getByLabel("Your query").fill("I can't find my second ticket.");
    await p.getByRole("button", { name: "Send" }).click();
    await p.getByText(/Your reference is CQ-/).waitFor();
    const c1 = sql("SELECT * FROM support_cases WHERE email = 'thandi.contact@example.co.za'")[0];
    assert.equal(c1.category, "tickets");
    assert.ok(c1.event_id, "linked to the event");
    assert.match(c1.body, /TR-ABCD1234/);
    await p.goto(`${BASE}/contact`);
    await p.getByRole("tab", { name: "Event organiser" }).click();
    assert.ok(await p.locator("[data-ref-field]").isHidden(), "no order reference box for organisers");
    await p.getByLabel("Name", { exact: true }).fill("Bongani Events");
    await p.getByLabel("Email", { exact: true }).fill("bongani.contact@example.co.za");
    await p.getByLabel("Type of query").selectOption("payouts");
    await p.getByLabel("Your query").fill("When is my payout paid?");
    await p.getByRole("button", { name: "Send" }).click();
    await p.getByText(/Your reference is CQ-/).waitFor();
    const c2 = sql("SELECT * FROM support_cases WHERE email = 'bongani.contact@example.co.za'")[0];
    assert.equal(c2.category, "payment"); assert.match(c2.subject, /^Event organiser: Payouts/);
    step("contact form: Customer and Event organiser tabs, event and order reference passed to the support team");

    if (problems.length) throw new Error(problems.join("\n"));
    console.log("PHP public page checks passed.");
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
