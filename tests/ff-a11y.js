const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR || "tests/artifacts";

const EVENTS = [
  { slug: "a", eventName: "Amapiano Summer Festival Extended Edition", eventDate: "2026-12-16T18:00:00Z", venueName: "Mary Fitzgerald Square", city: "Johannesburg", ticketTypes: [{ price: 350, quantityAvailable: 500, quantitySold: 120 }] },
  { slug: "b", eventName: "Cape Town Comedy Night", eventDate: "2026-09-04T19:30:00Z", venueName: "Baxter Theatre", city: "Cape Town", ticketTypes: [{ price: 180, quantityAvailable: 200, quantitySold: 200 }] },
  { slug: "c", eventName: "Gospel Celebration", eventDate: "2026-10-11T10:00:00Z", venueName: "Moses Mabhida Stadium Durban", city: "Durban", ticketTypes: [{ price: 120, quantityAvailable: 1000, quantitySold: 300 }] },
  { slug: "d", eventName: "Soweto Jazz Sessions", eventDate: "2026-11-02T17:00:00Z", venueName: "Soweto Theatre", city: "Johannesburg", ticketTypes: [{ price: 220, quantityAvailable: 300, quantitySold: 50 }] },
  { slug: "e", eventName: "SA Fintech Summit", eventDate: "2027-02-18T08:00:00Z", venueName: "CTICC", city: "Cape Town", ticketTypes: [{ price: 1500, quantityAvailable: 400, quantitySold: 100 }] }
];

const SIZES = [[320, 568], [360, 640], [390, 844], [430, 932], [768, 1024], [1280, 800]];
const SERVICES = (process.argv[2] || "top-up,withdraw,send-gift,tickets").split(",");

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const report = [];

  for (const [w, h] of SIZES) {
    const mobile = w < 768;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
    await ctx.route("https://api.titopay.co.za/**", async (route) => {
      const u = new URL(route.request().url());
      const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (u.pathname === "/v1/ticketing/public/events") { await sleep(120); return J({ items: EVENTS }); }
      if (u.pathname === "/v1/transactions" && route.request().method() === "POST") return route.abort();
      let body = { ok: true, items: [] };
      if (u.pathname === "/health") body = { status: "ok" };
      else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
      else if (u.pathname === "/v1/services") body = cat;
      else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "QA User", username: "qa", accountType: process.env.ACCT || "personal", status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
      else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
      J(body);
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors/.test(m.text())) errs.push(m.text().slice(0, 120)); });
    await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(3200);

    for (const svc of SERVICES) {
      for (let i = 0; i < 4; i += 1) {
        if (!(await page.evaluate(() => !!document.querySelector(".modal-backdrop")))) break;
        await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
        await page.waitForTimeout(220);
      }
      await page.evaluate(() => { location.hash = "services"; });
      await page.waitForTimeout(360);
      const tile = await page.$(`[data-service="${svc}"]`);
      if (!tile) { report.push({ size: `${w}x${h}`, svc, opened: false }); continue; }
      await tile.click();
      await page.waitForTimeout(svc === "tickets" ? 1600 : 900);

      const m = await page.evaluate(() => {
        const card = document.querySelector(".modal-card");
        if (!card) return { noCard: true };
        const cr = card.getBoundingClientRect();
        const clipped = [];
        card.querySelectorAll("button, input, select, textarea, strong, .chip, .ticket-card, .balance-context").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width) return;
          if (r.right > cr.right + 1 || r.left < cr.left - 1) clipped.push((el.className || el.tagName) + "|" + (el.textContent || "").trim().slice(0, 26));
        });
        const small = [];
        card.querySelectorAll("button, a[href], input, select, textarea").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width && r.height && r.height < 40) small.push((el.className || el.tagName) + "|" + (el.textContent || "").trim().slice(0, 22));
        });
        const unlabelled = [];
        card.querySelectorAll("input, select, textarea").forEach((el) => {
          if (el.type === "hidden") return;
          const ok = (el.id && card.querySelector(`label[for="${el.id}"]`)) || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
          if (!ok) unlabelled.push(el.name || el.type);
        });
        const iconOnly = [];
        card.querySelectorAll("button").forEach((b) => {
          if (!b.textContent.trim() && !b.getAttribute("aria-label")) iconOnly.push(b.className);
        });
        return {
          scrollX: card.scrollWidth > card.clientWidth + 1,
          docX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          clipped, small, unlabelled, iconOnly
        };
      });
      report.push({ size: `${w}x${h}`, svc, opened: true, ...m });
      if (w === 320 || w === 768) await page.screenshot({ path: `${OUT}/ffa11y-${svc}-${w}.png` });
    }
    report.push({ size: `${w}x${h}`, errors: errs });
    await ctx.close();
  }

  const bad = report.filter((r) => r.opened && ((r.clipped || []).length || (r.small || []).length || (r.unlabelled || []).length || (r.iconOnly || []).length || r.scrollX || r.docX));
  console.log(JSON.stringify({ checked: report.filter((r) => r.opened).length, failures: bad, errors: report.filter((r) => r.errors && r.errors.length) }, null, 1));
  await browser.close();
})();
