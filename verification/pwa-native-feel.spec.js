"use strict";

/* WHAT MAKES THIS FEEL LIKE A WEB PAGE RATHER THAN AN APP.
 *
 * Not opinion. Each probe below is a behaviour a person can see on a phone,
 * measured on the real bundle across the real screens:
 *
 *   1. SYSTEM BACK. On an installed app the back gesture closes the sheet on
 *      top. A web page with no history for its sheets leaves the app instead.
 *      This is the loudest difference of the lot.
 *   2. TEXT SELECTION ON CHROME. Resting a finger on a tab, a card label or a
 *      button and dragging selects the words. No native control does that.
 *   3. THE LONG-PRESS CALLOUT. Holding a button or an icon pops the browser's
 *      own Copy / Share menu over the app.
 *   4. NO PRESSED STATE. -webkit-tap-highlight-color is transparent across the
 *      app, so a control with no :active rule of its own gives no feedback at
 *      all when tapped: the tap reads as a miss.
 *   5. SCROLL CHAINING. Reaching the end of a list inside a sheet starts
 *      scrolling the page behind it.
 *   6. TAP TARGETS under the 44px both platforms ask for.
 *
 * Content is deliberately EXEMPT from 2 and 3. An amount, a reference, a
 * statement line and a chat message must stay selectable and copyable: taking
 * that away would be a native-looking app that lost a feature.
 *
 * Needs the stack:  bash scratchpad/start-native-stack.sh
 * Run: node verification/pwa-native-feel.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");

const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const tail = String(Date.now()).slice(-7);
const PASSWORD = "NativeFeel!2026#x";

let passed = 0;
let ran = 0;
const check = (condition, message, detail = "") => {
  ran += 1;
  if (condition) { passed += 1; console.log("  PASS  " + message); return true; }
  console.error(`  FAIL  ${message}${detail ? "\n        " + detail : ""}`);
  process.exitCode = 1;
  return false;
};

async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${API}${path}`, {
    method: options.method || "GET", headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  return { status: response.status, payload };
}

/* The probe runs inside the page because every question here is about COMPUTED
   style on a REAL element. Reading the stylesheet instead would answer a
   different question, and would miss anything a media query or the cascade
   changes on the device the customer is holding. */
const PROBE = () => {
  // Everything a finger is meant to press.
  const CONTROL = [
    "button", "a[href]", "[role=button]", "[role=tab]", "[data-action]",
    "[data-route]", "[data-service]", "label", "summary", "input[type=checkbox]",
    "input[type=radio]", ".chip", ".tab", ".nav-item", ".icon-btn", ".tap"
  ].join(",");

  // Content a person may legitimately want to select and copy. These are
  // EXEMPT from the selection and callout probes on purpose.
  const SELECTABLE = [
    "input", "textarea", "[contenteditable]", "code", "pre",
    "[data-copy]", "[data-copy-value]", "[data-selectable]"
  ].join(",");

  const describe = (el) => {
    const cls = String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${text ? ` "${text}"` : ""}`;
  };

  // Every selector in the loaded stylesheets that carries :active, with the
  // :active removed, so an element can be asked "is there a pressed state for
  // me anywhere?" rather than guessed at.
  // A plain style rule also carries an (empty) cssRules list now that CSS
  // nesting exists, so the selector has to be read BEFORE recursing or every
  // rule in the sheet is skipped and the answer is a confident zero.
  const activeSelectors = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules = [];
    try { rules = Array.from(sheet.cssRules || []); } catch { continue; }
    const walk = (list) => {
      for (const rule of list) {
        const selector = rule.selectorText || "";
        if (selector.includes(":active")) {
          for (const part of selector.split(",")) {
            if (!part.includes(":active")) continue;
            const bare = part.replace(/:active/g, "").trim();
            if (bare) activeSelectors.push(bare);
          }
        }
        if (rule.cssRules && rule.cssRules.length) walk(Array.from(rule.cssRules));
      }
    };
    walk(rules);
  }
  const matchesAny = (el, selectors) => {
    for (const selector of selectors) {
      try { if (el.matches(selector)) return true; } catch { /* not a selector we can test */ }
    }
    return false;
  };

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const findings = {
    selectableChrome: [], noPressedState: [], scrollChaining: [], smallTargets: []
  };
  const counted = { controls: 0, scrollers: 0 };

  // A <label> with no `for` and no control inside it does nothing when tapped:
  // it is a caption, and judging it as a control would report a pressed state
  // and a fingertip-sized target for a line of text.
  //
  // A label WITH a `for` is a convenience that focuses its field. The field is
  // the target, and on every platform the label above it is a line of text, so
  // a label pointing at a control that is itself big enough is not judged.
  const isCaptionOnly = (el) => {
    if (el.tagName !== "LABEL") return false;
    if (el.querySelector("input, select, textarea, button")) return false;
    const forId = el.getAttribute("for");
    if (!forId) return true;
    const field = document.getElementById(forId);
    if (!field) return true;
    return field.getBoundingClientRect().height >= 44;
  };

  for (const el of Array.from(document.querySelectorAll(CONTROL))) {
    if (!visible(el)) continue;
    if (isCaptionOnly(el)) continue;
    if (el.matches(SELECTABLE) || el.closest(SELECTABLE)) continue;
    counted.controls += 1;
    const style = getComputedStyle(el);

    const userSelect = style.userSelect || style.webkitUserSelect;
    if (userSelect !== "none") findings.selectableChrome.push(describe(el));

    // A label wrapping its own control, or a container that only exists to
    // catch the tap, is pressed through its child. Only leaves are judged.
    const isLeaf = !el.querySelector(CONTROL);
    if (isLeaf) {
      if (!matchesAny(el, activeSelectors)) findings.noPressedState.push(describe(el));
      const rect = el.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) {
        findings.smallTargets.push(`${describe(el)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }
  }

  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (el === document.body || el === document.documentElement) continue;
    const style = getComputedStyle(el);
    const scrolls = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4;
    if (!scrolls || !visible(el)) continue;
    counted.scrollers += 1;
    const behaviour = style.overscrollBehaviorY || style.overscrollBehavior || "auto";
    if (behaviour === "auto") findings.scrollChaining.push(describe(el));
  }

  return { findings, counted };
};

const dedupe = (list) => Array.from(new Set(list));

async function measure(page, label, report) {
  const { findings, counted } = await page.evaluate(PROBE);
  report.controls += counted.controls;
  report.scrollers += counted.scrollers;
  for (const key of Object.keys(findings)) {
    report[key] = dedupe((report[key] || []).concat(findings[key].map((f) => `${label}: ${f}`)));
  }
}


/* The long-press callout is iOS only. Chromium implements neither the property
   nor a CSSOM entry for it, so no browser probe here can answer the question
   and pretending otherwise would be a green tick for something unmeasured.
   This reads the SHIPPED stylesheet instead, and says so. */
function calloutDeclaration() {
  const css = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "pwa", "styles.min.css"), "utf8");
  const suppressed = /body\s*\{[^}]*-webkit-touch-callout\s*:\s*none/.test(css);
  const restored = /-webkit-touch-callout\s*:\s*default/.test(css);
  return { suppressed, restored };
}

const SHEETS = [
  ["statements sheet", "openStatementsModal"],
  ["limits sheet", "openLimitsModal"],
  ["device sessions sheet", "openDeviceSessionsModal"]
];

async function walkSheets(page, report, suffix) {
  for (const [label, fn] of SHEETS) {
    const opened = await page.evaluate((name) => {
      if (typeof window[name] !== "function") return false;
      try { window[name](); return true; } catch { return false; }
    }, fn);
    if (!opened) continue;
    await page.waitForTimeout(700);
    await measure(page, `${label}${suffix}`, report);
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
    await page.waitForTimeout(300);
  }
}

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — what still reads as a web page and not an app");
  console.log("=============================================================\n");

  const body = {
    fullName: "Native Feel", email: `native${tail}@titopay.local`,
    phone: `+2776${tail}`, password: PASSWORD, accountType: "personal"
  };
  const registered = await call("/auth/register", { method: "POST", body });
  const auth = registered.payload.accessToken
    ? registered.payload
    : (await call("/auth/login", { method: "POST", body: { identifier: body.email, password: PASSWORD } })).payload;
  if (!check(Boolean(auth.accessToken), "a customer is signed in for the walk")) process.exit(1);

  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const report = { controls: 0, scrollers: 0 };
  const scriptErrors = [];
  let page = null;

  // Two real phone sizes. The small one matters most: a sheet that fits on a
  // 390x844 screen overflows on a 360x640 one, and only a sheet that actually
  // scrolls can be asked whether it drags the page along behind it.
  for (const [viewport, suffix] of [[{ width: 390, height: 844 }, ""], [{ width: 360, height: 640 }, " @360"]]) {
    const context = await browser.newContext({
      viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block"
    });
    await context.addInitScript(([a, r]) => {
      localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    }, [auth.accessToken, auth.refreshToken]);
    page = await context.newPage();
    page.on("pageerror", (error) => scriptErrors.push(String(error)));
    await page.goto(`${PWA}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    for (const route of ["dashboard", "activity", "services", "profile"]) {
      await page.evaluate((r) => { location.hash = r; }, route);
      await page.waitForTimeout(700);
      await measure(page, `${route}${suffix}`, report);
    }
    await walkSheets(page, report, suffix);

    // The last context stays open for the back-gesture probe below.
    if (suffix) break;
    await context.close();
  }

  console.log(`  Walked ${report.controls} visible controls and ${report.scrollers} scroll containers `
    + `across two phone sizes.\n`);

  // ---- 1. THE SYSTEM BACK GESTURE ----------------------------------------
  // Measured, not read: open a sheet, press Back the way a phone does, and
  // look at whether the sheet went and the screen stayed.
  await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); location.hash = "dashboard"; });
  await page.waitForTimeout(700);
  const beforeBack = await page.evaluate(() => location.hash);
  await page.evaluate(() => { openStatementsModal(); });
  await page.waitForTimeout(700);
  check(await page.evaluate(() => Boolean(document.querySelector(".modal-backdrop"))),
    "a sheet opens, so the back probe has something to close");

  await page.goBack().catch(() => {});
  await page.waitForTimeout(800);
  const afterBack = await page.evaluate(() => ({
    sheet: Boolean(document.querySelector(".modal-backdrop")),
    hash: location.hash,
    locked: document.body.classList.contains("modal-open"),
    bodyFixed: document.body.style.position === "fixed"
  }));
  check(!afterBack.sheet, "the system back gesture closes the sheet on top",
    afterBack.sheet ? "the sheet survived Back; on an installed app Back leaves the app instead" : "");
  check(afterBack.hash === beforeBack,
    "and leaves the screen underneath exactly where it was",
    `${beforeBack} -> ${afterBack.hash}`);
  check(!afterBack.locked && !afterBack.bodyFixed,
    "and gives the page its scroll back rather than leaving it pinned");

  // Closing a sheet the ordinary way must not leave a dead entry behind: the
  // very next Back has to be a real move between screens, not a silent no-op.
  await page.evaluate(() => { location.hash = "activity"; });
  await page.waitForTimeout(700);
  await page.evaluate(() => { openStatementsModal(); });
  await page.waitForTimeout(600);
  await page.evaluate(() => { closeModal(); });
  await page.waitForTimeout(600);
  const afterTapClose = await page.evaluate(() => location.hash);
  await page.goBack().catch(() => {});
  await page.waitForTimeout(800);
  const plainBack = await page.evaluate(() => location.hash);
  check(afterTapClose === "#activity" && plainBack !== "#activity",
    "after closing a sheet by hand, the next Back still moves between screens",
    `closed at ${afterTapClose}, back went to ${plainBack}`);

  // A sheet opened from a sheet steps back one layer at a time, the way a
  // native stack does, rather than dropping the whole pile at once.
  await page.evaluate(() => { location.hash = "profile"; });
  await page.waitForTimeout(700);
  const stacked = await page.evaluate(() => {
    if (typeof openStatementsModal !== "function") return false;
    openStatementsModal();
    return Boolean(document.querySelector(".modal-backdrop"));
  });
  if (stacked) {
    await page.goBack().catch(() => {});
    await page.waitForTimeout(700);
    check(await page.evaluate(() => location.hash) === "#profile",
      "and Back out of a sheet never skips past the screen that opened it");
  }

  // The Pay hub is not a sheet, it is its own overlay, and it is reached from
  // the bottom bar more often than most sheets are. Back has to close it too.
  await page.evaluate(() => { location.hash = "dashboard"; });
  await page.waitForTimeout(700);
  const hubOpen = await page.evaluate(() => {
    if (typeof openPayHub !== "function") return false;
    openPayHub();
    return Boolean(document.querySelector(".pay-hub-backdrop"));
  });
  if (check(hubOpen, "the Pay hub opens")) {
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
    const afterHub = await page.evaluate(() => ({
      hub: Boolean(document.querySelector(".pay-hub-backdrop")),
      hash: location.hash
    }));
    check(!afterHub.hub && afterHub.hash === "#dashboard",
      "and the back gesture closes the Pay hub without leaving the screen",
      `hub=${afterHub.hub} hash=${afterHub.hash}`);
  }

  // A confirm dialog sits OVER a sheet. Back must cancel the dialog and leave
  // the sheet exactly where it was, not take both away at once.
  const dialogOpen = await page.evaluate(() => {
    if (typeof openStatementsModal !== "function" || typeof appDialog !== "function") return false;
    openStatementsModal();
    appDialog({ title: "Back probe", body: "Cancel me", confirmLabel: "Confirm" });
    return Boolean(document.querySelector(".tp-dialog-layer") && document.querySelector(".modal-backdrop"));
  });
  if (check(dialogOpen, "a confirm dialog opens over an open sheet")) {
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
    const afterDialog = await page.evaluate(() => ({
      dialog: Boolean(document.querySelector(".tp-dialog-layer")),
      sheet: Boolean(document.querySelector(".modal-backdrop")),
      hash: location.hash
    }));
    check(!afterDialog.dialog && afterDialog.sheet && afterDialog.hash === "#dashboard",
      "and Back cancels the dialog while the sheet under it stays open",
      `dialog=${afterDialog.dialog} sheet=${afterDialog.sheet} hash=${afterDialog.hash}`);

    // The sheet still has an entry of its own, so the NEXT Back closes it.
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
    const afterSecond = await page.evaluate(() => ({
      sheet: Boolean(document.querySelector(".modal-backdrop")),
      hash: location.hash
    }));
    check(!afterSecond.sheet && afterSecond.hash === "#dashboard",
      "and the Back after that closes the sheet, one layer at a time",
      `sheet=${afterSecond.sheet} hash=${afterSecond.hash}`);
  }

  // ---- 2..6. what the walk found -----------------------------------------
  const limit = process.env.NATIVE_FEEL_VERBOSE ? 200 : 8;
  const show = (list) => list.slice(0, limit).join("\n        ")
    + (list.length > limit ? `\n        ...and ${list.length - limit} more (NATIVE_FEEL_VERBOSE=1 for all)` : "");

  check(report.selectableChrome.length === 0,
    "no control lets a drag select its own text",
    report.selectableChrome.length ? show(report.selectableChrome) : "");

  check(report.noPressedState.length === 0,
    "every control shows that it was pressed",
    report.noPressedState.length ? show(report.noPressedState) : "");

  check(report.scrollChaining.length === 0,
    "no list scrolls the page behind it when it reaches its end",
    report.scrollChaining.length ? show(report.scrollChaining) : "");

  check(report.smallTargets.length === 0,
    "no tap target is smaller than a fingertip",
    report.smallTargets.length ? show(report.smallTargets) : "");

  const callout = calloutDeclaration();
  check(callout.suppressed,
    "the shipped stylesheet suppresses the long-press callout menu (read from the file, "
    + "because Chromium does not implement the iOS-only property)");
  check(callout.restored,
    "and hands it back to the content a person may want to copy");

  check(scriptErrors.length === 0, "the walk raised no script errors", scriptErrors[0] || "");

  await browser.close();
  console.log(`\n  ${passed}/${ran} native feel checks passed`);
  if (process.exitCode) process.exit(1);
})().catch((error) => { console.error("\nFAILED:", error.message); process.exit(1); });
