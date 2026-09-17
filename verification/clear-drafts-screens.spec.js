// CLEARING A DRAFT, ON A REAL PHONE SCREEN.
//
// The API tests prove the rules. What they cannot prove is the half a customer
// actually touches, and for a DESTRUCTIVE action that half carries most of the
// risk:
//
//   1. the button is not offered where it would only ever be refused;
//   2. it asks first, and saying no changes NOTHING - no request goes out;
//   3. saying yes sends the right method to the right path, once;
//   4. a refusal from the API reaches the person as the API's own sentence,
//      because that sentence is the only place the reason exists;
//   5. a finalised invoice or quote cannot be cleared from the screen at all.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/clear-drafts-screens.spec.js
//
// PWA_ROOT overrides the app directory so an extracted app.zip is tested
// exactly as it will be deployed.

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

// EVERY REQUEST IS RECORDED, not just the ones a route was written for. The
// point of the "cancel" checks below is that NOTHING went out, and that can
// only be shown by watching the whole conversation rather than one path.
async function openApp(browser, routes = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const sent = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    sent.push({ method: request.method(), path: url.pathname });
    const key = Object.keys(routes).find((candidate) => url.pathname.includes(candidate));
    const body = key ? routes[key] : { ok: true };
    await route.fulfill({
      status: body.__status || 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body)
    });
  });
  await page.goto(`http://127.0.0.1:${global.__port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.openModal === "function", null, { timeout: 15000 });
  await page.evaluate(() => window.saveAuth({ accessToken: "a", refreshToken: "r" }));
  return { context, page, errors, sent };
}

// The confirm sheet is a real dialog with real buttons; it is answered the way
// a finger answers it.
const confirm = (page) => page.click(".tp-dialog [data-dialog-confirm]");
const cancel = (page) => page.click(".tp-dialog [data-dialog-cancel]");

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> clearing a draft");
  console.log("=============================================================\n");

  const server = await serve();
  global.__port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    /* ---- 1. A saved quote draft, which lives only on the device --------- */
    const DRAFTS = [
      { id: "d1", action: "quote", kind: "Quote", status: "draft", number: "",
        customerName: "Thandi Mokoena", issueDate: "2026-09-01", totals: { total: 1200 } },
      { id: "d2", action: "invoice", kind: "Invoice", status: "final", number: "INV-0007",
        customerName: "Sipho Dlamini", issueDate: "2026-08-14", totals: { total: 3400 } }
    ];
    let s = await openApp(browser);
    await s.page.evaluate((drafts) => {
      window.localStorage.setItem("titopay_business_documents_v1", JSON.stringify(drafts));
      state.businessDocuments = drafts;
      window.openBusinessDocumentHistory();
    }, DRAFTS);
    await s.page.waitForSelector(".settings-row", { timeout: 10000 });

    const buttons = await s.page.evaluate(() => ({
      onDraft: Boolean(document.querySelector('[data-document-clear="d1"]')),
      onFinal: Boolean(document.querySelector('[data-document-clear="d2"]'))
    }));
    check("a DRAFT quote offers Clear", buttons.onDraft === true);
    check("A FINALISED INVOICE DOES NOT — it is part of a numbered series",
      buttons.onFinal === false);

    // Saying no must leave the draft exactly where it was.
    await s.page.click('[data-document-clear="d1"]');
    await s.page.waitForSelector(".tp-dialog", { timeout: 5000 });
    await cancel(s.page);
    await s.page.waitForTimeout(150);
    let stored = await s.page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("titopay_business_documents_v1") || "[]").map((d) => d.id));
    check("cancelling the confirm keeps the draft", stored.join(",") === "d1,d2", stored.join(","));

    await s.page.click('[data-document-clear="d1"]');
    await s.page.waitForSelector(".tp-dialog", { timeout: 5000 });
    await confirm(s.page);
    await s.page.waitForTimeout(250);
    stored = await s.page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("titopay_business_documents_v1") || "[]").map((d) => d.id));
    check("confirming removes the draft from the device", stored.join(",") === "d2", stored.join(","));
    check("AND LEAVES THE FINALISED DOCUMENT ALONE", stored.includes("d2"));
    check("clearing a local draft talks to no server at all",
      s.sent.every((r) => !/business|documents/.test(r.path)),
      s.sent.map((r) => `${r.method} ${r.path}`).join(", ") || "nothing sent");
    check("no page errors", s.errors.length === 0, s.errors.join(" | "));
    await s.context.close();

    /* ---- 2. A product on the sale screen -------------------------------- */
    // canClear is the API's answer, so the screen is driven by it rather than
    // by anything worked out in the client.
    const PRODUCTS = {
      ok: true,
      items: [
        { id: "p1", name: "Typed twice", category: "Plates", price: 55, trackStock: false,
          stockQuantity: 0, lowStockThreshold: 5, lowStock: false, status: "active", canClear: true },
        { id: "p2", name: "Sold all month", category: "Plates", price: 55, trackStock: true,
          stockQuantity: 12, lowStockThreshold: 5, lowStock: false, status: "active", canClear: false }
      ]
    };
    s = await openApp(browser, { "/v1/business/products": PRODUCTS });
    const rowButtons = await s.page.evaluate((products) => {
      const host = document.createElement("div");
      host.innerHTML = window.renderSalesStockView(products.items);
      return {
        p1: Boolean(host.querySelector('[data-product-clear="p1"]')),
        p2: Boolean(host.querySelector('[data-product-clear="p2"]')),
        // Archive stays on BOTH: clearing never replaces it, it sits beside it.
        archiveOnBoth: Boolean(host.querySelector('[data-product-archive="p1"]'))
          && Boolean(host.querySelector('[data-product-archive="p2"]'))
      };
    }, PRODUCTS);
    check("a product the API says is clearable offers Clear", rowButtons.p1 === true);
    check("ONE WITH SALES BEHIND IT DOES NOT", rowButtons.p2 === false);
    check("and Archive is still offered on both — Clear did not replace it",
      rowButtons.archiveOnBoth === true);

    // Pressing it asks first, and saying no sends nothing.
    await s.page.evaluate((products) => {
      state.businessProducts = products.items;
      window.openModal(`<div class="modal-head"><h2>Stock</h2></div>${window.renderSalesStockView(products.items)}`);
    }, PRODUCTS);
    await s.page.waitForSelector('[data-product-clear="p1"]', { timeout: 10000 });
    const before = s.sent.length;
    await s.page.click('[data-product-clear="p1"]');
    await s.page.waitForSelector(".tp-dialog", { timeout: 5000 });
    await cancel(s.page);
    await s.page.waitForTimeout(200);
    check("cancelling sends no request at all",
      s.sent.length === before, s.sent.slice(before).map((r) => `${r.method} ${r.path}`).join(", "));

    await s.page.click('[data-product-clear="p1"]');
    await s.page.waitForSelector(".tp-dialog", { timeout: 5000 });
    await confirm(s.page);
    await s.page.waitForTimeout(400);
    check("confirming sends exactly one DELETE for that product",
      s.sent.filter((r) => r.method === "DELETE" && r.path.endsWith("/v1/business/products/p1")).length === 1,
      s.sent.slice(before).map((r) => `${r.method} ${r.path}`).join(", "));
    check("no page errors", s.errors.length === 0, s.errors.join(" | "));
    await s.context.close();

    /* ---- 3. A TitoPro listing, and the API's refusal reaching the screen  */
    // The refusal is the only place the reason exists - a job already sent, a
    // takedown - so it must arrive verbatim rather than as "something failed".
    // Shaped the way middleware/error-handler.js actually shapes a refusal:
    // `error` carries the sentence and `details` the machine-readable code. My
    // first version of this fixture put the sentence under `message`, which the
    // app does not read - so the harness reported a failure and the app was
    // right. Getting the fixture wrong in the same direction twice is exactly
    // what the key names below are here to prevent.
    const REFUSAL = {
      __status: 409, ok: false,
      error: "This listing cannot be cleared because a customer has sent you a job through it. "
        + "Pause it instead, which takes it off TitoPro and keeps your work.",
      details: { code: "not_a_draft", reasons: ["a customer has sent you a job through it"] }
    };
    s = await openApp(browser, { "/v1/titopro/me/listing": REFUSAL });
    const refusal = await s.page.evaluate(async () => {
      const said = [];
      const realToast = window.showToast;
      window.showToast = (text, tone) => { said.push(`${tone || "info"}: ${text}`); return realToast(text, tone); };
      const before = window.askToConfirm;
      window.askToConfirm = async () => true;
      try {
        await window.clearTitoProListing();
      } catch (error) {
        said.push(`threw: ${error.message}`);
      }
      window.askToConfirm = before;
      window.showToast = realToast;
      return said;
    });
    check("the API's own refusal is what the person is shown",
      refusal.some((line) => /a customer has sent you a job through it/.test(line)),
      refusal.join(" | ").slice(0, 120));
    check("and it is shown as an error, not as a success",
      refusal.some((line) => /^error: /.test(line)), refusal.join(" | ").slice(0, 80));
    check("the clear is sent as DELETE to the listing itself",
      s.sent.some((r) => r.method === "DELETE" && r.path.endsWith("/v1/titopro/me/listing")),
      s.sent.map((r) => `${r.method} ${r.path}`).join(", "));
    check("no page errors", s.errors.length === 0, s.errors.join(" | "));
    await s.context.close();

    /* ---- 4. A stokvel group: the button only where it can work ---------- */
    const asksAbout = await (async () => {
      const probe = await openApp(browser);
      const verdicts = await probe.page.evaluate(() => ({
        // The chair of an empty group: offered.
        empty: window.stockvelLooksLikeDraft({ canManage: true, memberCount: 1, totalContributed: 0, balance: 0 }),
        // Somebody else has joined: not offered, Close is the answer.
        joined: window.stockvelLooksLikeDraft({ canManage: true, memberCount: 3, totalContributed: 0, balance: 0 }),
        // Money has been contributed: never offered.
        funded: window.stockvelLooksLikeDraft({ canManage: true, memberCount: 1, totalContributed: 500, balance: 500 }),
        // Not the organiser: not theirs to clear.
        member: window.stockvelLooksLikeDraft({ canManage: false, memberCount: 1, totalContributed: 0, balance: 0 }),
        // The screen does not know how many members there are: do not guess.
        unknown: window.stockvelLooksLikeDraft({ canManage: true, totalContributed: 0, balance: 0 })
      }));
      await probe.context.close();
      return verdicts;
    })();
    check("an empty group the organiser started offers Clear", asksAbout.empty === true);
    check("A GROUP SOMEBODY ELSE JOINED DOES NOT", asksAbout.joined === false);
    check("A GROUP WITH MONEY IN IT NEVER DOES", asksAbout.funded === false);
    check("a member who is not the organiser is not offered it", asksAbout.member === false);
    check("an unknown member count is treated as 'do not offer'", asksAbout.unknown === false);

    /* ---- 5. The bin icon is a bin --------------------------------------- */
    // icon() silently falls back to a generic grid square for a name it does
    // not know, so a missing icon looks like a design choice rather than a bug.
    s = await openApp(browser);
    const iconOk = await s.page.evaluate(() => {
      const trash = window.icon("trash");
      const fallback = window.icon("a-name-that-does-not-exist");
      return { differs: trash !== fallback, markup: trash.slice(0, 40) };
    });
    check("icon('trash') draws a bin rather than the generic fallback",
      iconOk.differs === true, iconOk.markup);
    await s.context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
