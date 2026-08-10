// The review screen said "Amount / TitoPay fee / Total debit / Recipient
// amount". All true, all ambiguous: it never said which of those numbers the
// customer ends up with. On a withdrawal the total LEAVES the wallet and the
// amount ARRIVES at the bank; on a top up the total is charged and the amount
// arrives in the wallet. Same four labels, opposite meanings.
//
// This drives the real Top Up and Withdraw forms to their review screens in a
// browser and reads what is actually on the glass.
const { chromium } = require("playwright");

const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";
const stamp = Date.now();

const USER = {
  fullName: "Fee Clarity Tester",
  email: `fees${stamp}@titopay.local`,
  phone: `+2786${String(stamp).slice(-7)}`,
  password: "FeeClarity!2026#x",
  accountType: "personal"
};

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function apiCall(path, body, token, headers = {}) {
  const r = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}
const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();

// Real money in, through the real top-up path, completed at the Peach mock.
async function fundWallet(token, amount) {
  const key = `fee-fund-${stamp}-${amount}`;
  const created = await apiCall("/payments/topup", { amount, currency: "ZAR", idempotencyKey: key }, token, { "idempotency-key": key });
  if (!created.payload.checkoutId) throw new Error(`funding failed: ${JSON.stringify(created.payload).slice(0, 160)}`);
  await fetch(`${PEACH}/__complete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkoutId: created.payload.checkoutId, outcome: "successful" })
  });
  for (let i = 0; i < 20; i += 1) {
    const st = await apiCall(`/payments/topup/${encodeURIComponent(created.payload.reference)}`, null, token);
    if (st.payload.status === "completed") return;
    await sleep(400);
  }
  throw new Error("funding never completed");
}

(async () => {
  console.log("\n=================================================================");
  console.log("  PWA — IS THE FEE BREAKDOWN ACTUALLY CLEAR?");
  console.log("=================================================================\n");

  await apiCall("/auth/register", USER);
  const login = await apiCall("/auth/login", { identifier: USER.email, password: USER.password });
  const token = login.payload.accessToken;
  check("test customer ready", Boolean(token));

  await fundWallet(token, 1000);
  const account = await apiCall("/payouts/bank-accounts", {
    accountHolder: "Fee Clarity Tester", bankName: "FNB", accountNumber: "62771234567",
    branchCode: "250655", accountType: "cheque", nickname: "Main"
  }, token);
  check("wallet funded and a payout account saved", account.status < 300, `HTTP ${account.status}`);

  // What the server says these cost. Every number on the screen has to match
  // these exactly — the screen must never do its own arithmetic.
  const topupQuote = (await apiCall("/transactions/fee-preview", { service: "wallet_top_up", amount: 200 }, token)).payload;
  const withdrawQuote = (await apiCall("/transactions/fee-preview", { service: "withdraw", amount: 100 }, token)).payload;
  const tp = topupQuote.preview || topupQuote;
  const wd = withdrawQuote.preview || withdrawQuote;
  console.log(`  [server quotes] top up ${tp.amount}+${tp.fee}=${tp.total} · withdraw ${wd.amount}+${wd.fee}=${wd.total}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 940 } });
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: undefined },
        body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
      });
      route.fulfill({
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" },
        body: await upstream.text()
      });
    } catch (error) { route.abort(); }
  });
  // Nothing may actually reach Peach in this spec — it only ever looks at
  // review screens, and never presses Confirm.
  const peachHits = [];
  await ctx.route("http://127.0.0.1:4400/**", (route) => { peachHits.push(route.request().url()); route.fulfill({ status: 204, body: "" }); });

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([t, r]) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: t, refreshToken: r }));
  }, [token, login.payload.refreshToken]);
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check("PWA session established", await page.evaluate(() => Boolean(state.auth && state.auth.accessToken)));

  const panelText = async () => flat(await page.evaluate(() => {
    const panel = document.querySelector(".cost-breakdown");
    return panel ? panel.innerText : "(no cost-breakdown panel on screen)";
  }));

  /* ============================================================== TOP UP */
  await page.evaluate(() => openTopUpModal({ id: "top-up", label: "Top Up", serviceCode: "wallet_top_up" }));
  await page.waitForTimeout(900);
  for (const key of "200".split("")) await page.click(`[data-money-key="${key}"]`);
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForSelector(".cost-breakdown", { timeout: 15000 });
  const topup = await panelText();
  console.log(`\n  TOP UP REVIEW PANEL:\n    ${topup.replace(/ (Top up amount|TitoPay|Total to pay|R\d)/g, "\n    $1")}\n`);

  check("top up says what the amount is for", /Top up amount/i.test(topup), topup.slice(0, 60));
  check("top up names the fee as a top up fee", /TitoPay top up fee/i.test(topup));
  check("top up calls the charge a total to pay, not a debit", /Total to pay/i.test(topup) && !/Total debit/i.test(topup));
  check("top up spells out what lands in the wallet", /will be added to your wallet/i.test(topup));
  check("top up numbers are the server's, exactly",
    topup.includes(String(tp.amount.toFixed(2))) && topup.includes(String(tp.fee.toFixed(2))) && topup.includes(String(tp.total.toFixed(2))),
    `expected ${tp.amount.toFixed(2)} / ${tp.fee.toFixed(2)} / ${tp.total.toFixed(2)}`);
  await page.screenshot({ path: "pwa-fees-topup.png" });

  await page.evaluate(() => closeModal());
  await page.waitForTimeout(700);

  /* ============================================================ WITHDRAW */
  await page.evaluate(() => openWithdrawModal({ id: "withdraw", label: "Withdraw", serviceCode: "withdraw" }));
  await page.waitForTimeout(1800);
  await page.fill('[name="amount"]', "100");
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForSelector(".cost-breakdown", { timeout: 15000 });
  const withdraw = await panelText();
  console.log(`\n  WITHDRAWAL REVIEW PANEL:\n    ${withdraw.replace(/ (Withdrawal amount|TitoPay|Total deducted|You)/g, "\n    $1")}\n`);

  check("withdrawal says what the amount is for", /Withdrawal amount/i.test(withdraw), withdraw.slice(0, 60));
  check("withdrawal names the fee as a withdrawal fee", /TitoPay withdrawal fee/i.test(withdraw));
  check("withdrawal calls the charge a total deducted", /Total deducted/i.test(withdraw));
  check("withdrawal spells out what the customer actually receives", /You’ll receive .* in your bank account/i.test(withdraw));
  check("withdrawal numbers are the server's, exactly",
    withdraw.includes(String(wd.amount.toFixed(2))) && withdraw.includes(String(wd.fee.toFixed(2))) && withdraw.includes(String(wd.total.toFixed(2))),
    `expected ${wd.amount.toFixed(2)} / ${wd.fee.toFixed(2)} / ${wd.total.toFixed(2)}`);
  check("the received amount and the deducted total are shown as different numbers",
    wd.total !== wd.amount && withdraw.includes(wd.amount.toFixed(2)) && withdraw.includes(wd.total.toFixed(2)),
    `receives ${wd.amount.toFixed(2)}, loses ${wd.total.toFixed(2)}`);
  const withdrawScreen = flat(await page.evaluate(() => document.querySelector(".modal, .modal-card, body").innerText));
  check("the screen no longer shows the service code as a destination",
    !/Destination withdraw\b/i.test(withdrawScreen) && /Paying out to/i.test(withdrawScreen),
    withdrawScreen.slice(0, 80));
  check("the money lines are stated once, not twice",
    (withdrawScreen.match(/Withdrawal amount/gi) || []).length === 1,
    `${(withdrawScreen.match(/Withdrawal amount/gi) || []).length} occurrence(s)`);
  await page.screenshot({ path: "pwa-fees-withdraw.png" });

  /* =========================================== nothing may have happened */
  const walletNow = Number(((await apiCall("/wallets", null, token)).payload.items || [])[0]?.available_balance ?? NaN);
  check("looking at review screens moved no money", walletNow === 1000, `R${walletNow}`);
  check("nothing was sent to Peach", peachHits.length === 0, `${peachHits.length} call(s)`);

  const HARNESS_NOISE = /frame-ancestors|chat\/socket|maintenance\/public|401 \(Unauthorized\)/i;
  const scriptErrors = consoleErrors.filter((line) => !HARNESS_NOISE.test(line));
  check("no script errors on either screen", scriptErrors.length === 0, scriptErrors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=================================================================`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`=================================================================\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
