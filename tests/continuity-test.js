const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VP = process.argv[2] ? JSON.parse(process.argv[2]) : null;

(async () => {
  const services = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(VP ? { viewport: { width: VP[0], height: VP[1] }, isMobile: VP[0] < 768, hasTouch: VP[0] < 768, deviceScaleFactor: VP[0] < 768 ? 2 : 1 } : devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  let txPosts = 0, registered = true;
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const u = new URL(route.request().url()); const method = route.request().method();
    if (u.pathname === "/v1/transactions" && method === "POST") { txPosts += 1; await sleep(250); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ transaction: { id: "tx-new", reference: "SM-1", status: "completed", amount: 250, total: 251.5 } }) }); }
    if (u.pathname.includes("/recipient/verify")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ registered, user: { fullName: "Naledi Mokoena", username: "naledi", phone: "+27711112222" }, invite: { url: "https://app.titopay.co.za", message: "Join TitoPay" } }) });
    if (u.pathname === "/v1/transactions/fee-preview") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preview: { amount: 250, fee: 1.5, thirdPartyFee: 0, total: 251.5, recipientAmount: 250 } }) });
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = services;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "QA User", username: "qa", accountType: "personal", status: "active", walletId: "81234567", ficaStatus: "approved" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 99999 }] };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(String(e).slice(0, 110)));
  const out = process.env.SHOT_DIR || "tests/artifacts";
  const R = {};

  const openSendMoney = async () => {
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(600);
    await page.click('[data-service="send-money"]');
    await page.waitForTimeout(800);
    await page.fill('.modal-card input[name="recipient"]', "+27711112222");
    await page.fill('.currency-affix input[name="amount"]', "250");
    const ref = await page.$('.modal-card input[name="reference"]');
    if (ref) await ref.fill("Rent July");
  };

  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3500);

  // ---- STEP 1-4: enter -> verify -> state survives -> continue in SAME transaction
  await openSendMoney();
  await page.click('.modal-card [data-action="verify-recipient-field"]');
  await page.waitForTimeout(1300);
  R.afterVerify = await page.evaluate(() => {
    const form = document.querySelector('.modal-card form[data-form="transaction"]');
    return {
      formStillOpen: !!form,
      inlineVerified: !!form?.querySelector("[data-recipient-verify-for]"),
      verifiedText: form?.querySelector(".rv-head")?.textContent.trim(),
      recipient: form?.querySelector('[name="recipient"]')?.value,
      amount: form?.querySelector('[name="amount"]')?.value,
      reference: form?.querySelector('[name="reference"]')?.value,
      submitStillAvailable: !!form?.querySelector('button[type="submit"]')
    };
  });
  await page.screenshot({ path: `${out}/flow-verified-inline.png` });

  // ---- STEP 5: continue -> fee preview -> review with same values
  await page.click('.modal-card form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(2200);
  R.review = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
    return {
      reviewOpen: !!document.querySelector('[data-action="confirm-transaction-review"]'),
      amountRow: rows.find((r) => r.startsWith("Amount")),
      totalRow: rows.find((r) => r.startsWith("Total debit")),
      hasEdit: !!document.querySelector('[data-action="edit-transaction-review"]'),
      hasCancel: !!document.querySelector('[data-action="cancel-transaction-review"]'),
      txPostsSoFar: null
    };
  });
  R.review.txPostsBeforeConfirm = txPosts;
  await page.screenshot({ path: `${out}/flow-review.png` });

  // ---- STEP 6: Edit returns to an editable form with values retained
  await page.click('[data-action="edit-transaction-review"]');
  await page.waitForTimeout(1000);
  R.afterEdit = await page.evaluate(() => {
    const form = document.querySelector(".modal-card form[data-form]");
    return {
      editFormOpen: !!form,
      amount: form?.querySelector('[name="amount"]')?.value,
      recipient: form?.querySelector('[name="recipient"]')?.value
    };
  });

  // ---- STEP 7: confirm completes exactly once
  const backToReview = await page.$('.modal-card form[data-form] button[type="submit"]');
  if (backToReview) { await backToReview.click(); await page.waitForTimeout(2000); }
  const confirm = await page.$('[data-action="confirm-transaction-review"]');
  if (confirm) {
    txPosts = 0;
    await confirm.click();
    await confirm.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2600);
    R.confirm = { posts: txPosts, successShown: await page.evaluate(() => /success|complete|sent/i.test(document.querySelector(".modal-card")?.textContent || "")) };
  }

  // ---- STEP 8: submit-time NOT REGISTERED keeps the transaction alive
  registered = false;
  await page.evaluate(() => { const b = document.querySelector(".modal-card [data-close]"); if (b) b.click(); });
  await page.waitForTimeout(500);
  await openSendMoney();
  await page.click('.modal-card form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(2000);
  R.notRegistered = await page.evaluate(() => {
    const form = document.querySelector('.modal-card form[data-form="transaction"]');
    return {
      formSurvived: !!form,
      inlineNotice: !!form?.querySelector("[data-recipient-not-registered]"),
      amountKept: form?.querySelector('[name="amount"]')?.value,
      recipientKept: form?.querySelector('[name="recipient"]')?.value,
      shareInviteAvailable: !!form?.querySelector("[data-invite-share]")
    };
  });
  R.notRegistered.txPosts = txPosts;
  await page.screenshot({ path: `${out}/flow-not-registered.png` });

  R.pageErrors = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
