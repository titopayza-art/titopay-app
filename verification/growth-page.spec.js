// Render the new Activation & Retention view in a real browser, against a
// payload shaped exactly like the API's, and screenshot it.
//
// The payload below is not invented: it is produced by calling the real
// activation-service against a seeded local database (see growth-seed.js), so
// the shapes, key names and edge cases are the ones the page will actually meet
// — including a cohort too small to read as a rate, and a week with no activity.
const { chromium } = require("/home/user/titopay-app/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const ADMIN = "/home/user/titopay-app/admin";
const OUT = process.argv[3] || "/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/growth-view.png";
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // The real console stylesheet, inlined rather than linked: a file:// <link>
  // is blocked by the browser, and a screenshot taken without the stylesheet
  // would prove nothing about how the page actually looks.
  const css = fs.readFileSync(path.join(ADMIN, "assets", "admin.css"), "utf8");
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
    <style>${css}
#page-content{padding:20px;max-width:1340px;box-sizing:border-box}</style></head>
    <body class="admin-body"><div class="admin-shell"><main class="admin-main">
      <div id="page-content"></div></main></div></body></html>`, { waitUntil: "load" });

  const source = fs.readFileSync(path.join(ADMIN, "assets", "admin-marketing.js"), "utf8");
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");

  const result = await page.evaluate(async ({ moduleUrl, payload }) => {
    const mod = await import(moduleUrl);
    // The console helpers the module is allowed to use, and nothing else.
    const host = {
      escapeHtml: (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
      money: (v) => "R" + Number(v || 0).toFixed(2),
      adminErrorMessage: (e) => String(e && e.message || e),
      downloadCsv: () => {},
      PAGE_EXPORTS: {},
      apiFetch: async (p) => {
        window.__calls = window.__calls || [];
        window.__calls.push(p);
        return payload;
      }
    };
    await mod.renderMarketing({}, host, "growth");
    // Give the async view a tick to finish writing.
    await new Promise((r) => setTimeout(r, 200));
    const root = document.getElementById("page-content");
    return {
      calls: window.__calls,
      hasExport: typeof host.PAGE_EXPORTS.marketing === "function",
      csvHeader: null,
      inlineStyles: root.querySelectorAll("[style]").length,
      tabs: [...root.querySelectorAll(".mk-tab")].map((t) => t.textContent.trim()),
      cards: [...root.querySelectorAll(".mk-card")].map((c) => ({
        label: c.querySelector(".mk-card-label")?.textContent.trim(),
        value: c.querySelector(".mk-card-value")?.textContent.trim(),
        note: c.querySelector(".mk-card-note")?.textContent.trim()
      })),
      stages: [...root.querySelectorAll(".mk-funnel-step")].map((s) => {
        const value = s.querySelector(".mk-funnel-value");
        const rate = value.querySelector("small");
        return {
          label: s.querySelector(".mk-funnel-label").textContent.trim(),
          count: value.childNodes[0].textContent.trim(),
          rate: rate.textContent.trim(),
          // The count and the rate must not run together as one number. They
          // did before the stylesheet loaded, and "156100%" is exactly the kind
          // of thing that ships.
          rateOnItsOwnLine: getComputedStyle(rate).display === "block"
        };
      }),
      warnBlocks: [...root.querySelectorAll(".mk-warn")].every((w) => getComputedStyle(w).display === "block"),
      heatApplied: (() => {
        const cell = root.querySelector(".mk-cohort td.mk-heat-100, .mk-cohort td.mk-heat-90, .mk-cohort td.mk-heat-50, .mk-cohort td.mk-heat-40");
        return cell ? getComputedStyle(cell).backgroundColor : "none";
      })(),
      cohortRows: [...root.querySelectorAll(".mk-cohort tbody tr")].map((r) => ({
        thin: r.classList.contains("mk-thin"),
        cells: [...r.children].slice(0, 5).map((c) => c.textContent.replace(/\s+/g, " ").trim())
      })),
      frequencyRows: [...root.querySelectorAll(".mk-panel table tbody tr")].length,
      text: root.textContent.replace(/\s+/g, " "),
      pwned: Boolean(window.__pwned),
      injectedNodes: root.querySelectorAll("img, script, iframe, svg").length,
      // A console page must never scroll the whole document sideways: wide
      // tables scroll inside their own card. This is the check for that.
      pageOverflowsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      tablesScrollInsideCards: [...root.querySelectorAll(".table-wrap")]
        .every((w) => w.scrollWidth <= w.clientWidth || getComputedStyle(w).overflowX !== "visible")
    };
  }, { moduleUrl, payload });

  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();

  console.log("API called:", result.calls);
  console.log("inline style attributes (CSP forbids these):", result.inlineStyles);
  console.log("CSV export registered:", result.hasExport);
  console.log("\ntabs:", result.tabs.join(" | "));
  console.log("\ncards:");
  for (const c of result.cards) console.log(`  ${String(c.label).padEnd(24)} ${String(c.value).padEnd(8)} ${c.note || ""}`);
  console.log("\nactivation stages:");
  for (const s of result.stages) {
    console.log(`  ${s.label.padEnd(18)} ${s.count.padStart(5)}  ${s.rate.padStart(6)}  ${s.rateOnItsOwnLine ? "" : "  <-- COUNT AND RATE RUN TOGETHER"}`);
  }
  console.log("\nsmall-cohort warnings on their own line:", result.warnBlocks);
  console.log("cohort heat actually painted:", result.heatApplied);
  console.log("\ncohort rows:");
  for (const r of result.cohortRows) console.log(`  ${r.thin ? "THIN " : "     "}${r.cells.join("  |  ")}`);
  console.log("\nfrequency rows:", result.frequencyRows);
  console.log("\nsays 'stages, not a funnel':", /stages, not a funnel/.test(result.text));
  console.log("says verification is not required:", /not required to transact/.test(result.text));
  console.log("script executed from API data (must be false):", result.pwned);
  console.log("nodes injected from API data (must be 0):", result.injectedNodes);
  if (result.pwned || result.injectedNodes) { console.error("\nHTML INJECTION FROM API DATA"); process.exit(1); }
  if (errors.length) { console.error("\nPAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
  if (result.inlineStyles > 0) { console.error("\nCSP violation: inline styles emitted"); process.exit(1); }
  console.log("page scrolls sideways (must be false):", result.pageOverflowsSideways);
  console.log("wide tables scroll inside their own card:", result.tablesScrollInsideCards);
  if (result.pageOverflowsSideways) { console.error("\nthe page scrolls sideways"); process.exit(1); }
  console.log("\nno page errors, no inline styles");
  console.log("screenshot:", OUT);
})();
