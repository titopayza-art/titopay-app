// The portals must not jump: nothing moves while a portal opens, a section
// change never collapses the page, and a new section starts at its top.
// Measured on a slow phone connection. Run after php-walkthrough.js:
//   node tests-ui/php-steady.js http://127.0.0.1:8600
const assert = require("assert/strict");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const PEOPLE = {
  customer: [{ email: "sipho@example.co.za", password: "fan-password-123" }, "/account", ["#/orders", "#/transfers", "#/settings"]],
  organiser: [{ email: "naledi@example.co.za", password: "organiser-pass-1" }, "/organisers", ["#/events", "#/team", "#/settings"]],
  admin: [{ email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" }, "/admin", ["#/organisers", "#/users", "#/integrations"]],
};
const problems = [];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    for (const [who, [creds, path, sections]] of Object.entries(PEOPLE)) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, functional: true, analytics: true })); } catch { /* no storage */ } });
      // Count only movement a person can see: shifts after the page is shown.
      await ctx.addInitScript(() => {
        window.__moved = 0;
        new PerformanceObserver((list) => {
          if (document.documentElement.classList.contains("booting")) return;
          for (const e of list.getEntries()) if (!e.hadRecentInput) window.__moved += e.value;
        }).observe({ type: "layout-shift", buffered: false });
      });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => problems.push(`[pageerror] ${who} ${e.message}`));
      assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${who}`);
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: 500000, uploadThroughput: 100000 });
      await p.goto(BASE + path);
      await p.waitForFunction(() => !document.documentElement.classList.contains("booting"), null, { timeout: 15000 });
      await p.waitForTimeout(1500);
      assert.equal(await p.locator(".portal-bar").count(), 1, `${who}: one portal bar`);
      assert.equal(await p.evaluate(() => Math.round(window.__moved * 1000) / 1000), 0, `${who}: nothing moves once the portal is shown`);
      for (const h of sections) {
        await p.evaluate(() => window.scrollTo(0, 300));
        const before = await p.evaluate(() => document.documentElement.scrollHeight);
        await p.evaluate(() => { window.__moved = 0; });
        await p.locator(`#sidenav a[href="${h}"]`).first().evaluate((a) => a.click());
        // While the next section loads, the page must not shrink under the reader.
        const during = await p.evaluate(() => document.documentElement.scrollHeight);
        assert.ok(during >= Math.min(before, 844), `${who} ${h}: page kept its height while loading`);
        await p.waitForFunction(() => !document.getElementById("main").hasAttribute("aria-busy"), null, { timeout: 15000 });
        await p.waitForTimeout(400);
        assert.equal(await p.evaluate(() => scrollY), 0, `${who} ${h}: new section starts at the top`);
        await p.waitForTimeout(800); // the menu strip glides to centre the current section
        const cur = await p.evaluate(() => { const a = document.querySelector('#sidenav [aria-current="page"]'); const r = a?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= innerWidth; });
        assert.ok(cur, `${who} ${h}: the current section is visible in the menu strip`);
      }
      await ctx.close();
      console.log(`  ok  ${who} portal opens without moving; ${sections.length} section changes hold still and start at the top`);
    }
    if (problems.length) throw new Error(problems.join("\n"));
    console.log("Portals hold still.");
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
