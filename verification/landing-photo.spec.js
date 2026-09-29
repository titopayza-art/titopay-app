// THE LANDING PHOTOGRAPH, AND THE THING THAT SILENTLY BREAKS IT.
//
// The hero panel carries a photograph of Sandton at blue hour. Two couplings
// hold it together and neither one announces itself when it comes apart:
//
//   service-worker.js precaches "./assets/landing-sandton.webp?v=603" and
//   matches WITHOUT ignoreSearch, so styles.css must reference the file with
//   the SAME query. Drop the ?v= from the stylesheet and nothing looks wrong:
//   the file sits in the cache, is never hit, and refetches over the network
//   on every cold start. Change one number and not the other and the same.
//
//   cache.addAll is atomic. A typo in that shell entry does not break the
//   photograph, it stops the worker installing at all, and the whole app
//   quietly loses offline support with nothing on screen to say so.
//
// So this loads the page, waits for the worker to take control, kills the
// network and reloads. The panel keeps navy as its background COLOUR under
// the image, which is checked too: a miss should degrade to the flat panel
// that shipped before, never to white type on white.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/landing-photo.spec.js

const { chromium } = require("playwright");
const http = require("node:http"); const fs = require("node:fs"); const path = require("node:path");
const ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".webmanifest": "application/manifest+json" };
function serve() { const s = http.createServer((req, res) => {
  let f = decodeURIComponent(String(req.url).split("?")[0]); if (f === "/" || f.endsWith("/")) f += "index.html";
  const r = path.join(ROOT, f);
  if (!r.startsWith(ROOT) || !fs.existsSync(r) || fs.statSync(r).isDirectory()) { res.writeHead(404).end("no"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(r)] || "application/octet-stream" }); res.end(fs.readFileSync(r));
}); return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s))); }
let bad = 0;
const check = (name, ok, detail = "") => { if (!ok) bad += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`); };
(async () => {
  const server = await serve(); const port = server.address().port;
  const b = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForSelector(".landing-hero-panel", { timeout: 15000 });

  const activated = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return "no serviceWorker API";
    const reg = await navigator.serviceWorker.ready.catch((e) => String(e));
    if (typeof reg === "string") return reg;
    for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return navigator.serviceWorker.controller ? "controlling" : "registered but not controlling";
  });
  check("THE WORKER STILL INSTALLS AND ACTIVATES WITH THE NEW SHELL ENTRY",
    activated === "controlling", activated);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    for (const n of names) {
      const hit = await (await caches.open(n)).match("./assets/landing-sandton.webp?v=603");
      if (hit) return { cache: n, type: hit.headers.get("content-type"), ok: hit.ok };
    }
    return { cache: null, names };
  });
  check("the photograph is in the precached shell", Boolean(cached.cache), JSON.stringify(cached));

  // Now kill the network entirely and reload.
  await ctx.setOffline(true);
  await page.reload({ waitUntil: "load" }).catch(() => null);
  await page.waitForTimeout(1800);
  const offline = await page.evaluate(() => {
    const panel = document.querySelector(".landing-hero-panel");
    if (!panel) return { panel: false };
    const cs = getComputedStyle(panel);
    return { panel: true, image: cs.backgroundImage.includes("landing-sandton"),
      colour: cs.backgroundColor, headline: (document.querySelector(".landing-hero-panel h1") || {}).textContent || "" };
  });
  check("the landing still renders with no network", offline.panel === true);
  check("AND THE PHOTOGRAPH IS STILL THERE", offline.image === true, JSON.stringify(offline));
  check("the navy is still underneath it as the fallback ground",
    /rgb\(6, 26, 61\)/.test(offline.colour || ""), offline.colour);
  await ctx.setOffline(false);
  await b.close(); server.close();
  console.log(bad ? `\n  ${bad} check(s) failed\n` : "\n  the photograph survives a dead connection\n");
  process.exit(bad ? 1 : 0);
})();
