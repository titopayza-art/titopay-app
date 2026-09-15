"use strict";
// THE APP FELT JUMPY. THESE ARE THE TWO REASONS, HELD DOWN.
//
// 1. Almost every sheet refreshes by calling openModal again with new HTML.
//    That tears out the old card and builds a new one, so the scroll position
//    went to the top after every save, toggle or delete. openModal now carries
//    the position across when the heading is the same sheet.
// 2. attachAuthKeyboardBehavior scrolled the card back to the top whenever a
//    field lost focus. It was written for the one-screen sign-in panel but was
//    attached to EVERY sheet containing an input, so dismissing the keyboard
//    on a long form threw the person back to the start.
//
//   CHROMIUM_PATH=... node verification/no-jump.js     (exits non-zero on a jump)

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
let bad = 0;
const check = (name, actual, expected) => {
  const ok = Object.is(actual, expected); if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} → ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 430, height: 780 } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(1200);

  // The field sits LOW in the sheet on purpose: focusing a field that is above
  // the current scroll position legitimately scrolls up to show it, which would
  // make this test lie.
  const sheet = (heading, withInput) => `
    <div class="modal-head"><p class="eyebrow">TEST</p><h2>${heading}</h2></div>
    ${Array.from({ length: 40 }, (_, i) => `<p style="padding:14px 0">row ${i}</p>`).join("")}
    ${withInput ? '<div class="field"><label>Amount</label><input name="amount"></div>' : ""}
    ${withInput ? Array.from({ length: 10 }, (_, i) => `<p style="padding:14px 0">tail ${i}</p>`).join("") : ""}`;

  console.log("--- a sheet that re-renders itself keeps your place ---");
  await page.evaluate((html) => window.openModal(html), sheet("Limits and controls", false));
  await page.waitForTimeout(300);
  console.log("  scrollers:", JSON.stringify(await page.evaluate(() => {
    const out = {};
    for (const sel of [".modal-backdrop", ".modal-card"]) {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el);
      out[sel] = { overflowY: cs.overflowY, clientH: el.clientHeight, scrollH: el.scrollHeight, canScroll: el.scrollHeight > el.clientHeight };
    }
    return out;
  })));
  await page.evaluate(() => { document.querySelector(".modal-card").scrollTop = 420; });
  await page.waitForTimeout(150);
  console.log("  after setting 420:", await page.evaluate(() => document.querySelector(".modal-card").scrollTop));
  await page.evaluate((html) => window.openModal(html), sheet("Limits and controls", false));
  await page.waitForTimeout(300);
  check("same sheet re-rendered", await page.evaluate(() => document.querySelector(".modal-card").scrollTop), 420);

  await page.evaluate((html) => window.openModal(html), sheet("A different screen", false));
  await page.waitForTimeout(300);
  check("a different sheet starts at the top", await page.evaluate(() => document.querySelector(".modal-card").scrollTop), 0);

  console.log("\n--- dismissing the keyboard no longer jumps to the top ---");
  await page.evaluate((html) => window.openModal(html), sheet("Pay for a need", true));
  await page.waitForTimeout(300);
  // Scroll to the field, focus it, then dismiss the keyboard.
  await page.evaluate(() => {
    const input = document.querySelector(".modal-card input[name=amount]");
    input.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.focus(".modal-card input[name=amount]");
  await page.waitForTimeout(250);
  const atFocus = await page.evaluate(() => document.querySelector(".modal-card").scrollTop);
  await page.evaluate(() => document.querySelector(".modal-card input[name=amount]").blur());
  await page.waitForTimeout(600);
  const afterBlur = await page.evaluate(() => document.querySelector(".modal-card").scrollTop);
  console.log(`  scroll at focus ${atFocus}, after dismissing ${afterBlur}`);
  check("the sheet stays where it was", afterBlur > 0 && Math.abs(afterBlur - atFocus) < 40, true);

  console.log("\npage errors:", errors.length ? errors : "none");
  if (errors.length) bad++;
  console.log(bad ? `\n${bad} FAILURE(S)` : "\nNO JUMPS");
  await browser.close(); server.close();
  process.exit(bad ? 1 : 0);
})();
