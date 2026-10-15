const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
// Opens every service and every main screen on one account type and reports
// every visible occurrence of "customer"/"user" so the wording can be judged in
// context rather than by grepping source.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const ACCOUNT = process.argv[2] || "personal";
const TERM = /customers?/i;

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  await ctx.route("https://api.titopay.co.za/**", (route) => {
    const u = new URL(route.request().url());
    const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/v1/ticketing/eligibility") return J({ eligibility: { eligible: true, blockers: [] } });
    if (u.pathname === "/v1/ticketing/business/events") return J({ items: [] });
    if (u.pathname === "/v1/ticketing/public/events") return J({ items: [] });
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "Naledi Mokoena", businessName: "Naledi Trading", username: "naledi", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    J(body);
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3400);

  const hits = [];
  const scan = async (where) => {
    const found = await page.evaluate(() => {
      const root = document.querySelector(".modal-card") || document.querySelector("#app");
      if (!root) return [];
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.replace(/\s+/g, " ").trim();
        if (t && /customers?/i.test(t)) out.push(t.slice(0, 110));
      }
      root.querySelectorAll("input, textarea").forEach((el) => {
        const ph = el.getAttribute("placeholder") || "";
        const val = el.value || "";
        if (/customers?/i.test(ph)) out.push(`[placeholder] ${ph.slice(0, 110)}`);
        if (/customers?/i.test(val)) out.push(`[value] ${val.slice(0, 110)}`);
      });
      root.querySelectorAll("[aria-label]").forEach((el) => {
        const a = el.getAttribute("aria-label") || "";
        if (/customers?/i.test(a)) out.push(`[aria-label] ${a.slice(0, 110)}`);
      });
      return [...new Set(out)];
    });
    found.forEach((text) => hits.push({ where, text }));
  };

  const dismiss = async () => {
    for (let i = 0; i < 5; i += 1) {
      if (!(await page.evaluate(() => !!document.querySelector(".modal-backdrop")))) break;
      await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
      await page.waitForTimeout(200);
    }
  };

  for (const route of ["home", "services", "qr", "activity", "profile"]) {
    await dismiss();
    await page.evaluate((r) => { location.hash = r; }, route);
    await page.waitForTimeout(700);
    await scan(`screen:${route}`);
  }

  await dismiss();
  await page.evaluate(() => { location.hash = "services"; });
  await page.waitForTimeout(900);
  const tiles = await page.evaluate(() => [...document.querySelectorAll("[data-service]")].map((e) => e.dataset.service));

  for (const svc of tiles) {
    await dismiss();
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(350);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) continue;
    await t.click();
    await page.waitForTimeout(svc === "ticketing" || svc === "tickets" ? 1500 : 750);
    await scan(`service:${svc}`);
  }

  // chat + receipts + chatbot
  await dismiss();
  await page.evaluate(() => { if (typeof openTitoPayChatModal === "function") openTitoPayChatModal(); });
  await page.waitForTimeout(1200);
  await scan("chat");
  await dismiss();
  await page.evaluate(() => { if (typeof openWalletReceiptsModal === "function") openWalletReceiptsModal(); });
  await page.waitForTimeout(700);
  await scan("receipts");

  const diag = await page.evaluate(() => ({ tiles: document.querySelectorAll("[data-service]").length, signedIn: !document.body.classList.contains("landing-static"), h1: document.querySelector("h1")?.textContent.trim() }));
  console.log(JSON.stringify({ account: ACCOUNT, diag, tilesSeen: tiles.length, errors: errs, hits }, null, 1));
  await browser.close();
})();
