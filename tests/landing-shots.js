const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.env.SHOT_DIR || "tests/artifacts";

const VIEWPORTS = [
  ["iphone-se", 375, 667, true],
  ["iphone-14-pro", 393, 852, true],
  ["iphone-pro-max", 430, 932, true],
  ["ipad", 820, 1180, false],
  ["laptop", 1440, 900, false]
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ ...launchOptions() });
  const report = [];
  for (const account of ["personal", "business"]) {
    for (const [name, w, h, mobile] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
      await ctx.route("https://api.titopay.co.za/**", (route) => {
        const u = new URL(route.request().url());
        const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
        if (u.pathname === "/health") return J({ status: "ok" });
        if (u.pathname === "/v1/maintenance/public") return J({ maintenance: { pwa: { enabled: false } } });
        if (u.pathname === "/v1/services") return J(JSON.parse(fs.readFileSync(CATALOGUE, "utf8")));
        J({ ok: true, items: [] });
      });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e).slice(0, 90)));
      await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(3000);
      if (account === "business") {
        await page.click('[data-account="business"]').catch(() => {});
        await page.waitForTimeout(1200);
      }
      const m = await page.evaluate(() => ({
        h1: document.querySelector("h1")?.textContent.trim(),
        tiles: [...document.querySelectorAll(".preview-grid .service-tile")].map((t) => t.textContent.trim()),
        scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      }));
      report.push({ account, name, size: `${w}x${h}`, ...m, errors: errs.length });
      await page.screenshot({ path: `${OUT}/landing-${account}-${name}.png` });
      await ctx.close();
    }
  }
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
