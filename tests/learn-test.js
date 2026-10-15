const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const ACCOUNT = process.argv[2] || "personal";

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  await ctx.route("https://api.titopay.co.za/**", (route) => {
    const u = new URL(route.request().url());
    const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "QA User", businessName: "Naledi Trading", username: "qa", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    J(body);
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 140)); });
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3400);

  const R = { account: ACCOUNT };
  await page.click('[data-service="learn"]');
  await page.waitForTimeout(900);

  R.shell = await page.evaluate(() => {
    const c = document.querySelector(".modal-card");
    return {
      heading: c.querySelector("h2")?.textContent.trim(),
      lead: c.querySelector(".lead")?.textContent.trim(),
      categories: [...c.querySelectorAll("[data-learn-category]")].map((b) => b.textContent.trim()),
      groups: [...c.querySelectorAll(".learn-group-title")].map((e) => e.textContent.trim()),
      lessons: c.querySelectorAll(".learn-item").length,
      count: c.querySelector("[data-learn-count]")?.textContent.trim(),
      allCollapsed: [...c.querySelectorAll(".learn-body")].every((b) => b.hidden),
      searchPresent: !!c.querySelector("[data-learn-search]")
    };
  });

  // open first lesson
  await page.click(".learn-item .learn-head");
  await page.waitForTimeout(350);
  R.opened = await page.evaluate(() => {
    const item = document.querySelector(".learn-item.is-open");
    return {
      title: item?.querySelector("strong")?.textContent.trim(),
      expanded: item?.querySelector(".learn-head")?.getAttribute("aria-expanded"),
      points: [...item.querySelectorAll(".learn-points li")].map((li) => li.textContent.trim().slice(0, 70)),
      note: item.querySelector(".learn-note")?.textContent.replace(/\s+/g, " ").trim().slice(0, 120),
      openCount: document.querySelectorAll(".learn-body:not([hidden])").length
    };
  });
  await page.screenshot({ path: `${OUT}/learn-open-${ACCOUNT}.png` });

  // toggle closed
  await page.click(".learn-item.is-open .learn-head");
  await page.waitForTimeout(300);
  R.reclosed = await page.evaluate(() => document.querySelectorAll(".learn-body:not([hidden])").length);

  // category filter
  const secondCat = await page.evaluate(() => [...document.querySelectorAll("[data-learn-category]")][2]?.dataset.learnCategory);
  await page.click(`[data-learn-category="${secondCat}"]`);
  await page.waitForTimeout(400);
  R.filtered = await page.evaluate((cat) => ({
    category: cat,
    groups: [...document.querySelectorAll(".learn-group-title")].map((e) => e.textContent.trim()),
    lessons: document.querySelectorAll(".learn-item").length,
    count: document.querySelector("[data-learn-count]")?.textContent.trim()
  }), secondCat);

  await page.click('[data-learn-category="all"]');
  await page.waitForTimeout(300);

  // search
  await page.fill("[data-learn-search]", "fraud");
  await page.waitForTimeout(450);
  R.search = await page.evaluate(() => ({
    titles: [...document.querySelectorAll(".learn-head-text strong")].map((e) => e.textContent.trim()),
    kept: document.querySelector("[data-learn-search]")?.value,
    focused: document.activeElement?.hasAttribute?.("data-learn-search")
  }));
  await page.fill("[data-learn-search]", "otp");
  await page.waitForTimeout(400);
  R.searchBody = await page.evaluate(() => [...document.querySelectorAll(".learn-head-text strong")].map((e) => e.textContent.trim()));
  await page.fill("[data-learn-search]", "zzzz");
  await page.waitForTimeout(400);
  R.noMatch = await page.evaluate(() => document.querySelector(".empty-state strong")?.textContent.trim());
  await page.fill("[data-learn-search]", "");
  await page.waitForTimeout(400);

  R.overflowX = await page.evaluate(() => {
    const c = document.querySelector(".modal-card");
    return { card: c.scrollWidth > c.clientWidth + 1, doc: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
