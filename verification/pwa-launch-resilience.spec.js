// WHY DOES THE APP OPEN TO A WHITE SCREEN INSTEAD OF THE SPLASH?
//
// The splash is inline HTML in index.html with inline critical CSS, so it
// paints with zero JavaScript. Measured from the reported screenshot, the
// screen is #ffffff. Nothing in TitoPay is #ffffff: the inline splash is
// #eef4fe and styles.min.css paints a pale-blue gradient. offline.html shows a
// logo and "You are offline". So the screen is not the app failing to render —
// it is a navigation that resolved to nothing, which a standalone iOS PWA
// draws as a blank white page with no error UI.
//
// The hypothesis this drives:
//
//   install  is best-effort by design — one 404 must not kill the worker, so
//            every fetch failure is swallowed and install resolves anyway.
//   activate is unconditional — it deletes every cache that is not the new
//            CACHE_NAME.
//
// Put together: update the app over a weak connection (a cold PWA launch on a
// phone, which is exactly when it happens), the new cache ends up empty, the
// install still succeeds, skipWaiting promotes it, and activate then deletes
// the previous version's fully populated shell. The device is left with a
// controlling worker, an empty cache and no fallback — and the next launch
// with any network hiccup falls all the way through to Response.error().
//
// This drives the REAL service-worker.js in Chromium. Nothing is stubbed
// except the network, which is the variable under test.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = "/home/user/titopay-app/pwa";
const PORT = 8137;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Server state the test drives.
const server_state = { failAssets: false, cacheName: null };

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(req.url.split("?")[0]);

  // The service worker file itself, with its CACHE_NAME rewritten on demand so
  // the test can simulate a deploy without editing the repository.
  if (clean === "/service-worker.js") {
    let source = fs.readFileSync(path.join(PWA, "service-worker.js"), "utf8");
    if (server_state.cacheName) {
      source = source.replace(/const CACHE_NAME = "[^"]+"/, `const CACHE_NAME = "${server_state.cacheName}"`);
    }
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    res.end(source);
    return;
  }

  // The shell assets fail while a "bad network" deploy is in progress. The
  // navigation itself keeps working, which is what makes this so quiet: the
  // update appears to succeed.
  // A connection that drops mid-update fails EVERY shell fetch, index.html
  // included. The service-worker.js request above still succeeds, which is what
  // makes this quiet: the browser sees a new worker, installs it, and the
  // install swallows all the failures and resolves anyway.
  if (server_state.failAssets) {
    res.writeHead(503).end();
    return;
  }

  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `: ${detail}` : ""}`);
};

const cacheReport = (page) => page.evaluate(async () => {
  if (typeof caches === "undefined") return { __nocaches: [String(location.href)] };
  const names = await caches.keys();
  const out = {};
  for (const name of names) {
    const cache = await caches.open(name);
    out[name] = (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
  }
  return out;
});

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ---- 1. a healthy install, the way a working device looks -------------
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500);
  let caches1 = await cacheReport(page);
  const firstName = Object.keys(caches1)[0];
  check("the shell is cached after a healthy install",
    Boolean(firstName) && caches1[firstName].some((u) => u.includes("index.html")),
    firstName ? `${caches1[firstName].length} entries` : "no cache");

  // Proof the splash is real and paints without JS: it is in the served HTML.
  const splashPresent = await page.evaluate(() => Boolean(document.querySelector(".launch-screen")) ||
    document.documentElement.outerHTML.includes("launch-screen"));
  check("index.html carries the inline splash", splashPresent);

  // ---- 2. the app updates over a weak connection ------------------------
  server_state.failAssets = true;
  server_state.cacheName = "titopay-pwa-v999-simulated-deploy";
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
  });
  await page.waitForTimeout(3000);

  console.log("    [page after update] url:", page.url());
  // The page under test may now be sitting on a browser error document, where
  // the caches API is unreachable. Inspect from a second page on the same
  // origin rather than reporting "no caches" and calling it a finding.
  const inspector = await context.newPage();
  server_state.failAssets = false;
  await inspector.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" }).catch(() => null);
  server_state.failAssets = true;
  const caches2 = await cacheReport(inspector).catch((e) => ({ __error: [String(e.message).slice(0, 80)] }));
  console.log("    [caches after update]", JSON.stringify(Object.keys(caches2)));
  const names2 = Object.keys(caches2);
  const newName = names2.find((n) => n.includes("v999"));
  check("the new worker installed despite every asset failing", Boolean(newName), names2.join(", "));
  // BEFORE THE FIX this read "and the previous working shell has been
  // DELETED", and it passed: activate purged every other cache unconditionally,
  // so a bad update destroyed the last working shell and the next launch had
  // nothing to fall back to. The assertion is inverted now because the
  // behaviour is: keep the old cache until the new one can actually serve.
  check("the previous working shell is KEPT as a fallback",
    names2.includes(firstName), `caches now: ${names2.join(", ") || "none"}`);

  // ---- 3. the next launch, with the network still unavailable -----------
  // failAssets stays ON and the context goes offline: this is the customer
  // relaunching the app before the connection has recovered, which is exactly
  // when the white screen was reported.
  await context.setOffline(true);
  // A REAL navigation. fetch(mode:"navigate") cannot be constructed from a
  // page, and an earlier version of this harness "passed" on that TypeError —
  // a failure for the wrong reason reads exactly like the bug.
  let navigationFailed = false;
  await page.goto(ORIGIN + "/", { waitUntil: "load" }).catch(() => { navigationFailed = true; });
  const painted = await page.evaluate(() => ({
    html: document.documentElement.outerHTML.length,
    hasSplash: Boolean(document.querySelector(".launch-screen")),
    hasOffline: document.body ? document.body.innerText.includes("You are offline") : false,
    bodyText: document.body ? document.body.innerText.trim().slice(0, 120) : "",
    fullText: document.body ? document.body.innerText : "",
    bg: getComputedStyle(document.body || document.documentElement).backgroundColor
  })).catch(() => null);

  // THE QUESTION THE WHOLE HARNESS EXISTS TO ASK.
  const blank = navigationFailed || !painted || painted.bodyText === "";
  check("the launch paints a real document, not a blank pane", !blank,
    painted ? `navFailed=${navigationFailed} bodyText="${painted.bodyText.replace(/\n/g, " / ")}"` : "no document");
  check("...and it is TitoPay, in TitoPay's colours",
    Boolean(painted) && /rgb\(238, 244, 254\)|rgb\(233, 241, 255\)/.test(painted.bg || "") ,
    painted ? painted.bg : "n/a");
  check("...and it tells the customer their money is safe",
    Boolean(painted) && (painted.hasSplash || /money and your\s+account are unaffected|You are offline/i.test(painted.bodyText + " " + (painted.fullText || ""))),
    painted ? `splash=${painted.hasSplash}` : "n/a");

  // ---- 4. THE WORST CASE: every cache empty and no network --------------
  // There is no shell to fall back to at all. Before, this was Response.error()
  // and a blank pane. The worker now carries its own document, so a white
  // screen is not reachable even here.
  await context.setOffline(false);
  server_state.failAssets = false;
  await page.goto(ORIGIN + "/", { waitUntil: "load" }).catch(() => null);
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
  });
  // Killing the network properly took three attempts, and the first two both
  // "passed" while measuring the wrong thing:
  //   setOffline()      Chromium still answered from its own HTTP cache.
  //   context.route()   does not intercept service-worker-initiated fetches,
  //                     so the worker's own fetch still reached the server.
  // Stopping the server is the only one of the three that is actually a dead
  // network for the code under test.
  await context.setOffline(true);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  let worstFailed = false;
  await page.goto(ORIGIN + "/", { waitUntil: "load" }).catch(() => { worstFailed = true; });
  const worst = await page.evaluate(() => ({
    text: document.body ? document.body.innerText.trim() : "",
    bg: getComputedStyle(document.body || document.documentElement).backgroundColor
  })).catch(() => null);
  check("with NO cache and NO network it still paints a document",
    !worstFailed && worst && worst.text.length > 0,
    worst ? `"${worst.text.replace(/\n/g, " / ").slice(0, 70)}"` : "no document");
  check("...in TitoPay's colours, not white",
    Boolean(worst) && worst.bg === "rgb(238, 244, 254)", worst ? worst.bg : "n/a");
  check("...saying the money is unaffected",
    Boolean(worst) && /money and your account are unaffected/i.test(worst.text));

  await context.setOffline(false);
  await browser.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nreproduced: every step behaved as the hypothesis predicted");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
