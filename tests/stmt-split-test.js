const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const ACCOUNT = process.argv[2] || "business";

const now = new Date();
const iso = (d) => d.toISOString();
const TX = [
  { id: "t1", reference: "TP-1", service_name: "Top Up", direction: "credit", amount: 1000, total: 1000, status: "completed", created_at: iso(new Date(now.getFullYear(), now.getMonth(), 3)) },
  { id: "t2", reference: "TP-2", service_name: "Airtime", direction: "debit", amount: 150, total: 152.5, status: "completed", created_at: iso(new Date(now.getFullYear(), now.getMonth(), 8)) },
  { id: "t3", reference: "TP-3", service_name: "Send Money", direction: "debit", amount: 400, total: 402.5, status: "completed", created_at: iso(new Date(now.getFullYear(), now.getMonth(), 12)) },
  { id: "t4", reference: "TP-4", service_name: "Merchant Sale", direction: "credit", amount: 2500, total: 2500, status: "completed", created_at: iso(new Date(now.getFullYear(), now.getMonth() - 1, 15)) },
  { id: "t5", reference: "TP-5", service_name: "Payout", direction: "debit", amount: 1800, total: 1800, status: "completed", created_at: iso(new Date(now.getFullYear() - 1, 5, 2)) }
];

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  let posted = null;
  await ctx.route("https://api.titopay.co.za/**", (route) => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const J = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/v1/transactions/fee-preview") { const a = Number((route.request().postDataJSON() || {}).amount || 0); return J({ preview: { amount: a, fee: 2.5, thirdPartyFee: 0, total: a + 2.5, recipientAmount: a } }); }
    if (u.pathname === "/v1/transactions" && m === "POST") { posted = route.request().postDataJSON(); return J({ transaction: { id: "x", reference: "R", status: "completed" } }); }
    if (u.pathname === "/v1/transactions" && m === "GET") return J({ items: TX });
    if (u.pathname.includes("/recipient/verify") || u.pathname.includes("/recipients/resolve") || u.pathname.includes("/chat/users/lookup")) return J({ registered: true, user: { fullName: "Thabo Ndlovu", username: "thabo" }, items: [{ registered: true }] });
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "Naledi Mokoena", businessName: "Naledi Trading", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
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
  const open = async (svc, wait = 900) => {
    for (let i = 0; i < 4; i += 1) {
      if (!(await page.evaluate(() => !!document.querySelector(".modal-backdrop")))) break;
      await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(420);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) return false;
    await t.click(); await page.waitForTimeout(wait); return true;
  };

  R.txLoaded = await page.evaluate(() => window.__txcount ?? null);

  // ---- STATEMENTS ----
  if (ACCOUNT === "business") {
    R.statementsOpened = await open("statements", 1100);
    if (R.statementsOpened) {
      R.statements = await page.evaluate(() => {
        const c = document.querySelector(".modal-card");
        return {
          heading: c.querySelector("h2")?.textContent.trim(),
          periods: [...c.querySelectorAll("[data-statement-period]")].map((b) => b.textContent.trim()),
          active: c.querySelector("[data-statement-period].is-active")?.textContent.trim(),
          period: c.querySelector(".statement-period")?.textContent.trim(),
          figures: [...c.querySelectorAll(".statement-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
          from: c.querySelector("[data-statement-from]")?.value,
          to: c.querySelector("[data-statement-to]")?.value,
          exportsEnabled: [...c.querySelectorAll("[data-statement-export]")].map((b) => !b.disabled)
        };
      });
      await page.screenshot({ path: `${OUT}/statements-thismonth.png` });
      await page.click('[data-statement-period="all"]');
      await page.waitForTimeout(400);
      R.statementsAll = await page.evaluate(() => ({
        period: document.querySelector(".statement-period")?.textContent.trim(),
        figures: [...document.querySelectorAll(".statement-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim())
      }));
      await page.click('[data-statement-period="last-month"]');
      await page.waitForTimeout(400);
      R.statementsLastMonth = await page.evaluate(() => ({
        period: document.querySelector(".statement-period")?.textContent.trim(),
        figures: [...document.querySelectorAll(".statement-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim())
      }));
      // empty period
      await page.fill("[data-statement-from]", "2019-01-01");
      await page.fill("[data-statement-to]", "2019-01-31");
      await page.waitForTimeout(450);
      R.statementsEmpty = await page.evaluate(() => ({
        figures: [...document.querySelectorAll(".statement-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
        hint: document.querySelector(".statement-summary .field-hint")?.textContent.trim(),
        exportsEnabled: [...document.querySelectorAll("[data-statement-export]")].map((b) => !b.disabled)
      }));
    }
  }

  // ---- BILL SPLIT ----
  if (ACCOUNT === "personal") {
    R.splitOpened = await open("bill-split", 900);
    if (R.splitOpened) {
      R.splitInitial = await page.evaluate(() => {
        const c = document.querySelector(".modal-card");
        return {
          heading: c.querySelector("h2")?.textContent.trim(),
          rows: c.querySelectorAll("[data-split-participant]").length,
          submitDisabled: c.querySelector('button[type="submit"]').disabled,
          summary: c.querySelector("[data-split-summary]")?.textContent.replace(/\s+/g, " ").trim(),
          removeDisabled: c.querySelector("[data-split-remove]")?.disabled,
          hiddenParticipants: c.querySelector('[name="participants"]')?.value
        };
      });
      await page.fill('[name="reference"]', "Dinner at Marble");
      await page.fill('[name="amount"]', "1000");
      await page.fill("[data-split-person]", "@thabo");
      await page.waitForTimeout(350);
      R.splitOne = await page.evaluate(() => ({
        shares: [...document.querySelectorAll("[data-split-share]")].map((e) => e.textContent.trim()),
        summary: [...document.querySelectorAll(".split-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
        hint: document.querySelector(".split-summary .field-hint")?.textContent.trim(),
        submitDisabled: document.querySelector('button[type="submit"]').disabled
      }));

      await page.click('[data-action="split-add-participant"]');
      await page.waitForTimeout(250);
      let rows = await page.$$("[data-split-person]");
      await rows[1].fill("+27711112222");
      await page.waitForTimeout(300);
      R.splitTwo = await page.evaluate(() => ({
        shares: [...document.querySelectorAll("[data-split-share]")].map((e) => e.textContent.trim()),
        summary: [...document.querySelectorAll(".split-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
        hiddenParticipants: document.querySelector('[name="participants"]').value
      }));

      // uneven: 1000 / 3 does not divide
      await page.click('[data-action="split-add-participant"]');
      await page.waitForTimeout(250);
      rows = await page.$$("[data-split-person]");
      await rows[2].fill("lerato@example.com");
      await page.waitForTimeout(350);
      R.splitUneven = await page.evaluate(() => ({
        shares: [...document.querySelectorAll("[data-split-share]")].map((e) => e.textContent.trim()),
        summary: [...document.querySelectorAll(".split-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
        hint: document.querySelector(".split-summary .field-hint")?.textContent.trim()
      }));
      R.sharesAddUp = await page.evaluate(() => {
        const shares = [...document.querySelectorAll("[data-split-share]")].map((e) => Number(e.textContent.replace(/[^\d.]/g, "")) || 0);
        return { shares, sum: Number(shares.reduce((a, b) => a + b, 0).toFixed(2)) };
      });
      await page.screenshot({ path: `${OUT}/split-uneven.png` });

      await page.selectOption('[name="splitMethod"]', "Percentage split");
      await page.waitForTimeout(350);
      R.splitPercentage = await page.evaluate(() => ({
        shares: [...document.querySelectorAll("[data-split-share]")].map((e) => e.textContent.trim()),
        hint: document.querySelector(".split-summary .field-hint")?.textContent.trim()
      }));
      await page.selectOption('[name="splitMethod"]', "Equal split");
      await page.waitForTimeout(300);

      const removes = await page.$$("[data-split-remove]");
      await removes[2].click();
      await page.waitForTimeout(300);
      R.afterRemove = await page.evaluate(() => ({
        rows: document.querySelectorAll("[data-split-participant]").length,
        hiddenParticipants: document.querySelector('[name="participants"]').value,
        shares: [...document.querySelectorAll("[data-split-share]")].map((e) => e.textContent.trim())
      }));

      await page.click('.modal-card form button[type="submit"]');
      await page.waitForTimeout(2000);
      R.splitReview = await page.evaluate(() => ({
        open: !!document.querySelector('[data-action="confirm-transaction-review"]'),
        rows: [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).slice(0, 6)
      }));
      R.posted = posted;
    }
  }

  R.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
