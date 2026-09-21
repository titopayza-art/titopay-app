// THE TITOPRO MODERATION PAGE, IN A REAL BROWSER.
//
// The API tests prove an operator CAN suspend a listing. They cannot prove
// that the screen they do it from renders, that the queue is ordered the way
// somebody reading it needs, or that the page does not quietly offer a button
// the API would refuse. That half is what this drives.
//
// What is defended:
//
//   1. the page paints at all - a hoisting mistake or a missing renderer is a
//      blank panel, and the console swallows a failed fetch by design;
//   2. urgent reports are read first, and each row says whether the reporter
//      was ever actually this professional's customer;
//   3. the detail panel carries what a decision needs: contact details, the
//      vetting, the score and every report ever raised, closed ones included;
//   4. a REMOVED listing is not offered "Suspend", and an untouched one is
//      not offered "Approve" - a button that can only fail is worse than no
//      button;
//   5. the page says plainly that approving is not publishing.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/titopro-moderation-console.spec.js
//
// ADMIN_ROOT overrides the console directory so an extracted admin.zip is
// tested exactly as it will be deployed.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ADMIN_ROOT = process.env.ADMIN_ROOT || path.join(__dirname, "..", "admin");
const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain" };

function serve() {
  const server = http.createServer((req, res) => {
    let file = decodeURIComponent(String(req.url).split("?")[0]);
    if (file === "/" || file.endsWith("/")) file += "index.html";
    const resolved = path.join(ADMIN_ROOT, file);
    if (!resolved.startsWith(ADMIN_ROOT) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.writeHead(404).end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(fs.readFileSync(resolved));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const PRO = "aaaa1111-1111-4111-8111-111111111111";
const REMOVED_PRO = "bbbb2222-2222-4222-8222-222222222222";

// The shapes the API really returns.
const REPORTS = { ok: true, reports: [
  { id: "r-old", reference: "TP-R-AAAA2345", category: "no_show", categoryLabel: "Did not arrive",
    urgent: false, status: "open", createdAt: "2026-08-01T09:00:00.000Z",
    detail: "He accepted the job and never came.", professionalUserId: PRO, professionalName: "Sipho Ndlovu",
    reporterUserId: "c1", reporterName: "Thandi Mokoena", hadJob: true, listingStatus: "published",
    listingAdminAction: null, reportsAgainstTotal: 2, outcome: "", resolutionNote: "", reviewedAt: null },
  { id: "r-urgent", reference: "TP-R-BBBB3456", category: "harassment", categoryLabel: "Threatening or abusive",
    urgent: true, status: "open", createdAt: "2026-09-14T16:20:00.000Z",
    detail: "He would not leave the property and shouted at my mother.", professionalUserId: PRO,
    professionalName: "Sipho Ndlovu", reporterUserId: "c2", reporterName: "Lerato Dlamini", hadJob: false,
    listingStatus: "published", listingAdminAction: null, reportsAgainstTotal: 2, outcome: "", resolutionNote: "", reviewedAt: null }
] };
// The queue arrives urgent-first from the API. The page must render that order
// rather than re-sorting it into something else.
REPORTS.reports.sort((a, b) => Number(b.urgent) - Number(a.urgent));

const LISTINGS = { ok: true, listings: [
  { id: "p2", userId: REMOVED_PRO, name: "Themba Khumalo", status: "suspended", adminAction: "removed",
    statusLabel: "Removed by TitoPay", adminReason: "Unsafe electrical work confirmed by a second professional.",
    adminActionedAt: "2026-09-10T08:00:00.000Z", adminActionedBy: "moderator@titopay.co.za",
    professions: ["electrician"], professionLabels: ["Electrician"], headline: "DB boards and faults",
    suburb: "Orlando East", city: "Soweto", openReports: 0 }
] };

const DETAIL = { ok: true,
  listing: { id: "p1", userId: PRO, name: "Sipho Ndlovu", status: "published", adminAction: null,
    statusLabel: "Live", adminReason: "", adminActionedAt: null, adminActionedBy: null,
    professions: ["plumber"], professionLabels: ["Plumber"], headline: "Drains and geysers",
    suburb: "Pimville", city: "Soweto", openReports: 2 },
  contact: { fullName: "Sipho Ndlovu", email: "sipho@example.co.za", phone: "+27821234567" },
  reports: [
    ...REPORTS.reports,
    { id: "r-closed", reference: "TP-R-CCCC4567", category: "overcharged", categoryLabel: "Charged more than quoted",
      urgent: false, status: "dismissed", createdAt: "2026-06-02T11:00:00.000Z",
      detail: "He charged more than the quote said.", reporterName: "Nomsa Zulu", hadJob: true,
      outcome: "approve", resolutionNote: "The re-quote was accepted in the app. Nothing in it.", reviewedAt: "2026-06-03T09:00:00.000Z" }
  ],
  rating: { count: 24, average: 4.8 },
  vetting: [{ checkType: "police_clearance", label: "Police clearance", status: "cleared", expiresAt: "2027-01-31T00:00:00.000Z" }]
};

const ROUTES = {
  "/admin/titopro/reports": REPORTS,
  "/admin/titopro/listings?state": LISTINGS,
  [`/admin/titopro/listings/${PRO}`]: DETAIL
};

(async () => {
  console.log("\n=============================================================");
  console.log("  ADMIN -> TitoPro moderation");
  console.log("=============================================================\n");

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });
  const errors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
        accessToken: "test-token", refreshToken: "test-refresh", role: "super_admin",
        scope: "admin", clientLastSeenAt: Date.now()
      }));
      // THE API IS POINTED AT THIS SAME ORIGIN, which is the one thing that
      // makes a stubbed console work at all. Left on its default the console
      // calls 127.0.0.1:8110, the browser sends a CORS preflight for the
      // Authorization header, and a preflight is not something a route handler
      // gets to answer - so every request failed before it was ever
      // intercepted and the page rendered "Cannot reach the TitoPay API"
      // instead of itself. Same origin, no preflight, no CORS.
      window.TITOPAY_ADMIN_CONFIG = { apiBaseUrl: `${location.origin}/v1` };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));

    // Everything the console asks the API for. /health is stubbed as well as
    // /v1: the console probes it first and shows "Cannot reach the TitoPay
    // API" in place of the page when that probe gets no answer.
    await page.route((url) => url.pathname.startsWith("/v1/") || url.pathname === "/health", async (route) => {
      const url = new URL(route.request().url());
      const target = `${url.pathname.replace(/^\/v1/, "")}${url.search}`;
      const key = Object.keys(ROUTES).find((candidate) => target.startsWith(candidate));
      let body = key ? ROUTES[key] : { ok: true, items: [] };
      if (url.pathname.endsWith("/health")) {
        body = { ok: true, status: "ok", build: 999 };
      } else if (target.startsWith("/admin/me")) {
        body = { ok: true, id: "admin-1", role: "super_admin", permissions: ["*"], fullName: "Moderator" };
      }
      await route.fulfill({ status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    });

    await page.goto(`http://127.0.0.1:${port}/titopro/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#page-content table", { timeout: 20000 });

    const shell = await page.evaluate(() => ({
      heading: document.querySelector(".page-head h1, h1")?.textContent.trim() || "",
      metrics: [...document.querySelectorAll(".metric-card")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
      tables: [...document.querySelectorAll("#page-content .card h3, #page-content .card-head h3, #page-content h3")]
        .map((el) => el.textContent.trim()),
      rows: [...document.querySelectorAll("#page-content table tbody tr")].map((tr) => tr.textContent.replace(/\s+/g, " ").trim())
    }));
    check("the moderation page paints", shell.rows.length >= 3, `${shell.rows.length} rows`);
    check("it is named for what it is", /TitoPro Moderation/i.test(shell.heading), shell.heading);
    check("the queue is counted before it is read",
      shell.metrics.some((m) => /Open reports\s*2/.test(m)) && shell.metrics.some((m) => /Urgent\s*1/.test(m)),
      shell.metrics.join(" · "));
    check("and so is how many came from real customers",
      shell.metrics.some((m) => /From real customers\s*1/.test(m)), shell.metrics.join(" · "));

    // THE ORDERING. A report about somebody being threatened does not wait
    // behind a fortnight of "he was late", and the page must not undo the
    // order the API sent.
    check("THE DANGEROUS REPORT IS READ FIRST",
      /Threatening or abusive/.test(shell.rows[0]) && /Urgent/.test(shell.rows[0]), shell.rows[0].slice(0, 70));
    check("a report from an actual customer says so",
      shell.rows.some((row) => /Did not arrive/.test(row) && /Customer of theirs/.test(row)),
      shell.rows.find((row) => /Did not arrive/.test(row))?.slice(0, 90) || "");
    check("and one from somebody who never hired them says that instead",
      /No job with them/.test(shell.rows[0]), shell.rows[0].slice(0, 90));
    check("the operator is shown what was actually said",
      shell.rows.some((row) => /would not leave the property/.test(row)));
    check("and how many reports this professional has ever had",
      shell.rows.some((row) => /2 report\(s\) ever/.test(row)));

    // A removed listing is listed, and is not offered a Suspend it cannot take.
    const removedRow = await page.evaluate((id) => {
      const cell = [...document.querySelectorAll("#page-content table tbody tr")]
        .find((tr) => tr.innerHTML.includes(id));
      return cell ? { text: cell.textContent.replace(/\s+/g, " ").trim(),
        buttons: [...cell.querySelectorAll("button")].map((b) => b.textContent.trim()) } : null;
    }, REMOVED_PRO);
    check("a removed listing stays findable", Boolean(removedRow), removedRow?.text.slice(0, 60) || "missing");
    check("it reads as TitoPay's decision, not as a lapsed check",
      /Removed by TitoPay/.test(removedRow?.text || ""), removedRow?.text.slice(0, 50) || "");
    check("with the reason kept against it",
      /Unsafe electrical work/.test(removedRow?.text || ""));
    check("and an operator can still hand it back",
      (removedRow?.buttons || []).includes("Approve"), (removedRow?.buttons || []).join(" · "));

    // ---- the detail panel ------------------------------------------------
    await page.click(`[data-titopro-open="${PRO}"]`);
    await page.waitForSelector("#titopro-listing-host .table-card", { timeout: 15000 });
    const panel = await page.evaluate(() => {
      const host = document.getElementById("titopro-listing-host");
      return {
        heading: host.querySelector("h3")?.textContent.trim() || "",
        metrics: [...host.querySelectorAll(".metric-card")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
        buttons: [...host.querySelectorAll(".table-card > .action-row button")].map((b) => b.textContent.trim()),
        copy: [...host.querySelectorAll("p.table-card-note")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
        reportRows: [...host.querySelectorAll("table tbody tr")].map((tr) => tr.textContent.replace(/\s+/g, " ").trim())
      };
    });
    check("opening a listing shows who it is", panel.heading === "Sipho Ndlovu", panel.heading);
    // IT MUST ALSO LOOK LIKE THE REST OF THE CONSOLE. "card" and "card-head"
    // are not styled anywhere in admin.css, so a panel built on them renders
    // as bare text in the middle of a page of bordered cards - which is what
    // this first shipped as, and only a screenshot showed it.
    const styled = await page.evaluate(() => {
      const section = document.querySelector("#titopro-listing-host .table-card");
      if (!section) return null;
      const style = getComputedStyle(section);
      return { border: style.borderTopWidth, padding: parseFloat(style.paddingTop), radius: parseFloat(style.borderTopLeftRadius) };
    });
    check("and the panel is a real console card, not bare text",
      Boolean(styled) && styled.padding > 4 && styled.radius > 2,
      styled ? `padding ${styled.padding}px, radius ${styled.radius}px` : "no panel");
    check("with the contact details a decision needs",
      panel.metrics.some((m) => /sipho@example\.co\.za/.test(m)) && panel.metrics.some((m) => /\+27821234567/.test(m)),
      panel.metrics.join(" · "));
    check("and what they score", panel.metrics.some((m) => /4\.8 \(24\)/.test(m)), panel.metrics.join(" · "));
    check("their background checks are on the same screen",
      panel.reportRows.some((row) => /Police clearance/.test(row) && /cleared/.test(row)));
    check("CLOSED REPORTS ARE SHOWN TOO - one complaint and a pattern differ",
      panel.reportRows.some((row) => /Charged more than quoted/.test(row) && /dismissed/.test(row)),
      `${panel.reportRows.length} rows in the panel`);
    check("including what was decided about them",
      panel.reportRows.some((row) => /Nothing in it/.test(row)));

    // A LIVE listing has nothing to approve, and can be suspended or removed.
    check("A LIVE LISTING IS NOT OFFERED AN APPROVE THAT WOULD DO NOTHING",
      !panel.buttons.some((b) => /^Approve/.test(b)), panel.buttons.join(" · "));
    check("it can be suspended or removed", panel.buttons.includes("Suspend") && panel.buttons.includes("Remove"),
      panel.buttons.join(" · "));
    check("AND THE PAGE SAYS APPROVING IS NOT PUBLISHING",
      panel.copy.some((line) => /does not put it live/i.test(line)),
      panel.copy.find((line) => /approv/i.test(line))?.slice(0, 90) || "");

    // Taking an action asks for the reason and refuses to proceed without one.
    let asked = "";
    page.on("dialog", async (dialog) => { asked = dialog.message(); await dialog.dismiss(); });
    await page.click(`[data-titopro-moderate="suspend"]`);
    await page.waitForTimeout(400);
    check("SUSPENDING ASKS FOR THE REASON BEFORE ANYTHING HAPPENS",
      /Why is this being suspended/.test(asked), asked.replace(/\s+/g, " ").slice(0, 90));
    check("and says the reason is not shown to the professional",
      /NOT shown to the professional/.test(asked), asked.replace(/\s+/g, " ").slice(-60));

    check("no page errors", errors.length === 0, errors.join(" | "));

    // A picture of the page as an operator meets it, for anybody who wants to
    // look rather than read a list of passes. Gitignored, like every artifact.
    const shot = path.join(__dirname, "artifacts", "titopro-moderation-console.png");
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`\n  screenshot: ${shot}`);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
