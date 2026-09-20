// WHAT THE SHEET DOES WHEN THE SOFTWARE KEYBOARD COMES UP.
//
// Reported from a phone, on the stokvel group chat: the sheet glitches and
// the page behind it scrolls into view under the composer.
//
// Two rules describe the same box and neither knows about the other:
//
//   .keyboard-aware-backdrop.keyboard-open .keyboard-aware-card   (0,3,0)
//     max-height: calc(var(--auth-viewport-height) - ...)
//
//   .modal-backdrop:not(.auth-modal-backdrop) > .modal-card       (0,3,0)
//     height: 100dvh; max-height: 100dvh;
//
// Equal specificity, so the one written later in the file wins - and that is
// the full-screen phone rule. With the keyboard up the backdrop correctly
// shrinks to the visible glass while the card stays a whole screen tall, so
// the card is taller than the box it lives in and stops being scrollable.
// The browser then scrolls something else to reach the focused field.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/sheet-keyboard-height.spec.js

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const API = "https://api.titopay.co.za";
// Two handsets, because the budget is what matters and the small one has
// far less of it: a 667px screen with the keyboard up leaves 367px for a
// sheet that carries a heading, a conversation and a composer.
const DEVICES = [
  { name: "iPhone 15 (393x852)", width: 393, height: 852, keyboard: 336 },
  { name: "iPhone SE (375x667)", width: 375, height: 667, keyboard: 300 }
];

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
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
  console.log("  APP -> a sheet with the keyboard up stays inside the glass");
  console.log("=============================================================\n");

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
   for (const device of DEVICES) {
    console.log(`  ${device.name}`);
    const context = await browser.newContext({ viewport: { width: device.width, height: device.height }, isMobile: true, hasTouch: true,
      deviceScaleFactor: 3, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // A REAL CONVERSATION, NOT AN EMPTY ONE. An empty chat fits in any glass,
    // so it cannot show the defect: the sheet was reported with messages in
    // it, and it is the messages that push the composer out of reach.
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, userId: "u2", name: "Thuso Tshiloane",
      message: `Message number ${i + 1} in the group conversation.`,
      createdAt: "2026-09-20T20:18:00.000Z", isDecision: false
    }));
    await page.route(`${API}/**`, (route) => route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true, items: /\/messages/.test(route.request().url()) ? messages : [] }) }));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.openStockvelChatModal === "function", null, { timeout: 15000 });

    check("the phone reports a coarse pointer", await page.evaluate(() => matchMedia("(pointer: coarse)").matches));

    // THE KEYBOARD, AS THE PAGE SEES IT. A software keyboard is not something
    // Playwright can raise, and it does not need to be: everything the app
    // reacts to arrives through window.visualViewport and its resize event.
    // Shrinking it by the height of a keyboard is the same signal.
    await page.evaluate((keyboard) => {
      const viewport = window.visualViewport;
      const full = viewport.height;
      Object.defineProperty(viewport, "height", { configurable: true, get: () => full - keyboard });
      Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 0 });
      window.__glass = { top: 0, height: full - keyboard };
    }, device.keyboard);

    // `state` is a module-level const, so it is reachable bare in here but is
    // not a property of window.
    await page.evaluate(() => {
      state.stockvel = state.stockvel || {};
      state.stockvel.detail = { id: "g1", name: "Ibiza", canManage: true };
      state.stockvel.groups = [state.stockvel.detail];
      window.openStockvelChatModal("g1");
    });
    await page.waitForSelector(".modal-backdrop .modal-card textarea[name=message]", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-sv-chat] [data-sv-decision]").length >= 12,
      null, { timeout: 8000 });

    await page.evaluate(() => {
      document.querySelector(".modal-card textarea[name=message]").focus();
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    // Two frames: one for the scheduled update, one for the style to land.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const geometry = await page.evaluate(() => {
      const backdrop = document.querySelector(".modal-backdrop");
      const card = document.querySelector(".modal-card");
      const style = getComputedStyle(card);
      return {
        keyboardOpen: backdrop.classList.contains("keyboard-open"),
        keyboardAware: backdrop.classList.contains("keyboard-aware-backdrop"),
        glass: window.__glass,
        backdrop: backdrop.getBoundingClientRect().toJSON(),
        card: card.getBoundingClientRect().toJSON(),
        cardHeight: style.height,
        cardMaxHeight: style.maxHeight,
        scrollable: card.scrollHeight > card.clientHeight + 1,
        scrollHeight: card.scrollHeight,
        clientHeight: card.clientHeight
      };
    });

    console.log(`  glass   ${geometry.glass.height}px tall`);
    console.log(`  backdrop ${Math.round(geometry.backdrop.height)}px, card ${Math.round(geometry.card.height)}px`);
    console.log(`  card computed height=${geometry.cardHeight} max-height=${geometry.cardMaxHeight}`);
    console.log(`  card scrollHeight=${geometry.scrollHeight} clientHeight=${geometry.clientHeight}\n`);

    check("the sheet knows the keyboard is up", geometry.keyboardOpen);
    check("the backdrop shrinks to the visible glass",
      Math.abs(geometry.backdrop.height - geometry.glass.height) <= 2,
      `${Math.round(geometry.backdrop.height)} vs ${geometry.glass.height}`);

    check("THE CARD IS NOT TALLER THAN THE GLASS IT SITS IN",
      geometry.card.height <= geometry.glass.height + 2,
      `card ${Math.round(geometry.card.height)}px in a ${geometry.glass.height}px glass`);

    check("THE CARD CAN STILL BE SCROLLED TO REACH ITS OWN CONTENT",
      geometry.scrollable,
      `scrollHeight ${geometry.scrollHeight} vs clientHeight ${geometry.clientHeight}`);

    // THE POINT OF THE WHOLE THING: the person can reach the box they type in
    // and the button that sends it, without the page behind having to move.
    const reach = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      // The card is set to scroll-behavior: smooth while the keyboard is up,
      // so assigning scrollTop starts an animation and reading it straight
      // back gives the old value. Ask for the jump explicitly.
      card.scrollTo({ top: card.scrollHeight, behavior: "instant" });
      const inGlass = (el) => {
        const box = el.getBoundingClientRect();
        return box.top >= window.__glass.top - 1
          && box.bottom <= window.__glass.top + window.__glass.height + 1;
      };
      const send = [...card.querySelectorAll("button[type=submit]")]
        .find((b) => /send to the group/i.test(b.textContent));
      return {
        composer: inGlass(card.querySelector("textarea[name=message]")),
        send: Boolean(send) && inGlass(send),
        pageMoved: Math.abs(window.scrollY) > 1
      };
    });
    check("the composer can be brought into the visible glass", reach.composer);
    check("SO CAN THE SEND BUTTON", reach.send);
    check("and the page behind never had to scroll to do it", !reach.pageMoved);

    // NOTHING OF THE PAGE BEHIND IS LEFT SHOWING. The scrim is translucent on
    // purpose, so any strip of it left uncovered is the app shell reading
    // through - which is what was reported as the background scrolling.
    check("the sheet covers the glass top to bottom", await page.evaluate(() => {
      const box = document.querySelector(".modal-card").getBoundingClientRect();
      const glass = window.__glass;
      return box.top <= glass.top + 1 && box.bottom >= glass.top + glass.height - 1;
    }));

    check("no page errors", errors.length === 0, errors.join(" | "));
    await context.close();
    console.log("");
   }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
