const { launchOptions, BASE_URL, ROOT } = require("./lib/env");
const CATALOGUE_PATH = require("path").join(ROOT, "services-default.json");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR || "tests/artifacts";

const CATALOGUE = {
  airtime: { providers: [{ code: "MTN", name: "MTN", products: [{ code: "A5", name: "R5 airtime", amount: 5 }, { code: "A12", name: "R12 airtime", amount: 12 }] }] },
  data: { providers: [{ code: "MTN", name: "MTN", products: [{ code: "D1", name: "1GB", size: "1 GB", validity: "30 days", amount: 85 }] }] },
  electricity: { providers: [{ code: "ESKOM", name: "Eskom prepaid", minAmount: 20, maxAmount: 3000, products: [] }] },
  voucher: { providers: [{ code: "1V", name: "1Voucher", products: [{ code: "V50", name: "R50 voucher", amount: 50 }] }] },
  bill_payment: { providers: [{ code: "DSTV", name: "DStv", fields: [{ name: "smartcard", label: "Smartcard number", primary: true }, { name: "surname", label: "Surname" }] }] }
};

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE_PATH, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);

  const requested = [];
  let txPosts = 0, qrPosts = 0, loginPosts = 0, otpPosts = 0, txResponse = null;
  let authed = false;

  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${BASE_URL}`)) requested.push(url.replace(`${BASE_URL}/`, ""));
    if (!url.includes("api.titopay.co.za")) return route.continue();

    const u = new URL(url);
    const method = route.request().method();
    const J = (st, b) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });

    if (u.pathname === "/v1/auth/login" && method === "POST") { loginPosts += 1; return J(200, { otpRequired: true, otpToken: "otp-1", challengeId: "c1" }); }
    if (u.pathname === "/v1/auth/verify-otp" && method === "POST") {
      otpPosts += 1; authed = true;
      return J(200, { accessToken: "acc-1", refreshToken: "ref-1", user: { id: "u1", fullName: "QA User", username: "qa", accountType: "personal", status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } });
    }
    if (u.pathname === "/v1/vas/catalogue") { await sleep(120); return J(200, CATALOGUE[u.searchParams.get("service")] || { providers: [] }); }
    if (u.pathname === "/v1/vas/validate") return J(200, { validation: { customerName: "N Mokoena" } });
    if (u.pathname.includes("/recipient/verify")) return J(200, { registered: true, user: { fullName: "Naledi Mokoena", username: "naledi", phone: "+27711112222" } });
    if (u.pathname === "/v1/transactions/fee-preview") {
      const amt = Number((route.request().postDataJSON() || {}).amount || 0);
      return J(200, { preview: { amount: amt, fee: 1.5, thirdPartyFee: 0, total: amt + 1.5, recipientAmount: amt } });
    }
    if (u.pathname === "/v1/transactions" && method === "POST") {
      txPosts += 1; await sleep(150);
      return J(200, txResponse || { transaction: { id: "t1", reference: "R1", status: "completed", amount: 250, total: 251.5 } });
    }
    if (u.pathname === "/v1/qr/generate-static" || u.pathname === "/v1/qr/generate-dynamic") {
      return J(200, { qr: { id: "qr1", reference: "QR-1", imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", deepLink: "https://app.titopay.co.za/qr/qr1" } });
    }
    if (u.pathname === "/v1/qr/pay" && method === "POST") { qrPosts += 1; return J(200, { transaction: { id: "q1", reference: "QP-1", status: "completed", amount: 100, total: 100.5 } }); }

    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") {
      if (!authed) return J(401, { error: "Unauthorized" });
      body = { user: { id: "u1", fullName: "QA User", username: "qa", accountType: "personal", status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    }
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    else if (u.pathname === "/v1/qr/profile") body = { qr: null };
    J(200, body);
  });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket|manifest/i.test(m.text())) errs.push("console: " + m.text().slice(0, 140)); });

  const R = {};

  // ---------- 1. COLD LOAD (unauthenticated) ----------
  await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3000);
  R.coldLoad = await page.evaluate(() => ({
    landing: document.body.classList.contains("landing-static"),
    hasAuthTabs: !!document.querySelector("[data-auth-tab]"),
    title: document.title
  }));
  R.versionedRequests = requested.filter((u) => u.includes("?v=") || /^(app\.js|styles\.css|index\.html|manifest)/.test(u));
  R.staleV168Requests = requested.filter((u) => /v=168|v168/.test(u));

  // ---------- 2. AUTHENTICATION (login -> OTP) ----------
  await page.click('[data-auth-tab="login"]').catch(() => {});
  await page.waitForTimeout(900);
  R.loginModal = await page.evaluate(() => !!document.querySelector('form[data-form="login"]'));
  if (R.loginModal) {
    await page.fill('form[data-form="login"] [name="identifier"]', "+27821234567").catch(() => {});
    const pw = await page.$('form[data-form="login"] [name="password"]');
    if (pw) await pw.fill("Test-PIN-12345");
    await page.click('form[data-form="login"] button[type="submit"]').catch(() => {});
    await page.waitForTimeout(1800);
    R.otpStage = await page.evaluate(() => {
      const f = document.querySelector('.modal-card form[data-form]');
      return { form: f?.dataset.form, hasOtpField: !!document.querySelector('[name="otp"]') };
    });
    const otpField = await page.$('.modal-card form[data-form="otp"] [name="otp"]');
    if (otpField) {
      await otpField.fill("123456");
      await page.click('.modal-card form[data-form="otp"] button[type=submit]').catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  R.authenticated = await page.evaluate(() => ({
    dashboard: !!document.querySelector(".bottom-nav"),
    walletShown: /12\s?847|12,847/.test(document.body.textContent || ""),
    loginPostsSeen: true
  }));
  R.loginPosts = loginPosts;
  R.otpPosts = otpPosts;
  // Sign-in ends on the security-tip sheet; dismiss it before touching the app.
  R.securityTipShown = await page.evaluate(() => /stay safe/i.test(document.querySelector(".modal-card")?.textContent || ""));
  await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
  await page.waitForTimeout(500);
  R.modalClosedAfterAuth = await page.evaluate(() => !document.querySelector(".modal-backdrop"));
  await page.screenshot({ path: `${OUT}/v169-dashboard.png` });

  const openService = async (svc, wait = 1500) => {
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(450);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) return false;
    await t.click();
    await page.waitForTimeout(wait);
    return true;
  };
  const close = async () => { await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click()); await page.waitForTimeout(320); };

  // ---------- 3. SEND MONEY (verify -> review -> confirm) ----------
  if (await openService("send-money", 900)) {
    await page.fill('.modal-card [name="recipient"]', "+27711112222");
    await page.fill('.currency-affix [name="amount"]', "250");
    await page.fill('.modal-card [name="reference"]', "Rent");
    await page.click('.modal-card [data-action="verify-recipient-field"]').catch(() => {});
    await page.waitForTimeout(1400);
    R.sendMoneyVerify = await page.evaluate(() => {
      const f = document.querySelector('.modal-card form[data-form="transaction"]');
      return { formSurvived: !!f, inline: !!f?.querySelector("[data-recipient-verify-for]"), amount: f?.querySelector('[name="amount"]')?.value, recipient: f?.querySelector('[name="recipient"]')?.value };
    });
    await page.click('.modal-card form[data-form="transaction"] button[type="submit"]');
    await page.waitForTimeout(2200);
    R.sendMoneyReview = await page.evaluate(() => ({
      open: !!document.querySelector('[data-action="confirm-transaction-review"]'),
      total: [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).find((t) => t.startsWith("Total debit"))
    }));
    const c = await page.$('[data-action="confirm-transaction-review"]');
    if (c) {
      txPosts = 0;
      await c.click();
      await c.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2600);
      R.sendMoneyConfirm = { posts: txPosts, success: await page.evaluate(() => /purchase complete|transaction recorded|success/i.test(document.querySelector(".modal-card")?.textContent || "")) };
      // focus restoration after the render that follows a completed transaction
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      R.focusRestored = await page.evaluate(() => {
        const a = document.activeElement;
        return { tag: a?.tagName?.toLowerCase(), service: a?.getAttribute?.("data-service"), modalGone: !document.querySelector(".modal-card") };
      });
    }
  }
  await close();

  // ---------- 4. QR PAYMENTS ----------
  await page.evaluate(() => { location.hash = "qr"; });
  await page.waitForTimeout(1400);
  R.qrScreen = await page.evaluate(() => ({
    rendered: !!document.querySelector("#app")?.textContent.trim(),
    hasQrActions: document.querySelectorAll('[data-action="receive"], [data-service="receive-money"], [data-service="qr-pay"], [data-action]').length > 0
  }));
  if (await openService("receive-money", 2200)) {
    R.qrGenerate = await page.evaluate(() => ({
      qrCard: !!document.querySelector("[data-qr-card]"),
      hasImage: !!document.querySelector("[data-qr-card] img"),
      hasCopy: !!document.querySelector("[data-copy-qr]"),
      hasShare: !!document.querySelector("[data-share-qr]")
    }));
    await page.screenshot({ path: `${OUT}/v169-qr.png` });
    await close();
  }
  if (await openService("qr-pay", 1200)) {
    R.qrPayForm = await page.evaluate(() => {
      const f = document.querySelector(".modal-card form[data-form]");
      return { form: f?.dataset.form, fields: [...(f?.querySelectorAll("input:not([type=hidden])") || [])].map((e) => e.name) };
    });
    await close();
  }

  // ---------- 5. VAS FLOWS OPEN + STATE PRESERVATION ----------
  const vas = {};
  for (const svc of ["airtime-data", "electricity", "voucher", "pay-bills"]) {
    if (!(await openService(svc))) { vas[svc] = "NO TILE"; continue; }
    vas[svc] = await page.evaluate(() => {
      const f = document.querySelector("form[data-vas-journey]");
      return f ? { journey: f.dataset.vasJourney, providers: [...(f.querySelector('[name="provider"]')?.options || [])].length, products: f.querySelectorAll(".vas-product").length, accountFields: f.querySelectorAll("[data-vas-account] [name]").length } : "NO FORM";
    });
    await close();
  }
  R.vas = vas;

  // state preservation: data switch keeps typed values
  if (await openService("airtime-data")) {
    await page.fill('[name="recipient"]', "+27711112222");
    await page.fill('[name="reference"]', "For gogo");
    const p0 = await page.$('[data-vas-product="0"]');
    if (p0) await p0.click();
    await page.waitForTimeout(300);
    await page.click('form[data-vas-journey] button[type="submit"]');
    await page.waitForTimeout(2100);
    const edit = await page.$('[data-action="edit-transaction-review"]');
    if (edit) { await edit.click(); await page.waitForTimeout(2100); }
    R.statePreserved = await page.evaluate(() => {
      const f = document.querySelector("form[data-vas-journey]");
      return f ? { journey: f.dataset.vasJourney, recipient: f.querySelector('[name="recipient"]')?.value, amount: f.querySelector('[name="amount"]')?.value, reference: f.querySelector('[name="reference"]')?.value, product: f.querySelector(".vas-product.is-selected .vas-product-name")?.textContent.trim() } : null;
    });
    await close();
  }

  // ---------- 6. NO STALE ASSETS ----------
  R.allLocalRequests = Array.from(new Set(requested)).sort();
  R.staleV168Requests = requested.filter((u) => /v=168|v168/.test(u));
  R.errors = errs;
  R.qrPosts = qrPosts;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
