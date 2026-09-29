// EVERY SECTION OF THE HR PORTAL, OPENED THE WAY A PERSON OPENS IT.
//
// It was reported as "literally non functional", and it was: the workspace is
// a single-page app whose router matches on the path, its routes are "/",
// "/employees", "/leave" and so on, and there is no "/index.html". Apache
// serves that URL as a real file instead of rewriting it, so anyone who typed
// or bookmarked it reached the router with a path it did not know. The portal
// looked completely alive - it signed you in, the whole sidebar rendered,
// your name and role sat in the corner - and the body said "Page not found".
// It made no further API calls at all from that route, so nothing loaded.
//
// This signs in at that exact URL and then walks the sidebar, checking each
// destination renders something and is not the not-found page.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   POSTGRES_URL=... HR_EMAIL=... HR_PASSWORD=... node verification/hr-portal-walk.spec.js
//
// Needs the API on 127.0.0.1:8110 and an HR account: seed one with
//   cd api && node scripts/seed-hr.js

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HR_ROOT = process.env.HR_ROOT || path.join(__dirname, "..", "hr");
const LOCAL_API = process.env.HR_API || "http://127.0.0.1:8110";
const EMAIL = process.env.HR_EMAIL || "hrtest@titopay.local";
const PASSWORD = process.env.HR_PASSWORD || "HrPortal!2026#x";

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// Stands in for the portal's .htaccess: real files are served, everything
// else falls back to index.html WITHOUT changing the address bar.
function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    let resolved = path.join(HR_ROOT, file);
    if (!resolved.startsWith(HR_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      resolved = path.join(HR_ROOT, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const NOT_FOUND = /page not found|no longer exists/i;

(async () => {
  console.log("\n=============================================================");
  console.log("  HR PORTAL -> every section opens and loads");
  console.log("=============================================================\n");

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // The portal talks to the production API by address. Send it to the local
    // one instead; nothing about the portal is changed to do it.
    await page.route("https://api.titopay.co.za/**", async (route) => {
      const request = route.request();
      const target = request.url().replace("https://api.titopay.co.za", LOCAL_API);
      try {
        const response = await page.request.fetch(target, {
          method: request.method(), headers: request.headers(), data: request.postData() || undefined
        });
        await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
      } catch (error) {
        await route.abort();
      }
    });

    // THE URL THAT KILLED IT.
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    check("the portal reaches its own route from /index.html",
      new URL(page.url()).pathname === "/",
      new URL(page.url()).pathname);

    const inputs = await page.$$("input");
    check("the sign-in form is on screen", inputs.length >= 2, `${inputs.length} inputs`);
    if (inputs.length < 2) throw new Error("no sign-in form - cannot walk the portal");
    await inputs[0].fill(EMAIL);
    await inputs[1].fill(PASSWORD);
    await (await page.$("text=Sign in securely") || await page.$("button[type=submit]")).click();
    await page.waitForTimeout(4500);

    const signedIn = await page.evaluate(() => document.body.innerText);
    check("signing in reaches the workspace", !NOT_FOUND.test(signedIn),
      NOT_FOUND.test(signedIn) ? "landed on the not-found page" : "");
    check("AND THE WORKSPACE IS NOT THE NOT-FOUND PAGE", /good (morning|afternoon|evening)|dashboard/i.test(signedIn));

    const sections = await page.evaluate(() => [...document.querySelectorAll("nav a, aside a")]
      .map((a) => ({ label: a.textContent.trim(), href: a.getAttribute("href") }))
      .filter((item) => item.label && item.href && !/sign out/i.test(item.label)));
    check("the sidebar offers its sections", sections.length >= 10, `${sections.length} links`);

    console.log("");
    const broken = [];
    for (const section of sections) {
      await page.click(`nav a[href="${section.href}"], aside a[href="${section.href}"]`).catch(() => {});
      await page.waitForTimeout(1100);
      const state = await page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        return { text: main.innerText.replace(/\s+/g, " ").trim(), path: location.pathname };
      });
      const notFound = NOT_FOUND.test(state.text);
      const empty = state.text.length < 40;
      if (notFound || empty) broken.push(`${section.label} (${state.path})${notFound ? " not-found" : " empty"}`);
      console.log(`  ${notFound || empty ? "FAIL" : "PASS"}  ${section.label.padEnd(16)} ${state.path}`);
    }
    console.log("");
    check("EVERY SECTION IN THE SIDEBAR OPENS SOMETHING", broken.length === 0, broken.join(" | "));

    // A deep link is how a colleague shares a page. It must survive a reload.
    await page.goto(`http://127.0.0.1:${port}/employees`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const deep = await page.evaluate(() => (document.querySelector("main") || document.body).innerText);
    check("a deep link still works after a reload", !NOT_FOUND.test(deep));

    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
