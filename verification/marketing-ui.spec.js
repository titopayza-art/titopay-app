// The Marketing & Sales pages in a real browser: do they render the DATA, not
// just an empty shell? The crawl proves a page loads without a script error;
// this proves the numbers and controls a person needs are actually on screen.
const { chromium } = require("playwright");

const ADMIN = "http://127.0.0.1:8020";
const API = "http://127.0.0.1:8110/v1";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
// money() formats with non-breaking and thin spaces, so normalise every kind of
// space to a plain one before matching. Without this a passing page looks broken.
const flat = (t) => String(t || "").replace(/[\s  ]+/g, " ").trim();

(async () => {
  console.log(`\n${"=".repeat(72)}\n  MARKETING & SALES — the pages a person actually uses\n${"=".repeat(72)}\n`);

  // Login limits now live in PostgreSQL and survive an API restart, which is
  // the point of them — but it means repeated local runs as the same test admin
  // exhaust the five-per-fifteen-minutes allowance. Clearing the sandbox
  // counters is a test-environment action and touches nothing else.
  const fs = require("fs");
  const { Client } = require("./api/node_modules/pg");
  const db = new Client({ connectionString: process.env.POSTGRES_URL
    || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1] });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters");
  await db.end();

  const login = await fetch(`${API}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" })
  }).then((r) => r.json());
  check("admin signed in", Boolean(login.accessToken));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1",
    JSON.stringify({ accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now() })),
  [login.accessToken, login.refreshToken]);

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/frame-ancestors|Failed to load resource|WebSocket/.test(m.text())) errors.push(m.text());
  });

  async function open(path, waitFor) {
    await page.goto(`${ADMIN}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(waitFor, { timeout: 20000 });
    await page.waitForTimeout(700);
    return flat(await page.textContent("body"));
  }

  /* ---------------------------------------------------------------- nav */
  await page.goto(`${ADMIN}/dashboard/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const navText = flat(await page.textContent("body"));
  check("the sidebar has a Marketing & Sales group", /Marketing & Sales/i.test(navText));
  check("the original Marketing page is still in the sidebar",
    (navText.match(/Marketing/g) || []).length >= 2,
    `${(navText.match(/Marketing/g) || []).length} mentions`);

  /* ------------------------------------------------------------ overview */
  const overview = await open("/marketing-sales/", ".mk-cards");
  check("overview shows the campaign and lead cards",
    /Active campaigns/i.test(overview) && /Total leads/i.test(overview) && /Marketing spend/i.test(overview));
  check("overview states that only direct revenue is headlined", /Direct only/i.test(overview));
  check("overview explains the attribution rule", /never added into the total/i.test(overview));
  const tabs = await page.evaluate(() => document.querySelectorAll("[data-mk-view]").length);
  check("all thirteen sections are reachable as tabs", tabs === 13, `${tabs} tabs`);
  await page.screenshot({ path: "mk-overview.png" });

  /* ----------------------------------------------------------- campaigns */
  const campaigns = await open("/marketing-sales/campaigns/", ".table-wrap, .mk-empty");
  check("the campaign table lists a campaign with its budget",
    // "R 19,000.00 / R 20,000.00" — spend over allocation, as the console formats money.
    /Winter acquisition/i.test(campaigns) && /R ?19,000\.00 \/ R ?20,000\.00/.test(campaigns),
    campaigns.slice(campaigns.indexOf("Winter"), campaigns.indexOf("Winter") + 110));
  check("a budget warning is visible", /% of budget used/i.test(campaigns));

  /* ---------------------------------------------------------- promotions */
  const promotions = await open("/marketing-sales/promotions/", ".table-wrap, .mk-empty");
  check("promotions show a coupon code and its usage", /WINTER/i.test(promotions) && /Exhausted/i.test(promotions));
  check("the page states the percentage-cap rule", /must have a maximum benefit/i.test(promotions));

  /* ------------------------------------------------------------ pipeline */
  const pipeline = await open("/marketing-sales/pipeline/", ".mk-kanban");
  const columns = await page.evaluate(() => document.querySelectorAll(".mk-column").length);
  check("the pipeline renders one column per stage", columns === 8, `${columns} columns`);
  check("a lead card is on the board", /Spaza/i.test(pipeline));
  await page.screenshot({ path: "mk-pipeline.png" });

  /* --------------------------------------------------------------- links */
  const links = await open("/marketing-sales/links/", ".table-wrap, .mk-empty");
  check("the links page names the only allowed destinations", /titopay\.co\.za/i.test(links));

  /* ----------------------------------------------------------------- ROI */
  const roi = await open("/marketing-sales/roi/", ".table-wrap, .mk-empty");
  check("ROI separates direct, assisted and estimated revenue",
    /Direct revenue/i.test(roi) && /Assisted/i.test(roi) && /Estimated/i.test(roi));
  check("ROI explains that only direct feeds the return", /Only direct revenue/i.test(roi));
  await page.screenshot({ path: "mk-roi.png" });

  /* ----------------------------------------------------------- analytics */
  const analytics = await open("/marketing-sales/analytics/", ".mk-funnel");
  check("both funnels render", /Customer funnel/i.test(analytics) && /Merchant funnel/i.test(analytics));
  check("the acquisition-cost caveat is shown to the reader", /upper bound/i.test(analytics));

  /* ------------------------------------------------------------ referrals */
  const referrals = await open("/marketing-sales/referrals/", ".mk-note");
  check("the referral qualification rule is stated on the page",
    /never rewarded for a\s*registration alone/i.test(referrals) || /registration alone/i.test(referrals));

  /* ------------------------------------------- the old marketing page lives */
  const original = await open("/marketing/", ".admin-shell");
  check("THE ORIGINAL MARKETING CONSOLE STILL WORKS",
    /announcement/i.test(original) || /campaign/i.test(original), original.slice(0, 90));

  check("no script errors on any marketing page", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
