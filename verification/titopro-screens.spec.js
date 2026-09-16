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

// THE CATALOGUE, BUILT FROM THE API'S OWN CONFIG RATHER THAN TYPED AGAIN.
//
// This was a hand-written list of five professions, which meant the harness
// could pass while the picker was missing a profession the platform actually
// offers - the fixture was the thing being tested. It is now derived from
// config/titopro-reference.js and shaped exactly as GET /titopro/professions
// shapes it, so a profession added there appears here on the next run and one
// removed there cannot linger.
const reference = require("../api/src/config/titopro-reference");
const PROFESSIONS = reference.PROFESSIONS.map((item) => ({
  key: item.key,
  label: item.label,
  group: item.group,
  shape: item.shape,
  hint: item.hint,
  usesDiary: reference.usesBookingDiary(item.key),
  requiredChecks: reference.requiredChecksFor(item.key).map((check) => ({
    key: check,
    label: reference.vettingCheck(check).label,
    says: reference.vettingCheck(check).says
  }))
}));


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

const CATALOGUE = { ok: true, shapes: [], professions: PROFESSIONS, vettingAdvisory: reference.VETTING_ADVISORY };

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
    // Derived, not listed: the browse grid must flag exactly the professions
    // the reference marks as needing enhanced vetting - no more, and crucially
    // no fewer, since a missing shield is a customer told nothing about who is
    // coming into their house.
    const ENHANCED = reference.PROFESSIONS.filter((item) => reference.requiresEnhancedVetting(item.key))
      .map((item) => item.label).sort();
    check("VETTED work is flagged before the form is opened",
      browse.flagged.slice().sort().join("|") === ENHANCED.join("|"),
      `flagged ${browse.flagged.join(", ")} / expected ${ENHANCED.join(", ")}`);
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
    check("the picker marks which work needs a check",
      blocked.shields === reference.PROFESSIONS.filter((item) => reference.requiresEnhancedVetting(item.key)).length
        && blocked.picks === reference.PROFESSIONS.length,
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

    // ---- 5c. RATING A FINISHED JOB, AND REPORTING A LISTING --------------
    // The three things a customer does AFTER the work: score it, read what
    // other people scored, and tell TitoPay when it went wrong.
    const CONFIRMED = { ...JOB, status: "confirmed", professionalUserId: "33333333-3333-4333-8333-333333333333" };

    // A finished job offers the rating, once.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/rating": { ok: true, rating: null },
      "/v1/titopro/jobs/": { ok: true, job: CONFIRMED } });
    await s.page.evaluate((job) => { window.titoProState().role = "customer"; return window.openTitoProJob(job.id); }, CONFIRMED);
    await s.page.waitForSelector(".tp-steps", { timeout: 10000 });
    const finished = await s.page.evaluate(() => ({
      buttons: [...document.querySelectorAll(".tp-steps .btn")].map((b) => b.textContent.trim()),
      canRate: Boolean(document.querySelector('[data-action^="titopro-rate:"]')),
      canReport: Boolean(document.querySelector('[data-action^="titopro-report:"]')),
      canCancel: Boolean(document.querySelector('[data-action$=":cancel"]'))
    }));
    check("a finished job offers the rating", finished.canRate === true, finished.buttons.join(" · "));
    check("and a route to report the professional", finished.canReport === true);
    check("a finished job cannot be cancelled", finished.canCancel === false);
    await s.context.close();

    // Once rated, the button is gone and the score is shown instead.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/rating": { ok: true, rating: { id: "r1", stars: 4, word: "Good", comment: "Good job." } },
      "/v1/titopro/jobs/": { ok: true, job: CONFIRMED } });
    await s.page.evaluate((job) => { window.titoProState().role = "customer"; return window.openTitoProJob(job.id); }, CONFIRMED);
    await s.page.waitForSelector(".tp-rated", { timeout: 10000 });
    const rated = await s.page.evaluate(() => ({
      copy: document.querySelector(".tp-rated")?.textContent.replace(/\s+/g, " ").trim() || "",
      lit: document.querySelectorAll(".tp-rated .tp-star.is-on").length,
      dim: document.querySelectorAll(".tp-rated .tp-star:not(.is-on)").length,
      stillOffered: Boolean(document.querySelector('[data-action^="titopro-rate:"]'))
    }));
    check("A RATED JOB IS NOT OFFERED THE FORM AGAIN", rated.stillOffered === false, rated.copy);
    check("four stars are drawn as four lit and one dim", rated.lit === 4 && rated.dim === 1,
      `${rated.lit} lit, ${rated.dim} dim`);

    // The form itself: five choices, and it says the rating is final.
    await s.page.evaluate((job) => window.openTitoProRate(job.id), CONFIRMED);
    await s.page.waitForSelector(".tp-rate-row", { timeout: 10000 });
    const form = await s.page.evaluate(() => ({
      choices: [...document.querySelectorAll('.tp-rate-pick input[name="stars"]')].map((i) => i.value),
      labelled: [...document.querySelectorAll('.tp-rate-pick input')].every((i) => i.getAttribute("aria-label")),
      lead: document.querySelector(".modal-head .lead")?.textContent.replace(/\s+/g, " ").trim() || "",
      hint: document.querySelector('form[data-form="titopro-rate"] .field-hint')?.textContent.trim() || ""
    }));
    check("the rating picker offers exactly one to five",
      form.choices.join(",") === "1,2,3,4,5", form.choices.join(","));
    check("every star is reachable with a screen reader", form.labelled === true);
    check("AND THE CUSTOMER IS TOLD IT CANNOT BE CHANGED",
      /cannot be changed/i.test(form.lead), form.lead.slice(0, 70));
    check("and that their first name goes with the words",
      /first name/i.test(form.hint), form.hint.slice(0, 70));
    await s.context.close();

    // A professional's page: the score, and what customers actually wrote.
    const PRO_PAGE = { ok: true, professional: {
      userId: "33333333-3333-4333-8333-333333333333", name: "Sipho Ndlovu",
      professions: ["plumber"], professionLabels: ["Plumber"], headline: "Drains and geysers",
      suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25, ficaVerified: true,
      rating: 4.3, ratingCount: 3,
      reviews: [
        { id: "r1", stars: 5, by: "Thandi", profession: "Plumber", comment: "On time, cleaned up after himself.", commentHidden: false },
        { id: "r2", stars: 4, by: "Lerato", profession: "Plumber", comment: null, commentHidden: true }
      ] } };
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE, "/professionals/": PRO_PAGE });
    await s.page.evaluate((id) => window.openTitoProProfessional(id), PRO_PAGE.professional.userId);
    await s.page.waitForSelector(".tp-reviews", { timeout: 10000 });
    const page = await s.page.evaluate(() => ({
      score: document.querySelector(".tp-card .tp-score")?.textContent.replace(/\s+/g, " ").trim() || "",
      reviews: [...document.querySelectorAll(".tp-review")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
      bodies: [...document.querySelectorAll(".tp-review-body")].length,
      canReport: Boolean(document.querySelector('[data-action^="titopro-report:"]')),
      note: document.querySelector(".tp-reviews .tp-note")?.textContent.replace(/\s+/g, " ").trim() || ""
    }));
    check("the score is shown in South African decimals", /4,3/.test(page.score), page.score);
    check("with how many ratings it is built on", /3 ratings/.test(page.score), page.score);
    check("every review is on the page", page.reviews.length === 2, `${page.reviews.length} reviews`);
    check("A HIDDEN COMMENT LOSES ITS WORDS AND KEEPS ITS STAR",
      page.bodies === 1 && page.reviews[1].includes("Lerato"), `${page.bodies} comment(s) of 2 reviews`);
    check("only paid, finished jobs can be rated, and the page says so",
      /only once/i.test(page.note), page.note.slice(0, 80));
    check("the listing can be reported from the page", page.canReport === true);
    await s.context.close();

    // A NEW PROFESSIONAL IS NOT A BAD ONE. Five empty stars read as nought out
    // of five, and nobody ever gives that person a first job.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/professionals/": { ok: true, professional: { ...PRO_PAGE.professional, rating: null, ratingCount: 0, reviews: [] } } });
    await s.page.evaluate((id) => window.openTitoProProfessional(id), PRO_PAGE.professional.userId);
    await s.page.waitForSelector(".tp-score", { timeout: 10000 });
    const fresh = await s.page.evaluate(() => ({
      score: document.querySelector(".tp-score")?.textContent.replace(/\s+/g, " ").trim() || "",
      stars: document.querySelectorAll(".tp-card .tp-star").length,
      reviews: document.querySelectorAll(".tp-review").length
    }));
    check("AN UNRATED PROFESSIONAL READS AS NEW, NOT AS NOUGHT",
      /New on TitoPro/.test(fresh.score) && fresh.stars === 0, `"${fresh.score}", ${fresh.stars} stars drawn`);
    check("and shows no empty review list", fresh.reviews === 0);
    await s.context.close();

    // Reporting: the reasons come from the API, never from a second copy here.
    const REASONS = { ok: true, reasons: [
      { key: "off_platform_payment", label: "Asked me to pay outside TitoPay", says: "They wanted cash or an EFT." },
      { key: "no_show", label: "Did not arrive", says: "They accepted the job and never came." },
      { key: "other", label: "Something else", says: "Tell us what happened." } ] };
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/my-report": { ok: true, report: null }, "/report-reasons": REASONS });
    await s.page.evaluate((id) => window.openTitoProReport(id), PRO_PAGE.professional.userId);
    await s.page.waitForSelector('form[data-form="titopro-report"]', { timeout: 10000 });
    const report = await s.page.evaluate(() => ({
      options: [...document.querySelectorAll('select[name="category"] option')].map((o) => o.value),
      required: Boolean(document.querySelector('[name="detail"]')?.required),
      hint: document.querySelector('form[data-form="titopro-report"] .field-hint')?.textContent.replace(/\s+/g, " ").trim() || "",
      note: document.querySelector('form[data-form="titopro-report"] .tp-note')?.textContent.replace(/\s+/g, " ").trim() || ""
    }));
    check("the reasons are exactly the ones the API serves",
      report.options.join(",") === "off_platform_payment,no_show,other", report.options.join(","));
    check("a report cannot be sent with no words", report.required === true);
    check("THE REPORTER IS TOLD THEY ARE NOT IDENTIFIED TO THE PROFESSIONAL",
      /never shown what you wrote or who reported them/i.test(report.hint), report.hint.slice(0, 80));
    check("and that a report is not an emergency service",
      /10111/.test(report.note), report.note.slice(0, 80));
    await s.context.close();

    // Reporting the same listing twice is answered, not silently refused.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/my-report": { ok: true, report: { id: "x", reference: "TP-R-ABCD2345", categoryLabel: "Did not arrive", status: "open" } },
      "/report-reasons": REASONS });
    await s.page.evaluate((id) => window.openTitoProReport(id), PRO_PAGE.professional.userId);
    await s.page.waitForSelector(".tp-banner", { timeout: 10000 });
    const already = await s.page.evaluate(() => ({
      banner: document.querySelector(".tp-banner")?.textContent.replace(/\s+/g, " ").trim() || "",
      formOffered: Boolean(document.querySelector('form[data-form="titopro-report"]'))
    }));
    check("A SECOND REPORT IS NOT OFFERED A FORM THAT WOULD BE REFUSED",
      already.formOffered === false, already.banner.slice(0, 60));
    check("and the first report is shown not to have been lost",
      /TP-R-ABCD2345/.test(already.banner) && /looking at it/i.test(already.banner), already.banner.slice(0, 90));
    await s.context.close();

    // ---- 5d. A LISTING TITOPAY TOOK DOWN --------------------------------
    // The professional is told plainly, and is not offered a "Go live" button
    // that can only ever say no.
    for (const [action, wording] of [["suspended", /suspended your listing/i], ["removed", /removed your listing/i]]) {
      s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
        "/v1/titopro/me/listing": { ok: true,
          profile: { status: "suspended", adminAction: action, professions: ["plumber"], serviceRadiusKm: 20,
            outstandingChecks: [], enhancedVettingProfessions: [],
            unpublishedReason: `TitoPay has ${action} this listing. Contact support.` },
          eligibility: { eligible: true, ficaVerified: true, blockers: [] } } });
      await s.page.evaluate(() => window.openTitoProListing());
      await s.page.waitForSelector(".tp-banner.is-blocked", { timeout: 10000 });
      const takedown = await s.page.evaluate(() => ({
        banner: document.querySelector(".tp-banner")?.textContent.replace(/\s+/g, " ").trim() || "",
        goLive: Boolean(document.querySelector('[data-action="titopro-publish"]'))
      }));
      check(`${action.toUpperCase()} · the professional is told TitoPay did it`,
        wording.test(takedown.banner), takedown.banner.slice(0, 70));
      check(`${action.toUpperCase()} · NO GO-LIVE BUTTON THAT CAN ONLY SAY NO`, takedown.goLive === false);
      check(`${action.toUpperCase()} · and support is the route, not a retry`,
        /support/i.test(takedown.banner), takedown.banner.slice(0, 90));
      await s.context.close();
    }

    // ---- 5f. THE LISTING CARRIES A NAME, PHOTOS, TERMS AND A WAY TO TALK -
    const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const FULL_PAGE = { ok: true, professional: { ...PRO_PAGE.professional,
      verifiedName: "Sipho Ndlovu", name: "Sipho's Plumbing",
      terms: "Call-out fee R250, payable whether or not the job goes ahead.",
      photos: [PHOTO, PHOTO, PHOTO] } };

    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE, "/professionals/": FULL_PAGE });
    await s.page.evaluate((id) => window.openTitoProProfessional(id), FULL_PAGE.professional.userId);
    await s.page.waitForSelector(".tp-gallery", { timeout: 10000 });
    const proPage = await s.page.evaluate(() => ({
      heading: document.querySelector(".modal-head h2")?.textContent.trim() || "",
      verified: document.querySelector(".tp-verified-line")?.textContent.replace(/\s+/g, " ").trim() || "",
      photos: document.querySelectorAll(".tp-gallery img").length,
      terms: document.querySelector(".tp-terms")?.textContent.trim() || "",
      termsNote: [...document.querySelectorAll(".tp-note")].map((el) => el.textContent.trim()).join(" | "),
      canMessage: Boolean(document.querySelector('[data-action^="titopro-chat-pro:"]'))
    }));
    check("the page is headed by the name they trade under",
      proPage.heading === "Sipho's Plumbing", proPage.heading);
    check("AND THE IDENTITY TITOPAY ACTUALLY CHECKED IS SHOWN BESIDE IT",
      /Sipho Ndlovu/.test(proPage.verified), proPage.verified);
    check("their photos are on the page", proPage.photos === 3, `${proPage.photos} photos`);
    check("so are their terms", /Call-out fee R250/.test(proPage.terms), proPage.terms.slice(0, 50));
    check("SAID TO BE THEIRS, NOT TITOPAY'S",
      /not TitoPay's/.test(proPage.termsNote), proPage.termsNote.slice(0, 70));
    check("and a customer can message them before raising a job", proPage.canMessage === true);
    await s.context.close();

    // The listing form: the new fields, and the Other box appearing only when
    // Other is actually chosen.
    const DRAFT_LISTING = (professions, extra = {}) => ({ ok: true,
      profile: { status: "draft", professions, professionLabels: [], serviceRadiusKm: 20,
        tradingName: "Sipho's Plumbing", outstandingChecks: [], enhancedVettingProfessions: [],
        photos: [PHOTO], terms: "Deposit of 50% on projects over R5 000.", ...extra },
      eligibility: { eligible: true, ficaVerified: true, blockers: [] } });

    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": DRAFT_LISTING(["plumber"]) });
    await s.page.evaluate(() => window.openTitoProListing());
    await s.page.waitForSelector(".tp-photo-grid", { timeout: 10000 });
    const listingForm = await s.page.evaluate(() => ({
      tradingName: document.querySelector('[name="tradingName"]')?.value || "",
      required: Boolean(document.querySelector('[name="tradingName"]')?.required),
      terms: document.querySelector('[name="terms"]')?.value || "",
      photos: document.querySelectorAll(".tp-photo img").length,
      canRemove: Boolean(document.querySelector('[data-action^="titopro-photo-remove:"]')),
      canAdd: Boolean(document.querySelector("[data-titopro-photo-input]")),
      otherBox: Boolean(document.querySelector('[name="otherService"]'))
    }));
    check("the listing form asks for a name, and insists on one",
      listingForm.tradingName === "Sipho's Plumbing" && listingForm.required === true, listingForm.tradingName);
    check("it carries the saved photos, each removable",
      listingForm.photos === 1 && listingForm.canRemove && listingForm.canAdd, `${listingForm.photos} photo(s)`);
    check("and the professional's own terms", /50%/.test(listingForm.terms), listingForm.terms.slice(0, 40));
    check("NO \"OTHER\" BOX WHEN OTHER IS NOT CHOSEN", listingForm.otherBox === false);
    await s.context.close();

    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": DRAFT_LISTING(["other"], { otherService: "Welding, gates and burglar bars" }) });
    await s.page.evaluate(() => window.openTitoProListing());
    await s.page.waitForSelector('[name="otherService"]', { timeout: 10000 });
    const other = await s.page.evaluate(() => ({
      value: document.querySelector('[name="otherService"]')?.value || "",
      hint: document.querySelector('[name="otherService"]')?.closest(".field")?.querySelector(".field-hint")?.textContent.trim() || ""
    }));
    check("CHOOSING OTHER ASKS WHAT THE WORK IS", /Welding/.test(other.value), other.value);
    check("and says the listing cannot go live without it",
      /cannot go live/i.test(other.hint), other.hint.slice(0, 70));
    await s.context.close();

    // The three professions the picker must now offer.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE,
      "/v1/titopro/me/listing": DRAFT_LISTING(["plumber"]) });
    await s.page.evaluate(() => window.openTitoProListing());
    await s.page.waitForSelector(".tp-picks", { timeout: 10000 });
    const offered = await s.page.evaluate(() =>
      [...document.querySelectorAll('.tp-pick input[name="professions"]')].map((input) => input.value));
    for (const key of ["graphic_designer", "web_developer", "other"]) {
      check(`the picker offers ${key.replace(/_/g, " ")}`, offered.includes(key), offered.join(", ").slice(0, 80));
    }
    await s.context.close();

    // ---- 5g. WHAT A BACKGROUND CHECK DOES NOT TELL YOU -------------------
    //
    // TitoPay says it has confirmed a police clearance, and a customer
    // reasonably reads that as "TitoPay says this person is safe". It does not
    // say that and cannot, so the advisory has to appear where the decision is
    // being made - and the term limiting TitoPay's responsibility has to be in
    // front of the customer BEFORE they send the job, not after.
    const VETTED_PRO = { ok: true, professional: { ...PRO_PAGE.professional,
      professions: ["cleaner"], professionLabels: ["Cleaner"],
      enhancedVettingProfessions: ["cleaner"] } };

    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE, "/professionals/": VETTED_PRO });
    await s.page.evaluate((id) => window.openTitoProProfessional(id), VETTED_PRO.professional.userId);
    await s.page.waitForSelector(".tp-advisory", { timeout: 10000 });
    const advisory = await s.page.evaluate(() => {
      const blocks = [...document.querySelectorAll(".tp-advisory")];
      const full = blocks.find((el) => !el.classList.contains("is-compact"));
      const compact = blocks.find((el) => el.classList.contains("is-compact"));
      const form = document.querySelector('form[data-form="titopro-request"]');
      const submit = form?.querySelector('button[type="submit"]');
      return {
        count: blocks.length,
        title: full?.querySelector(".tp-advisory-title")?.textContent.trim() || "",
        steps: [...(full?.querySelectorAll(".tp-advisory-steps li") || [])].map((el) => el.textContent.trim()),
        liability: full?.querySelector(".tp-advisory-liability")?.textContent.trim() || "",
        compactLiability: compact?.querySelector("p:nth-child(3)")?.textContent.trim() || "",
        insideForm: Boolean(compact && form && form.contains(compact)),
        // Before the button, not after it: the position is the whole point.
        beforeSubmit: Boolean(compact && submit &&
          (compact.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING))
      };
    });
    check("a vetted professional's page carries the advisory",
      advisory.count === 2, `${advisory.count} blocks`);
    check("it is headed for the moment it matters", /Before you let anyone into your home/.test(advisory.title), advisory.title);
    check("IT GIVES THE CUSTOMER SOMETHING TO DO, not just a warning",
      advisory.steps.length >= 4 && advisory.steps.some((step) => /Ask for ID at the door/.test(step)),
      `${advisory.steps.length} steps`);
    check("it says what TitoPay is not responsible for",
      /not responsible for loss, damage or injury/i.test(advisory.liability), advisory.liability.slice(0, 80));
    check("NOT AS AN ABSOLUTE EXCLUSION - a blanket one is the kind a court strikes out",
      /to the extent the law allows/i.test(advisory.liability) && !/any loss whatsoever/i.test(advisory.liability),
      advisory.liability.slice(-90));
    check("AND IT IS INSIDE THE REQUEST FORM, ABOVE SEND REQUEST",
      advisory.insideForm && advisory.beforeSubmit,
      `inForm=${advisory.insideForm} beforeSubmit=${advisory.beforeSubmit}`);
    check("with the limitation repeated at the point of commitment",
      /not responsible for loss/i.test(advisory.compactLiability), advisory.compactLiability.slice(0, 60));
    await s.context.close();

    // AND NOT WHERE IT WOULD BE WALLPAPER. A plumber needs no background check;
    // an advisory on every listing is one nobody reads on the listings where it
    // actually matters.
    s = await openApp(browser, 390, { "/v1/titopro/professions": CATALOGUE, "/professionals/": PRO_PAGE });
    await s.page.evaluate((id) => window.openTitoProProfessional(id), PRO_PAGE.professional.userId);
    await s.page.waitForSelector('form[data-form="titopro-request"]', { timeout: 10000 });
    const unvetted = await s.page.evaluate(() => document.querySelectorAll(".tp-advisory").length);
    check("A PROFESSION THAT NEEDS NO CHECK SHOWS NO ADVISORY", unvetted === 0, `${unvetted} blocks`);
    await s.context.close();

    // ---- 5e. NOTHING RUNS OFF THE SIDE OF ANY SCREEN --------------------
    //
    // The original check only measured the BROWSE screen, and the bug was on
    // the listing one: the hidden checkbox inside each profession pill was
    // absolutely positioned with no positioned ancestor, so `.field input`
    // gave it width:100% and min-height:58px against the MODAL. Each pill grew
    // an invisible 345x58 box running hundreds of pixels past the right edge.
    // Nothing looked wrong until a pill was tapped: iOS focuses the checkbox
    // and scrolls sideways to reveal it, leaving the customer on a blank white
    // column with the form off the left of the screen.
    //
    // So every TitoPro screen is measured now, and the measurement is of EVERY
    // element, visible or not - a box with opacity:0 scrolls a phone exactly as
    // far as a box you can see.
    const SCREENS = [
      ["listing", ".tp-picks", (page) => page.evaluate(() => window.openTitoProListing())],
      ["professional", ".tp-card", (page) => page.evaluate((id) => window.openTitoProProfessional(id), PRO_PAGE.professional.userId)],
      ["rate", ".tp-rate-row", (page) => page.evaluate((job) => window.openTitoProRate(job.id), CONFIRMED)],
      ["report", 'form[data-form="titopro-report"]', (page) => page.evaluate((id) => window.openTitoProReport(id), PRO_PAGE.professional.userId)],
      ["job", ".tp-steps", (page) => page.evaluate((job) => window.openTitoProJob(job.id), CONFIRMED)]
    ];
    for (const width of [360, 390]) {
      for (const [name, ready, open] of SCREENS) {
        s = await openApp(browser, width, { "/v1/titopro/professions": CATALOGUE,
          "/my-report": { ok: true, report: null }, "/report-reasons": REASONS,
          "/professionals/": PRO_PAGE, "/rating": { ok: true, rating: null },
          "/v1/titopro/jobs/": { ok: true, job: CONFIRMED },
          "/v1/titopro/me/listing": { ok: true,
            profile: { status: "draft", professions: ["cleaner"], serviceRadiusKm: 20,
              outstandingChecks: ["Police clearance", "References"], enhancedVettingProfessions: ["cleaner"] },
            eligibility: { eligible: false, ficaVerified: true, blockers: ["Before you can offer this work TitoPay needs: Police clearance and References."] } } });
        await open(s.page);
        await s.page.waitForSelector(ready, { timeout: 10000 });
        const fit = await s.page.evaluate((w) => {
          const doc = document.documentElement;
          const past = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            if (r.right > w + 1) past.push(`${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 24)}@${Math.round(r.right)}`);
          }
          return { past: past.slice(0, 4), bodyScroll: doc.scrollWidth - doc.clientWidth };
        }, width);
        check(`${width}px · ${name} · no box reaches past the right edge`,
          fit.past.length === 0, fit.past.join(", "));
        check(`${width}px · ${name} · the page does not scroll sideways`,
          fit.bodyScroll <= 1, `${fit.bodyScroll}px`);
        await s.context.close();
      }
    }

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
