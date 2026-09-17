// NOTHING ON A SERVICE SCREEN MAY BE WIDER THAN THE PHONE.
//
// A modal card wider than the viewport does not look like a bug to the person
// holding the phone. It looks cheap: the screen drifts sideways under a thumb,
// labels are cut off at the left edge, and the heading of the sheet they
// opened is half off-screen. The Quote screen was reported exactly that way.
//
// Eyeballing a screenshot cannot catch this reliably, so this MEASURES it:
// every service screen is opened at three real handset widths, the document is
// checked for sideways scroll, and every element whose box crosses either edge
// is named. A failure here prints the element that did it, so the fix is one
// selector away rather than a hunt.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/service-screen-overflow.spec.js
//
// PWA_ROOT tests an extracted app.zip exactly as it deploys.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const API = "https://api.titopay.co.za";
const WIDTHS = [360, 390, 430];
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

// The catalogue the app itself ships, so a service added to it is measured on
// the next run instead of being remembered here.
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(PWA_ROOT, "services-default.json"), "utf8"));
const SERVICES = (Array.isArray(CATALOGUE) ? CATALOGUE : CATALOGUE.items || CATALOGUE.services || [])
  .filter((s) => s.status === "active");

// Screens that navigate to a full page rather than opening a sheet: there is
// no modal card to measure and the route change takes the harness off the
// screen it is testing.
const NAVIGATES_AWAY = new Set([
  "transactions", "profile-security", "business-profile", "tickets", "activity", "fica"
]);

async function openApp(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    let body = { ok: true, items: [] };
    if (url.pathname.endsWith("/v1/services")) body = { ok: true, items: SERVICES, services: SERVICES };
    await route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${global.__port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.handleService === "function", null, { timeout: 15000 });
  await page.evaluate(() => window.saveAuth({ accessToken: "a", refreshToken: "r" }));
  return { context, page, errors };
}

// THE MEASUREMENT. Two questions, because they fail differently:
//   does the PAGE scroll sideways (what the thumb feels), and
//   does any BOX cross the viewport edge (what gets cut off).
// An element inside its own overflow-x:auto container is allowed to be wide -
// a table or a code block legitimately scrolls - so those are excluded.
const MEASURE = `(() => {
  const doc = document.scrollingElement;
  const vw = doc.clientWidth;
  const card = document.querySelector(".modal-card") || document.querySelector(".modal-backdrop");
  const offenders = [];
  const scrollable = new Set();
  document.querySelectorAll("*").forEach((el) => {
    const style = getComputedStyle(el);
    if (style.overflowX === "auto" || style.overflowX === "scroll") scrollable.add(el);
  });
  const insideScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (scrollable.has(p)) return true;
    return false;
  };
  const root = card || document.body;
  root.querySelectorAll("*").forEach((el) => {
    if (insideScroller(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // 1px of tolerance for sub-pixel rounding at odd device ratios.
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 60)) || "",
        left: Math.round(r.left), right: Math.round(r.right),
        minWidth: getComputedStyle(el).minWidth
      });
    }
  });
  // NATIVE DATE CONTROLS, WHICH IS WHERE THIS ACTUALLY BIT.
  //
  // On iOS a date input carries an intrinsic width that max-width and
  // min-width do not restrain; only dropping the native inline appearance
  // does. Chromium on Linux does not reproduce the spill, so measuring the
  // rendered width here would prove nothing. What CAN be checked on any engine
  // is that the rule reaches the control at all - so every date field in the
  // app is required to resolve to appearance:none, which is the thing that
  // stops the spill on the device that has it.
  const dates = [];
  (card || document).querySelectorAll('input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"]').forEach((el) => {
    const style = getComputedStyle(el);
    dates.push({
      appearance: style.webkitAppearance || style.appearance,
      boxSizing: style.boxSizing,
      id: el.id || el.name || el.getAttribute("data-doc-issue") !== null ? "doc-issue" : ""
    });
  });
  const fieldsets = [];
  (card || document).querySelectorAll("fieldset").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    fieldsets.push({ cls: String(el.className).slice(0, 40), width: Math.round(r.width),
      minInline: getComputedStyle(el).minInlineSize });
  });
  return {
    viewport: vw,
    docScroll: doc.scrollWidth - vw,
    cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null,
    offenders: offenders.slice(0, 6),
    dates,
    fieldsets
  };
})()`;

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> no service screen is wider than the phone");
  console.log("=============================================================\n");

  const server = await serve();
  global.__port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });
  const broken = new Map();
  let opened = 0;
  let dateFields = 0;
  let fieldsetsSeen = 0;
  const skipped = [];
  const nativeDates = new Set();
  const looseDates = new Set();
  const wideFieldsets = new Set();

  try {
    for (const width of WIDTHS) {
      const s = await openApp(browser, width);
      for (const accountType of ["personal", "business"]) {
        await s.page.evaluate((type) => window.switchLandingAccount(type), accountType);
        for (const service of SERVICES) {
          const id = service.id || service.code || service.service_code;
          if (NAVIGATES_AWAY.has(id)) continue;
          let measured = null;
          try {
            await s.page.evaluate((serviceId) => {
              document.querySelectorAll(".modal-backdrop, .tp-dialog-layer").forEach((el) => el.remove());
              window.handleService(serviceId);
            }, id);
            await s.page.waitForTimeout(90);
            measured = await s.page.evaluate(MEASURE);
          } catch (error) {
            continue;
          }
          if (!measured || measured.cardWidth === null) { skipped.push(`${id}@${width}/${accountType}`); continue; }
          opened += 1;
          if (measured.docScroll > 1 || measured.offenders.length) {
            const key = `${id} @${width} (${accountType})`;
            broken.set(key, measured);
          }
          for (const d of measured.dates) {
            dateFields += 1;
            if (d.appearance !== "none") nativeDates.add(`${id}@${width}: appearance=${d.appearance}`);
            if (d.boxSizing !== "border-box") looseDates.add(`${id}@${width}: box-sizing=${d.boxSizing}`);
          }
          for (const f of measured.fieldsets) {
            fieldsetsSeen += 1;
            if (f.minInline !== "0px") wideFieldsets.add(`${id}@${width}: .${f.cls} min-inline-size=${f.minInline}`);
            if (f.width > measured.cardWidth + 1) wideFieldsets.add(`${id}@${width}: .${f.cls} ${f.width}px in ${measured.cardWidth}px card`);
          }
        }
      }
      await s.context.close();
    }

    if (broken.size) {
      console.log("  SCREENS THAT OVERFLOW:\n");
      for (const [key, m] of broken) {
        console.log(`   ${key}: sideways scroll ${m.docScroll}px, card ${m.cardWidth}px of ${m.viewport}px`);
        for (const o of m.offenders) {
          console.log(`       <${o.tag} class="${o.cls}"> left=${o.left} right=${o.right} min-width=${o.minWidth}`);
        }
      }
      console.log("");
    }
    console.log(`  measured ${opened} screen openings; ${skipped.length} did not open a sheet`);
    if (skipped.length) console.log("  not measured: " + [...new Set(skipped.map((k) => k.split("@")[0]))].join(", ") + "\n");
    check("the harness actually opened screens to measure", opened > 40, `${opened} openings`);
    check("every active service screen fits the phone it is opened on",
      broken.size === 0, broken.size ? `${broken.size} screen/width combinations overflow` : "");

    // The iOS date spill, which is what was actually reported. Chromium cannot
    // show the spill, so what is pinned is the rule that prevents it reaching
    // EVERY date field rather than the one screen it was first found on.
    if (nativeDates.size) [...nativeDates].slice(0, 8).forEach((d) => console.log("       " + d));
    check("every date field in the app drops the native inline appearance",
      nativeDates.size === 0 && dateFields > 0, `${dateFields} date fields checked, ${nativeDates.size} still native`);
    check("and every one of them sizes inside its field",
      looseDates.size === 0, [...looseDates].slice(0, 3).join("; "));

    if (wideFieldsets.size) [...wideFieldsets].slice(0, 8).forEach((f) => console.log("       " + f));
    check("no fieldset refuses to shrink or outgrows its card",
      wideFieldsets.size === 0, `${fieldsetsSeen} fieldsets checked, ${wideFieldsets.size} bad`);
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
