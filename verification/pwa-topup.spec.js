// Drive the real PWA bundle (app.min.js, the file index.html loads) through a
// complete Peach card top-up in Chromium.
const { chromium } = require("playwright");

const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";
const stamp = Date.now();

const USER = {
  fullName: "PWA TopUp Tester",
  email: `pwa${stamp}@titopay.local`,
  phone: `+2785${String(stamp).slice(-7)}`,
  password: "PwaTester!2026#x",
  accountType: "personal"
};

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function apiCall(path, body, token) {
  const r = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log("\n=================================================================");
  console.log("  PWA CARD TOP-UP IN A REAL BROWSER");
  console.log("=================================================================\n");

  await apiCall("/auth/register", USER);
  const login = await apiCall("/auth/login", { identifier: USER.email, password: USER.password });
  const token = login.payload.accessToken;
  const refresh = login.payload.refreshToken;
  check("test customer ready", Boolean(token));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // Seed the session the way the app stores it, so we exercise the top-up flow
  // rather than the login form.
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([t, r]) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: t, refreshToken: r }));
  }, [token, refresh]);
  await page.goto(`${PWA}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const session = await page.evaluate(() => ({
    hasToken: Boolean(state.auth && state.auth.accessToken),
    wallets: (state.wallets || []).length,
    balance: (state.wallets || [])[0] ? Number(state.wallets[0].available_balance) : null
  }));
  check("PWA session established", session.hasToken && session.wallets > 0, JSON.stringify(session));

  // The new helpers must exist in the bundle the browser actually loaded.
  const helpers = await page.evaluate(() => ({
    isCardTopupService: typeof isCardTopupService,
    startCardTopup: typeof startCardTopup,
    resumeTopupFromReturn: typeof resumeTopupFromReturn,
    pollAndPresentTopup: typeof pollAndPresentTopup,
    routes: typeof isCardTopupService === "function" ? isCardTopupService("wallet_top_up") : null
  }));
  check("top-up helpers loaded in app.min.js",
    helpers.isCardTopupService === "function" && helpers.startCardTopup === "function" && helpers.resumeTopupFromReturn === "function",
    JSON.stringify(helpers));
  check("wallet_top_up routes to the card flow", helpers.routes === true);

  // Run the confirm path exactly as the review screen does, and let the browser
  // actually navigate to the Peach payment page.
  await page.evaluate(() => {
    state.pendingTransactionReview = {
      data: { serviceCode: "wallet_top_up", reference: "browser test" },
      amount: 480.25,
      recipient: "TitoPay Wallet",
      idempotencyKey: `pwa-${Date.now()}`,
      preview: { amount: 480.25, fee: 0, total: 480.25 }
    };
    // Fire and forget: the call navigates the page away to Peach.
    startCardTopup(state.pendingTransactionReview);
  });
  await page.waitForURL(/127\.0\.0\.1:4400\/pay\//, { timeout: 20000 });
  check("PWA redirected the customer to the Peach payment page", /4400\/pay\//.test(page.url()), page.url());

  await page.waitForSelector("#pay", { timeout: 15000 });
  const peachPageText = await page.textContent("body");
  check("Peach page shows the amount to pay", /480\.25/.test(peachPageText || ""), (peachPageText || "").replace(/\s+/g, " ").slice(0, 110));

  const topups = await apiCall("/payments/topup?limit=1", null, token);
  const reference = topups.payload.items?.[0]?.reference;
  check("API recorded a pending top-up", Boolean(reference), reference || "none");

  // Wallet must not have moved yet.
  const beforeWallet = await apiCall("/wallets", null, token);
  const beforeBalance = Number((beforeWallet.payload.items || [])[0]?.available_balance ?? -1);
  check("wallet untouched before payment", beforeBalance === 0, `R${beforeBalance}`);

  // Click Pay. Peach POSTs the browser back to the API, which 303s to the PWA.
  await page.click("#pay").catch(() => null);
  await page.waitForURL(/127\.0\.0\.1:8010/, { timeout: 30000 });
  check("browser landed back on the PWA after paying", page.url().startsWith(PWA), page.url());
  await page.waitForTimeout(5000);

  const modalText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 4000));
  check("PWA shows the topped-up outcome", /wallet topped up/i.test(modalText), modalText.match(/Wallet topped up[^.]*\./i)?.[0] || modalText.slice(0, 160));
  check("PWA shows the amount credited", /480\.25/.test(modalText));

  const urlAfter = page.url();
  check("return query string cleaned from the URL", !/topup=/.test(urlAfter), urlAfter);

  const afterWallet = await apiCall("/wallets", null, token);
  const afterBalance = Number((afterWallet.payload.items || [])[0]?.available_balance ?? -1);
  check("wallet credited exactly once", Math.abs(afterBalance - 480.25) < 0.005, `R${afterBalance}`);

  // A refresh must not credit again.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const afterReload = await apiCall("/wallets", null, token);
  check("browser refresh did not double-credit",
    Math.abs(Number((afterReload.payload.items || [])[0]?.available_balance) - 480.25) < 0.005,
    `R${(afterReload.payload.items || [])[0]?.available_balance}`);

  const realErrors = consoleErrors.filter((e) => !/favicon|manifest|service-?worker|404|Failed to load resource|frame-ancestors|chat\/socket/i.test(e));
  check("no JavaScript errors in the page", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await page.screenshot({ path: "pwa-topup-success.png", fullPage: false });
  await browser.close();

  console.log("\n=================================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`)); }
  console.log("=================================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
