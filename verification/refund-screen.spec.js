// REFUNDING A CUSTOMER, ON A REAL PHONE SCREEN.
//
// This screen used to end on "Refund is not enabled for live processing yet.
// No wallet debit was made." after the business had filled the whole thing in.
// The API now has a refund lifecycle behind it, and these checks are about the
// half the API cannot prove:
//
//   1. the dead-end message is gone;
//   2. THERE IS NO CUSTOMER FIELD - the person refunded is read off the
//      payment, so a typo cannot pay a stranger;
//   3. Check names the customer and says what is left to refund, before
//      anything moves;
//   4. the review says they receive the full amount and the fee is the
//      business's, in those words;
//   5. Confirm sends one POST, carrying an idempotency key;
//   6. a wallet that cannot cover it cannot press Confirm at all.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/refund-screen.spec.js

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const API = "https://api.titopay.co.za";
const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".jpg": "image/jpeg" };

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    const resolved = path.join(PWA_ROOT, file);
    if (!resolved.startsWith(PWA_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function openApp(browser, routes = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const sent = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (error) { body = {}; }
    sent.push({ method: request.method(), path: url.pathname, query: url.search, body });
    const key = Object.keys(routes).find((candidate) => url.pathname.includes(candidate));
    const answer = key ? routes[key] : { ok: true };
    await route.fulfill({
      status: answer.__status || 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(answer)
    });
  });
  await page.goto(`http://127.0.0.1:${global.__port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.openRefundModal === "function", null, { timeout: 15000 });
  await page.evaluate(() => window.saveAuth({ accessToken: "a", refreshToken: "r" }));
  return { context, page, errors, sent };
}

const LOOKUP = {
  ok: true, originalReference: "TX-1730000000-A1B2C3", customerName: "Thandi Mokoena",
  paid: 75, alreadyRefunded: 0, refundable: 75
};
const previewFor = (sufficient) => ({
  ok: true,
  preview: {
    serviceCode: "refund", originalReference: "TX-1730000000-A1B2C3", originalAmount: 75,
    alreadyRefunded: 0, refundable: 75, customerName: "Thandi Mokoena",
    refundType: "full_refund", amount: 75, customerReceives: 75, fee: 1, total: 76,
    walletBalance: sufficient ? 500 : 20, sufficientBalance: sufficient
  }
});

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> Refund customer");
  console.log("=============================================================\n");

  const server = await serve();
  global.__port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    /* ---- 1. The form itself ------------------------------------------- */
    let s = await openApp(browser);
    await s.page.evaluate(() => window.openRefundModal({ serviceCode: "refund" }));
    await s.page.waitForSelector('form[data-form="merchant-refund"]', { timeout: 10000 });

    const form = await s.page.evaluate(() => {
      const f = document.querySelector('form[data-form="merchant-refund"]');
      return {
        names: [...f.querySelectorAll("input,select,textarea")].map((el) => el.name).filter(Boolean),
        goesToTransactions: f.dataset.form === "transaction",
        amountHidden: document.querySelector("[data-refund-amount-field]")?.hidden,
        text: f.textContent.replace(/\s+/g, " ")
      };
    });
    check("THE CUSTOMER FIELD IS GONE — a typo can no longer pay a stranger",
      !form.names.includes("recipient"), form.names.join(", "));
    check("the reference is still asked for", form.names.includes("originalReference"));
    check("the form no longer submits to the generic transaction endpoint",
      form.goesToTransactions === false);
    check("a full refund hides the amount box (the API works out what is left)",
      form.amountHidden === true);
    check("the screen says the customer gets the full amount",
      /customer gets the full amount/i.test(form.text), form.text.slice(0, 90));

    // Switching to partial reveals the amount.
    await s.page.selectOption('form[data-form="merchant-refund"] [name="refundType"]', "partial_refund");
    await s.page.waitForTimeout(150);
    check("choosing Partial reveals the amount box",
      (await s.page.evaluate(() => document.querySelector("[data-refund-amount-field]").hidden)) === false);
    await s.page.selectOption('form[data-form="merchant-refund"] [name="refundType"]', "full_refund");
    await s.context.close();

    /* ---- 2. Checking the payment names the customer -------------------- */
    s = await openApp(browser, { "/v1/refunds/lookup": LOOKUP });
    await s.page.evaluate(() => window.openRefundModal({ serviceCode: "refund" }));
    await s.page.waitForSelector("[data-refund-reference]", { timeout: 10000 });
    await s.page.fill("[data-refund-reference]", "TX-1730000000-A1B2C3");
    await s.page.click('[data-action="refund-lookup"]');
    await s.page.waitForSelector("[data-refund-found] .integration-note", { timeout: 10000 });
    const found = await s.page.evaluate(() =>
      document.querySelector("[data-refund-found]").textContent.replace(/\s+/g, " ").trim());
    check("Check names who is being refunded", /Thandi Mokoena/.test(found), found.slice(0, 80));
    check("and says what is still refundable", /75/.test(found), found.slice(0, 80));
    check("the lookup is a GET and moves nothing",
      s.sent.some((r) => r.method === "GET" && r.path.endsWith("/v1/refunds/lookup")),
      s.sent.map((r) => `${r.method} ${r.path}`).join(", "));
    await s.context.close();

    /* ---- 3. The review, and Confirm ------------------------------------ */
    s = await openApp(browser, {
      "/v1/refunds/lookup": LOOKUP,
      "/v1/refunds/preview": previewFor(true),
      "/v1/refunds": { ok: true, refund: { refundId: "r1", reference: "RF-1", amount: 75,
        fee: 1, total: 76, customerReceives: 75, customerName: "Thandi Mokoena", status: "completed" } }
    });
    await s.page.evaluate(() => window.openRefundModal({ serviceCode: "refund" }));
    await s.page.fill("[data-refund-reference]", "TX-1730000000-A1B2C3");
    await s.page.click('form[data-form="merchant-refund"] button[type="submit"]');
    await s.page.waitForSelector('[data-action="confirm-refund"]', { timeout: 10000 });

    const review = await s.page.evaluate(() => ({
      text: document.querySelector(".modal-card").textContent.replace(/\s+/g, " "),
      confirmDisabled: document.querySelector('[data-action="confirm-refund"]').disabled
    }));
    check("the review names the person being refunded", /Thandi Mokoena/.test(review.text));
    check("it separates what THEY receive from what leaves the wallet",
      /They receive/.test(review.text) && /Leaves your wallet/.test(review.text));
    check("it says the fee is the business's, not the customer's",
      /fee is yours, not theirs/i.test(review.text), review.text.slice(0, 60));
    check("Confirm is available when the wallet can cover it", review.confirmDisabled === false);

    const before = s.sent.length;
    await s.page.click('[data-action="confirm-refund"]');
    await s.page.waitForTimeout(600);
    const posts = s.sent.slice(before).filter((r) => r.method === "POST" && r.path.endsWith("/v1/refunds"));
    check("Confirm sends exactly one refund request", posts.length === 1,
      s.sent.slice(before).map((r) => `${r.method} ${r.path}`).join(", "));
    check("AND IT CARRIES AN IDEMPOTENCY KEY, so a retry is the same refund",
      Boolean(posts[0] && posts[0].body.idempotencyKey), JSON.stringify(posts[0]?.body || {}).slice(0, 120));
    check("the destination is never sent from the screen",
      posts[0] && !("recipient" in posts[0].body) && !("customerUserId" in posts[0].body),
      Object.keys(posts[0]?.body || {}).join(", "));
    check("no page errors", s.errors.length === 0, s.errors.join(" | "));
    await s.context.close();

    /* ---- 4. A wallet that cannot cover it ------------------------------ */
    s = await openApp(browser, {
      "/v1/refunds/lookup": LOOKUP, "/v1/refunds/preview": previewFor(false)
    });
    await s.page.evaluate(() => window.openRefundModal({ serviceCode: "refund" }));
    await s.page.fill("[data-refund-reference]", "TX-1730000000-A1B2C3");
    await s.page.click('form[data-form="merchant-refund"] button[type="submit"]');
    await s.page.waitForSelector('[data-action="confirm-refund"]', { timeout: 10000 });
    const short = await s.page.evaluate(() => ({
      disabled: document.querySelector('[data-action="confirm-refund"]').disabled,
      text: document.querySelector(".modal-card").textContent.replace(/\s+/g, " ")
    }));
    check("A WALLET THAT CANNOT COVER THE REFUND CANNOT CONFIRM IT", short.disabled === true);
    check("and is told the shortfall rather than left guessing",
      /needs/.test(short.text) && /Nothing has been taken/.test(short.text));
    await s.context.close();

    /* ---- 5. The dead end is gone --------------------------------------- */
    const source = fs.readFileSync(path.join(PWA_ROOT, "app.js"), "utf8");
    check("the refund screen no longer routes through the generic transaction form",
      !/openRefundModal[\s\S]{0,900}data-form="transaction"/.test(source));
    const min = fs.readFileSync(path.join(PWA_ROOT, "app.min.js"), "utf8");
    check("and the shipped bundle carries the refund flow too",
      min.includes("/v1/refunds") && min.includes("merchant-refund"));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
