const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const ACCOUNT = process.argv[2] || "personal";
// [name, w, h, safeTop] -- safeTop emulates env(safe-area-inset-top) since a
// headless browser reports 0 for it.
const CASES = [
  ["android", 360, 800, 0],
  ["android-status", 412, 915, 24],
  ["iphone-se", 375, 667, 0],
  ["iphone-notch", 393, 852, 47],
  ["iphone-max-notch", 430, 932, 59],
  ["tablet", 820, 1180, 24]
];
const ROUTES = ["dashboard", "services", "qr", "activity", "profile"];

const TX = Array.from({ length: 24 }, (_, i) => ({
  id: `t${i}`, reference: `TP-${i}`, service_name: "Send Money",
  direction: i % 3 === 0 ? "credit" : "debit", amount: 100 + i, total: 102.5 + i,
  status: "completed", created_at: new Date(Date.now() - i * 86400000).toISOString()
}));

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const report = [];

  for (const [name, w, h, safeTop] of CASES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768, deviceScaleFactor: 2 });
    await ctx.addInitScript((top) => {
      localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" }));
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.setProperty("--safe-top", `${top}px`);
      });
    }, safeTop);
    await ctx.route("https://api.titopay.co.za/**", (route) => {
      const u = new URL(route.request().url());
      const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      let body = { ok: true, items: [] };
      if (u.pathname === "/health") body = { status: "ok" };
      else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
      else if (u.pathname === "/v1/services") body = cat;
      else if (u.pathname === "/v1/transactions") body = { items: TX };
      else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "Naledi Mokoena", businessName: "Naledi Trading", username: "naledi", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "pending_review", phone: "+27821234567", email: "naledi@example.co.za" } };
      else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
      J(body);
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push(m.text().slice(0, 120)); });
    await page.goto(`${BASE_URL}/index.html#dashboard`, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(3200);
    await page.evaluate((top) => document.documentElement.style.setProperty("--safe-top", `${top}px`), safeTop);
    await page.waitForTimeout(300);

    // Read the bar tokens off the page so the expectation tracks the design
    // instead of duplicating it.
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const px = (v) => parseFloat(cs.getPropertyValue(v)) || 0;
      return { barRow: px("--app-bar-row"), barMinRow: px("--app-bar-min-row") };
    });
    const per = { case: name, size: `${w}x${h}`, safeTop, barRow: tokens.barRow, barMinRow: tokens.barMinRow, routes: {} };

    for (const route of ROUTES) {
      await page.evaluate((r) => { location.hash = r; }, route);
      await page.waitForTimeout(800);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);

      const atTop = await page.evaluate(() => {
        const bar = document.querySelector("[data-app-topbar]");
        const screen = document.querySelector(".screen");
        if (!bar || !screen) return { missing: true };
        const br = bar.getBoundingClientRect();
        const cs = getComputedStyle(bar);
        // first laid-out child of the screen
        const first = [...screen.children].find((e) => e.getBoundingClientRect().height > 0);
        return {
          position: cs.position,
          zIndex: cs.zIndex,
          bg: cs.backgroundColor,
          top: Math.round(br.top),
          height: Math.round(br.height),
          shadowAtTop: bar.classList.contains("is-scrolled"),
          firstChildTop: first ? Math.round(first.getBoundingClientRect().top) : null,
          gapUnderHeader: first ? Math.round(first.getBoundingClientRect().top - br.bottom) : null,
          docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        };
      });

      // scroll down hard, then check nothing crosses the header and it stays put
      const scrolled = await page.evaluate(() => {
        window.scrollTo(0, 400);
        return new Promise((resolve) => setTimeout(() => {
          const bar = document.querySelector("[data-app-topbar]");
          const br = bar.getBoundingClientRect();
          // Anything inside the screen that is positioned with a z-index at or
          // above the bar would paint over it. That is the real overlap test.
          const overlaps = [];
          document.querySelectorAll(".screen *").forEach((el) => {
            const cs = getComputedStyle(el);
            if (cs.position === "static") return;
            const z = parseInt(cs.zIndex, 10);
            if (Number.isFinite(z) && z >= 40) {
              const r = el.getBoundingClientRect();
              if (r.height && r.top < br.bottom - 1) overlaps.push(`${(el.className || el.tagName).toString().split(" ")[0]}@z${z}`);
            }
          });
          // The bar itself must be fully opaque, or content shows through it.
          const barBg = getComputedStyle(bar).backgroundColor;
          if (/rgba\(.*,\s*(0|0?\.\d+)\)/.test(barBg)) overlaps.push(`bar-not-opaque:${barBg}`);
          resolve({
            barTop: Math.round(br.top),
            barHeight: Math.round(br.height),
            shadowOnScroll: bar.classList.contains("is-scrolled"),
            overlapCount: overlaps.length,
            overlaps: [...new Set(overlaps)].slice(0, 5),
            scrollY: Math.round(window.scrollY)
          });
        }, 320));
      });

      per.routes[route] = { ...atTop, ...scrolled };
      if (route === "dashboard" && (name === "iphone-notch" || name === "android")) {
        await page.evaluate(() => window.scrollTo(0, 260));
        await page.waitForTimeout(350);
        await page.screenshot({ path: `${OUT}/hdr-${ACCOUNT}-${name}.png` });
      }
    }

    // scroll restoration: scroll activity, go to profile, come back
    await page.evaluate(() => { location.hash = "activity"; });
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 320));
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => Math.round(window.scrollY));
    await page.evaluate(() => { location.hash = "profile"; });
    await page.waitForTimeout(700);
    await page.evaluate(() => { location.hash = "activity"; });
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => Math.round(window.scrollY));
    per.scrollRestore = { before, after, preserved: Math.abs(before - after) <= 8 };

    per.errors = errs;
    report.push(per);
    await ctx.close();
  }

  // condensed pass/fail
  const failures = [];
  report.forEach((r) => {
    Object.entries(r.routes).forEach(([route, m]) => {
      // The bar is the safe-area inset plus a content row. The row size is a
      // token, so read it rather than restating it here -- v183 raised it from
      // 44px to 56px so the two icon buttons (48px) stop touching both edges,
      // and a hard-coded 44 turned a deliberate change into 20 failures.
      const expected = Math.max(r.barRow, r.barMinRow + r.safeTop);
      if (m.position !== "fixed") failures.push(`${r.case}/${route}: position=${m.position}`);
      if (m.top !== 0 || m.barTop !== 0) failures.push(`${r.case}/${route}: bar not pinned (top=${m.top}, afterScroll=${m.barTop})`);
      if (Math.abs(m.height - expected) > 1) failures.push(`${r.case}/${route}: height=${m.height} expected=${expected}`);
      if (m.overlapCount) failures.push(`${r.case}/${route}: ${m.overlapCount} overlap(s) ${m.overlaps.join(",")}`);
      // Whatever the token says, the row has to clear the 48px buttons.
      if (m.height - r.safeTop < 48) failures.push(`${r.case}/${route}: content row ${m.height - r.safeTop}px is under the 48px button height`);
      if (m.docOverflowX) failures.push(`${r.case}/${route}: horizontal overflow`);
      if (m.shadowAtTop) failures.push(`${r.case}/${route}: shadow shown at top`);
      if (!m.shadowOnScroll && m.scrollY > 2) failures.push(`${r.case}/${route}: no shadow after scroll`);
      if (m.gapUnderHeader != null && (m.gapUnderHeader < 16 || m.gapUnderHeader > 26)) failures.push(`${r.case}/${route}: gap under header ${m.gapUnderHeader}px`);
    });
    if (!r.scrollRestore.preserved) failures.push(`${r.case}: scroll not restored (${r.scrollRestore.before} -> ${r.scrollRestore.after})`);
    if (r.errors.length) failures.push(`${r.case}: ${r.errors.length} console errors`);
  });

  console.log(JSON.stringify({
    account: ACCOUNT,
    heights: report.map((r) => ({ case: r.case, safeTop: r.safeTop, height: r.routes.dashboard.height, gap: r.routes.dashboard.gapUnderHeader })),
    scrollRestore: report.map((r) => ({ case: r.case, ...r.scrollRestore })),
    failures
  }, null, 1));
  await browser.close();
})();
