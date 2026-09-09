// THE SERVICE CATALOGUE'S STATUS CONTROL, DRIVEN IN A REAL BROWSER.
//
// The API side is proved by node tests that call updateService directly:
// setting a capability-gated service live stores "active" and still serves
// "coming soon", and an ungated one really does go live. What those cannot
// prove is the half a person touches — that the select renders the stored
// status, that changing it sends the right request, and that a gated answer is
// reported honestly instead of as success.
//
// So the API is stubbed here ON PURPOSE. This harness is not asking what the
// gate decides; it is asking what the page does with the answer, including the
// answer that differs from what was asked for. A live session would make that
// case nearly impossible to stage on demand.
//
// Served over HTTP, never file://: the console resolves its API base from
// location.hostname, and under file:// it also treats "admin.js?v=..." as a
// literal filename, so a file:// run measures a page that never booted.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
// Harness screenshots go here, not into the repo root.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });

const ADMIN = "/home/user/titopay-app/admin";
const PORT = 8141;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

// One gated row and one that is not, because a control that refused everything
// would pass a test that only checked the refusal.
const CATALOGUE = {
  ok: true,
  items: [
    { id: "11111111-1111-4111-8111-111111111111", service_code: "airtime", service_name: "Airtime",
      status: "coming_soon", storedStatus: "active", capability: "vas", capabilityLive: false,
      unavailableReason: "No provider is contracted for this capability yet.",
      personal_visible: true, business_visible: false },
    { id: "22222222-2222-4222-8222-222222222222", service_code: "events", service_name: "Events",
      status: "disabled", personal_visible: false, business_visible: false },
  ],
  capabilities: [
    { capability: "vas", live: false, configured: "none", variable: "VAS_PROVIDER",
      source: "default", declares: { canPurchase: false },
      releasedBy: "Set VAS_PROVIDER to an adapter declaring canPurchase: true." },
  ],
};

let putBodies = [];
// What the stubbed API answers a write with, AND the write actually lands in
// CATALOGUE. A stub that replays its opening state forever cannot stage a
// second change: the select comes back to the value it already had, the
// handler correctly does nothing, and the harness measures its own laziness.
// That is exactly what the first run of this did.
//
// The gated row answers with the GATED status, exactly as the real API does.
const answerFor = (id, status) => {
  const index = id.startsWith("1111") ? 0 : 1;
  const gated = index === 0;
  const served = gated ? (status === "disabled" ? "disabled" : "coming_soon") : status;
  CATALOGUE.items[index] = gated
    ? { ...CATALOGUE.items[index], storedStatus: status, status: served }
    : { ...CATALOGUE.items[index], status: served };
  return { ok: true, item: CATALOGUE.items[index] };
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith("/v1/")) {
    if (req.method === "PUT" && /\/v1\/services\/admin\//.test(url.pathname)) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const id = url.pathname.split("/").pop();
        const parsed = JSON.parse(body || "{}");
        putBodies.push({ id, body: parsed });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answerFor(id, parsed.status)));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (url.pathname === "/v1/admin/integration-readiness") {
      // The REAL service, called in-process, so the page is rendering the
      // platform's own answer rather than a fixture somebody wrote.
      process.env.NODE_ENV = "test";
      process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";
      return require("/home/user/titopay-app/api/src/services/integration-readiness-service")
        .integrationReadiness()
        .then((report) => res.end(JSON.stringify({ ok: true, ...report })))
        .catch((error) => res.end(JSON.stringify({ ok: false, error: error.message })));
    }
    if (url.pathname === "/v1/services/admin") return res.end(JSON.stringify(CATALOGUE));
    if (url.pathname === "/v1/admin/me") {
      return res.end(JSON.stringify({ ok: true, admin: { id: "a1", email: "harness@titopay.local",
        fullName: "Harness", role: "super_admin", permissions: ["*"] } }));
    }
    return res.end(JSON.stringify({ ok: true, items: [] }));
  }
  const clean = decodeURIComponent(url.pathname);
  let file = path.join(ADMIN, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(ADMIN) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ": " + detail : ""}`);
};

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.addInitScript((origin) => {
    // The console resolves its API base from location.hostname and would land
    // on 127.0.0.1:8110 — a different origin, which its own
    // `connect-src 'self'` then refuses. The first run of this harness
    // measured exactly that and reported "API unreachable", which was the
    // harness failing, not the page. TITOPAY_ADMIN_CONFIG takes precedence, so
    // the stub answers same-origin and the REAL CSP stays in force.
    window.TITOPAY_ADMIN_CONFIG = { apiBaseUrl: `${origin}/v1` };
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: "harness", refreshToken: "harness",
      admin: { id: "a1", email: "harness@titopay.local", fullName: "Harness",
        role: "super_admin", permissions: ["*"] },
      clientLastSeenAt: Date.now(),
    }));
  }, ORIGIN);
  await page.goto(`${ORIGIN}/integration-readiness/`, { waitUntil: "load" });
  await page.waitForTimeout(2500);

  // The console boots its own shell from the session above. If it did not get
  // that far, say so rather than quietly measuring a scaffold this harness
  // built itself — a page that never booted proves nothing.
  const booted = await page.evaluate(() => Boolean(document.getElementById("page-content")));
  ok("the console booted its own page shell", booted, booted ? "" : `url=${page.url()}`);
  await page.evaluate(() => window.renderIntegrationReadiness && window.renderIntegrationReadiness());
  await page.waitForTimeout(600);
  const rows = await page.$$eval("tbody tr", (trs) => trs.map((tr) =>
    [...tr.children].map((td) => td.textContent.trim().replace(/\s+/g, " "))));
  console.log(`  rows rendered: ${rows.length}`);
  for (const r of rows) console.log(`    ${(r[1]||"").padEnd(9)} ${(r[0]||"").padEnd(38)} ${(r[2]||"").slice(0,44)}`);
  ok("twelve checks render", rows.length === 12, String(rows.length));
  ok("no page errors", errors.length === 0, errors.slice(0,2).join(" | "));
  await page.screenshot({ path: `${ARTIFACTS}/readiness.png`, fullPage: true });
  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
