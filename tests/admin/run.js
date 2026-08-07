/* Admin console gate. Drives the real console in Chromium against the
   deterministic stub in ./stub.js and fails the process on any regression:
   a route that stops rendering, a sign-in flow that breaks, a console error,
   a missing table control, an RBAC gate that opens, or a version string that
   does not match across the release files.

   Run: node tests/admin/run.js  (also wired as `npm run test:admin`). */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { startAdminStub } = require("./stub");

// The console pins its local API base to http://127.0.0.1:8110/v1 (see
// ADMIN_API_BASE in admin/assets/admin.js), so the stub must listen there.
const PORT = 8110;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = path.resolve(__dirname, "..", "..", "admin");

const ROUTES = ["dashboard", "alerts", "analytics", "service-builder", "search", "users", "merchants", "transactions", "wallets", "beneficiaries", "chat-monitor", "ticketing", "enterprise-distribution", "qr-management", "marketing", "pricing", "integrations", "feature-management", "api-provider-settings", "settings", "email-centre", "email-centre/analytics", "email-centre/templates", "email-centre/queue", "email-centre/logs", "email-centre/settings", "email-centre/otp", "sms-analytics", "support", "chatbot-escalations", "company-documents", "compliance", "revenue", "security", "system-logs", "audit", "development-tools", "engineering-tools", "database-health", "staff-management", "rbac-permissions"];

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

/* Release integrity: one version string across every page, the version file
   and the deployment marker. A mismatch ships a mixed build. */
function checkVersionConsistency() {
  const versions = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(/\?v=(admin-console-v\d+)/g)) versions.add(match[1]);
      }
    }
  };
  walk(ADMIN);
  const versionFile = fs.readFileSync(path.join(ADMIN, "admin-version.txt"), "utf8");
  const marker = fs.readFileSync(path.join(ADMIN, "DEPLOYMENT_BUILD_MARKER.txt"), "utf8");
  const fromFile = (versionFile.match(/Build: (admin-console-v\d+)/) || [])[1];
  const fromMarker = (marker.match(/(admin-console-v\d+)/) || [])[1];
  check(versions.size === 1, `all pages reference one asset version (found: ${[...versions].join(", ")})`);
  const single = [...versions][0];
  check(fromFile === single, `admin-version.txt matches the pages (${fromFile})`);
  check(fromMarker === single, `deployment marker matches the pages (${fromMarker})`);
}

(async () => {
  checkVersionConsistency();

  const server = await startAdminStub(PORT);
  // CI installs the browser Playwright expects, so the default launch works
  // there. A developer box with a system-provided Chromium (for example the
  // PLAYWRIGHT_BROWSERS_PATH image this repo is developed in) may hold a
  // different revision; fall back to the first Chromium found there.
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean);
    let executablePath = process.env.TP_ADMIN_CHROMIUM || "";
    for (const root of roots) {
      if (executablePath) break;
      try {
        const hit = fs.readdirSync(root).find((name) => /^chromium-\d+$/.test(name));
        if (hit) executablePath = path.join(root, hit, "chrome-linux", "chrome");
      } catch {}
    }
    if (!executablePath || !fs.existsSync(executablePath)) throw error;
    browser = await chromium.launch({ executablePath });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/frame-ancestors|404|Failed to load resource/.test(message.text())) consoleErrors.push(message.text());
  });

  // --- Sign-in flow -------------------------------------------------------
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(400);
  const loginIds = ["admin-login-form", "identifier", "password", "caps-hint", "admin-login-submit", "show-reset", "reset-card", "admin-reset-request-form", "login-status", "login-environment"];
  const missing = await page.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), loginIds);
  check(missing.length === 0, `sign-in page carries every scripted element${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);

  await page.fill("#identifier", "owner@titopay.co.za");
  await page.fill("#password", "test-password");
  await Promise.all([
    page.waitForURL("**/dashboard/", { timeout: 20000 }),
    page.click("#admin-login-submit"),
  ]);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 20000 });
  check((await page.textContent(".page-header h1")).includes("Infrastructure Dashboard"), "credential sign-in reaches the dashboard");

  // --- Every route renders ------------------------------------------------
  let rendered = 0;
  for (const route of ROUTES) {
    await page.goto(`${BASE}/${route}/`);
    try {
      await page.waitForSelector("#page-content", { timeout: 15000 });
      await page.waitForTimeout(250);
      const blocks = await page.evaluate(() => document.getElementById("page-content")?.children.length || 0);
      if (blocks > 0) rendered += 1;
      else failures.push(`${route} rendered no content`);
    } catch {
      failures.push(`${route} did not render`);
    }
  }
  check(rendered === ROUTES.length, `all ${ROUTES.length} console routes render (${rendered} ok)`);

  // --- Table enhancement layer -------------------------------------------
  await page.goto(`${BASE}/users/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(400);
  check(await page.$("th[data-tp-sortable]") !== null, "tables gain sortable headers");
  check(await page.$(".tp-table-search input") !== null, "tables gain the row filter");
  await page.click("#page-content thead th:first-child");
  await page.waitForTimeout(200);
  check(await page.getAttribute("#page-content thead th:first-child", "aria-sort") === "ascending", "sorting announces aria-sort");

  // --- Alert Centre -------------------------------------------------------
  await page.goto(`${BASE}/alerts/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(600);
  check(await page.$(".tp-alert-row") !== null, "alert centre lists derived alerts");
  check(await page.$("[data-alert-bell]") !== null, "topbar carries the alert bell");
  const badgeBefore = await page.evaluate(() => {
    const badge = document.getElementById("alert-badge");
    return badge && !badge.hidden ? Number(badge.textContent.replace("+", "")) : 0;
  });
  check(badgeBefore > 0, `bell badge shows unread alerts (${badgeBefore})`);
  await page.click("[data-alert-bell]");
  await page.waitForTimeout(300);
  check(await page.evaluate(() => !document.getElementById("alert-panel").hidden), "bell opens the alert panel");
  await page.click("[data-alert-mark-all]");
  await page.waitForTimeout(300);
  const badgeAfter = await page.evaluate(() => {
    const badge = document.getElementById("alert-badge");
    return badge && !badge.hidden ? Number(badge.textContent.replace("+", "")) : 0;
  });
  check(badgeAfter === 0, "mark all read clears the badge");

  // --- Support quick replies ----------------------------------------------
  await page.goto(`${BASE}/support/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(500);
  const historyButton = await page.$("[data-support-chat-history]");
  if (historyButton) {
    await historyButton.click();
    await page.waitForSelector("#support-agent-message", { timeout: 15000 });
    await page.waitForTimeout(400);
    check(await page.$(".support-quick-replies") !== null, "support conversation carries the quick replies panel");
    await page.click(".support-quick-replies summary");
    await page.waitForTimeout(250);
    await page.click('[data-support-quick-reply="0"]');
    await page.waitForTimeout(250);
    const inserted = await page.evaluate(() => document.getElementById("support-agent-message").value);
    check(inserted.startsWith("Welcome to TitoPay Customer Care.") && inserted.includes("My name is Platform,"), "quick reply inserts with the agent's first name substituted");

    // Manage mode: edit the first title, save, confirm it took; then restore.
    await page.click("[data-sqr-manage]");
    await page.waitForTimeout(250);
    check(await page.$("#sqr-editor") !== null, "quick replies manager opens for the owner");
    await page.fill("#sqr-editor .sqr-edit-row:first-child .sqr-edit-title", "Custom Greeting");
    await page.click("[data-sqr-save]");
    await page.waitForTimeout(300);
    const customised = await page.evaluate(() => document.getElementById("sqr-body").textContent.includes("Custom Greeting"));
    check(customised, "an edited quick reply is saved and shown");
    await page.click("[data-sqr-manage]");
    await page.waitForTimeout(200);
    page.once("dialog", (dialog) => dialog.accept());
    await page.click("[data-sqr-restore]");
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => document.getElementById("sqr-body").textContent.includes("Greeting") && !document.getElementById("sqr-body").textContent.includes("Custom Greeting"));
    check(restored, "restore defaults returns the built-in set");
  } else {
    failures.push("support queue offered no conversation to open");
  }

  // --- SMS Analytics ------------------------------------------------------
  // The stub serves campaign records but no dedicated /admin/sms/analytics
  // endpoint, so this exercises the derived-metrics fallback path.
  await page.goto(`${BASE}/sms-analytics/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(500);
  check((await page.$$(".metric-card")).length >= 7, "sms analytics renders its metric tiles");
  check((await page.$$(".email-chart-grid .email-chart")).length >= 3, "sms analytics draws campaign charts from delivery counters");
  const smsNote = await page.textContent(".analytics-note").catch(() => "");
  check(smsNote.includes("A-P1-6"), "sms analytics states its data provenance honestly");
  const barsSized = await page.evaluate(() => {
    const bars = [...document.querySelectorAll(".email-chart-row i")];
    return bars.length > 0 && bars.every((bar) => /^\d+(\.\d+)?%$/.test(bar.style.width));
  });
  check(barsSized, "chart bars receive their widths without inline style attributes");

  // --- Marketing toolkit --------------------------------------------------
  await page.goto(`${BASE}/marketing/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(600);
  check((await page.$$(".mkt-template-row")).length === 3, "marketing composers carry template rows");
  await page.fill('#marketing-sms-form [name="title"]', "Gate test broadcast");
  await page.fill('#marketing-sms-form [name="message"]', "TitoPay gate check message.");
  await page.click('.mkt-template-row[data-mkt-type="sms"] [data-mkt-save]');
  await page.waitForTimeout(250);
  await page.fill('#marketing-sms-form [name="message"]', "");
  await page.evaluate(() => {
    const select = document.querySelector('.mkt-template-row[data-mkt-type="sms"] [data-mkt-select]');
    select.value = [...select.options].find((option) => option.textContent === "Gate test broadcast")?.value || "";
  });
  await page.click('.mkt-template-row[data-mkt-type="sms"] [data-mkt-apply]');
  await page.waitForTimeout(250);
  const restoredMessage = await page.inputValue('#marketing-sms-form [name="message"]');
  check(restoredMessage === "TitoPay gate check message.", "a saved marketing template applies back into the composer");
  const meterText = await page.textContent("#sms-meter");
  check(/1 segment/.test(meterText || ""), "sms meter reports characters and segments");
  await page.fill('#marketing-campaign-form [name="destinationUrl"]', "https://titopay.co.za/app");
  await page.fill('#marketing-campaign-form [name="utmSource"]', "qr");
  await page.waitForTimeout(200);
  check((await page.textContent("#campaign-url-preview")).includes("utm_source=qr"), "campaign link preview carries UTM parameters");
  check(await page.$("#mkt-calendar-host .mkt-cal-grid") !== null, "marketing calendar renders");
  const calMonthBefore = await page.textContent(".mkt-cal-nav strong");
  await page.click('[data-mkt-cal-shift="-1"]');
  await page.waitForTimeout(200);
  check(await page.textContent(".mkt-cal-nav strong") !== calMonthBefore, "calendar navigates between months");
  check((await page.textContent("#mkt-month-summary")).includes("SMS broadcasts"), "cross-channel month summary renders");

  // --- Approval queue rejection -------------------------------------------
  const rejectOffered = (await page.$$("[data-marketing-sms-reject], [data-marketing-email-reject], [data-announcement-reject]")).length;
  check(rejectOffered >= 4, `all approval queues offer reject alongside approve (${rejectOffered} shown)`);
  page.once("dialog", (dialog) => dialog.accept("Gate test rejection"));
  await page.click("[data-marketing-email-reject]");
  await page.waitForTimeout(1200);
  const reasonShown = await page.evaluate(() => document.body.textContent.includes("Rejected by ceo: Gate test rejection"));
  check(reasonShown, "a rejection records its reason and shows it on the queue");

  // --- Personal <-> business delink ---------------------------------------
  await page.goto(`${BASE}/users/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(500);
  const delinkBefore = (await page.$$("[data-user-delink]")).length;
  check(delinkBefore > 0, `linked users offer the delink action (${delinkBefore} shown)`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("[data-user-delink]");
  await page.waitForTimeout(900);
  const delinkAfter = (await page.$$("[data-user-delink]")).length;
  check(delinkAfter === delinkBefore - 1, "delinking separates the accounts and the list refreshes");

  // --- RBAC editor --------------------------------------------------------
  await page.goto(`${BASE}/rbac-permissions/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(500);
  check(await page.$("#rbac-create-form") !== null, "rbac page offers the create-role form");
  await page.click('[data-rbac-edit="customer_support"]');
  await page.waitForSelector("#rbac-edit-form", { timeout: 15000 });
  await page.waitForTimeout(300);
  const catalogue = await page.$$eval('#rbac-edit-form [name="permissions"]', (boxes) => boxes.map((box) => box.value));
  check(catalogue.includes("analytics") && catalogue.includes("service_builder"), "checklist offers the console's newer module permissions");
  await page.fill("#rbac-new-permission", "reports_export");
  await page.click('#rbac-edit-form [data-rbac-add-permission]');
  await page.waitForTimeout(250);
  const added = await page.evaluate(() => {
    const box = document.querySelector('#rbac-edit-form [name="permissions"][value="reports_export"]');
    return box ? box.checked : false;
  });
  check(added, "a typed permission is added to the role, ticked");
  await page.click("[data-rbac-cancel]");
  await page.waitForTimeout(300);

  // --- Service Builder ----------------------------------------------------
  await page.goto(`${BASE}/service-builder/`);
  await page.waitForFunction(() => !document.querySelector(".admin-skeleton"), { timeout: 15000 });
  await page.waitForTimeout(600);
  check(await page.$("[data-sb-new]") !== null, "service builder renders its dashboard");
  await page.click("[data-sb-new]");
  await page.waitForTimeout(400);
  check(await page.$(".sb-wizard") !== null, "wizard opens");
  await page.fill('[data-sb-field="name"]', "Gate Test Service");
  await page.fill('[data-sb-field="description"]', "Created by the CI gate.");
  await page.click("[data-sb-save-draft]");
  await page.waitForTimeout(400);
  await page.click("[data-sb-cancel]");
  await page.waitForTimeout(400);
  const draftListed = await page.evaluate(() => document.body.textContent.includes("Gate Test Service"));
  check(draftListed, "saved draft appears in the service list");
  await page.evaluate(() => localStorage.removeItem("titopay_admin_service_builder_v1"));

  // --- Analytics permission gate -----------------------------------------
  const gatedPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await gatedPage.route("**/v1/admin/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "adm", role: "customer_support", fullName: "Agent", username: "agent", permissions: ["support", "users"], session: {} }),
  }));
  await gatedPage.goto(`${BASE}/`);
  await gatedPage.evaluate(() => localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));
  await gatedPage.goto(`${BASE}/analytics/`);
  await gatedPage.waitForSelector("#page-content", { timeout: 15000 });
  await gatedPage.waitForTimeout(800);
  const gated = await gatedPage.evaluate(() => document.body.textContent.includes("Access restricted") && !document.getElementById("analytics-root"));
  check(gated, "analytics stays gated for a role without the permission");
  await gatedPage.goto(`${BASE}/service-builder/`);
  await gatedPage.waitForSelector("#page-content", { timeout: 15000 });
  await gatedPage.waitForTimeout(800);
  const builderGated = await gatedPage.evaluate(() => document.body.textContent.includes("Access restricted") && !document.getElementById("service-builder-root"));
  check(builderGated, "service builder stays gated for a role without the permission");
  await gatedPage.close();

  // --- No unexpected console errors --------------------------------------
  check(consoleErrors.length === 0, `no console errors across the run${consoleErrors.length ? ` (first: ${consoleErrors[0].slice(0, 90)})` : ""}`);

  await browser.close();
  server.close();

  if (failures.length) {
    console.error(`\nadmin console gate FAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nadmin console gate passed");
})().catch((error) => {
  console.error("admin console gate crashed:", error.message);
  process.exit(1);
});
