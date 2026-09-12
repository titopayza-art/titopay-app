"use strict";

/* THE PAGE AN OPERATOR OPENS WHEN A CONSOLE SCREEN IS BROKEN.
 *
 * Rendered in a real browser with the API intercepted, so this measures what
 * an operator is actually served rather than the source that builds it.
 *
 *   1. The topbar says which API build the console is talking to.
 *   2. It says so LOUDLY when that build is behind what the console needs,
 *      which is the case this whole change exists for.
 *   3. The failing query is shown with the real Postgres error — the detail
 *      the console deliberately strips everywhere else.
 *   4. The failing save is shown, with its reason.
 *   5. A missing table names the page it breaks, not just itself.
 *   6. The shape of platform_settings on THIS database is reported, because
 *      five files declare that table and they disagree.
 *   7. An API too old to answer says so, and names the fallback, instead of
 *      rendering an empty page.
 *
 * Serve the console first:  python3 -m http.server 8020 --directory admin
 * Run: node verification/admin-database-health.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");

const CONSOLE_URL = "http://127.0.0.1:8020";

const DIAGNOSIS = {
  startedAt: "2026-08-16T01:00:00.000Z",
  apiBuild: 35,
  reachable: true,
  databaseError: null,
  tableCount: 174,
  pages: [
    { page: "Compliance Dashboard", required: ["compliance_flags", "money_integrity_alerts"], missing: ["money_integrity_alerts"] },
    { page: "Revenue", required: ["revenue_ledger", "wallets"], missing: [] }
  ],
  probes: [
    { page: "Compliance Dashboard", what: "money integrity alerts", ok: false,
      error: { message: 'relation "money_integrity_alerts" does not exist', code: "42P01" } },
    { page: "Revenue", what: "revenue by service", ok: true }
  ],
  writes: [
    { what: "Save Maintenance Mode", ok: false,
      error: { message: 'column "updated_by" of relation "platform_settings" does not exist', code: "42703" } },
    { what: "Any audited admin action", ok: true }
  ],
  notes: {
    platformSettingsForeignKeys: 0,
    platformSettingsColumns: ["key", "value", "created_at", "updated_at"],
    appliedMigrations: 3
  },
  providers: [
    { capability: "kyc", configured: "internal", variable: "KYC_PROVIDER", source: "default", registered: true, state: "wired", declares: { identityAssurance: "structural" } },
    { capability: "vas", configured: "none", variable: "VAS_PROVIDER", source: "default", registered: true, state: "none" },
    // Registered, and declaring that it cannot transact: the state the console
    // used to paint red as a fault when it is neither a fault nor a live rail.
    { capability: "payment", configured: "flash", variable: "VAS_PROVIDER", source: "environment", registered: true, state: "seam", canTransact: false, declares: { canPurchase: false } }
  ],
  verdict: {
    ok: false,
    headline: "1 console page is missing tables.",
    guidance: "Create them from the shipped schema with `node src/db/init.js` ... then run this diagnosis again."
  }
};

const HEALTH = {
  ok: true, apiBase: "/v1", build: 35,
  tables: [
    { table_name: "compliance_flags", exists: true, pages: ["Compliance Dashboard"] },
    { table_name: "money_integrity_alerts", exists: false, pages: ["Compliance Dashboard"] },
    { table_name: "revenue_ledger", exists: true, pages: ["Revenue"] }
  ]
};

let passed = 0;
const check = (condition, message, detail = "") => {
  if (condition) { passed += 1; console.log("  PASS  " + message); return; }
  console.error(`  FAIL  ${message}${detail ? "  — " + detail : ""}`);
  process.exitCode = 1;
};

async function openConsole(browser, { build, diagnosisStatus = 200 }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, bypassCSP: true });
  await context.addInitScript(() => {
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: "harness", refreshToken: "harness", role: "super_admin",
      scope: "admin", clientLastSeenAt: Date.now()
    }));
  });
  await context.route("http://127.0.0.1:8110/**", (route) => {
    const url = route.request().url();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/health")) return json({ ok: true, build, appVersion: "1.0" });
    if (url.includes("/diagnostics/console")) {
      return diagnosisStatus === 200
        ? json({ ok: true, diagnosis: DIAGNOSIS })
        : json({ ok: false, error: "Not Found" }, diagnosisStatus);
    }
    if (url.includes("/module-health")) return json(HEALTH);
    if (url.includes("/admin/me")) return json({ ok: true, admin: { id: "h", role: "super_admin", permissions: ["*"] } });
    return json({ ok: true, items: [] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${CONSOLE_URL}/database-health/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { page, errors, context };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"]
  });

  // ---- Current API --------------------------------------------------------
  const current = await openConsole(browser, { build: 35 });
  const chip = await current.page.evaluate(() => {
    const node = document.querySelector(".api-build-badge");
    return node ? { text: node.textContent.trim(), stale: node.classList.contains("api-build-stale") } : null;
  });
  check(Boolean(chip) && /API\s*35/.test(chip.text),
    "the topbar says which API build the console is talking to", chip ? chip.text : "no chip");
  check(chip && chip.stale === false, "and it is quiet when that build is current");

  const body = (await current.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  check(/relation "money_integrity_alerts" does not exist/.test(body),
    "the failing query shows the real Postgres error");
  check(/42P01/.test(body), "with the Postgres error code beside it");
  check(/column "updated_by" of relation "platform_settings" does not exist/.test(body),
    "the failing save shows its own reason");
  check(/Save Maintenance Mode/.test(body), "against the button an operator actually pressed");
  check(/Compliance Dashboard/.test(body) && /money_integrity_alerts/.test(body),
    "a missing table names the console page it breaks");
  check(/Foreign keys: 0/.test(body) && /key, value, created_at, updated_at/.test(body),
    "the shape of platform_settings on this database is reported");
  check(/Migrations applied: 3/.test(body), "and how many migrations have been applied");
  check(/1 console page is missing tables/.test(body), "the verdict leads with what is wrong");
  check(/db\/init\.js/.test(body), "and names the command that fixes it");
  check(current.errors.length === 0, "the page renders with no script errors", current.errors[0] || "");
  await current.context.close();

  // ---- Stale API ----------------------------------------------------------
  const stale = await openConsole(browser, { build: 25, diagnosisStatus: 404 });
  const staleChip = await stale.page.evaluate(() => {
    const node = document.querySelector(".api-build-badge");
    return node ? { text: node.textContent.trim(), stale: node.classList.contains("api-build-stale"), title: node.title } : null;
  });
  check(staleChip && staleChip.stale === true,
    "an API behind what the console needs is flagged, not left to be guessed at");
  check(staleChip && /25/.test(staleChip.text) && /35/.test(staleChip.text),
    "showing both what it is and what is needed", staleChip ? staleChip.text : "");
  check(staleChip && /upload/i.test(staleChip.title),
    "and saying what to do about it", staleChip ? staleChip.title.slice(0, 60) : "");

  const staleBody = (await stale.page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  check(/cannot run the diagnosis yet/i.test(staleBody),
    "an API too old to diagnose says so rather than rendering an empty page");
  check(/db:diagnose/.test(staleBody), "and names the shell fallback for that case");
  check(stale.errors.length === 0, "and still renders with no script errors", stale.errors[0] || "");
  await stale.context.close();

  await browser.close();
  console.log(`\n  ${passed}/17 database health checks passed`);
  if (process.exitCode) process.exit(1);
})().catch((error) => { console.error("\nFAILED:", error.message); process.exit(1); });
