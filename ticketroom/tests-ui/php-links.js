// Dead-link and broken-page check for the PHP edition. Run after
// php-walkthrough.js on the same instance (it reuses the accounts it made).
// Opens every page and portal section as a visitor, fan, organiser and admin;
// follows every link; checks every image; fails on any 404, empty page,
// console error or "Page not found".
//   node tests-ui/php-links.js http://127.0.0.1:8400
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8400";
const PEOPLE = {
  visitor: null,
  fan: { email: "sipho@example.co.za", password: "fan-password-123" },
  organiser: { email: "naledi@example.co.za", password: "organiser-pass-1" },
  admin: { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026" },
};
const START = {
  visitor: ["/", "/sell", "/help", "/contact", "/unsubscribe", "/legal/terms-of-use", "/legal/terms", "/legal/privacy", "/legal/cookies", "/legal/paia", "/privacy", "/cookies", "/terms", "/signin"],
  fan: ["/account#/tickets", "/account#/orders", "/account#/transfers", "/account#/refunds", "/account#/settings", "/account#/wallet", "/account#/tags", "/account#/payment-methods"],
  organiser: ["/organisers#/", "/organisers#/events", "/organisers#/events/new", "/organisers#/marketing", "/organisers#/team", "/organisers#/settings", "/organisers#/finance", "/organisers#/refunds", "/scan", "/pos"],
  admin: ["/admin#/", "/admin#/organisers", "/admin#/events", "/admin#/users", "/admin#/lookup", "/admin#/support", "/admin#/site", "/admin#/posters", "/admin#/assistant", "/admin#/emails", "/admin#/integrations", "/admin#/audit", "/admin#/outbox", "/admin#/refunds", "/admin#/payouts", "/admin#/tags"],
};
const problems = [];
const checked = new Set();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  let pages = 0;
  for (const [who, creds] of Object.entries(PEOPLE)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|409|501)/.test(m.text())) problems.push(`[${who}] console on ${p.url()}: ${m.text()}`); });
    p.on("pageerror", (e) => problems.push(`[${who}] page error on ${p.url()}: ${e.message}`));
    p.on("response", (r) => { if (r.status() === 404 && r.url().startsWith(BASE)) problems.push(`[${who}] 404 ${r.url()} (from ${p.url()})`); });
    if (creds) {
      const r = await p.request.post(`${BASE}/api/auth/login`, { data: creds });
      if (r.status() !== 200) { problems.push(`[${who}] cannot sign in`); continue; }
    }
    // Event pages and the order page come from live data.
    const list = await (await p.request.get(`${BASE}/api/public/events`)).json();
    const extra = (list.events || []).map((e) => `/events/${e.slug}`);
    for (const url of [...START[who], ...(who === "visitor" ? extra : [])]) {
      await p.goto(BASE + url, { waitUntil: "networkidle" });
      await p.waitForTimeout(300);
      pages++;
      const text = (await p.locator("#main").innerText().catch(() => "")).trim();
      if (!text) problems.push(`[${who}] empty page ${url}`);
      if (/Page not found|Something went wrong|Unknown API route/i.test(text)) problems.push(`[${who}] error page ${url}: ${text.slice(0, 80)}`);
      for (const img of await p.locator("img").all()) {
        if (!(await img.isVisible())) continue;
        const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
        if (!ok) problems.push(`[${who}] broken image on ${url}: ${await img.getAttribute("src")}`);
      }
      const hrefs = await p.$$eval("a[href]", (as) => as.filter((a) => a.offsetParent !== null).map((a) => a.getAttribute("href")));
      for (const h of hrefs) {
        if (/^(mailto:|tel:|#$|javascript:)/.test(h)) continue;
        if (h.startsWith("#")) continue; // in-page anchors/portal routes are visited above
        const abs = new URL(h, BASE + url).toString();
        if (!abs.startsWith(BASE)) { if (!checked.has(abs)) { checked.add(abs); problems.push(`[${who}] external link (check by hand): ${abs} on ${url}`); } continue; }
        const key = `${who} ${abs.split("#")[0]}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const res = await p.request.get(abs.split("#")[0], { maxRedirects: 3 });
        if (res.status() >= 400) problems.push(`[${who}] dead link ${h} on ${url} -> ${res.status()}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  const real = problems.filter((x) => !x.includes("external link"));
  console.log(`Checked ${pages} pages and ${checked.size} links.`);
  if (problems.length) console.log(problems.join("\n"));
  process.exit(real.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
