// THE LANDING PHOTOGRAPH, AND THE THING THAT SILENTLY BREAKS IT.
//
// The hero panel carries a photograph of Sandton at blue hour. Two couplings
// hold it together and neither one announces itself when it comes apart:
//
//   service-worker.js precaches each file BY ITS FULL URL and matches
//   WITHOUT ignoreSearch, so styles.css must reference them with the SAME
//   query. Drop the ?v= from the stylesheet and nothing looks wrong: the file
//   sits in the cache, is never hit, and refetches over the network on every
//   cold start. Change one number and not the other and the same.
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
  const ORIGIN_FOR_CONTRAST = `http://127.0.0.1:${port}/`;
  const page = await ctx.newPage();
  await page.goto(ORIGIN_FOR_CONTRAST, { waitUntil: "load" });
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

  // Both frames, not just the default: the account type is remembered, so a
  // business customer's FIRST paint is the business photograph.
  for (const which of ["personal", "business"]) {
    const cached = await page.evaluate(async (name) => {
      const names = await caches.keys();
      for (const n of names) {
        const cache = await caches.open(n);
        const keys = await cache.keys();
        const match = keys.find((r) => r.url.includes(`landing-${name}.webp`));
        if (match) {
          const hit = await cache.match(match.url);
          return { cache: n, url: match.url.split("/").pop(), type: hit && hit.headers.get("content-type") };
        }
      }
      return { cache: null };
    }, which);
    check(`the ${which} photograph is in the precached shell`,
      Boolean(cached.cache) && cached.type === "image/webp", JSON.stringify(cached));
  }

  // Now kill the network entirely and reload.
  await ctx.setOffline(true);
  await page.reload({ waitUntil: "load" }).catch(() => null);
  await page.waitForTimeout(1800);
  const offline = await page.evaluate(() => {
    const panel = document.querySelector(".landing-hero-panel");
    if (!panel) return { panel: false };
    const cs = getComputedStyle(panel);
    return { panel: true, image: /landing-(personal|business)\.webp/.test(cs.backgroundImage),
      colour: cs.backgroundColor, headline: (document.querySelector(".landing-hero-panel h1") || {}).textContent || "" };
  });
  check("the landing still renders with no network", offline.panel === true);
  check("AND THE PHOTOGRAPH IS STILL THERE", offline.image === true, JSON.stringify(offline));

  // The business frame is a different file, reached by a class on the same
  // element - so it is a separate cache entry and a separate chance to miss.
  const businessOffline = await page.evaluate(async () => {
    const tab = document.querySelector('[data-account="business"]');
    if (!tab) return { switched: false };
    tab.click();
    await new Promise((r) => setTimeout(r, 900));
    const panel = document.querySelector(".landing-hero-panel");
    return { switched: true,
      image: panel ? getComputedStyle(panel).backgroundImage : "",
      isBusiness: panel ? /landing-business\.webp/.test(getComputedStyle(panel).backgroundImage) : false };
  });
  check("switching to Business offline shows the business photograph",
    businessOffline.isBusiness === true, JSON.stringify(businessOffline).slice(0, 140));
  check("the navy is still underneath it as the fallback ground",
    /rgb\(6, 26, 61\)/.test(offline.colour || ""), offline.colour);
  await ctx.setOffline(false);

  /* ----------------------------------------------------------------------
     IS THE TYPE STILL READABLE ON THE PHOTOGRAPH?

     White type over a photograph is only safe while the scrim holds it down,
     and a scrim that is right for one frame can be wrong for another: the
     personal frame is mostly sky, the business one is full of lit towers. The
     first business photograph measured 2.65 against an AA floor of 3.0 on a
     375x667 screen under the SAME gradient that gave the personal frame 5.64.
     So this is measured per frame, per screen, not carried over.

     Method: hide the type, screenshot the exact box it occupied, and take the
     LIGHTEST pixel in that box as the worst case a reader could meet. The
     supporting line is white at 72% opacity, so it is composited over that
     pixel before the ratio is taken - the colour someone actually sees rather
     than the one declared.
     ---------------------------------------------------------------------- */
  for (const [label, width, height] of [["phone", 393, 852], ["small", 375, 667]]) {
    for (const account of ["personal", "business"]) {
      const shot = await b.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      const p2 = await shot.newPage();
      await p2.goto(ORIGIN_FOR_CONTRAST, { waitUntil: "load" });
      await p2.waitForSelector(".landing-hero-panel h1", { timeout: 15000 });
      await p2.waitForTimeout(1200);
      if (account === "business") {
        await p2.evaluate(() => document.querySelector('[data-account="business"]').click());
        await p2.waitForTimeout(1300);
      }
      const boxes = await p2.evaluate(() => {
        const h1 = document.querySelector(".landing-hero-panel h1");
        const line = document.querySelector(".landing-hero-panel .landing-hero-line");
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        };
        const out = { h1: box(h1), line: line ? box(line) : null };
        h1.style.visibility = "hidden";
        if (line) line.style.visibility = "hidden";
        return out;
      });
      await p2.waitForTimeout(120);
      for (const [which, alpha, floor] of [["h1", 1, 3], ["line", 0.72, 4.5]]) {
        const clip = boxes[which];
        if (!clip || clip.width < 2 || clip.height < 2) continue;
        const png = await p2.screenshot({ clip });
        const ratio = await p2.evaluate(async ({ dataUrl, alpha }) => {
          const img = new Image();
          img.src = dataUrl;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          c.getContext("2d").drawImage(img, 0, 0);
          const px = c.getContext("2d").getImageData(0, 0, img.width, img.height).data;
          const lum = (r, g, b) => {
            const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          // The lightest pixel under the type is the worst case for white.
          let worst = null, worstL = -1;
          for (let i = 0; i < px.length; i += 4) {
            const l = lum(px[i], px[i + 1], px[i + 2]);
            if (l > worstL) { worstL = l; worst = [px[i], px[i + 1], px[i + 2]]; }
          }
          const fg = worst.map((v) => Math.round(255 * alpha + v * (1 - alpha)));
          const a = lum(fg[0], fg[1], fg[2]);
          const bl = lum(worst[0], worst[1], worst[2]);
          return Math.round(((Math.max(a, bl) + 0.05) / (Math.min(a, bl) + 0.05)) * 100) / 100;
        }, { dataUrl: `data:image/png;base64,${png.toString("base64")}`, alpha });
        check(`${account} ${label} ${which === "h1" ? "headline" : "supporting line"} is readable on the photograph`,
          ratio >= floor, `${ratio} against an AA floor of ${floor}`);
      }
      await shot.close();
    }
  }

  await b.close(); server.close();
  console.log(bad ? `\n  ${bad} check(s) failed\n` : "\n  the photograph survives a dead connection\n");
  process.exit(bad ? 1 : 0);
})();
