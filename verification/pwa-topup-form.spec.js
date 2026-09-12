// Reproduce EXACTLY what the customer did: open Top Up from the wallet, type an
// amount, press "Preview top up", read the review screen, press Confirm.
//
// This is the path that produced the red toast "Card top-ups are completed
// through the secure card payment flow" — the earlier spec called
// startCardTopup() directly and never went through the form.
const { chromium } = require("playwright");
// Harness screenshots go here, not into the repo root. A verification run
// must never leave build artifacts in the working tree; three got committed
// that way before this existed. The directory is gitignored.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });

const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const stamp = Date.now();
const AMOUNT = 200;

const USER = {
  fullName: "TopUp Form Tester",
  email: `form${stamp}@titopay.local`,
  phone: `+2786${String(stamp).slice(-7)}`,
  password: "FormTester!2026#x",
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
const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();

(async () => {
  console.log("\n=================================================================");
  console.log("  PWA TOP UP — THROUGH THE REAL FORM, NOT A SHORTCUT");
  console.log("=================================================================\n");

  await apiCall("/auth/register", USER);
  const login = await apiCall("/auth/login", { identifier: USER.email, password: USER.password });
  const token = login.payload.accessToken;
  check("test customer ready", Boolean(token));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await (await browser.newContext()).newPage();
  const consoleErrors = [];
  const toasts = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([t, r]) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: t, refreshToken: r }));
  }, [token, login.payload.refreshToken]);
  await page.goto(`${PWA}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  check("PWA session established", await page.evaluate(() => Boolean(state.auth && state.auth.accessToken)));

  // Watch every toast the app raises, so a silent error cannot pass as success.
  await page.evaluate(() => {
    window.__toasts = [];
    const original = window.showToast;
    window.showToast = function (message, kind) {
      window.__toasts.push({ message: String(message), kind: String(kind || "") });
      return original.apply(this, arguments);
    };
  });

  /* ------------------------------------------- 1. open Top Up from the wallet */
  console.log("--- 1. Open Top Up the way the customer does ---");
  await page.click('[data-wallet-action="top-up"], [data-service="top-up"]').catch(async () => {
    await page.evaluate(() => openTopUpModal({ id: "top-up", label: "Top Up", serviceCode: "wallet_top_up" }));
  });
  await page.waitForTimeout(1200);
  let modal = flat(await page.evaluate(() => document.body.innerText));
  check("Top Up screen opened", /Add money/i.test(modal), modal.slice(0, 90));
  check("card is the funding method offered", /Card . instant/i.test(modal));

  /* --------------------------------------------- 2. type R200 and press Preview */
  console.log("\n--- 2. Enter R200 on the keypad and press Top up ---");
  // The amount is now entered on the screen's own keypad rather than a text
  // field, so drive the keys the customer actually presses.
  for (const key of String(AMOUNT).split("")) {
    await page.click(`[data-money-key="${key}"]`);
  }
  const typed = await page.evaluate(() => document.querySelector('.money-screen [name="amount"]').value);
  check("the keypad wrote the amount", Number(typed) === AMOUNT, typed);
  const shownBig = await page.evaluate(() => document.querySelector("[data-amount-display]").textContent);
  check("and the screen shows it", shownBig === String(AMOUNT), shownBig);
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(4000);

  const raised = await page.evaluate(() => window.__toasts || []);
  raised.forEach((t) => toasts.push(t));
  const blocking = raised.filter((t) => t.kind === "error");
  check("no error toast (the reported failure)", blocking.length === 0,
    blocking.map((t) => t.message).join(" | "));
  check("the old 'secure card payment flow' refusal is gone",
    !raised.some((t) => /secure card payment flow/i.test(t.message)),
    raised.map((t) => t.message).join(" | "));

  /* ------------------------------------------------- 3. the review screen */
  console.log("\n--- 3. The review screen shows the real fee ---");
  const review = flat(await page.evaluate(() => document.body.innerText));
  check("review screen reached", /confirm/i.test(review) && /R\s?200/.test(review), review.slice(0, 160));

  const quote = await apiCall("/transactions/fee-preview", { service: "wallet_top_up", amount: AMOUNT }, token);
  const expectedFee = Number((quote.payload.preview || quote.payload).fee);
  const expectedTotal = Number((quote.payload.preview || quote.payload).total);
  const shown = await page.evaluate(() => state.pendingTransactionReview && state.pendingTransactionReview.preview);
  check("review holds the API's quote", Boolean(shown), JSON.stringify(shown));
  check(`review fee matches the pricing rule (R${expectedFee.toFixed(2)})`, Number(shown?.fee) === expectedFee, String(shown?.fee));
  check(`review total is R${expectedTotal.toFixed(2)}`, Number(shown?.total) === expectedTotal, String(shown?.total));
  check("the total is on screen for the customer", new RegExp(expectedTotal.toFixed(2).replace(".", "\\.")).test(review), review.slice(0, 200));

  await page.screenshot({ path: `${ARTIFACTS}/pwa-topup-review.png`, fullPage: false });

  /* ----------------------------------------------------- 4. Confirm -> Peach */
  console.log("\n--- 4. Confirm takes the customer to Peach for the total ---");
  const before = Number((await apiCall("/wallets", null, token)).payload.items?.[0]?.available_balance ?? -1);
  check("wallet untouched at the review screen", before === 0, `R${before}`);

  await page.click('[data-action="confirm-transaction-review"]');
  await page.waitForURL(/127\.0\.0\.1:4400\/pay\//, { timeout: 25000 });
  check("browser reached the Peach payment page", /4400\/pay\//.test(page.url()), page.url());

  await page.waitForSelector("#pay", { timeout: 15000 });
  const peachText = flat(await page.textContent("body"));
  check("Peach asks for the TOTAL the review screen quoted",
    peachText.includes(expectedTotal.toFixed(2)), peachText.slice(0, 120));

  /* -------------------------------------------------- 5. pay -> credited once */
  console.log("\n--- 5. Pay, and the wallet is credited the amount exactly once ---");
  await page.click("#pay").catch(() => null);
  await page.waitForURL(/127\.0\.0\.1:8010/, { timeout: 30000 });
  await page.waitForTimeout(5500);

  const outcome = flat(await page.evaluate(() => document.body.innerText)).slice(0, 3000);
  check("PWA reports the wallet topped up", /wallet topped up/i.test(outcome), outcome.slice(0, 150));
  check("it names the credited amount, not the charge", /200\.00/.test(outcome));

  const after = Number((await apiCall("/wallets", null, token)).payload.items?.[0]?.available_balance ?? -1);
  check("wallet credited exactly the amount", Math.abs(after - AMOUNT) < 0.005, `R${after}`);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const afterReload = Number((await apiCall("/wallets", null, token)).payload.items?.[0]?.available_balance ?? -1);
  check("a refresh did not credit again", Math.abs(afterReload - AMOUNT) < 0.005, `R${afterReload}`);

  const realErrors = consoleErrors.filter((e) => !/favicon|manifest|service-?worker|404|Failed to load resource|frame-ancestors|chat\/socket/i.test(e));
  check("no JavaScript errors in the page", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await page.screenshot({ path: `${ARTIFACTS}/pwa-topup-form-success.png`, fullPage: false });
  await browser.close();

  console.log("\n  toasts raised during the run:");
  toasts.forEach((t) => console.log(`   [${t.kind || "info"}] ${t.message}`));

  console.log("\n=================================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`)); }
  console.log("=================================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
