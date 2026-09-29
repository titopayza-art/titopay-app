// Drive the staff "Take a sale" screen on a phone-sized viewport and look at it.
//
// The report was a screenshot: the sheet had a text field, the OS keyboard was
// up, the generated QR had been pushed somewhere behind it, and content was
// showing through underneath. This reproduces that state rather than reasoning
// about it — including the keyboard, simulated the only way a headless browser
// can simulate one: by taking the bottom off the viewport, which is exactly
// what iOS does to the visual viewport when the keyboard opens.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = "/home/user/titopay-app/pwa";
const PORT = 8124;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] || "/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/staff-sell";

// iPhone 14 Pro, and the same screen with a keyboard eating the bottom.
const PHONE = { width: 393, height: 852 };
const KEYBOARD = { width: 393, height: 852 - 336 };

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };
function startServer() {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(PWA, clean === "/" ? "index.html" : clean);
    if (!file.startsWith(PWA)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

// A 1x1 gif standing in for the QR image the server mints.
const QR = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

function stub(page) {
  return page.route("**/api.titopay.co.za/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    let body = { ok: true };
    if (p === "/v1/auth/me") body = { ok: true, user: { id: "u1", fullName: "Staff Member", username: "staffer", accountType: "personal", status: "active" } };
    else if (p === "/v1/wallets") body = { ok: true, wallets: [] };
    else if (p === "/v1/transactions") body = { ok: true, transactions: [] };
    else if (p === "/v1/staff-workspace/workplaces") {
      body = { ok: true, items: [{ businessUserId: "biz-1", businessName: "TitoPay", role: "Cashier", since: "2026-06-01" }] };
    } else if (/\/products$/.test(p)) {
      body = { ok: true, items: [
        { id: "p1", name: "Merch - T shirt", price: 200, status: "active" },
        { id: "p2", name: "Cap", price: 120, status: "active" },
        { id: "p3", name: "Hoodie", price: 450, status: "active" }
      ] };
    } else if (/\/sale$/.test(p)) {
      body = { ok: true, sale: { total: 200, reference: "TP-9152641376",
        businessName: "TitoPay", qr: { imageDataUrl: QR, qrId: "ee0f42c4-8645-4117-806f-2b1c9a77d310" } } };
    }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function shot(page, name, note) {
  await page.screenshot({ path: `${OUT}-${name}.png` });
  const m = await page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    const backdrops = document.querySelectorAll(".modal-backdrop").length;
    const doc = document.documentElement;
    return {
      backdrops,
      cardClasses: card ? card.className : "(no modal)",
      // Does the page behind the sheet still scroll?
      bodyPosition: getComputedStyle(document.body).position,
      pageScrollable: doc.scrollHeight > window.innerHeight + 1,
      // Is the sheet's own content taller than the sheet, i.e. does the till
      // need scrolling to reach its primary action?
      cardScrolls: card ? card.scrollHeight > card.clientHeight + 1 : false,
      cardOverflow: card ? Math.max(0, card.scrollHeight - card.clientHeight) : 0,
      // The control that has to be reachable.
      submitVisible: (() => {
        const btn = document.querySelector(".modal-card button[type=submit], .modal-card [data-action='merchant-generate-qr'], .modal-card [data-action='staff-generate-qr']");
        if (!btn) return "(no primary action)";
        const r = btn.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight ? "on screen" : `OFF SCREEN (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)}, viewport ${window.innerHeight})`;
      })(),
      // A text field is what summons the OS keyboard in the first place.
      textInputs: document.querySelectorAll(".modal-card input:not([type=hidden])").length
    };
  });
  console.log(`\n${name}${note ? "  — " + note : ""}`);
  console.log(`  card              ${m.cardClasses}`);
  console.log(`  stacked backdrops ${m.backdrops}`);
  console.log(`  body position     ${m.bodyPosition}   page scrollable behind: ${m.pageScrollable}`);
  console.log(`  sheet scrolls     ${m.cardScrolls}  (${m.cardOverflow}px hidden)`);
  console.log(`  primary action    ${m.submitVisible}`);
  console.log(`  text inputs       ${m.textInputs}${m.textInputs ? "  <- these raise the OS keyboard" : "  (keypad only, no OS keyboard)"}`);
  return m;
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await stub(page);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "a", refreshToken: "r" }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  });
  await page.goto(ORIGIN + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  // Opened through the real path: My Workplaces fetches the list and sets the
  // state itself, then the cashier taps "Take a sale". `state` is a const so it
  // is not on window — driving the UI is both more faithful and the only way in.
  await page.evaluate(() => window.openMyWorkplacesModal());
  await page.waitForTimeout(900);
  await page.click('[data-action^="staff-sell:"]');
  await page.waitForTimeout(1000);
  await shot(page, "1-opened", "the sheet as it opens");

  // Tap a product, the way a cashier does.
  const product = await page.$(".modal-card [data-wsale-add], .modal-card [data-wsale-picker] button");
  if (product) { await product.click(); await page.waitForTimeout(300); }

  // The keyboard comes up when the amount field takes focus. Simulated by
  // taking the bottom off the viewport, which is what iOS does.
  const amount = await page.$(".modal-card input:not([type=hidden])");
  if (amount) {
    await amount.focus();
    await page.setViewportSize(KEYBOARD);
    await page.waitForTimeout(500);
    await shot(page, "2-keyboard", "amount field focused, keyboard up");
  }

  // Generate the QR, which is where the report says it fell apart.
  const submit = await page.$(".modal-card button[type=submit], .modal-card [data-action='merchant-generate-qr'], .modal-card [data-action='staff-generate-qr']");
  if (submit) {
    await submit.click({ force: true });
    await page.waitForTimeout(1200);
    await shot(page, "3-qr", "after the QR is generated, keyboard still up");
  }

  await browser.close();
  server.close();
  console.log(`\nscreenshots: ${OUT}-1-opened.png, ${OUT}-2-keyboard.png, ${OUT}-3-qr.png`);
})();
