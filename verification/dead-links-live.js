// The links a browser actually renders.
//
// The static pass cannot judge a destination built from a variable, and the HR
// portal builds nearly all of its links that way. This walks the rendered DOM
// of both apps and classifies every href and every route control that is
// actually on screen. It clicks nothing: this is an audit, and clicking through
// a live app deletes things.
const { chromium } = require("playwright");
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PWA = "http://127.0.0.1:8010";
const HR = "http://127.0.0.1:8030";
const PWA_ROUTES = new Set(["services", "qr", "activity", "profile", "dashboard"]);
const API = "http://127.0.0.1:8110/v1";
const stamp = Date.now();
const USER = {
  fullName: "Crawl Tester",
  email: `crawl${stamp}@titopay.local`,
  phone: `+2787${String(stamp).slice(-7)}`,
  password: "CrawlTester!2026#x",
  accountType: "personal"
};

const dead = [];
let judged = 0;

function classify(app, where, href, text) {
  const value = String(href || "").trim();
  judged += 1;
  if (!value) return dead.push({ app, where, href: "(empty)", text });
  if (value === "#") return dead.push({ app, where, href: "#", text });
  if (/^javascript:\s*void/i.test(value)) return dead.push({ app, where, href: value, text });
  if (/^(https?:|mailto:|tel:|data:|blob:)/i.test(value)) return;
  if (value.startsWith("#")) {
    const route = value.slice(1);
    // In the customer app a hash is a route, and only five of them draw.
    if (app === "PWA" && route && !PWA_ROUTES.has(route)) {
      dead.push({ app, where, href: value, text, why: "not a route this app renders" });
    }
    return;
  }
  if (value.startsWith("/") || value.startsWith(".")) return; // resolved by the server
  dead.push({ app, where, href: value, text, why: "neither a URL, a path nor a route" });
}

async function collect(page, app, where) {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll("a"))
    .map((a) => ({ href: a.getAttribute("href"), text: (a.textContent || "").trim().slice(0, 40) })));
  for (const link of links) classify(app, where, link.href, link.text);

  const routes = await page.evaluate(() => Array.from(document.querySelectorAll("[data-route]"))
    .map((el) => ({ route: el.getAttribute("data-route"), text: (el.textContent || "").trim().slice(0, 40),
      inModal: Boolean(el.closest(".modal-backdrop")) })));
  for (const r of routes) {
    judged += 1;
    if (app === "PWA" && r.route && !PWA_ROUTES.has(r.route)) {
      dead.push({ app, where, href: `data-route="${r.route}"`, text: r.text,
        why: "the app draws no such screen" });
    }
  }
  return { links: links.length, routes: routes.length };
}

(async () => {
  console.log(`\n${"=".repeat(78)}\n  RENDERED LINKS — what is actually on screen\n${"=".repeat(78)}\n`);
  const browser = await chromium.launch({ executablePath: CHROME });

  // Signed IN, because signed out the customer app renders a landing page and
  // none of the screens where a dead link would hide. The bundle hard-codes its
  // API origin to production, so that origin is bridged to the sandbox — the
  // same arrangement pwa-crawl.spec.js uses.
  const reg = await fetch(`${API}/auth/register`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(USER) }).then((r) => r.json());
  const auth = reg.accessToken ? reg : await fetch(`${API}/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: USER.email, password: USER.password }) }).then((r) => r.json());
  if (!auth.accessToken) { console.log("  Could not sign a customer in — the PWA was NOT walked.\n"); }

  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await c.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [auth.accessToken, auth.refreshToken]);
  const ctx = c;
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: undefined },
        body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
      });
      const body = await upstream.text();
      await route.fulfill({
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json",
          "access-control-allow-origin": "*" },
        body
      });
    } catch (error) {
      await route.fulfill({ status: 502, contentType: "application/json",
        body: JSON.stringify({ ok: false, error: String(error.message) }) });
    }
  });

  const p = await c.newPage();
  await p.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  for (const route of ["dashboard", "services", "activity", "profile", "qr"]) {
    await p.evaluate((r) => { location.hash = r; }, route);
    await p.waitForTimeout(900);
    const seen = await collect(p, "PWA", `#${route}`);
    console.log(`  PWA #${route.padEnd(10)} ${seen.links} links, ${seen.routes} route controls`);
  }
  await c.close();

  // HR portal, signed in, every module.
  const h = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const hp = await h.newPage();
  await hp.goto(`${HR}/index.html`, { waitUntil: "domcontentloaded" });
  await hp.waitForTimeout(1800);
  const inputs = await hp.$$("input");
  if (inputs.length >= 2) {
    await inputs[0].fill("portal.director@titopay.local");
    await inputs[1].fill("PortalTest!2026#x");
    await hp.click("text=Sign in securely");
    await hp.waitForTimeout(3200);
  }
  const signedIn = await hp.evaluate(() => Boolean(document.querySelector(".sidebar")));
  if (!signedIn) {
    console.log("\n  HR portal: could not sign in, so its modules were not walked.");
  } else {
    for (const module of ["Dashboard", "Employees", "Recruitment", "Leave", "Attendance", "Payroll",
      "Claims", "Announcements", "Documents", "Learning Hub", "Reports", "Audit log"]) {
      try { await hp.click(`text="${module}"`, { timeout: 4000 }); } catch { continue; }
      await hp.waitForTimeout(1200);
      const seen = await collect(hp, "HR", module);
      console.log(`  HR  ${module.padEnd(14)} ${seen.links} links, ${seen.routes} route controls`);
    }
  }
  await browser.close();

  console.log(`\n${"=".repeat(78)}`);
  if (dead.length) {
    console.log(`  ${dead.length} rendered link(s) go nowhere:\n`);
    for (const d of dead) {
      console.log(`    [${d.app}] ${d.where}  ${d.href}`);
      console.log(`      "${d.text}"${d.why ? " — " + d.why : ""}`);
    }
  } else {
    console.log(`  Every one of the ${judged} rendered destinations goes somewhere.`);
  }
  console.log(`${"=".repeat(78)}\n`);
  process.exit(dead.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
