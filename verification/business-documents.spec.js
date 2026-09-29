// A NUMBERED DOCUMENT SERIES ONLY EVER GOES FORWARDS.
//
// Quote, Invoice and Proforma numbers were derived by counting the finalised
// documents on the device and adding one. That is correct only while the
// device still holds every document it has ever issued, and it does not: the
// list is capped at 40, and iOS evicts a web app's localStorage after a
// stretch of not opening it. Lose the list and the count is zero again, so the
// next quote is numbered 0001 for the second time - two documents, one number,
// which is the single thing a numbered series exists to prevent. It was
// reported as "quotes disappear and the numbers don't change".
//
// Also here because it is the same screen's catalogue: Send Money was seeded
// business_visible = FALSE, so a business account had no tile for paying
// anybody from its own wallet.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/business-documents.spec.js

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

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> business documents and the number series");
  console.log("=============================================================\n");

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${API}/**`, (route) => route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, items: [] }) }));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.nextBusinessDocumentNumber === "function", null, { timeout: 15000 });

    const series = await page.evaluate(() => {
      const out = {};
      state.businessDocuments = [];
      try { localStorage.removeItem("titopay_document_series_v1"); } catch (error) { /* private mode */ }
      out.first = window.nextBusinessDocumentNumber("quote");
      // Finalise three quotes the way the app does it.
      out.issued = [];
      for (let i = 0; i < 3; i += 1) {
        const number = window.nextBusinessDocumentNumber("quote");
        out.issued.push(number);
        window.saveBusinessDocumentDraft({ id: `q${i}`, action: "quote", prefix: "QUO",
          kind: "Quote", status: "final", number, totals: { total: 10 } });
      }
      out.afterThree = window.nextBusinessDocumentNumber("quote");
      // THE FAILURE: the device loses every document.
      state.businessDocuments = [];
      out.afterLosingEverything = window.nextBusinessDocumentNumber("quote");
      // A draft must never burn a number.
      window.saveBusinessDocumentDraft({ id: "d1", action: "quote", prefix: "QUO",
        kind: "Quote", status: "draft", number: "", totals: { total: 10 } });
      out.afterADraft = window.nextBusinessDocumentNumber("quote");
      // Each kind keeps its own series.
      out.invoice = window.nextBusinessDocumentNumber("invoice");
      out.proforma = window.nextBusinessDocumentNumber("proforma-invoice");
      return out;
    });

    check("the series starts at 0001", series.first === "QUO-2026-0001", series.first);
    check("and advances one per finalised document",
      series.issued.join(",") === "QUO-2026-0001,QUO-2026-0002,QUO-2026-0003", series.issued.join(","));
    check("the next number follows the last one issued",
      series.afterThree === "QUO-2026-0004", series.afterThree);
    check("A DEVICE THAT LOSES EVERY DOCUMENT DOES NOT REISSUE A NUMBER",
      series.afterLosingEverything === "QUO-2026-0004",
      `${series.afterLosingEverything} (counting the list would give QUO-2026-0001 again)`);
    check("a draft burns no number", series.afterADraft === "QUO-2026-0004", series.afterADraft);
    check("invoices are their own series", series.invoice === "INV-2026-0001", series.invoice);
    check("and so are proformas", series.proforma.startsWith("PRO-2026-"), series.proforma);
    check("no page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  // SEND MONEY ON A BUSINESS ACCOUNT. Read from the catalogue the app ships,
  // so this fails if the flag is ever set back.
  const catalogue = JSON.parse(fs.readFileSync(path.join(PWA_ROOT, "services-default.json"), "utf8"));
  const items = Array.isArray(catalogue) ? catalogue : catalogue.items || catalogue.services || [];
  const sendMoney = items.find((s) => s.service_code === "send-money");
  check("Send Money is in the catalogue", Boolean(sendMoney));
  check("A BUSINESS ACCOUNT CAN SEE SEND MONEY",
    sendMoney && sendMoney.business_visible === true,
    `business_visible=${sendMoney && sendMoney.business_visible}`);
  check("and a personal account still can",
    sendMoney && sendMoney.personal_visible === true,
    `personal_visible=${sendMoney && sendMoney.personal_visible}`);

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
