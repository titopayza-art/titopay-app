// WHO CAN SEE THE SERVICE CATALOGUE, AND WHAT HAPPENS TO EVERYONE ELSE.
//
// A new console page has two gates and they have to agree. The rail decides
// what is OFFERED; the API decides what is SERVED. If the rail is looser than
// the API an operator finds a page that 403s, and if it is tighter they lose a
// page they are entitled to. If the API is looser than the rail, a permission
// is not a permission at all — the URL is public to any signed-in admin.
//
// So this drives two REAL role-limited admin accounts through the real console
// against the real API: `engineering`, which holds "services", and
// `customer_support`, which does not. Nothing here is stubbed, because a stub
// would let the harness author decide the answer to the question being asked.
//
// Run with the API on 127.0.0.1:8110 and tokens written by the harness setup.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ADMIN = "/home/user/titopay-app/admin";
const SCRATCH = "/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad";
const PORT = 8135;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
// Same-origin proxy in front of the real API: every console page ships
// `connect-src 'self'`, so a cross-origin API is refused by the browser before
// the request is made and the harness would measure a CSP error, not a gate.
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1/")) {
    const upstream = http.request({ host: "127.0.0.1", port: 8110, path: req.url,
      method: req.method, headers: { ...req.headers, host: "127.0.0.1:8110" } }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502).end(); });
    req.pipe(upstream);
    return;
  }
  const clean = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(ADMIN, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(ADMIN) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `: ${detail}` : ""}`);
};

async function openAs(browser, role) {
  const token = fs.readFileSync(path.join(SCRATCH, `tok-${role}.txt`), "utf8").trim();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(({ t, origin }) => {
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({ accessToken: t, clientLastSeenAt: Date.now() }));
    window.TITOPAY_ADMIN_CONFIG = { apiBaseUrl: origin };
  }, { t: token, origin: ORIGIN });
  return page;
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  // ---- engineering: holds "services". Must be offered the page and served it.
  const eng = await openAs(browser, "engineering");
  await eng.goto(`${ORIGIN}/dashboard/`, { waitUntil: "domcontentloaded" });
  await eng.waitForTimeout(3500);
  const engRole = await eng.$eval(".sidebar", (el) => el.innerText).catch(() => "");
  check("engineering signs in", /Engineering|engineering/i.test(engRole) || engRole.length > 0);
  const engLink = await eng.$('a[data-nav-slug="service-catalogue"]');
  check("engineering is offered Service Catalogue in the rail", Boolean(engLink));

  await eng.goto(`${ORIGIN}/services/`, { waitUntil: "domcontentloaded" });
  await eng.waitForTimeout(3500);
  const engRows = await eng.$$eval("#page-content table tbody tr", (t) => t.length).catch(() => 0);
  check("and is served the catalogue", engRows > 30, `${engRows} rows`);

  // ---- customer_support: does NOT hold "services".
  const sup = await openAs(browser, "customer_support");
  await sup.goto(`${ORIGIN}/dashboard/`, { waitUntil: "domcontentloaded" });
  await sup.waitForTimeout(3500);
  const supNav = await sup.$$eval(".sidebar a[data-nav-slug]", (a) => a.map((x) => x.dataset.navSlug));
  check("customer support signs in and sees a rail", supNav.length > 0, `${supNav.length} modules`);
  check("but is NOT offered Service Catalogue", !supNav.includes("service-catalogue"),
    supNav.includes("service-catalogue") ? "the rail offered it" : "hidden");
  // The rail must not have collapsed to nothing — that would hide the failure.
  check("its own modules are still there", supNav.includes("support") && supNav.includes("users"),
    JSON.stringify(supNav.slice(0, 8)));

  // THE URL IS THE REAL TEST. Hiding a link is presentation; the question is
  // whether typing the address hands over the catalogue anyway.
  await sup.goto(`${ORIGIN}/services/`, { waitUntil: "domcontentloaded" });
  await sup.waitForTimeout(3500);
  const supText = await sup.$eval(".admin-shell", (el) => el.innerText).catch(() => "");
  const supRows = await sup.$$eval("#page-content table tbody tr", (t) => t.length).catch(() => 0);
  check("visiting the URL directly serves no catalogue rows", supRows === 0, `${supRows} rows`);
  for (const leak of ["VAS_PROVIDER", "canPurchase", "service_config", "top-up", "coming soon"]) {
    check(`and leaks no "${leak}"`, !supText.includes(leak));
  }
  // Checked against the PAGE HEADER, not the whole shell: the sidebar contains
  // words like "access" on every screen, so matching anywhere would pass on a
  // blank page. This asserts the refusal is what the operator is actually told.
  const supHeader = await sup.$eval(".page-header", (el) => el.innerText).catch(() => "");
  check("it is refused in words, not left blank", /permission denied/i.test(supHeader),
    supHeader.replace(/\n/g, " ").slice(0, 60));
  check("and the refusal is attributed to a 403, not a fault",
    /403/.test(supText) && !/cannot reach|unreachable/i.test(supText));

  await sup.screenshot({ path: path.join(SCRATCH, "service-catalogue-denied.png") });
  await browser.close();
  server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
