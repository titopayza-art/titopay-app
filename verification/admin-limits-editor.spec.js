"use strict";

/* THE CONSOLE PAGE THAT CONTROLS THE CUSTOMER'S LIMITS SCREEN.
 *
 * Rendered in a real browser with the API intercepted, so this measures the
 * page an operator is actually served rather than the source that builds it.
 *
 * What matters here is not that a form appears. It is that the form cannot
 * quietly do the wrong thing:
 *
 *   1. The rows are the rows the customer reads, in the same order, across
 *      the three levels. Nothing to translate in your head.
 *   2. An empty box is "no standing limit", and it says so rather than
 *      leaving an operator to guess whether blank means zero.
 *   3. A save sends ALL three levels in full. The configuration merge resets
 *      every rail a save does not mention, so a form that posted only the
 *      changed field would silently reset the rest.
 *   4. An empty box is sent as null, not as "" — the value that used to read
 *      as "no limit" by accident rather than on purpose.
 *   5. A typed amount that is not a number is refused before it leaves the
 *      browser, naming the box.
 *   6. The wording fields are on the same page, and the two caveats say they
 *      cannot be emptied.
 *   7. The raw JSON document is still reachable, and folded away.
 *
 * Serve the console first:  python3 -m http.server 8020 --directory admin
 * Run: node verification/admin-limits-editor.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");

const CONSOLE_URL = "http://127.0.0.1:8020";

const CONFIG = {
  ok: true,
  config: {
    tiers: {
      0: { label: "Limited Access", description: "A lower monthly transaction limit while identity verification is outstanding.", monthlyReceive: 25000, monthlySend: 25000, singleTransaction: 2500, dailySend: 4000, singleWithdrawal: 1000, monthlyWithdraw: 3000, maxBalance: 10000 },
      1: { label: "Basic Verified", description: "Identity verification completed. A higher monthly transaction limit.", monthlyReceive: 200000, monthlySend: 200000, singleTransaction: 10000, dailySend: 20000, singleWithdrawal: 10000, monthlyWithdraw: 30000, maxBalance: 50000 },
      2: { label: "Fully Verified", description: "Identity and documentary due diligence completed.", monthlyReceive: null, monthlySend: null, singleTransaction: null, dailySend: null, singleWithdrawal: null, monthlyWithdraw: null, maxBalance: null }
    },
    products: { send_gift: { singleTransaction: 5000 } },
    riskBands: { normal: { multiplier: 1 } }
  }
};
const CONTENT = {
  ok: true,
  stored: false,
  updatedAt: null,
  updatedBy: null,
  content: {
    lead: "Your limits depend on your verification status, risk profile and applicable TitoPay compliance requirements.",
    disclaimer: "These are TitoPay operational limits based on its risk management and compliance framework. They are not statutory thresholds.",
    topLevelNote: "No fixed monthly transaction limit. Risk assessment, transaction monitoring and applicable TitoPay compliance requirements still apply.",
    upgradeHint: "Complete full verification to become eligible for higher limits, subject to TitoPay's risk and compliance requirements.",
    atTopHint: "You are at TitoPay's highest verification level."
  }
};

let passed = 0;
const check = (condition, message, detail = "") => {
  if (condition) { passed += 1; console.log("  PASS  " + message); return; }
  console.error(`  FAIL  ${message}${detail ? "  — " + detail : ""}`);
  process.exitCode = 1;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"]
  });
  // The console ships a Content Security Policy that allows only its own origin
  // and the production API. Serving it from a local static server and answering
  // its calls from here is exactly the case that policy blocks, and rightly so:
  // it is bypassed for the harness only, and the policy itself is unchanged.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, bypassCSP: true });
  // The console reads its session from localStorage before it fetches anything.
  await context.addInitScript(() => {
    localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
      accessToken: "harness", refreshToken: "harness", role: "super_admin",
      scope: "admin", clientLastSeenAt: Date.now()
    }));
  });

  const saves = [];
  await context.route("http://127.0.0.1:8110/**", async (route) => {
    const request = route.request();
    const url = request.url();
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "PUT" || request.method() === "POST") {
      saves.push({ url, body: JSON.parse(request.postData() || "{}") });
      if (url.includes("/compliance/limits-content")) return json(CONTENT);
      if (url.includes("/compliance/limits")) return json({ ...CONFIG, warnings: [] });
      return json({ ok: true });
    }
    if (url.includes("/compliance/limits-content")) return json(CONTENT);
    if (url.includes("/compliance/limits/versions")) return json({ ok: true, versions: [] });
    if (url.includes("/compliance/limits")) return json(CONFIG);
    if (url.includes("/compliance/queue")) return json({ ok: true, items: [] });
    if (url.includes("/admin/me")) return json({ ok: true, admin: { id: "harness", role: "super_admin", permissions: ["services"] } });
    return json({ ok: true, items: [], versions: [] });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`${CONSOLE_URL}/compliance/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".limit-matrix", { timeout: 15000 });

  // ---- 1. The rows are the customer's rows, in the customer's order --------
  const matrix = await page.evaluate(() => {
    const table = document.querySelector(".limit-matrix");
    return {
      rows: [...table.querySelectorAll("tbody th[scope='row']")].map((th) => th.textContent.trim()),
      levels: [...table.querySelectorAll("thead .limit-label")].map((input) => input.value),
      placeholder: table.querySelector(".limit-input")?.placeholder,
      topLevelBoxes: [...table.querySelectorAll('.limit-input[data-limit-level="2"]')].map((i) => i.value),
      basicMonthly: table.querySelector('.limit-input[data-limit-level="1"][data-limit-key="monthlySend"]')?.value
    };
  });
  check(matrix.rows.slice(0, 7).join(" | ") ===
    "Send per month | Receive per month | Send per payment | Send per day | Withdraw per payment | Withdraw per month | Maximum wallet balance",
  "the rows are the customer's limit rows, in the customer's order", matrix.rows.join(" | "));
  check(matrix.levels.join(" | ") === "Limited Access | Basic Verified | Fully Verified",
    "the three levels are the columns, and their names are editable", matrix.levels.join(" | "));
  check(matrix.basicMonthly === "200000", "the stored numbers are what the boxes hold", matrix.basicMonthly);

  // ---- 2. Empty means no standing limit, and says so ----------------------
  check(matrix.topLevelBoxes.every((value) => value === ""),
    "a level with no standing limit shows empty boxes");
  check(/no limit/i.test(String(matrix.placeholder)),
    "and the placeholder says what empty means", matrix.placeholder);

  // ---- 3 + 4. A save sends all three levels in full, with null for empty ---
  await page.fill("#limits-reason", "harness: raise the per-payment cap");
  await page.evaluate(() => {
    const box = document.querySelector('.limit-input[data-limit-level="1"][data-limit-key="singleTransaction"]');
    box.value = "15000";
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("[data-limits-save]");
  await page.waitForTimeout(600);
  const limitSave = saves.find((save) => save.url.includes("/compliance/limits") && !save.url.includes("content"));
  check(Boolean(limitSave), "the save reaches the API");
  const tiers = limitSave?.body?.config?.tiers || {};
  check(Object.keys(tiers).sort().join(",") === "0,1,2",
    "all three levels are sent, not only the one that changed", Object.keys(tiers).join(","));
  check(Number(tiers["1"]?.singleTransaction) === 15000, "the edited number is what is sent");
  check(Number(tiers["0"]?.monthlySend) === 25000, "and the untouched levels are sent as they were");
  check(tiers["2"]?.monthlySend === null,
    "an empty box is sent as null, never as an empty string", JSON.stringify(tiers["2"]?.monthlySend));
  check(tiers["1"]?.label === "Basic Verified" && typeof tiers["1"]?.description === "string",
    "the level name and its explanation travel with the numbers");
  check(limitSave?.body?.reason === "harness: raise the per-payment cap",
    "and the stated reason goes with it");

  // ---- 5. A non-numeric amount never leaves the browser -------------------
  const before = saves.length;
  await page.evaluate(() => {
    // The toast from the successful save is still on screen. Cleared, so what
    // is read below is the answer to THIS click and not the previous one.
    document.querySelectorAll(".toast").forEach((node) => node.remove());
    document.querySelector('.limit-input[data-limit-level="1"][data-limit-key="monthlySend"]').value = "200,000";
    document.getElementById("limits-reason").value = "harness: typo";
  });
  await page.click("[data-limits-save]");
  await page.waitForTimeout(400);
  check(saves.length === before, "a typed amount with a comma is refused before it is sent");
  const toast = await page.evaluate(() => document.querySelector(".toast")?.textContent || "");
  check(/not an amount|digits only/i.test(toast), "and the operator is told which box and why", toast.slice(0, 80));

  // ---- 6. The wording is on the same page ---------------------------------
  const copy = await page.evaluate(() => {
    const fields = [...document.querySelectorAll("[data-limits-copy]")].map((f) => f.dataset.limitsCopy);
    const text = document.body.innerText;
    return { fields, saysCannotEmpty: (text.match(/cannot be emptied/gi) || []).length, hasReset: Boolean(document.querySelector("[data-limits-copy-reset]")) };
  });
  check(copy.fields.join(",") === "lead,disclaimer,topLevelNote,upgradeHint,atTopHint",
    "every sentence on the customer's screen is editable here", copy.fields.join(","));
  check(copy.saysCannotEmpty >= 2, "the two caveat sentences say they cannot be emptied", String(copy.saysCannotEmpty));
  check(copy.hasReset, "and TitoPay's own wording can be put back");

  // ---- 7. The raw document survives, folded away --------------------------
  const advanced = await page.evaluate(() => {
    const details = document.querySelector("details.advanced-json");
    return { exists: Boolean(details), open: details?.open, hasTextarea: Boolean(details?.querySelector("#limits-json")) };
  });
  check(advanced.exists && advanced.hasTextarea, "the raw configuration is still reachable");
  check(advanced.open === false, "and it is folded away rather than the first thing an operator meets");

  check(pageErrors.length === 0, "the page renders with no script errors", pageErrors.slice(0, 2).join(" | "));

  await browser.close();
  console.log(`\n  ${passed}/18 admin limits editor checks passed`);
  if (process.exitCode) process.exit(1);
})().catch((error) => { console.error("\nFAILED:", error.message); process.exit(1); });
