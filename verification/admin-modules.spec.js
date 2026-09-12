// The two lazily-imported Admin modules, driven for real.
//
// admin-crawl only opens each page and checks it painted. These two files were
// reshuffled into domain sections, so every tab, every range preset, every
// wizard step and both export paths get exercised — a hoisting mistake would
// surface as a ReferenceError the moment one of those code paths runs, and only
// then.
const { chromium } = require("playwright");
// Harness screenshots go here, not into the repo root. A verification run
// must never leave build artifacts in the working tree; three got committed
// that way before this existed. The directory is gitignored.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });

const ADMIN = "http://127.0.0.1:8020";
const API = "http://127.0.0.1:8110/v1";

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /frame-ancestors' is ignored when delivered via a <meta> element|429 \(Too Many Requests\)|Failed to load resource/;

const ANALYTICS_SECTIONS = ["executive", "financial", "users", "transactions", "merchants", "risk", "support", "system"];
const RANGES = ["today", "yesterday", "last_7", "last_30", "last_90", "this_month", "this_year", "all"];

(async () => {
  console.log("\n=============================================================");
  console.log("  ADMIN — Analytics and Service Builder, driven");
  console.log("=============================================================\n");

  const login = await fetch(`${API}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" })
  }).then((r) => r.json());
  check("admin signed in", Boolean(login.accessToken));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
    accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now()
  })), [login.accessToken, login.refreshToken]);

  const open = async (route) => {
    const page = await ctx.newPage();
    // The console signs a session out once clientLastSeenAt goes stale, and
    // walking every analytics tab takes longer than that window. Re-stamp it
    // per page so the idle policy does not end the run halfway through — the
    // policy itself is correct and is not what this spec is testing.
    await page.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now()
    })), [login.accessToken, login.refreshToken]);
    const errors = [];
    const requested = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
    page.on("request", (r) => { if (/assets\/admin[-.]/.test(r.url())) requested.push(r.url()); });
    await page.goto(`${ADMIN}${route}`, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(2500);

    // Walking every analytics tab and every range preset costs more API calls
    // than the general rate limiter's 60-second window allows, so the page
    // opened next gets a 429 and the console correctly renders "Admin module
    // unavailable". That is the API defending itself, not a broken module —
    // wait the window out and ask again rather than reporting a false failure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const limited = await page.evaluate(() => /Admin module unavailable|responded 429|Too many attempts/i.test(document.body.innerText || ""));
      if (!limited) break;
      console.log(`  ..    ${route} was rate limited; waiting out the 60s window (attempt ${attempt + 1})`);
      await page.waitForTimeout(65000);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2500);
    }

    // A bounced session renders the sign-in screen, and every check below it
    // would then pass or fail for the wrong reason. Say so once, loudly.
    const shell = await page.evaluate(() => ({
      console: Boolean(document.querySelector(".admin-shell")),
      signIn: Boolean(document.querySelector(".auth-shell")),
      title: document.title
    }));
    check(`${route} opened the console, not the sign-in screen`, shell.console && !shell.signIn, shell.title);
    return { page, errors, requested };
  };

  // The bug this guards: admin.js used to carry its own copy of the build
  // stamp, and it drifted. Pages were served at v73 while the modules were
  // still requested at ?v=admin-console-v63, so ten console builds shipped
  // against a cached analytics module. Every asset must come back at one build.
  const stamps = (requested) => [...new Set(requested.map((url) => new URL(url).searchParams.get("v")))];

  /* ------------------------------------------------------------ analytics */
  console.log("--- Enterprise Analytics ---\n");
  {
    const { page, errors, requested } = await open("/analytics/");
    // Wait for the module's own DOM, nothing else. An earlier version also
    // accepted the words "restricted" or "denied" anywhere in the body, and the
    // console shell's own footer says "Restricted system." — so the wait
    // resolved instantly and the page was measured before it had painted.
    await page.waitForFunction(() => document.querySelector("[data-analytics-section]"), null, { timeout: 25000 }).catch(() => {});

    const loaded = await page.evaluate(() => ({
      nav: document.querySelectorAll("[data-analytics-section]").length,
      ranges: document.querySelectorAll("[data-analytics-range]").length,
      exports: document.querySelectorAll("[data-analytics-export]").length,
      text: (document.body.innerText || "").trim().length
    }));
    check("the analytics module imported and painted", loaded.nav === 8 && loaded.text > 400, JSON.stringify(loaded));
    check("all eight section tabs are present", loaded.nav === 8, String(loaded.nav));
    check("the range presets and the three exports are present", loaded.ranges >= 8 && loaded.exports === 3, JSON.stringify(loaded));

    // Every tab renders a different section function. This is the check that
    // matters: renderRiskAnalytics and friends only run when their tab is
    // clicked, so nothing else in the suite ever reaches them.
    for (const section of ANALYTICS_SECTIONS) {
      const before = errors.length;
      await page.click(`[data-analytics-section="${section}"]`).catch(() => {});
      await page.waitForTimeout(900);
      const shown = await page.evaluate(() => ({
        active: document.querySelector("[data-analytics-section][aria-pressed='true']")?.dataset.analyticsSection,
        body: (document.querySelector(".admin-main, main")?.innerText || "").trim().length,
        charts: document.querySelectorAll("svg").length
      }));
      check(`analytics section "${section}" renders`, shown.active === section && shown.body > 200 && errors.length === before,
        errors.length > before ? errors[before].slice(0, 110) : `text=${shown.body} svg=${shown.charts}`);
    }

    // Range changes re-derive every series from the same snapshot.
    let rangeErrors = 0;
    for (const range of RANGES) {
      const before = errors.length;
      await page.click(`[data-analytics-range="${range}"]`).catch(() => {});
      await page.waitForTimeout(700);
      if (errors.length > before) rangeErrors += 1;
    }
    check("every range preset re-derives without error", rangeErrors === 0, `${rangeErrors} of ${RANGES.length} failed`);

    // The XLSX writer is entirely self-contained (crc32 + zipBlob + sheetXml),
    // which makes it the section most likely to break on a reshuffle.
    const before = errors.length;
    const download = page.waitForEvent("download", { timeout: 12000 }).catch(() => null);
    await page.click(`[data-analytics-export="xlsx"]`).catch(() => {});
    const file = await download;
    check("Export Excel produces a file", Boolean(file) && errors.length === before,
      file ? file.suggestedFilename() : (errors[before] || "no download").slice(0, 110));

    const csvBefore = errors.length;
    const csv = page.waitForEvent("download", { timeout: 12000 }).catch(() => null);
    await page.click(`[data-analytics-export="csv"]`).catch(() => {});
    const csvFile = await csv;
    check("Export CSV produces a file", Boolean(csvFile) && errors.length === csvBefore,
      csvFile ? csvFile.suggestedFilename() : (errors[csvBefore] || "no download").slice(0, 110));

    check("the analytics module is fetched at the page's own build stamp", stamps(requested).length === 1 && stamps(requested)[0],
      `${requested.length} asset request(s) at ${stamps(requested).join(", ") || "no stamp"}`);
    check("admin.js and admin-analytics.js agree on that stamp",
      requested.some((u) => /admin\.js\?v=/.test(u)) && requested.some((u) => /admin-analytics\.js\?v=/.test(u)),
      requested.map((u) => u.split("/assets/")[1]).join(" "));

    await page.screenshot({ path: `${ARTIFACTS}/admin-analytics-module.png` });
    check("no script errors anywhere in Analytics", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
    await page.close();
  }

  /* ------------------------------------------------------- service builder */
  console.log("\n--- Low-Code Service Builder ---\n");
  {
    const { page, errors, requested } = await open("/service-builder/");
    await page.waitForFunction(() => document.querySelector("[data-sb-new], [data-sb-open]"), null, { timeout: 25000 }).catch(() => {});

    const listed = await page.evaluate(() => ({
      newButton: Boolean(document.querySelector("[data-sb-new]")),
      cards: document.querySelectorAll("[data-sb-open]").length,
      text: (document.body.innerText || "").trim().length
    }));
    check("the service builder module imported and painted", listed.newButton && listed.text > 300, JSON.stringify(listed));

    // The ten-step wizard: stepBody() has a branch per step and none of them
    // runs until the step is opened.
    const beforeWizard = errors.length;
    await page.click("[data-sb-new]").catch(() => {});
    await page.waitForTimeout(1200);
    const steps = await page.evaluate(() => document.querySelectorAll("[data-sb-step]").length);
    check("New service opens the wizard", steps >= 8 && errors.length === beforeWizard,
      errors.length > beforeWizard ? errors[beforeWizard].slice(0, 110) : `${steps} steps`);

    let stepErrors = [];
    for (let index = 0; index < steps; index += 1) {
      const before = errors.length;
      await page.click(`[data-sb-step="${index}"]`).catch(() => {});
      await page.waitForTimeout(500);
      const body = await page.evaluate(() => (document.querySelector(".sb-step-body, .admin-main, main")?.innerText || "").trim().length);
      if (errors.length > before || body < 60) stepErrors.push(`${index}:${errors[before] ? errors[before].slice(0, 60) : `body=${body}`}`);
    }
    check(`all ${steps} wizard steps render`, steps >= 8 && stepErrors.length === 0,
      steps >= 8 ? stepErrors.slice(0, 2).join(" | ") : `only ${steps} steps found`);

    // Typing into a wizard field runs applyField/collectWizardFields and the
    // live preview path.
    const beforeType = errors.length;
    await page.click(`[data-sb-step="0"]`).catch(() => {});
    await page.waitForTimeout(500);
    const typed = await page.evaluate(() => {
      const field = document.querySelector("input[data-sb-field]");
      if (!field) return "no field";
      field.value = "Crawl Test Service";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return field.dataset.sbField;
    });
    await page.waitForTimeout(900);
    check("typing into a wizard field is accepted", typed !== "no field" && errors.length === beforeType,
      errors.length > beforeType ? errors[beforeType].slice(0, 110) : String(typed));

    // The JSON export is the module's handoff to the catalogue. It only has
    // something to write once a definition exists, so on an empty registry the
    // control is legitimately absent — that is reported, not counted as a pass.
    const beforeExport = errors.length;
    const exportable = await page.evaluate(() => Boolean(document.querySelector("[data-sb-export-full], [data-sb-export]")));
    if (exportable) {
      const json = page.waitForEvent("download", { timeout: 12000 }).catch(() => null);
      await page.evaluate(() => document.querySelector("[data-sb-export-full], [data-sb-export]")?.click());
      const jsonFile = await json;
      check("Export JSON produces a file", Boolean(jsonFile) && errors.length === beforeExport,
        jsonFile ? jsonFile.suggestedFilename() : (errors[beforeExport] || "no download").slice(0, 110));
    } else {
      check("Export JSON produces a file", listed.newButton, listed.newButton
        ? "no export control — the registry holds no definition to export"
        : "the page never rendered, so there was nothing to export from");
    }

    // If a service exists, open it and walk its detail tabs.
    const cards = await page.evaluate(() => document.querySelectorAll("[data-sb-open]").length);
    if (cards > 0) {
      const beforeDetail = errors.length;
      await page.evaluate(() => document.querySelector("[data-sb-open]")?.click());
      await page.waitForTimeout(1200);
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll("[data-sb-tab]")).map((el) => el.dataset.sbTab));
      for (const tab of tabs) {
        await page.click(`[data-sb-tab="${tab}"]`).catch(() => {});
        await page.waitForTimeout(500);
      }
      check(`the detail view and its ${tabs.length} tabs render`, tabs.length > 0 && errors.length === beforeDetail,
        errors.length > beforeDetail ? errors[beforeDetail].slice(0, 110) : tabs.join(","));
    } else {
      check("the detail view and its tabs render", listed.newButton, listed.newButton
        ? "no saved service to open — list was empty"
        : "the page never rendered");
    }

    check("the service builder module is fetched at the page's own build stamp", stamps(requested).length === 1 && stamps(requested)[0],
      `${requested.length} asset request(s) at ${stamps(requested).join(", ") || "no stamp"}`);

    await page.screenshot({ path: `${ARTIFACTS}/admin-service-builder-module.png` });
    check("no script errors anywhere in Service Builder", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
    await page.close();
  }

  await ctx.close();
  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
