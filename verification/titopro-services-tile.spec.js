// THE TITOPRO TILE, ON THE SERVICES SCREEN A CUSTOMER ACTUALLY OPENS.
//
// Everything behind TitoPro was built, routed and tested, and the tile was
// still not on the screen. Two separate reasons, neither of which any API test
// could see:
//
//   1. pwa/services-default.json - the catalogue the app fetches and merges
//      with the API's answer - had no titopro entry, so on a slow or failed
//      connection the tile did not exist at all;
//   2. SERVICE_GROUPS did not list it, so it fell through to "More", the
//      unnamed catch-all at the very bottom of the page.
//
// This drives the real app against a stubbed API and asserts the tile is on
// the screen, under the right heading, for BOTH audiences - and that it still
// appears when the catalogue endpoint fails outright, which is the case the
// fallback file exists for.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/titopro-services-tile.spec.js
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

// The API's catalogue, as service-management-service serves it: the TitoPro
// row exactly as DEFAULT_SERVICES declares it.
const CATALOGUE = {
  ok: true,
  items: [
    { service_code: "top-up", service_name: "Top Up", service_icon: "upload", action: "top-up",
      description: "Add money to your TitoPay wallet.", fee: 0, commission: 0, status: "active",
      personal_visible: true, business_visible: true, sort_order: 10, feature_badge: "none" },
    { service_code: "tickets", service_name: "Tickets", service_icon: "ticket", action: "tickets",
      description: "Browse approved TitoPay events.", fee: 0, commission: 0, status: "active",
      personal_visible: true, business_visible: true, sort_order: 185, feature_badge: "new" },
    { service_code: "book", service_name: "Book", service_icon: "calendar", action: "book",
      description: "Book a table, an appointment or a service.", fee: 0, commission: 0, status: "active",
      personal_visible: true, business_visible: true, sort_order: 305, feature_badge: "new" },
    { service_code: "titopro", service_name: "TitoPro", service_icon: "maintenance", action: "titopro",
      description: "Hire a verified plumber, painter, cleaner or bookkeeper, and pay through your wallet.",
      fee: 0, commission: 0, status: "active",
      personal_visible: true, business_visible: true, sort_order: 306, feature_badge: "new" }
  ]
};

async function openServices(browser, { accountType = "personal", catalogueFails = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/services")) {
      // THE CASE THE FALLBACK FILE EXISTS FOR. A 503 here is a customer on a
      // bad connection, and the app has to have a catalogue of its own.
      if (catalogueFails) {
        await route.fulfill({ status: 503, contentType: "application/json",
          headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: false }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(CATALOGUE) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`http://127.0.0.1:${global.__port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.groupedServiceSections === "function", null, { timeout: 15000 });
  // `state` is a module-level const, not a global, so the audience is set
  // through the app's own function rather than by reaching into it.
  await page.evaluate((type) => {
    window.saveAuth({ accessToken: "a", refreshToken: "r" });
    window.switchLandingAccount(type);
  }, accountType);
  await page.evaluate(() => window.loadServices());
  await page.waitForFunction(() => window.visibleServices().length > 0, null, { timeout: 15000 });
  return { context, page, errors };
}

// What a customer sees: every heading, and the tiles under each one.
async function readGrid(page) {
  return page.evaluate(() => {
    const html = window.groupedServiceSections(window.visibleServices().filter((s) => !s.disabled));
    const host = document.createElement("div");
    host.innerHTML = html;
    const sections = [];
    let current = null;
    for (const node of host.children) {
      if (node.classList.contains("section-head")) {
        current = { heading: node.textContent.trim(), tiles: [] };
        sections.push(current);
      } else if (current) {
        current.tiles.push(...[...node.querySelectorAll("[data-service]")]
          .map((el) => el.getAttribute("data-service")));
      }
    }
    return sections;
  });
}

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> TitoPro on the Services screen");
  console.log("=============================================================\n");

  const server = await serve();
  global.__port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    for (const accountType of ["personal", "business"]) {
      const s = await openServices(browser, { accountType });
      const sections = await readGrid(s.page);
      const where = sections.find((section) => section.tiles.includes("titopro"));

      check(`${accountType.toUpperCase()} · TitoPro is on the Services screen`,
        Boolean(where), sections.map((x) => `${x.heading}: ${x.tiles.join(", ")}`).join(" | "));
      // THE WHOLE POINT. "More" is the unnamed catch-all at the bottom of the
      // page; a service that lands there is a service nobody finds.
      check(`${accountType.toUpperCase()} · AND NOT BURIED UNDER "MORE"`,
        where?.heading !== "More", where?.heading || "absent");
      check(`${accountType.toUpperCase()} · it sits under Buy`,
        where?.heading === "Buy", `${where?.heading}: ${where?.tiles.join(", ")}`);
      if (accountType === "personal") {
        // Book is beside it here. For a BUSINESS, serviceGroupOf deliberately
        // sends Book to "Run your business" - it opens their booking console
        // rather than a list of places to book - so the two only share a
        // heading on the personal screen.
        check("PERSONAL · beside Book, in sort order",
          where.tiles.includes("book") && where.tiles.indexOf("titopro") > where.tiles.indexOf("book"),
          where.tiles.join(" → "));
      } else {
        const business = sections.find((section) => section.heading === "Run your business");
        check("BUSINESS · Book stays with the business console, TitoPro does not follow it",
          Boolean(business?.tiles.includes("book")) && !business.tiles.includes("titopro"),
          `Run your business: ${business?.tiles.join(", ")}`);
      }
      check(`${accountType.toUpperCase()} · no page errors`, s.errors.length === 0, s.errors.join(" | "));
      await s.context.close();
    }

    // THE FALLBACK CATALOGUE, WHICH IS WHY THE FILE HAD TO CHANGE TOO.
    const offline = await openServices(browser, { accountType: "personal", catalogueFails: true });
    const sections = await readGrid(offline.page);
    const where = sections.find((section) => section.tiles.includes("titopro"));
    check("THE TILE SURVIVES A CATALOGUE THE API CANNOT SERVE",
      Boolean(where), sections.map((x) => x.heading).join(" | "));
    check("and it is still under Buy, not in the catch-all",
      where?.heading === "Buy", where?.heading || "absent");
    await offline.context.close();

    // The tile has to open something. A data-service attribute that reaches no
    // handler is a tile that does nothing when it is tapped.
    const s = await openServices(browser, { accountType: "personal" });
    // handleService is what the tile's click listener calls with
    // dataset.service, so this is the same path a tap takes.
    const opened = await s.page.evaluate(async () => {
      await window.handleService("titopro");
      return document.querySelector(".modal-head h2")?.textContent.trim() || "";
    });
    check("TAPPING IT OPENS TITOPRO", /TitoPro|Offer my services|Your work/.test(opened), opened || "nothing opened");
    await s.context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
