// DOES EVERY SERVICE TILE LEAD SOMEWHERE REAL?
//
// A service catalogue is a set of promises. Each tile says: tap this and
// TitoPay will do it. The only way to know whether that is true is to tap all
// of them and look at where you land - which is what this does, against the
// SHIPPED BUNDLE (app.min.js, not the source), for both account types, with
// the API stubbed so every tile has data to render.
//
// Four outcomes, and only two of them are acceptable:
//
//   REAL       a screen opened with something on it - a form, a list, an
//              explanation with a control, a navigation. The promise holds.
//   EXPLAINED  a "not active yet" notice. Acceptable ONLY for a service the
//              catalogue is serving as coming_soon; on an active service it is
//              a broken promise wearing a polite face.
//   EMPTY      a screen opened carrying nothing a customer can read or press.
//   DEAD       nothing happened at all, or an error was raised.
//
// The distinction that matters is EXPLAINED-on-an-active-service. That is the
// failure mode a screenshot never shows and a human tester stops noticing
// after the third tile.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

// THE CATALOGUE EXISTS TWICE, AND THE TWO COPIES DISAGREE.
//
// pwa/services-default.json is the offline fallback the app renders when
// /v1/services cannot be reached. api/src/services/service-management-service.js
// carries the seed the server starts from. They have drifted - Stokvel is
// visible to personal accounts in one and invisible in both account types in
// the other - so a sweep driven by either one alone silently skips whatever
// that copy hides. The first run of this file used the fallback and never
// tapped Stokvel at all.
//
// So the sweep runs against the UNION: every service either copy knows about,
// visible to an account type if EITHER copy shows it there. That is not a
// catalogue the app ever serves, and it is not meant to be - it is the widest
// set of promises the product could make, which is the right set to test for
// dead ends.
const FALLBACK = JSON.parse(fs.readFileSync(path.join(PWA, "services-default.json"), "utf8")).items;

function apiDefaults() {
  const file = path.join(__dirname, "..", "api", "src", "services", "service-management-service.js");
  if (!fs.existsSync(file)) return [];
  const src = fs.readFileSync(file, "utf8");
  const rows = [];
  const pattern = /\["([a-z0-9-]+)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*"(\w+)",\s*(true|false),\s*(true|false),\s*(\d+)/g;
  for (const m of src.matchAll(pattern)) {
    rows.push({ service_code: m[1], service_name: m[2], service_icon: m[3], action: m[4],
      description: m[5], status: m[6], personal_visible: m[7] === "true",
      business_visible: m[8] === "true", sort_order: Number(m[9]), fee: 0, commission: 0,
      feature_badge: "none" });
  }
  return rows;
}

const CATALOGUE = (() => {
  const merged = new Map();
  for (const row of [...FALLBACK, ...apiDefaults()]) {
    const key = row.service_code;
    const seen = merged.get(key);
    if (!seen) { merged.set(key, { ...row }); continue; }
    seen.personal_visible = seen.personal_visible || row.personal_visible;
    seen.business_visible = seen.business_visible || row.business_visible;
    // A service either copy still calls coming_soon is served that way: the
    // stricter claim wins, so nothing is tested as live that one source says
    // is not.
    if (row.status === "coming_soon" || seen.status === "coming_soon") seen.status = "coming_soon";
    if (row.status === "disabled" && seen.status === "disabled") seen.status = "disabled";
  }
  return [...merged.values()];
})();

function user(accountType) {
  return {
    id: "cafe0000-1111-4222-8333-444444444444",
    fullName: "Service Path Probe", username: "servicepathprobe",
    email: "servicepath@titopay.local", phone: "+27820000123",
    accountType, account_type: accountType, status: "active",
    fica_status: "verified", ficaStatus: "verified"
  };
}

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

// Enough of a signed-in account for every screen to have something to draw.
// A tile that renders an empty state because the stub returned nothing would
// otherwise read as a dead end when it is simply a new customer's view.
async function stubApi(context, accountType) {
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/health") return json({ status: "ok" });
    if (p === "/auth/me") return json({ user: user(accountType) });
    if (p === "/services") return json({ items: CATALOGUE });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: accountType, currency: "ZAR",
      available_balance: "2500.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/transactions") return json({ items: [] });
    if (p === "/beneficiaries") return json({ items: [], summary: null });
    if (p === "/qr/profile") return json({ qr: null });
    // Enterprise Distribution's tile is gated on server-side eligibility, not
    // on the catalogue, so a stub that says nothing hides it and the sweep
    // skips it without saying so. Granted here, for business only, which is
    // the only account type the gate can pass anyway.
    if (p === "/enterprise-distribution/eligibility") {
      return json({ eligibility: accountType === "business" ? { eligible: true, reason: "" } : { eligible: false } });
    }
    return json({ items: [], item: null });
  });
}

// What is on the screen right now that was not there before the tap.
async function landing(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".modal-backdrop .modal-card");
    const seen = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 1 && r.height > 1;
    };
    if (!card) {
      return { kind: "none", hash: location.hash, text: "" };
    }
    const text = (card.innerText || "").replace(/\s+/g, " ").trim();
    // Controls a customer can actually operate. A heading and a paragraph is a
    // notice; a notice plus a form or a list is a screen.
    const controls = [...card.querySelectorAll("button, a[href], input, select, textarea")]
      .filter((el) => seen(el) && !el.hasAttribute("data-close")
        && el.getAttribute("data-action") !== "modal-back"
        && (el.getAttribute("aria-label") || "").toLowerCase() !== "close");
    const heading = (card.querySelector("h1, h2, h3") || {}).textContent || "";
    // A SCREEN WITH NOTHING TO SHOW IS STILL A SCREEN, IF IT SAYS SO.
    //
    // The first version counted controls only, and failed Rewards on both
    // account types because an account with no offers has nothing to press.
    // But "No offers right now - when TitoPay publishes promotions they appear
    // here first" is not a dead end; it is the correct answer to the question
    // the customer asked. A written empty state counts as arriving somewhere.
    const emptyState = [...card.querySelectorAll(".empty-state")].find(seen);
    const emptyStateText = emptyState ? (emptyState.innerText || "").replace(/\s+/g, " ").trim() : "";
    // What is NOT acceptable is a screen that never finished. A spinner left
    // on the page after the load settled is a customer staring at nothing.
    const stillLoading = /loading|taking a moment|one moment/i.test(emptyStateText);
    return {
      kind: "modal",
      hash: location.hash,
      heading: heading.trim(),
      text: text.slice(0, 400),
      controls: controls.length,
      // Substantive: a heading plus a sentence explaining the state, not a
      // bare word.
      explainedEmpty: Boolean(emptyState) && !stillLoading && emptyStateText.length >= 40,
      stillLoading,
      notActiveYet: /not active yet|will activate it once operational/i.test(text)
    };
  });
}

// CLOSING A MODAL IS NOT REMOVING ITS DIV.
//
// The first version of this ripped .modal-backdrop out of the DOM. openModal()
// calls lockPageScroll(), which sets `body { position: fixed; top: -<scrollY>px }`
// - so tearing out the backdrop left the body pinned, every tile below the
// first screenful became unclickable, and the sweep reported 26 dead ends that
// were entirely my own doing. The failures even looked plausible: the tiles
// near the top passed and everything further down failed.
//
// So it closes the way the app closes: its own closeModal(), which unlocks the
// scroll. The bundle is a plain top-level script, not an IIFE, so its
// functions are reachable. The DOM sweep stays only as a backstop, and the
// body styles are cleared explicitly either way.
async function closeAnything(page) {
  await page.evaluate(() => {
    try { if (typeof closeModal === "function") closeModal(); } catch { /* fall through */ }
    document.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
    for (const prop of ["position", "top", "left", "right", "width", "overflow"]) {
      document.body.style[prop] = "";
    }
    document.body.classList.remove("modal-open");
    document.documentElement.style.overflow = "";
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(150);
}

// Proves the reset actually worked before the next tap, so a scroll lock can
// never again masquerade as a dead end.
async function bodyIsFree(page) {
  return page.evaluate(() => getComputedStyle(document.body).position !== "fixed"
    && !document.querySelector(".modal-backdrop"));
}

let bad = 0;
const rows = [];

async function sweep(browser, accountType) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubApi(context, accountType);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((u) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user: u }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, user(accountType));
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1500);
  location: {
    const booted = await page.evaluate(() => Boolean(document.querySelector("[data-app-topbar]")));
    if (!booted) { console.log(`  FAIL  ${accountType}: the app did not boot signed in`); bad += 1; break location; }
  }

  // Reach the services screen the customer reaches.
  await page.evaluate(() => { location.hash = "services"; });
  await page.waitForTimeout(900);

  const tiles = await page.evaluate(() => [...document.querySelectorAll(".service-tile")]
    .map((el) => ({
      code: el.getAttribute("data-service-code") || "",
      type: el.getAttribute("data-service-type") || "",
      id: el.getAttribute("data-service") || "",
      label: (el.innerText || "").replace(/\s+/g, " ").trim(),
      soon: /\bsoon\b/i.test(el.innerText || "")
    }))
    .filter((t) => t.id));

  // WHAT THE CATALOGUE OFFERED THAT THE SCREEN NEVER DREW.
  //
  // A tile that is never rendered cannot be tapped, so it passes this sweep by
  // being absent - the quietest way for a dead service to survive an audit.
  // Anything skipped is named, with the reason where the app gives one.
  const rendered = new Set(tiles.map((t) => String(t.id).toLowerCase()));
  const expected = CATALOGUE.filter((row) => row.status !== "disabled"
    && (accountType === "personal" ? row.personal_visible : row.business_visible));
  const missing = expected.filter((row) =>
    !rendered.has(String(row.action || "").toLowerCase()) && !rendered.has(String(row.service_code).toLowerCase()));

  console.log(`\n  ${accountType.toUpperCase()} — ${tiles.length} tiles rendered`);
  if (missing.length) {
    console.log(`  offered by a catalogue but not drawn: ${missing.map((r) => r.service_code).join(", ")}`);
  }
  console.log("");

  for (const tile of tiles) {
    await closeAnything(page);
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(250);
    if (!(await bodyIsFree(page))) {
      console.log(`  FAIL  ${tile.id}: the harness did not reset the page before this tap`);
      bad += 1;
      continue;
    }
    let thrown = "";
    try {
      const target = page.locator(`.service-tile[data-service="${tile.id}"]`).first();
      await target.scrollIntoViewIfNeeded({ timeout: 5000 });
      await target.click({ timeout: 8000 });
    } catch (error) { thrown = String(error.message).split("\n")[0]; }
    await page.waitForTimeout(900);
    const where = await landing(page);

    // Classify.
    let verdict;
    if (thrown) verdict = "DEAD";
    else if (where.kind === "none") {
      // A hash change is a real destination too - Activity and the dashboards
      // are screens, not modals.
      verdict = where.hash && where.hash !== "#services" ? "REAL" : "DEAD";
    } else if (where.notActiveYet) verdict = "EXPLAINED";
    else if (where.stillLoading) verdict = "STUCK";
    else if (where.controls === 0 && !where.explainedEmpty) verdict = "EMPTY";
    else if (where.controls === 0 && where.explainedEmpty) verdict = "REAL (empty state)";
    else verdict = "REAL";

    const catalogued = CATALOGUE.find((row) =>
      row.service_code === tile.code || row.action === tile.id || row.service_code === tile.id);
    const servedStatus = catalogued ? catalogued.status : "(not in catalogue)";
    const acceptable = verdict.startsWith("REAL")
      || (verdict === "EXPLAINED" && (tile.soon || servedStatus === "coming_soon"));
    if (!acceptable) bad += 1;

    rows.push({ accountType, tile: tile.id, label: tile.label.split("\n")[0], servedStatus, verdict, acceptable,
      detail: thrown || where.heading || where.hash || where.text.slice(0, 60) });

    console.log(`  ${acceptable ? "ok  " : "FAIL"} ${String(tile.id).padEnd(26)}${String(servedStatus).padEnd(13)}${String(verdict).padEnd(11)}${(thrown || where.heading || where.hash || "").slice(0, 46)}`);
  }

  if (errors.length) {
    console.log(`\n  page errors during the sweep: ${errors.slice(0, 3).join(" | ")}`);
    bad += errors.length;
  }
  await page.screenshot({ path: `${ARTIFACTS}/service-paths-${accountType}.png` });
  await context.close();
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  for (const accountType of ["personal", "business"]) await sweep(browser, accountType);
  await browser.close(); server.close();

  const failures = rows.filter((r) => !r.acceptable);
  console.log(`\n  ${rows.length} tiles tapped across both account types`);
  if (failures.length) {
    console.log(`\n  TILES WITHOUT A REAL PATH:`);
    for (const row of failures) {
      console.log(`    ${row.accountType.padEnd(9)} ${row.tile.padEnd(26)} served ${row.servedStatus.padEnd(12)} ${row.verdict}  ${row.detail}`);
    }
  }
  fs.writeFileSync(`${ARTIFACTS}/service-paths.json`, JSON.stringify(rows, null, 2));
  console.log(bad ? `\n${bad} check(s) failed` : "\nevery tile leads somewhere real");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
