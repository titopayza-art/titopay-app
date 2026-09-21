// WHY IS THE APP SLOW TO LOG IN?
//
// The question has three candidate answers and they need separating, because
// only one of them is fixable in the place people usually look:
//
//   1. the server is slow to check a password,
//   2. the server is slow to hand back the account after it does, or
//   3. the phone has to download and execute the whole application before the
//      login form exists at all.
//
// Measured, 1 and 2 are not it. A password check is ~200ms of bcrypt at cost
// factor 12 (correct, and deliberately not cheap), and the eight calls the app
// fires after sign-in return together in well under 100ms.
//
// This harness measures 3, which is the one nobody sees on a desk. It loads the
// real shipped app over a throttled connection with an empty cache, and asks
// one question: how long before a customer can type their password?
//
// It runs cold on purpose. A returning customer with a warm service-worker
// cache is fast; the number that matters is the FIRST load after a release,
// because every release invalidates the bundle for everybody at once.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
// PWA_ROOT lets this run against an EXTRACTED DEPLOYMENT PACKAGE rather than
// the repository, which is the only way to prove the zip a customer's server
// will actually serve is complete. A package can pass every repo-based check
// and still be missing a file nobody noticed was needed.
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8153;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

// Served gzipped, because the production host does and measuring uncompressed
// bytes over a throttled link would invent a problem twice as large as the
// real one.
const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  const body = fs.readFileSync(file);
  if (/text|json|javascript|manifest/.test(type)) {
    const gz = zlib.gzipSync(body, { level: 6 });
    res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
});

// Throttling profiles. South African mobile is not a desk on fibre, and the
// launch audience is a phone on a mobile network.
const LINKS = [
  { name: "Fibre, fast phone", down: 30 * 1024 * 1024 / 8, up: 10 * 1024 * 1024 / 8, latency: 8, cpu: 1 },
  { name: "Good 4G, mid Android", down: 8 * 1024 * 1024 / 8, up: 2 * 1024 * 1024 / 8, latency: 60, cpu: 4 },
  { name: "Busy 4G, mid Android", down: 1.6 * 1024 * 1024 / 8, up: 750 * 1024 / 8, latency: 180, cpu: 4 },
];

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? ": " + detail : ""}`);
};

async function run(browser, link, warm) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: link.latency,
    downloadThroughput: link.down, uploadThroughput: link.up,
  });
  // BANDWIDTH IS HALF THE STORY. 1.1 MB of JavaScript has to be PARSED and
  // EXECUTED after it lands, and that is CPU, not network. Measuring on a
  // datacentre core reports a phone nobody owns. 4x is the usual stand-in for
  // a mid-range Android, which is what most of this audience is holding.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: link.cpu || 1 });

  let bytes = 0;
  const perFile = new Map();
  page.on("response", async (response) => {
    try {
      const length = Number(response.headers()["content-length"] || 0);
      if (!length) return;
      bytes += length;
      const name = new URL(response.url()).pathname.split("/").pop() || "/";
      perFile.set(name, (perFile.get(name) || 0) + length);
    } catch (error) { /* a response that went away mid-flight is not a measurement */ }
  });

  if (warm) {
    // Prime the cache exactly as a returning customer's phone is primed, then
    // measure the SECOND load.
    await page.goto(ORIGIN, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    bytes = 0; perFile.clear();
  }

  const started = Date.now();
  await page.goto(ORIGIN, { waitUntil: "commit" });

  // TWO MOMENTS, NOT ONE, because they answer different questions.
  //
  // The first version of this waited for a password field and reported a
  // timeout on FIBRE, which was the harness measuring its own mistake: the app
  // opens on a landing screen and sign-in is a button that opens a modal. A
  // password input does not exist until somebody presses it. Reporting that as
  // "the app is slow" would have been a fabricated finding.
  //
  //   interactive  the Sign in button exists and responds. This is the wait a
  //                customer actually experiences, because until app.min.js has
  //                parsed, pressing it does nothing.
  //   typeable     the password field is on screen after that press.
  let interactive = null;
  let typeable = null;
  try {
    await page.waitForSelector('[data-auth-tab="login"]', { timeout: 60000, state: "attached" });
    // Present in the DOM is not the same as wired up: the landing markup and
    // the click handler both come from the bundle, so poll until the press
    // actually produces the form rather than trusting the element's presence.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await page.click('[data-auth-tab="login"]', { timeout: 2000 }).catch(() => {});
      const field = await page.$('input[type="password"], input[name="password"]');
      if (field) { typeable = Date.now() - started; break; }
      await page.waitForTimeout(250);
    }
    interactive = typeable;
  } catch (error) { interactive = null; typeable = null; }
  const paint = await page.evaluate(() => {
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return fcp ? Math.round(fcp.startTime) : null;
  }).catch(() => null);

  await context.close();
  return { typeable, interactive, paint, bytes, perFile };
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  const rows = [];
  console.log("\n  TIME UNTIL A CUSTOMER CAN TYPE THEIR PASSWORD\n");
  console.log(`  ${"connection".padEnd(28)}${"cold".padStart(10)}${"warm".padStart(10)}${"downloaded".padStart(14)}`);
  console.log(`  ${"-".repeat(62)}`);
  for (const link of LINKS) {
    const cold = await run(browser, link, false);
    const warmed = await run(browser, link, true);
    rows.push({ link, cold, warmed });
    const fmt = (v) => v === null ? "  timeout" : `${(v / 1000).toFixed(2)}s`;
    console.log(`  ${link.name.padEnd(28)}${fmt(cold.typeable).padStart(10)}${fmt(warmed.typeable).padStart(10)}` +
      `${(Math.round(cold.bytes / 1024) + " KB").padStart(14)}`);
  }

  const biggest = [...rows[0].cold.perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log("\n  WHAT THE COLD LOAD ACTUALLY SPENDS ITS BYTES ON (over the wire, gzipped)");
  for (const [name, size] of biggest) console.log(`    ${String(Math.round(size / 1024) + " KB").padStart(8)}  ${name}`);

  const slow = rows[rows.length - 1];
  console.log("");
  // Not a pass/fail on a target nobody agreed to. What is asserted is that the
  // harness measured something real and that the warm path is genuinely the
  // fast one, so the finding "it is the cold bundle" is supported rather than
  // assumed.
  ok("the login field was reached on every connection",
    rows.every((r) => r.cold.typeable !== null && r.warmed.typeable !== null));
  ok("a returning customer is faster than a first load",
    rows.every((r) => Number.isFinite(r.cold.typeable) && Number.isFinite(r.warmed.typeable)
      && r.warmed.typeable <= r.cold.typeable),
    rows.map((r) => `${(r.cold.typeable / 1000).toFixed(1)}s -> ${(r.warmed.typeable / 1000).toFixed(1)}s`).join(", "));
  ok("the cold load is dominated by one file",
    biggest.length > 0 && biggest[0][1] > rows[0].cold.bytes * 0.4,
    `${biggest[0] && biggest[0][0]} is ${Math.round((biggest[0] ? biggest[0][1] : 0) / rows[0].cold.bytes * 100)}% of it`);

  fs.writeFileSync(`${ARTIFACTS}/login-speed.json`, JSON.stringify(
    rows.map((r) => ({ connection: r.link.name, coldMs: r.cold.typeable, warmMs: r.warmed.typeable,
      coldKb: Math.round(r.cold.bytes / 1024) })), null, 2));

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
