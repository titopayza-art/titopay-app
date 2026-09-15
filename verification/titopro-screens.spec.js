// TITOPRO ON A REAL PHONE SCREEN.
//
// The API tests prove the rules. They cannot prove the half a customer
// actually meets, and that half is where this feature lives or dies:
//
//   1. the browse grid renders every profession the API publishes, grouped;
//   2. a professional is told which work needs a background check BEFORE
//      they fill the form in;
//   3. the right buttons appear for the right side of a job - a customer must
//      never see "Send quote" and a professional must never see "Accept";
//   4. a blocked listing says exactly what is outstanding;
//   5. the money on screen is the money the API quoted, not a second sum
//      worked out in the client;
//   6. nothing overflows at 360px.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/titopro-screens.spec.js
//
// PWA_ROOT overrides the app directory so an extracted app.zip is tested
// exactly as it will be deployed.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const API = "https://api.titopay.co.za";
const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".jpg": "image/jpeg" };

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    const resolved = path.join(PWA_ROOT, file);
    if (!resolved.startsWith(PWA_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// The API, answering exactly as the real one does.
const PROFESSIONS = [
  { key: "plumber", label: "Plumber", group: "Home repairs", shape: "callout", hint: "Burst pipes, geysers, blocked drains", usesDiary: true, requiredChecks: [] },
  { key: "electrician", label: "Electrician", group: "Home repairs", shape: "callout", hint: "Faults, DB boards, certificates of compliance", usesDiary: true, requiredChecks: [] },
  { key: "painter", label: "Painter", group: "Home improvement", shape: "project", hint: "Interior and exterior painting", usesDiary: false, requiredChecks: [] },
  { key: "cleaner", label: "Cleaner", group: "Home care", shape: "recurring", hint: "Home and office cleaning", usesDiary: true,
    requiredChecks: [{ key: "police_clearance", label: "Police clearance", says: "A SAPS Police Clearance Certificate." },
      { key: "reference_check", label: "References", says: "Two contactable references." }] },
  { key: "bookkeeper", label: "Bookkeeper", group: "Professional", shape: "remote", hint: "Books, VAT and SARS submissions", usesDiary: false, requiredChecks: [] }
];

const JOB = {
  id: "11111111-1111-4111-8111-111111111111", reference: "TP-J-K7M2QRXP", status: "quoted",
  profession: "plumber", professionLabel: "Plumber", shape: "callout", shapeLabel: "Call-out",
  bookingWord: "Job", title: "Blocked kitchen drain", description: "Water comes back up.",
  quotedAmount: 850, customerFee: 5, professionalFee: 32.75, usesDiary: true,
  certificateRequired: false, certificateReference: null, outstandingChecks: []
};

async function openApp(browser, width, routes) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    const key = Object.keys(routes).find((candidate) => url.pathname.endsWith(candidate) || url.pathname.includes(candidate));
    const body = key ? routes[key] : { ok: true };
    await route.fulfill({ status: body.__status || 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${global.__port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.openTitoProModal === "function", null, { timeout: 15000 });
  // A signed-in customer, so the screens behave as they will in the app.
  await page.evaluate(() => window.saveAuth({ accessToken: "a", refreshToken: "r" }));
  return { context, page, errors };
}

const CATALOGUE = { ok: true, shapes: [], professions: PROFESSIONS };

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> TitoPro screens");
  console.log("=============================================================\n");

  const server = await serve();
  global.__port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    // ---- 1. Browse -------------------------------------------------------
    let s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE });
    await s.page.evaluate(() => window.openTitoProModal());
    await s.page.waitForSelector(".tp-pro-row", { timeout: 10000 });

    const browse = await s.page.evaluate(() => ({
      // Scoped to the profession groups. .tp-group-title is also used by the
      // "Do this for a living?" panel, which is not a profession group.
      groups: [...document.querySelectorAll(".tp-group > .tp-group-title")].map((el) => el.textContent.trim()),
      rows: [...document.querySelectorAll(".tp-pro-row")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
      flagged: [...document.querySelectorAll(".tp-pro-row")].filter((el) => el.querySelector(".tp-flag"))
        .map((el) => el.querySelector(".tp-pro-name").textContent.trim())
    }));
    check("every profession the API publishes is on the grid", browse.rows.length === PROFESSIONS.length, `${browse.rows.length} rows`);
    check("they are grouped the way the API groups them",
      browse.groups.join("|") === "Home repairs|Home improvement|Home care|Professional", browse.groups.join(" · "));
    check("VETTED work is flagged before the form is opened",
      browse.flagged.length === 1 && browse.flagged[0] === "Cleaner", browse.flagged.join(", "));
    check("no page errors", s.errors.length === 0, s.errors.join(" | "));
    await s.context.close();

    // ---- 2. A customer's job: the right buttons --------------------------
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE, "/v1/titopro/jobs/": { ok: true, job: JOB } });
    await s.page.evaluate((job) => { window.titoProState().role = "customer"; return window.openTitoProJob(job.id); }, JOB);
    await s.page.waitForSelector(".tp-steps", { timeout: 10000 });
    const asCustomer = await s.page.evaluate(() => ({
      buttons: [...document.querySelectorAll(".tp-steps .btn")].map((b) => b.textContent.trim()),
      forms: [...document.querySelectorAll(".tp-steps form")].map((f) => f.dataset.form),
      money: [...document.querySelectorAll(".tp-money div")].map((d) => d.textContent.replace(/\s+/g, " ").trim())
    }));
    check("a customer is offered Accept and Decline",
      asCustomer.buttons.some((b) => /^Accept/.test(b)) && asCustomer.buttons.includes("Decline"), asCustomer.buttons.join(" · "));
    check("A CUSTOMER IS NEVER OFFERED THE QUOTE FORM",
      !asCustomer.forms.includes("titopro-quote"), asCustomer.forms.join(",") || "none");
    check("the customer sees what THEY pay, from the API's own figures",
      // Matched on the DIGITS, not on a rendering. The app formats money with
      // Intl.NumberFormat("en-ZA"), so the separator and the space after the R
      // are the platform's choice and differ between a headless browser and a
      // real handset. What must be right is 855 - the job plus the fee.
      asCustomer.money.some((line) => /You pay\s*R\s*855[.,]00/.test(line)), asCustomer.money.join(" | "));
    check("TitoPro uses the app's ONE money formatter, not a second one",
      await s.page.evaluate(() => window.titoProMoney(855) === window.money(855)), "titoProMoney === money");
    check("the accept button carries the total, not the bare job price",
      asCustomer.buttons.some((b) => /R\s*855[.,]00/.test(b)), asCustomer.buttons.find((b) => /Accept/.test(b)) || "");
    await s.context.close();

    // ---- 3. The professional's side of the same job ----------------------
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/jobs/": { ok: true, job: { ...JOB, status: "requested", quotedAmount: null } } });
    await s.page.evaluate((job) => { window.titoProState().role = "professional"; return window.openTitoProJob(job.id); }, JOB);
    await s.page.waitForSelector(".tp-steps", { timeout: 10000 });
    const asPro = await s.page.evaluate(() => ({
      forms: [...document.querySelectorAll(".tp-steps form")].map((f) => f.dataset.form),
      buttons: [...document.querySelectorAll(".tp-steps .btn")].map((b) => b.textContent.trim()),
      hint: document.querySelector(".tp-steps .field-hint")?.textContent.trim() || ""
    }));
    check("a professional is offered the quote form", asPro.forms.includes("titopro-quote"), asPro.forms.join(","));
    check("A PROFESSIONAL IS NEVER OFFERED ACCEPT",
      !asPro.buttons.some((b) => /^Accept/.test(b)), asPro.buttons.join(" · "));
    check("and is told what TitoPay will charge them", /R20 plus 1,5%/.test(asPro.hint), asPro.hint.slice(0, 60));
    await s.context.close();

    // ---- 4. The electrician's certificate gate, on screen ---------------
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/jobs/": { ok: true, job: { ...JOB, status: "in_progress", profession: "electrician",
        professionLabel: "Electrician", certificateRequired: true } } });
    await s.page.evaluate((job) => { window.titoProState().role = "professional"; return window.openTitoProJob(job.id); }, JOB);
    await s.page.waitForSelector('form[data-form="titopro-done"]', { timeout: 10000 });
    const coc = await s.page.evaluate(() => {
      const form = document.querySelector('form[data-form="titopro-done"]');
      return { required: Boolean(form.querySelector('[name="certificateReference"]')?.required),
        hint: form.querySelector(".field-hint")?.textContent.trim() || "" };
    });
    check("an electrician cannot mark done without the certificate field", coc.required === true);
    check("and is told why it matters", /sell/i.test(coc.hint), coc.hint.slice(0, 70));
    await s.context.close();

    // ---- 5. A blocked listing says what is outstanding -------------------
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": { ok: true,
        profile: { status: "draft", professions: ["cleaner"], serviceRadiusKm: 20,
          outstandingChecks: ["Police clearance", "References"], enhancedVettingProfessions: ["cleaner"] },
        eligibility: { eligible: false, ficaVerified: true,
          blockers: ["Before you can offer this work TitoPay needs: Police clearance and References. Contact TitoPay support to start the checks."] } } });
    await s.page.evaluate(() => window.openTitoProListing());
    await s.page.waitForSelector(".tp-banner", { timeout: 10000 });
    const blocked = await s.page.evaluate(() => ({
      banner: document.querySelector(".tp-banner")?.textContent.replace(/\s+/g, " ").trim() || "",
      blockedClass: document.querySelector(".tp-banner")?.className || "",
      missing: [...document.querySelectorAll(".tp-check.is-missing")].map((el) => el.textContent.trim()),
      picks: [...document.querySelectorAll(".tp-pick")].length,
      shields: [...document.querySelectorAll(".tp-pick em")].length
    }));
    check("a blocked listing says exactly what is outstanding",
      /Police clearance and References/.test(blocked.banner), blocked.banner.slice(0, 80));
    check("and it reads as blocked, not as an error", blocked.blockedClass.includes("is-blocked"));
    check("each missing check is listed on its own", blocked.missing.length === 2, blocked.missing.join(" · "));
    check("the picker marks which work needs a check", blocked.shields === 1 && blocked.picks === 5,
      `${blocked.shields} shield of ${blocked.picks} services`);
    await s.context.close();

    // ---- 5b. THREE STATES, AND THE SCREEN IS WHICHEVER ONE IS TRUE -------
    // The same shape as Book. A plumber opening TitoPro wants their work;
    // somebody with a blocked drain wants a plumber. Landing both on the same
    // grid of other people's listings serves neither.
    const LIVE = { status: "published", professions: ["plumber"], professionLabels: ["Plumber"],
      suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25, outstandingChecks: [], enhancedVettingProfessions: [] };

    // No listing -> find somebody, with a plain route to offering your own.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE, "/v1/titopro/me/listing": { ok: true, profile: null } });
    await s.page.evaluate(() => window.openTitoProModal());
    await s.page.waitForSelector(".tp-pro-row", { timeout: 10000 });
    const noListing = await s.page.evaluate(() => ({
      heading: document.querySelector(".modal-head h2")?.textContent.trim(),
      offersListing: Boolean(document.querySelector('[data-action="titopro-listing"]')),
      offerCopy: document.querySelector(".tp-offer")?.textContent.replace(/\s+/g, " ").trim() || ""
    }));
    check("NO LISTING · lands on finding somebody", noListing.heading === "TitoPro", noListing.heading);
    check("NO LISTING · and offers a route to listing", noListing.offersListing);
    check("NO LISTING · which says listing itself is free",
      /pay nothing to be listed/.test(noListing.offerCopy), noListing.offerCopy.slice(0, 70));
    await s.context.close();

    // A DRAFT -> what is still missing, not a grid of competitors.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": { ok: true, profile: { ...LIVE, status: "draft" },
        eligibility: { eligible: false, ficaVerified: false, blockers: ["Complete your FICA verification before you can be listed."] } } });
    await s.page.evaluate(() => window.openTitoProModal());
    await s.page.waitForSelector(".tp-banner", { timeout: 10000 });
    const draft = await s.page.evaluate(() => ({
      heading: document.querySelector(".modal-head h2")?.textContent.trim(),
      banner: document.querySelector(".tp-banner")?.textContent.replace(/\s+/g, " ").trim() || ""
    }));
    check("DRAFT · lands on finishing the listing", draft.heading === "Offer my services", draft.heading);
    check("DRAFT · and says what is missing", /FICA verification/.test(draft.banner), draft.banner.slice(0, 60));
    await s.context.close();

    // LIVE -> their work, with the jobs that need them first.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": { ok: true, profile: LIVE, eligibility: { eligible: true, ficaVerified: true, blockers: [] } },
      "/v1/titopro/jobs": { ok: true, jobs: [
        { ...JOB, status: "requested", title: "Blocked kitchen drain" },
        { ...JOB, id: "22222222-2222-4222-8222-222222222222", status: "confirmed", title: "Tap replaced" }
      ] } });
    await s.page.evaluate(() => window.openTitoProModal());
    await s.page.waitForSelector(".tp-banner.is-live", { timeout: 10000 });
    const live = await s.page.evaluate(() => ({
      heading: document.querySelector(".modal-head h2")?.textContent.trim(),
      count: document.querySelector(".tp-group-title")?.textContent.trim() || "",
      rows: [...document.querySelectorAll(".tp-list .tp-pro-row")].map((el) => el.querySelector(".tp-pro-name").textContent.trim()),
      canHire: Boolean(document.querySelector('[data-action="titopro-hire"]'))
    }));
    check("LIVE · lands on their own work, not a grid of competitors", live.heading === "Your work", live.heading);
    check("LIVE · only the jobs that still need them are on the front screen",
      live.rows.length === 1 && live.rows[0] === "Blocked kitchen drain", live.rows.join(" · "));
    check("LIVE · counted in words a person would use", live.count === "One job needs you", live.count);
    check("A LIVE PROFESSIONAL CAN STILL HIRE SOMEBODY", live.canHire === true,
      "their own geyser bursts too");
    await s.context.close();

    // A PAUSED listing says so, rather than leaving an empty inbox unexplained.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": { ok: true, profile: { ...LIVE, status: "paused" }, eligibility: { eligible: true, blockers: [] } },
      "/v1/titopro/jobs": { ok: true, jobs: [] } });
    await s.page.evaluate(() => window.openTitoProModal());
    await s.page.waitForSelector(".tp-banner", { timeout: 10000 });
    const paused = await s.page.evaluate(() => document.querySelector(".tp-banner")?.textContent.replace(/\s+/g, " ").trim() || "");
    check("PAUSED · an empty inbox is explained, not left a mystery",
      /paused/i.test(paused) && /Nobody can find you/.test(paused), paused.slice(0, 70));
    await s.context.close();

    // ---- 6. Narrow phone -------------------------------------------------
    for (const width of [360, 414]) {
      s = await openApp(browser, width, { "/v1/titopro/professions": CATALOGUE });
      await s.page.evaluate(() => window.openTitoProModal());
      await s.page.waitForSelector(".tp-pro-row", { timeout: 10000 });
      const fit = await s.page.evaluate(() => {
        const spill = [...document.querySelectorAll(".tp-pro-row, .tp-group-title, .tp-note")]
          .filter((el) => el.scrollWidth - el.clientWidth > 1)
          .map((el) => el.textContent.trim().slice(0, 30));
        return { spill, bodyScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      check(`${width}px · nothing overflows its row`, fit.spill.length === 0, fit.spill.join(", "));
      check(`${width}px · the page does not scroll sideways`, fit.bodyScroll <= 1, `${fit.bodyScroll}px`);
      await s.context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
