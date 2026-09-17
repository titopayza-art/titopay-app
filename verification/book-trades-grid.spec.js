// THE BROWSE GRID, MEASURED RATHER THAN REASONED ABOUT.
//
// Adding a Trades group took TitoPay Book from seven category tiles to eight,
// and the grid is two columns, so the count decides the shape. The source
// tests pin the rule; this measures the result in a real browser at the widths
// a customer actually holds:
//
//   1. every row is full - no tile stranded alone, which is the ragged wrap
//      the group list was created to avoid;
//   2. no label overflows its tile. .bk-tile sets white-space:nowrap, so a
//      label that does not fit does not wrap, it spills;
//   3. no two tiles wear the same glyph;
//   4. the tiles are reachable and hit a real target size.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/book-trades-grid.spec.js
//
// PWA_ROOT overrides the app directory so an extracted app.zip is measured
// exactly as it will be deployed.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".jpg": "image/jpeg"
};

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    const resolved = path.join(PWA_ROOT, file);
    if (!resolved.startsWith(PWA_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Open the real Book browse modal, rendered by the shipped app.min.js.
async function openBrowse(browser, origin, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.renderBookDiscover === "function", null, { timeout: 15000 });
  // The venue list is fetched; the grid is not, so an empty list still renders
  // every tile. Discovery is exactly what is being measured here.
  await page.evaluate(() => window.renderBookDiscover());
  await page.waitForSelector(".bk-grid .bk-tile", { timeout: 10000 });
  return { context, page, errors };
}

async function measure(page) {
  return page.evaluate(() => {
    const grid = document.querySelector(".bk-grid");
    const tiles = [...grid.querySelectorAll(".bk-tile")];
    const rows = new Map();
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      const key = Math.round(box.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({
        label: tile.textContent.trim(),
        wide: tile.classList.contains("bk-tile-wide"),
        width: Math.round(box.width),
        height: Math.round(box.height),
        // Does the text fit the space the tile gives it? white-space:nowrap
        // means an overlong label spills rather than wraps.
        overflow: tile.scrollWidth - tile.clientWidth,
        glyph: tile.querySelector("svg")?.innerHTML.slice(0, 40) || ""
      });
    }
    return {
      gridWidth: Math.round(grid.getBoundingClientRect().width),
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      tiles: tiles.length,
      rows: [...rows.values()]
    };
  });
}

(async () => {
  console.log("\n=============================================================");
  console.log("  BOOK -> the browse grid with Trades added");
  console.log("=============================================================\n");

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    for (const width of [360, 390, 414, 768]) {
      console.log(`  --- ${width}px ---`);
      const session = await openBrowse(browser, origin, width);
      const grid = await measure(session.page);

      check(`${width}px · eight tiles render`, grid.tiles === 8, `${grid.tiles} tiles, ${grid.columns} columns`);
      check(`${width}px · no page errors`, session.errors.length === 0, session.errors.join(" | "));

      // 1. NO STRANDED TILE. With an even count every row holds two.
      const shortRows = grid.rows.filter((row) => row.length < 2 && !row[0].wide);
      check(`${width}px · NO TILE STRANDED ALONE IN A ROW`, shortRows.length === 0,
        shortRows.map((row) => row[0].label).join(", ") || `${grid.rows.length} full rows`);

      // With eight groups nothing should be wide. That is the bug fix.
      const wide = grid.rows.flat().filter((tile) => tile.wide);
      check(`${width}px · no tile is forced full width at an even count`, wide.length === 0,
        wide.map((t) => t.label).join(", "));

      // 2. NO LABEL SPILLS. This is what white-space:nowrap does to a long one.
      const spilling = grid.rows.flat().filter((tile) => tile.overflow > 0);
      check(`${width}px · every label fits its tile`, spilling.length === 0,
        spilling.map((t) => `${t.label} +${t.overflow}px`).join(", ") || "no overflow");

      // Trades is the new label and the one most at risk of not fitting.
      const trades = grid.rows.flat().find((tile) => tile.label === "Trades");
      check(`${width}px · Trades is on the grid and fits`,
        Boolean(trades) && trades.overflow <= 0, trades ? `${trades.width}px tile` : "missing");

      // 4. Touch target. Anything under 44px is hard to hit on a phone.
      const small = grid.rows.flat().filter((tile) => tile.height < 44);
      check(`${width}px · tiles are a real touch target`, small.length === 0,
        small.map((t) => `${t.label} ${t.height}px`).join(", ") || `${grid.rows[0][0].height}px tall`);

      await session.context.close();
      console.log("");
    }

    // 3. GLYPHS. Car borrowed the wrench before Trades existed; two identical
    // icons side by side read as a rendering fault rather than two categories.
    const session = await openBrowse(browser, origin, 390);
    const grid = await measure(session.page);
    const glyphs = grid.rows.flat().map((tile) => tile.glyph);
    check("every tile has a drawn glyph", glyphs.every(Boolean), `${glyphs.filter(Boolean).length}/8`);
    check("NO TWO TILES SHARE A GLYPH", new Set(glyphs).size === glyphs.length,
      `${new Set(glyphs).size} distinct of ${glyphs.length}`);

    const labels = grid.rows.flat().map((tile) => tile.label);
    check("the seven original groups are all still there",
      ["Eat and drink", "Beauty", "Health", "Car", "Fitness", "Stay", "Things to do"]
        .every((label) => labels.includes(label)), labels.join(" · "));

    // The tile does something: tapping it filters the browse.
    const clickable = await session.page.evaluate(() => {
      const tile = [...document.querySelectorAll(".bk-tile")].find((el) => el.textContent.trim() === "Trades");
      return { action: tile?.dataset.action || "", tag: tile?.tagName || "" };
    });
    check("the Trades tile is a button wired to its category",
      clickable.tag === "BUTTON" && clickable.action === "book-group:plumber",
      `${clickable.tag} ${clickable.action}`);
    await session.context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
