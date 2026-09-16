// SCREENSHOTS OF THE REAL TITOPRO SCREENS.
//
// Not mock-ups. This serves the shipped PWA, stubs the API with the shapes it
// really returns, opens each screen through the app's own functions and
// photographs what renders. If a screen is broken, the picture is broken.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/titopro-shots.js
//
// Images land in verification/artifacts/, which is gitignored - a screenshot
// is a thing you look at once, not a thing the repository carries.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const OUT = path.join(__dirname, "artifacts");
fs.mkdirSync(OUT, { recursive: true });
const API = "https://api.titopay.co.za";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".jpg": "image/jpeg" };

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

// The shapes the API really returns, with South African content.
const PROFESSIONS = [
  { key: "plumber", label: "Plumber", group: "Home repairs", shape: "callout", hint: "Burst pipes, geysers, blocked drains, leaking taps", usesDiary: true, requiredChecks: [] },
  { key: "electrician", label: "Electrician", group: "Home repairs", shape: "callout", hint: "Faults, DB boards, plugs and lights, certificates of compliance", usesDiary: true, requiredChecks: [] },
  { key: "appliance_technician", label: "Appliance technician", group: "Home repairs", shape: "callout", hint: "Fridges, washing machines, stoves and ovens", usesDiary: true, requiredChecks: [] },
  { key: "handyman", label: "Handyman", group: "Home repairs", shape: "callout", hint: "Small repairs, mounting, assembly, odd jobs", usesDiary: true, requiredChecks: [] },
  { key: "locksmith", label: "Locksmith", group: "Home repairs", shape: "callout", hint: "Lockouts, lock changes, keys cut on site", usesDiary: true,
    requiredChecks: [{ key: "police_clearance", label: "Police clearance", says: "A SAPS Police Clearance Certificate." }] },
  { key: "painter", label: "Painter", group: "Home improvement", shape: "project", hint: "Interior and exterior painting, prep and finishing", usesDiary: false, requiredChecks: [] },
  { key: "carpenter", label: "Carpenter", group: "Home improvement", shape: "project", hint: "Built-in cupboards, doors, decking, repairs in wood", usesDiary: false, requiredChecks: [] },
  { key: "tiler", label: "Tiler", group: "Home improvement", shape: "project", hint: "Floors, walls, bathrooms, waterproofing", usesDiary: false, requiredChecks: [] },
  { key: "cleaner", label: "Cleaner", group: "Home care", shape: "recurring", hint: "Home and office cleaning, once off or every week", usesDiary: true,
    requiredChecks: [{ key: "police_clearance", label: "Police clearance", says: "A SAPS Police Clearance Certificate, dated within the last year." },
      { key: "reference_check", label: "References", says: "Two contactable references from previous work of the same kind." }] },
  { key: "garden_service", label: "Garden service", group: "Home care", shape: "recurring", hint: "Lawns, hedges, refuse removal, seasonal clearing", usesDiary: true, requiredChecks: [] },
  { key: "pool_service", label: "Pool service", group: "Home care", shape: "recurring", hint: "Weekly cleaning, chemicals, pumps and filters", usesDiary: true, requiredChecks: [] },
  { key: "bookkeeper", label: "Bookkeeper", group: "Professional", shape: "remote", hint: "Books, VAT, payroll and SARS submissions", usesDiary: false, requiredChecks: [] },
  { key: "designer", label: "Designer", group: "Professional", shape: "remote", hint: "Logos, branding, social media and print", usesDiary: false, requiredChecks: [] },
  { key: "tutor", label: "Tutor", group: "Professional", shape: "remote", hint: "School subjects, matric and tertiary", usesDiary: false,
    requiredChecks: [{ key: "police_clearance", label: "Police clearance", says: "A SAPS Police Clearance Certificate." }] }
];
const CATALOGUE = { ok: true, shapes: [], professions: PROFESSIONS };

const PROS = [
  { userId: "aaaa1111-1111-4111-8111-111111111111", name: "Sipho Ndlovu", professions: ["plumber", "handyman"],
    professionLabels: ["Plumber", "Handyman"], headline: "Drains and geysers, 15 years on the tools",
    suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25, ficaVerified: true,
    rating: 4.8, ratingCount: 24 },
  { userId: "bbbb2222-2222-4222-8222-222222222222", name: "Lerato Mokoena", professions: ["plumber"],
    professionLabels: ["Plumber"], headline: "Emergency call-outs, seven days a week",
    suburb: "Diepkloof", city: "Soweto", serviceRadiusKm: 20, ficaVerified: true,
    rating: 4.3, ratingCount: 7 },
  // Nobody has rated Themba yet. The row must read "New on TitoPro" rather
  // than nought out of five, or he never gets a first job.
  { userId: "cccc3333-3333-4333-8333-333333333333", name: "Themba Dlamini", professions: ["plumber", "appliance_technician"],
    professionLabels: ["Plumber", "Appliance technician"], headline: "Geysers, pumps and washing machines",
    suburb: "Orlando East", city: "Soweto", serviceRadiusKm: 30, ficaVerified: true,
    rating: null, ratingCount: 0 }
];

// One professional's page, as a customer deciding whether to hire them sees it.
const PHOTO_SWATCH = (hex) => {
  // A flat colour tile stands in for a photograph: the shot is of the LAYOUT,
  // and a real photo would only make it harder to see whether the grid is
  // right. 1x1 PNGs, upscaled by the CSS exactly as a real image would be.
  const png = { "1": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
  return `data:image/png;base64,${png["1"]}`;
};

const PRO_PAGE = { ok: true, professional: {
  userId: "aaaa1111-1111-4111-8111-111111111111", name: "Sipho Ndlovu",
  professions: ["plumber", "handyman"], professionLabels: ["Plumber", "Handyman"],
  headline: "Drains and geysers, 15 years on the tools",
  bio: "Fifteen years on the tools in Soweto. Geysers, blocked drains and burst pipes, same day where I can.",
  suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25, ficaVerified: true,
  rating: 4.8, ratingCount: 24,
  verifiedName: "Sipho Ndlovu",
  terms: "Call-out fee R250, payable whether or not the job goes ahead.\nGeysers carry a 12 month guarantee on labour.\n50% deposit on any job over R5 000.",
  photos: [PHOTO_SWATCH("a"), PHOTO_SWATCH("b"), PHOTO_SWATCH("c")],
  reviews: [
    { id: "r1", stars: 5, by: "Thandi", profession: "Plumber", comment: "On time, fixed the geyser and cleaned up after himself.", commentHidden: false },
    { id: "r2", stars: 5, by: "Bongani", profession: "Plumber", comment: "Came out on a Sunday for a burst pipe. Fair price.", commentHidden: false },
    { id: "r3", stars: 4, by: "Nomsa", profession: "Handyman", comment: "Good work, arrived an hour later than we agreed.", commentHidden: false }
  ] } };

const REPORT_REASONS = { ok: true, reasons: [
  { key: "off_platform_payment", label: "Asked me to pay outside TitoPay", says: "They wanted cash or an EFT instead of paying through the app." },
  { key: "impersonation", label: "Not who they say they are", says: "The person who arrived was not the person on the listing." },
  { key: "unsafe", label: "Unsafe or dangerous", says: "The work or their behaviour put someone at risk." },
  { key: "harassment", label: "Threatening or abusive", says: "They were abusive, threatening or would not leave." },
  { key: "no_show", label: "Did not arrive", says: "They accepted the job and never came." },
  { key: "poor_work", label: "Work was not done properly", says: "The work was left unfinished or badly done." },
  { key: "overcharged", label: "Charged more than quoted", says: "The final price did not match what was agreed." },
  { key: "not_qualified", label: "Not qualified for the work", says: "No certificate, or clearly not trained for what they took on." },
  { key: "other", label: "Something else", says: "Tell us what happened." } ] };

const JOB = {
  id: "11111111-1111-4111-8111-111111111111", reference: "TP-J-K7M2QRXP", status: "quoted",
  profession: "plumber", professionLabel: "Plumber", shape: "callout", shapeLabel: "Call-out",
  bookingWord: "Job", title: "Blocked kitchen drain",
  description: "Water comes back up when the sink drains. Started on Tuesday.",
  quotedAmount: 850, customerFee: 5, professionalFee: 32.75, usesDiary: true,
  suburb: "Pimville", city: "Soweto", certificateRequired: false, certificateReference: null, outstandingChecks: []
};

const shots = [];

async function shoot(browser, name, title, routes, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    const key = Object.keys(routes).find((candidate) => url.pathname.includes(candidate));
    await route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(key ? routes[key] : { ok: true }) });
  });
  await page.goto(`http://127.0.0.1:${global.__port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.openTitoProModal === "function", null, { timeout: 15000 });
  await page.evaluate(() => window.saveAuth({ accessToken: "a", refreshToken: "r" }));
  await run(page);
  await page.waitForTimeout(350);
  const file = path.join(OUT, `titopro-${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ file, title });
  console.log(`  ${title}\n    ${file}`);
  await context.close();
}

(async () => {
  console.log("\n  TitoPro — screenshots of the real screens\n");
  const server = await serve();
  global.__port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    await shoot(browser, "1-browse", "Browse — what can I get done?",
      { "/titopro/professions": CATALOGUE, "/titopro/me/listing": { ok: true, profile: null } },
      async (page) => {
        await page.evaluate(() => window.openTitoProModal());
        await page.waitForSelector(".tp-pro-row", { timeout: 10000 });
      });

    await shoot(browser, "2-results", "Plumbers in Soweto — every one verified",
      { "/titopro/professions": CATALOGUE, "/titopro/search": { ok: true, professionals: PROS },
        "/titopro/me/listing": { ok: true, profile: null } },
      async (page) => {
        await page.evaluate(() => window.openTitoProModal());
        await page.waitForSelector(".tp-pro-row", { timeout: 10000 });
        await page.evaluate(() => {
          window.titoProState().profession = "plumber";
          return window.titoProCatalogue().then((c) => window.renderTitoProBrowse(c));
        });
        await page.waitForSelector('form[data-form="titopro-search"]', { timeout: 10000 });
        await page.fill('input[name="city"]', "Soweto");
        await page.evaluate(() => window.submitTitoProSearch({ city: "Soweto" }));
        await page.waitForSelector(".tp-verified", { timeout: 10000 });
      });

    await shoot(browser, "3-request", "Asking for the work",
      { "/titopro/professions": CATALOGUE, "/titopro/search": { ok: true, professionals: PROS },
        "/titopro/me/listing": { ok: true, profile: null } },
      async (page) => {
        await page.evaluate((pros) => {
          const store = window.titoProState();
          store.profession = "plumber"; store.city = "Soweto"; store.results = pros; store.searched = true;
          return window.openTitoProProfessional(pros[0].userId);
        }, PROS);
        await page.waitForSelector('form[data-form="titopro-request"]', { timeout: 10000 });
      });

    await shoot(browser, "4-job-customer", "The price, and what you actually pay",
      { "/titopro/professions": CATALOGUE, "/titopro/jobs/": { ok: true, job: JOB } },
      async (page) => {
        await page.evaluate((job) => { window.titoProState().role = "customer"; return window.openTitoProJob(job.id); }, JOB);
        await page.waitForSelector(".tp-steps", { timeout: 10000 });
      });

    await shoot(browser, "5-job-professional", "The professional quotes, and sees their cut",
      { "/titopro/professions": CATALOGUE,
        "/titopro/jobs/": { ok: true, job: { ...JOB, status: "requested", quotedAmount: null } } },
      async (page) => {
        await page.evaluate((job) => { window.titoProState().role = "professional"; return window.openTitoProJob(job.id); }, JOB);
        await page.waitForSelector('form[data-form="titopro-quote"]', { timeout: 10000 });
      });

    await shoot(browser, "6-certificate", "An electrician cannot close without the COC",
      { "/titopro/professions": CATALOGUE,
        "/titopro/jobs/": { ok: true, job: { ...JOB, status: "in_progress", profession: "electrician",
          professionLabel: "Electrician", title: "DB board tripping", certificateRequired: true, quotedAmount: 1800,
          professionalFee: 47, customerFee: 5 } } },
      async (page) => {
        await page.evaluate((job) => { window.titoProState().role = "professional"; return window.openTitoProJob(job.id); }, JOB);
        await page.waitForSelector('form[data-form="titopro-done"]', { timeout: 10000 });
      });

    await shoot(browser, "7-listing-blocked", "Listing blocked — and told exactly why",
      { "/titopro/professions": CATALOGUE,
        "/titopro/me/listing": { ok: true,
          profile: { status: "draft", professions: ["cleaner"], professionLabels: ["Cleaner"],
            headline: "Homes and offices, Soweto", bio: "Eight years in Soweto. References from every home I have worked in.",
            suburb: "Pimville", city: "Soweto", serviceRadiusKm: 20,
            outstandingChecks: ["Police clearance", "References"], enhancedVettingProfessions: ["cleaner"] },
          eligibility: { eligible: false, ficaVerified: true,
            blockers: ["Before you can offer this work TitoPay needs: Police clearance and References. Contact TitoPay support to start the checks."] } } },
      async (page) => {
        await page.evaluate(() => window.openTitoProModal());
        await page.waitForSelector(".tp-banner", { timeout: 10000 });
      });

    await shoot(browser, "8-live", "A live professional opens TitoPro on their work",
      { "/titopro/professions": CATALOGUE,
        "/titopro/me/listing": { ok: true,
          profile: { status: "published", professions: ["plumber", "handyman"], professionLabels: ["Plumber", "Handyman"],
            headline: "Drains and geysers", suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25,
            outstandingChecks: [], enhancedVettingProfessions: [] },
          eligibility: { eligible: true, ficaVerified: true, blockers: [] } },
        "/titopro/jobs": { ok: true, jobs: [
          { ...JOB, status: "requested", title: "Blocked kitchen drain", reference: "TP-J-K7M2QRXP" },
          { ...JOB, id: "22", status: "quoted", title: "Geyser leaking into ceiling", reference: "TP-J-P4RT9WXY" },
          { ...JOB, id: "33", status: "scheduled", title: "Replace outside tap", reference: "TP-J-B7KD2MNQ" },
          { ...JOB, id: "44", status: "confirmed", title: "Unblocked bathroom drain", reference: "TP-J-H3JF8LTV" }
        ] } },
      async (page) => {
        await page.evaluate(() => window.openTitoProModal());
        await page.waitForSelector(".tp-banner.is-live", { timeout: 10000 });
      });

    await shoot(browser, "9-professional", "One professional, and what customers said",
      { "/titopro/professions": CATALOGUE, "/professionals/": PRO_PAGE },
      async (page) => {
        await page.evaluate((id) => window.openTitoProProfessional(id), PRO_PAGE.professional.userId);
        await page.waitForSelector(".tp-reviews", { timeout: 10000 });
      });

    await shoot(browser, "10-rate", "Rating the job, once, after it is finished",
      { "/titopro/professions": CATALOGUE },
      async (page) => {
        await page.evaluate((job) => window.openTitoProRate(job.id), JOB);
        await page.waitForSelector(".tp-rate-row", { timeout: 10000 });
        // Four of five, so the picker is photographed part-filled rather than
        // full - which is the state that shows the control actually works.
        // The LABEL is clicked, not the input: the input is visually hidden
        // and a finger has never touched one, so clicking it would test
        // something nobody does.
        await page.click('.tp-rate-pick:nth-child(4)');
      });

    await shoot(browser, "11-report", "Reporting a listing, in the customer's own words",
      { "/titopro/professions": CATALOGUE, "/my-report": { ok: true, report: null }, "/report-reasons": REPORT_REASONS },
      async (page) => {
        await page.evaluate((id) => window.openTitoProReport(id), PRO_PAGE.professional.userId);
        await page.waitForSelector('form[data-form="titopro-report"]', { timeout: 10000 });
      });

    await shoot(browser, "12-suspended", "A listing TitoPay took down, explained to the professional",
      { "/titopro/professions": CATALOGUE,
        "/titopro/me/listing": { ok: true,
          profile: { status: "suspended", adminAction: "suspended", professions: ["plumber"], professionLabels: ["Plumber"],
            headline: "Drains and geysers", suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25,
            outstandingChecks: [], enhancedVettingProfessions: [],
            unpublishedReason: "TitoPay has suspended this listing. Contact support." },
          eligibility: { eligible: true, ficaVerified: true, blockers: [] } } },
      async (page) => {
        await page.evaluate(() => window.openTitoProListing());
        await page.waitForSelector(".tp-banner.is-blocked", { timeout: 10000 });
      });

    await shoot(browser, "13-listing-form", "The listing form: name, photos and terms",
      { "/titopro/professions": CATALOGUE,
        "/titopro/me/listing": { ok: true,
          profile: { status: "draft", professions: ["plumber", "handyman"], professionLabels: ["Plumber", "Handyman"],
            tradingName: "Sipho's Plumbing", headline: "Drains and geysers, 15 years on the tools",
            bio: "Fifteen years on the tools in Soweto.", suburb: "Pimville", city: "Soweto", serviceRadiusKm: 25,
            photos: [PHOTO_SWATCH("a"), PHOTO_SWATCH("b")],
            terms: "Call-out fee R250. 50% deposit on any job over R5 000.",
            outstandingChecks: [], enhancedVettingProfessions: [] },
          eligibility: { eligible: true, ficaVerified: true, blockers: [] } } },
      async (page) => {
        await page.evaluate(() => window.openTitoProListing());
        await page.waitForSelector(".tp-photo-grid", { timeout: 10000 });
      });

  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n  ${shots.length} screenshots in ${OUT}\n`);
})().catch((error) => { console.error(error); process.exit(1); });
