"use strict";
// THE DIALOG IS NOW THE ONLY THING STANDING BETWEEN A TAP AND A PAYMENT.
//
// Two money paths ask before they proceed, and both are written as
//   if (somethingIsWrong && await askToConfirm(...)) { ...charge anyway... }
//   else throw error;
// - selling stock the business does not have (oversell), and
// - a TitoKids payment over the parent's limit.
// A cancel MUST come back false so the throw runs and nothing is charged. If
// the dialog ever resolved a truthy object, or resolved twice, or resolved on
// Escape with anything other than false, money would move that nobody agreed
// to. That is what this harness holds.
//
//   node verification/dialog-contract.js       (exits non-zero on any failure)

const http = require("http"); const fs = require("fs"); const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");
const ROOT = path.join(__dirname, "..", "pwa");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]); if (rel === "/") rel = "/index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
let failures = 0;
const check = (name, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(1300);

  const ask = async (kind, act) => {
    await page.evaluate((k) => {
      window.__r = undefined;
      (k === "confirm" ? window.askToConfirm({ title: "T", body: "B", confirmLabel: "Yes" })
                       : window.askForValue({ title: "T", body: "B", value: "12" })).then((v) => { window.__r = v; });
    }, kind);
    await page.waitForTimeout(250);
    await act();
    await page.waitForTimeout(300);
    return page.evaluate(() => window.__r);
  };

  console.log("--- askToConfirm must resolve strictly true/false ---");
  check("confirm button", await ask("confirm", () => page.click("[data-dialog-confirm]")), true);
  check("cancel button", await ask("confirm", () => page.click("[data-dialog-cancel]")), false);
  check("Escape key", await ask("confirm", () => page.keyboard.press("Escape")), false);
  check("tap outside", await ask("confirm", () => page.click(".tp-dialog-layer", { position: { x: 5, y: 5 } })), false);

  console.log("\n--- askForValue: a cancel is null, an empty answer is still an answer ---");
  check("typed value", await ask("value", async () => { await page.fill("[data-dialog-input]", "18"); await page.click("[data-dialog-confirm]"); }), "18");
  check("cleared then confirmed", await ask("value", async () => { await page.fill("[data-dialog-input]", ""); await page.click("[data-dialog-confirm]"); }), "");
  check("cancelled", await ask("value", () => page.click("[data-dialog-cancel]")), null);
  check("Enter submits", await ask("value", async () => { await page.fill("[data-dialog-input]", "7"); await page.keyboard.press("Enter"); }), "7");

  console.log("\n--- the layer must never be left behind ---");
  check("no layer after all of the above", await page.evaluate(() => document.querySelectorAll(".tp-dialog-layer").length), 0);
  check("body has no leftover listener state (dialog reopens cleanly)",
    await ask("confirm", () => page.click("[data-dialog-confirm]")), true);
  check("still no layer", await page.evaluate(() => document.querySelectorAll(".tp-dialog-layer").length), 0);

  console.log("\npage errors:", errors.length ? errors : "none");
  if (errors.length) failures++;
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL DIALOG CONTRACT CHECKS PASSED");
  await browser.close(); server.close();
  process.exit(failures ? 1 : 0);
})();
