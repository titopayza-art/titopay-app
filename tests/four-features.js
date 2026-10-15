const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const ACCOUNT = process.argv[2] || "personal";

const EVENTS = [
  { slug: "amapiano-fest", eventName: "Amapiano Summer Festival", eventDate: "2026-12-16T18:00:00Z", venueName: "Mary Fitzgerald Square", city: "Johannesburg", ticketTypes: [{ price: 350, quantityAvailable: 500, quantitySold: 120 }, { price: 750, quantityAvailable: 100, quantitySold: 40 }] },
  { slug: "comedy-night", eventName: "Cape Town Comedy Night", eventDate: "2026-09-04T19:30:00Z", venueName: "Baxter Theatre", city: "Cape Town", ticketTypes: [{ price: 180, quantityAvailable: 200, quantitySold: 200 }] },
  { slug: "gospel", eventName: "Gospel Celebration", eventDate: "2026-10-11T10:00:00Z", venueName: "Moses Mabhida", city: "Durban", ticketTypes: [{ price: 120, quantityAvailable: 1000, quantitySold: 300 }] },
  { slug: "jazz", eventName: "Soweto Jazz Sessions", eventDate: "2026-11-02T17:00:00Z", venueName: "Soweto Theatre", city: "Johannesburg", ticketTypes: [{ price: 220, quantityAvailable: 300, quantitySold: 50 }] },
  { slug: "tech", eventName: "SA Fintech Summit", eventDate: "2027-02-18T08:00:00Z", venueName: "CTICC", city: "Cape Town", ticketTypes: [{ price: 1500, quantityAvailable: 400, quantitySold: 100 }] }
];

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  let txPosts = 0, lastBody = null;
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const J = (st, b) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/v1/ticketing/public/events") { await sleep(200); return J(200, { items: EVENTS }); }
    if (u.pathname === "/v1/ticketing/eligibility") return J(200, { eligibility: { eligible: true } });
    if (u.pathname === "/v1/ticketing/business/events") return J(200, { items: [] });
    if (u.pathname === "/v1/transactions/fee-preview") { const a = Number((route.request().postDataJSON() || {}).amount || 0); return J(200, { preview: { amount: a, fee: 2.5, thirdPartyFee: 0, total: a + 2.5, recipientAmount: a } }); }
    if (u.pathname === "/v1/transactions" && m === "POST") { txPosts += 1; lastBody = route.request().postDataJSON(); return J(200, { transaction: { id: "t1", reference: "R1", status: "completed", amount: 100, total: 102.5 } }); }
    if (u.pathname.includes("/recipient/verify")) return J(200, { registered: true, user: { fullName: "Naledi Mokoena", username: "naledi" } });
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: ACCOUNT === "business" ? "Naledi Trading" : "QA User", businessName: "Naledi Trading", username: "qa", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    J(200, body);
  });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 130)); });
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3400);

  const R = { account: ACCOUNT };
  const open = async (svc, wait = 1400) => {
    for (let i = 0; i < 4; i += 1) {
      if (!(await page.evaluate(() => !!document.querySelector(".modal-backdrop")))) break;
      await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
      await page.waitForTimeout(280);
    }
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(420);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) return false;
    await t.click(); await page.waitForTimeout(wait); return true;
  };

  R.tiles = await page.evaluate(() => [...document.querySelectorAll("[data-service]")].map((e) => e.dataset.service));

  // ---- TOP UP ----
  R.topUpOpened = await open("top-up", 900);
  if (R.topUpOpened) {
    R.topUp = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        balanceContext: c.querySelector(".balance-context")?.textContent.replace(/\s+/g, " ").trim(),
        quickAmounts: [...c.querySelectorAll("[data-quick-amount]")].map((b) => b.textContent.trim()),
        methodOptions: [...(c.querySelector("[data-funding-method]")?.options || [])].map((o) => o.textContent.trim()),
        hint: c.querySelector("[data-funding-hint]")?.textContent.trim(),
        optionalMarked: !!c.querySelector(".field-optional"),
        infoPanels: c.querySelectorAll(".integration-note p").length,
        labelsBound: [...c.querySelectorAll("input,select")].filter((e) => e.type !== "hidden" && e.offsetParent).every((e) => e.id && c.querySelector(`label[for="${e.id}"]`))
      };
    });
    await page.click('[data-quick-amount="200"]');
    await page.waitForTimeout(250);
    R.topUpQuick = await page.evaluate(() => ({ amount: document.querySelector('[name="amount"]').value, active: document.querySelector('[data-quick-amount="200"]').classList.contains("is-active") }));
    await page.selectOption("[data-funding-method]", "eft_bank_transfer");
    await page.waitForTimeout(300);
    R.topUpEftHint = await page.evaluate(() => document.querySelector("[data-funding-hint]")?.textContent.trim().slice(0, 60));
    await page.screenshot({ path: `${OUT}/ff-topup-${ACCOUNT}.png` });
    await page.click(".modal-card form button[type=submit]");
    await page.waitForTimeout(2000);
    R.topUpReview = await page.evaluate(() => ({ open: !!document.querySelector('[data-action="confirm-transaction-review"]'), total: [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).find((t) => t.startsWith("Total debit")) }));
  }

  // ---- WITHDRAW ----
  if (await open("withdraw", 900)) {
    R.withdraw = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        balanceContext: c.querySelector(".balance-context")?.textContent.replace(/\s+/g, " ").trim(),
        quickAmounts: [...c.querySelectorAll("[data-quick-amount]")].map((b) => b.textContent.trim()),
        speedOptions: [...(c.querySelector("[data-withdrawal-speed]")?.options || [])].map((o) => o.textContent.trim()),
        hint: c.querySelector("[data-withdrawal-hint]")?.textContent.trim().slice(0, 50),
        accountHint: [...c.querySelectorAll(".field-hint")].map((e) => e.textContent.trim())[0],
        fieldOrder: [...c.querySelectorAll("label")].map((l) => l.textContent.replace(/\s+/g, " ").trim())
      };
    });
    const all = await page.$$("[data-quick-amount]");
    await all[all.length - 1].click();
    await page.waitForTimeout(250);
    R.withdrawAll = await page.evaluate(() => document.querySelector('[name="amount"]').value);
    await page.selectOption("[data-withdrawal-speed]", "instant_peach_withdrawal");
    await page.waitForTimeout(300);
    R.withdrawInstantHint = await page.evaluate(() => document.querySelector("[data-withdrawal-hint]")?.textContent.trim().slice(0, 45));
    await page.screenshot({ path: `${OUT}/ff-withdraw-${ACCOUNT}.png` });
  }

  // ---- SEND GIFT ----
  R.giftOpened = await open("send-gift", 900);
  if (R.giftOpened) {
    R.gift = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        occasionChips: c.querySelectorAll("[data-gift-occasion]").length,
        activeOccasion: c.querySelector("[data-gift-occasion].is-active")?.textContent.trim(),
        hiddenOccasionValue: c.querySelector("[data-gift-occasion-value]")?.value,
        timingChips: [...c.querySelectorAll("[data-gift-timing]")].map((b) => b.textContent.trim()),
        scheduleHidden: c.querySelector("[data-gift-schedule]")?.classList.contains("hidden"),
        counter: c.querySelector("[data-gift-counter]")?.textContent.trim(),
        quickAmounts: [...c.querySelectorAll("[data-quick-amount]")].map((b) => b.textContent.trim()),
        customHidden: c.querySelector("[data-custom-occasion]")?.classList.contains("hidden")
      };
    });
    await page.click('[data-gift-occasion="Custom"]');
    await page.waitForTimeout(300);
    R.giftCustom = await page.evaluate(() => ({
      customShown: !document.querySelector("[data-custom-occasion]").classList.contains("hidden"),
      required: document.querySelector('[name="customOccasion"]').required,
      hiddenValue: document.querySelector("[data-gift-occasion-value]").value
    }));
    await page.click('[data-gift-occasion="Birthday"]');
    await page.waitForTimeout(250);
    R.giftBackToPreset = await page.evaluate(() => ({ customHidden: document.querySelector("[data-custom-occasion]").classList.contains("hidden"), value: document.querySelector("[data-gift-occasion-value]").value }));
    await page.click('[data-gift-timing="later"]');
    await page.waitForTimeout(300);
    R.giftSchedule = await page.evaluate(() => ({ shown: !document.querySelector("[data-gift-schedule]").classList.contains("hidden"), required: document.querySelector('[name="scheduledDelivery"]').required }));
    await page.click('[data-gift-timing="now"]');
    await page.waitForTimeout(250);
    R.giftNow = await page.evaluate(() => ({ hidden: document.querySelector("[data-gift-schedule]").classList.contains("hidden"), value: document.querySelector('[name="scheduledDelivery"]').value, required: document.querySelector('[name="scheduledDelivery"]').required }));
    await page.fill("[data-gift-message]", "Happy birthday gogo, enjoy your day from all of us at home.");
    await page.waitForTimeout(300);
    R.giftCounter = await page.evaluate(() => document.querySelector("[data-gift-counter]").textContent.trim());
    await page.click('[data-quick-amount="100"]');
    await page.fill('[name="recipient"]', "+27711112222");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/ff-gift-${ACCOUNT}.png` });
    await page.click(".modal-card form button[type=submit]");
    await page.waitForTimeout(2200);
    R.giftReview = await page.evaluate(() => ({ open: !!document.querySelector('[data-action="confirm-transaction-review"]') }));
    R.giftPayloadKeys = lastBody ? null : "not submitted yet";
  }

  // ---- TICKETS ----
  R.ticketsOpened = await open("tickets", 2000);
  if (R.ticketsOpened) {
    R.tickets = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        heading: c.querySelector("h2")?.textContent.trim(),
        cards: c.querySelectorAll(".ticket-card").length,
        dates: [...c.querySelectorAll(".ticket-date strong")].map((e) => e.textContent.trim()),
        months: [...c.querySelectorAll(".ticket-date span")].map((e) => e.textContent.trim()),
        prices: [...c.querySelectorAll(".ticket-price")].map((e) => e.textContent.trim()),
        soldOut: c.querySelectorAll(".ticket-card.is-sold-out").length,
        disabledCtas: [...c.querySelectorAll(".ticket-cta")].filter((b) => b.disabled).length,
        searchPresent: !!c.querySelector("[data-ticket-search]"),
        liveRegion: c.querySelector("[data-ticket-list]")?.getAttribute("aria-live")
      };
    });
    await page.fill("[data-ticket-search]", "cape");
    await page.waitForTimeout(400);
    R.ticketSearch = await page.evaluate(() => ({
      shown: [...document.querySelectorAll(".ticket-body > strong")].map((e) => e.textContent.trim()),
      kept: document.querySelector("[data-ticket-search]")?.value,
      focused: document.activeElement?.hasAttribute?.("data-ticket-search")
    }));
    await page.fill("[data-ticket-search]", "zzz");
    await page.waitForTimeout(400);
    R.ticketNoMatch = await page.evaluate(() => document.querySelector(".empty-state strong")?.textContent.trim());
    await page.fill("[data-ticket-search]", "");
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/ff-tickets-${ACCOUNT}.png` });
  }

  // ---- BUSINESS: browse public events from the ticketing dashboard ----
  if (ACCOUNT === "business") {
    if (await open("ticketing", 2200)) {
      R.businessBrowse = await page.evaluate(() => !!document.querySelector('[data-action="ticketing-browse-public"]'));
      const browse = await page.$('[data-action="ticketing-browse-public"]');
      if (browse) {
        await browse.click();
        await page.waitForTimeout(2200);
        R.businessTickets = await page.evaluate(() => ({
          heading: document.querySelector(".modal-card h2")?.textContent.trim(),
          cards: document.querySelectorAll(".ticket-card").length
        }));
        await page.screenshot({ path: `${OUT}/ff-biz-tickets.png` });
      }
    }
  }

  R.txPosts = txPosts;
  R.errors = errs;
  R.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
