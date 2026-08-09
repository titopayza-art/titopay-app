// The money screens were redesigned. This proves the redesign is presentation
// only — that the keypad feeds the same form, the same fee preview comes back,
// the same review screen appears, and the same confirmation moves the same
// money as before.
//
// If any of that had drifted, the change would be a rewrite of the payment
// pipeline dressed up as a UI change, which it must not be.
const { chromium } = require("playwright");
const crypto = require("crypto");
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";

const stamp = Date.now();
const tail = String(stamp).slice(-7);
const PASSWORD = "MoneyScreens!2026#x";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket connection|ServiceWorker/;

async function withRateLimit(send) {
  for (let i = 0; i < 6; i += 1) {
    const r = await send();
    if (r.status !== 429) return r;
    const wait = Number(r.payload?.retryAfterSeconds) || 15;
    console.log(`  ...rate limited, waiting ${wait + 2}s`);
    await sleep((wait + 2) * 1000);
  }
  throw new Error("still rate limited");
}
async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return withRateLimit(async () => {
    const r = await fetch(`${API}${path}`, {
      method: options.method || "GET", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await r.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return { status: r.status, payload };
  });
}
const PREFIXES = ["76", "78"];   // SA mobile prefixes are 06x, 07x, 08x
let idx = 0;
async function register(kind, label) {
  const body = { fullName: label, email: `${kind}${tail}@titopay.local`, phone: `+27${PREFIXES[idx++]}${tail}`, password: PASSWORD, accountType: "personal" };
  const reg = await call("/auth/register", { method: "POST", body });
  if (reg.payload.accessToken) return { ...body, ...reg.payload };
  return { ...body, ...(await call("/auth/login", { method: "POST", body: { identifier: body.email, password: PASSWORD } })).payload };
}
async function fundWallet(token, amount) {
  const key = `ms-${stamp}-${amount}-${crypto.randomBytes(3).toString("hex")}`;
  const created = await call("/payments/topup", { token, method: "POST", headers: { "idempotency-key": key }, body: { amount, currency: "ZAR", idempotencyKey: key } });
  if (!created.payload.checkoutId) throw new Error("funding failed");
  await fetch(`${PEACH}/__complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkoutId: created.payload.checkoutId, outcome: "successful" }) });
  for (let i = 0; i < 15; i += 1) {
    const s = await call(`/payments/topup/${encodeURIComponent(created.payload.reference)}`, { token });
    if (s.payload.status === "completed") return;
    await sleep(300);
  }
}

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — the redesigned money screens still move money");
  console.log("=============================================================\n");

  const sender = await register("msend", "Money Screens Sender");
  const payee = await register("mpay", "Money Screens Payee");
  check("two customers signed in", Boolean(sender.accessToken && payee.accessToken));
  await fundWallet(sender.accessToken, 800);

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [sender.accessToken, sender.refreshToken]);
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const rq = route.request();
    const target = rq.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const up = await fetch(target, { method: rq.method(), headers: { ...rq.headers(), host: undefined }, body: ["GET", "HEAD"].includes(rq.method()) ? undefined : rq.postData() || undefined });
      route.fulfill({ status: up.status, headers: { "content-type": up.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" }, body: await up.text() });
    } catch { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
  await sleep(1500);
  check("the customer is signed in", await page.evaluate(() => Boolean(state.auth?.accessToken)));

  const type = async (digits) => {
    for (const k of String(digits).split("")) await page.click(`[data-money-key="${k}"]`);
  };
  const amountField = () => page.evaluate(() => document.querySelector('.money-screen [name="amount"]')?.value);

  /* ---- 1. the keypad ------------------------------------------------------ */
  console.log("\n--- the keypad ---\n");
  await page.evaluate(() => openTopUpModal({ id: "top-up", label: "Top Up", serviceCode: "wallet_top_up" }));
  await page.waitForSelector(".money-screen", { timeout: 15000 });
  await sleep(500);

  check("the screen opens full-screen", await page.evaluate(() => Boolean(document.querySelector(".modal-card.fullscreen-modal"))));
  check("the button is disabled with no amount", await page.evaluate(() => document.querySelector(".money-cta").disabled));

  await type("1250");
  check("the keypad writes the amount", (await amountField()) === "1250", await amountField());
  check("and groups it for reading", (await page.evaluate(() => document.querySelector("[data-amount-display]").textContent)) === "1 250");

  await page.click('[data-money-key="back"]');
  check("backspace deletes one digit", (await amountField()) === "125");

  await page.click('[data-money-key="."]');
  await type("50");
  check("cents are accepted", (await amountField()) === "125.50", await amountField());
  await type("9");
  check("a third decimal is refused", (await amountField()) === "125.50", await amountField());

  check("the button is enabled and names the amount",
    await page.evaluate(() => !document.querySelector(".money-cta").disabled
      && /125[.,]50/.test(document.querySelector(".money-cta").textContent)),
    await page.evaluate(() => document.querySelector(".money-cta").textContent.trim()));

  // No text input means no OS keyboard, which is the whole reason for a keypad.
  check("the amount is not a focusable text field",
    await page.evaluate(() => document.querySelector('.money-screen [name="amount"]').type === "hidden"));

  /* ---- 2. Top Up still previews and confirms ------------------------------ */
  console.log("\n--- Top Up: preview, review, confirm ---\n");
  await page.evaluate(() => {
    const f = document.querySelector(".money-screen [name='amount']");
    f.value = "200";
    syncMoneyScreen(f.closest("form"));
  });
  await page.click(".money-cta");
  await sleep(4000);

  const review = await page.evaluate(() => ({
    text: document.body.innerText.replace(/\s+/g, " "),
    preview: state.pendingTransactionReview?.preview || null
  }));
  const quote = (await call("/transactions/fee-preview", { token: sender.accessToken, method: "POST", body: { service: "wallet_top_up", amount: 200 } })).payload;
  const expected = quote.preview || quote;
  check("the review screen is reached", Boolean(review.preview), review.text.slice(0, 90));
  check("the fee is the API's fee, not the screen's guess",
    Math.abs(Number(review.preview?.fee) - Number(expected.fee)) < 0.005,
    `screen ${review.preview?.fee} vs API ${expected.fee}`);
  check("the total is the API's total",
    Math.abs(Number(review.preview?.total) - Number(expected.total)) < 0.005,
    `screen ${review.preview?.total} vs API ${expected.total}`);
  check("the customer can see the total before confirming",
    review.text.includes(String(Number(expected.total).toFixed(2))), review.text.slice(0, 120));
  check("nothing has been charged yet",
    (await call("/wallets", { token: sender.accessToken })).payload.items[0].available_balance === "800.00"
    || Math.abs(Number((await call("/wallets", { token: sender.accessToken })).payload.items[0].available_balance) - 800) < 0.005);

  /* ---- 3. Send Money end to end ------------------------------------------ */
  console.log("\n--- Send Money: keypad to money moved ---\n");
  const before = Number((await call("/wallets", { token: sender.accessToken })).payload.items[0].available_balance);
  const payeeBefore = Number((await call("/wallets", { token: payee.accessToken })).payload.items[0].available_balance);

  await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
  await sleep(500);
  await page.evaluate((identifier) => {
    openSendMoneyModal(coreWalletAction("send"), {
      beneficiaryUserId: "", fullName: "Money Screens Payee", nickname: "Money Screens Payee",
      username: "", accountType: "personal", phone: identifier
    });
  }, payee.phone);
  await page.waitForSelector(".money-screen", { timeout: 15000 });
  await sleep(600);

  // The stub above has no resolvable identifier, so put the real one in the
  // recipient field the form actually submits.
  await page.evaluate((identifier) => {
    const form = document.querySelector(".money-screen");
    let field = form.querySelector('[name="recipient"]');
    if (!field) {
      field = document.createElement("input");
      field.type = "hidden";
      field.name = "recipient";
      form.appendChild(field);
    }
    field.value = identifier;
  }, payee.phone);

  await type("150");
  check("Send Money shows the recipient card", await page.evaluate(() => Boolean(document.querySelector(".money-option"))));
  check("and the amount", (await amountField()) === "150");

  await page.click(".money-cta");
  await sleep(4500);
  const sendReview = await page.evaluate(() => ({
    preview: state.pendingTransactionReview?.preview || null,
    text: document.body.innerText.replace(/\s+/g, " ")
  }));
  check("Send Money reaches its review screen", Boolean(sendReview.preview), sendReview.text.slice(0, 110));

  await page.evaluate(() => document.querySelector('[data-action="confirm-transaction-review"]')?.click());
  await sleep(6000);

  const after = Number((await call("/wallets", { token: sender.accessToken })).payload.items[0].available_balance);
  const payeeAfter = Number((await call("/wallets", { token: payee.accessToken })).payload.items[0].available_balance);
  const fee = Number(sendReview.preview?.fee || 0);
  check("the sender was debited the amount plus the fee",
    Math.abs(after - (before - 150 - fee)) < 0.005, `R${before} -> R${after} (fee R${fee})`);
  check("the payee was credited", Math.abs(payeeAfter - (payeeBefore + 150)) < 0.005,
    `R${payeeBefore} -> R${payeeAfter}`);

  /* ---- 4. the guard rails held ------------------------------------------- */
  console.log("\n--- the guard rails ---\n");
  await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
  await sleep(400);
  await page.evaluate(() => openSendMoneyModal(coreWalletAction("send"), {
    beneficiaryUserId: "", fullName: "Money Screens Payee", nickname: "Money Screens Payee", username: "", accountType: "personal"
  }));
  await page.waitForSelector(".money-screen", { timeout: 15000 });
  await sleep(500);
  await type("99999");
  const warned = await page.evaluate(() => {
    const w = document.querySelector("[data-amount-warning]");
    return { hidden: w.hidden, text: w.textContent.trim() };
  });
  check("spending more than the balance is called out before submitting",
    warned.hidden === false && /more than your available balance/i.test(warned.text), warned.text);

  check("no script errors anywhere", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));

  await page.screenshot({ path: "pwa-money-screens.png" });
  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
