// Does the Service Catalogue page actually answer the question it was built for?
//
// Driven against the REAL API (build 114) and the REAL database, with a real
// admin session — not a stub. The whole point of the page is that it reports a
// derived fact, so a fixture would prove nothing: the fixture author would be
// the one deciding what the gate says.
//
// Served over HTTP, never file://. The console resolves its API base from
// location.hostname, and under file:// it also treats "admin.js?v=..." as a
// literal filename — so a file:// run measures a page that never booted.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ADMIN = "/home/user/titopay-app/admin";
const PORT = 8133;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOKEN = fs.readFileSync("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/tok.txt", "utf8").trim();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

// /v1/* is PROXIED to the real API rather than stubbed. Every console page
// ships `connect-src 'self' https://api.titopay.co.za`, so a browser will not
// let the page talk to 127.0.0.1:8110 at all — the first run of this harness
// measured nothing but a CSP refusal and an "API unreachable" screen. Serving
// the API under the same origin keeps the real CSP in force AND keeps the
// responses real.
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

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  // A real session, seeded BEFORE the first script runs. Setting it after the
  // navigation raced the console's own redirect to sign-in, which is what the
  // first run of this harness actually measured.
  await page.addInitScript(({ token, origin }) => {
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: token, role: "super_admin", permissions: ["*"], clientLastSeenAt: Date.now()
    }));
    // The same config hook a real deployment uses to point the console at its
    // API; here it points at the same-origin proxy in front of the real one.
    window.TITOPAY_ADMIN_CONFIG = { apiBaseUrl: origin };
  }, { token: TOKEN, origin: ORIGIN });
  await page.goto(`${ORIGIN}/services/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  if (!/\/services\//.test(page.url())) {
    console.log(`FAIL  the page redirected away to ${page.url()} — the session was not accepted`);
    await browser.close(); server.close(); process.exit(1);
  }

  check("the console booted", await page.evaluate(() => typeof window.renderServiceCatalogue === "function"));

  const rows = await page.$$eval("#page-content table tbody tr", (trs) =>
    trs.map((tr) => Array.from(tr.cells).map((c) => c.textContent.trim())));
  check("the catalogue rendered its rows", rows.length > 30, `${rows.length} rows`);

  // The five services in the screenshot must each show the mismatch plainly.
  const wanted = ["airtime", "data", "electricity", "voucher", "airtime-and-data"];
  for (const code of wanted) {
    const row = rows.find((cells) => cells[1] === code);
    const served = row ? row[3] : "";
    const stored = row ? row[4] : "";
    const why = row ? row[5] : "";
    check(`${code} reads as held back`,
      Boolean(row) && served === "coming soon" && stored === "active" && why.length > 20,
      row ? `served="${served}" stored="${stored}" why="${why.slice(0, 40)}…"` : "row missing");
  }

  // A live service must NOT carry a spurious explanation, or the column is noise.
  const live = rows.find((cells) => cells[1] === "send-money");
  check("a live service shows live and no reason", live && live[3] === "live" && live[5] === "-",
    live ? `served="${live[3]}" why="${live[5]}"` : "row missing");

  const text = await page.$eval("#page-content", (el) => el.innerText);
  check("the gate card names the capability", /"vas" cannot transact yet/.test(text));
  check("it names the variable that selects the adapter", /VAS_PROVIDER/.test(text));
  check("it says the adapter declares canPurchase: false", /canPurchase: false/.test(text));
  check("it says what would release the services", /declare canPurchase: true/.test(text));
  check("it says plainly there is nothing to switch on", /nothing to switch on here/i.test(text));
  check("the held-back count is surfaced as a metric", /held by a capability/i.test(text));

  // Read-only about STATUS. The console's data-table engine adds its own row
  // selection and export controls to every table, and those belong here — an
  // operator exporting the catalogue is exactly the point. What must not exist
  // is a control that appears to change a service's status, because for the
  // rows people come to this page about, it could not.
  const controls = await page.$eval("#page-content", (el) => ({
    forms: el.querySelectorAll("form").length,
    // Row-selection checkboxes and the table search box come from the console's
    // own data-table engine and are on every table; neither can write anything.
    statusFields: el.querySelectorAll("select, textarea, input:not([type=checkbox]):not([type=search])").length,
    buttons: Array.from(el.querySelectorAll("button")).map((b) => b.textContent.trim()).filter(Boolean)
  }));
  const pretendsToWrite = /save|activate|enable|disable|publish|apply|update/i;
  check("no form on the page", controls.forms === 0, controls.forms);
  check("no field that could set a status", controls.statusFields === 0, controls.statusFields);
  check("no button pretends to change a status",
    !controls.buttons.some((label) => pretendsToWrite.test(label)),
    JSON.stringify(controls.buttons));

  // CSP is style-src 'self' — an inline style attribute would be dropped
  // silently, so the page must not rely on one.
  const inlineStyles = await page.$$eval("#page-content [style]", (n) => n.length);
  check("no inline styles (CSP style-src 'self')", inlineStyles === 0, inlineStyles);

  const navLink = await page.$eval('a[data-nav-slug="service-catalogue"]', (a) => a.textContent.trim()).catch(() => null);
  check("it has its own entry in the sidebar", navLink === "Service Catalogue", navLink);

  check("no page errors", errors.length === 0, errors.join(" | "));

  await page.screenshot({ path: "/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/service-catalogue.png", fullPage: true });
  await browser.close();
  server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
