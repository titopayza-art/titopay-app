// THE WITHDRAWAL REQUEST SCREEN HAS TO BE ASKABLE.
//
// Three things were wrong with it, all visible on one phone screenshot of a
// brand-new group:
//
//   1. It printed "The group holds R 0,00" directly above an amount box and
//      let the person fill the whole form in. The server refuses any amount
//      above the balance, so on an empty pot every possible entry is rejected
//      and the only way to find out was to submit.
//
//   2. The reason box said "The group will see this reason when they vote".
//      There is no vote. One organiser decides - which the heading above it
//      and the note below it both already said.
//
//   3. The creator of a group is its only organiser, and an organiser may not
//      approve their own withdrawal. So their own request had nobody who
//      could decide it, and the screen said nothing about it.
//
//   NODE_PATH=/opt/node22/lib/node_modules:/opt/node22/lib/node_modules/playwright/node_modules \
//   node verification/stokvel-withdrawal-screen.spec.js

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PWA_ROOT = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const API = "https://api.titopay.co.za";

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed });
  console.log(`${passed ? "  PASS" : "  FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

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

// The group as the app holds it after loading a detail. Roles and statuses
// are spelled the way the server spells them.
function groupFixture(overrides) {
  return Object.assign({
    id: "g1", name: "Ibiza", balance: 0, canManage: true,
    members: [
      { id: "m1", name: "Thuso Tshiloane", role: "chair", status: "active" },
      { id: "m2", name: "Bafo", role: "member", status: "active" }
    ],
    contributions: [], activity: [], withdrawals: []
  }, overrides);
}

(async () => {
  console.log("\n=============================================================");
  console.log("  APP -> requesting a withdrawal from a stokvel group");
  console.log("=============================================================\n");

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium" });

  try {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`${API}/**`, (route) => route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, items: [] }) }));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.openStockvelWithdrawalRequestModal === "function",
      null, { timeout: 15000 });

    // `state` is a module-level const, so it is reachable bare in here but is
    // not a property of window.
    const open = (group) => page.evaluate((fixture) => {
      state.stockvel = { detail: fixture, groups: [{ id: fixture.id, name: fixture.name }] };
      window.closeModal();
      window.openStockvelWithdrawalRequestModal(fixture.id);
      const card = document.querySelector(".modal-card");
      return {
        text: card.textContent.replace(/\s+/g, " ").trim(),
        hasForm: Boolean(card.querySelector("form[data-form=stockvel-withdrawal]")),
        placeholder: (card.querySelector("textarea[name=reason]") || {}).placeholder || ""
      };
    }, group);

    /* ---- 1. An empty pot ------------------------------------------------ */
    const empty = await open(groupFixture({ balance: 0 }));
    check("AN EMPTY POT DOES NOT OFFER A FORM THAT CANNOT SUCCEED", !empty.hasForm,
      empty.hasForm ? "the amount box is still there" : "");
    check("and says so before anything is typed",
      /nothing to withdraw yet/i.test(empty.text), empty.text.slice(0, 90));
    check("naming what the group actually holds", /R\s?0[.,]00/.test(empty.text));
    check("with a way to put money in", await page.evaluate(() =>
      Boolean(document.querySelector("[data-stockvel-contribute]"))));

    /* ---- 2. A pot with money in it -------------------------------------- */
    const funded = await open(groupFixture({ balance: 1500 }));
    check("a funded group still gets the form", funded.hasForm);
    check("THE REASON BOX NO LONGER PROMISES A VOTE",
      !/vote/i.test(funded.placeholder), funded.placeholder);
    check("and says who actually reads it", /organiser/i.test(funded.placeholder), funded.placeholder);
    check("the screen mentions no vote anywhere", !/\bvote\b/i.test(funded.text));

    /* ---- 3. Who can decide it ------------------------------------------- */
    check("THE ONLY ORGANISER IS TOLD NOBODY CAN APPROVE THEIR REQUEST",
      /only organiser/i.test(funded.text));
    check("and is told how to fix it", /make organiser/i.test(funded.text));

    const twoOrganisers = await open(groupFixture({
      balance: 1500,
      members: [
        { id: "m1", name: "Thuso Tshiloane", role: "chair", status: "active" },
        { id: "m2", name: "Bafo", role: "organiser", status: "active" }
      ]
    }));
    check("a group with a second organiser is not warned",
      !/only organiser/i.test(twoOrganisers.text));

    const removedOrganiser = await open(groupFixture({
      balance: 1500,
      members: [
        { id: "m1", name: "Thuso Tshiloane", role: "chair", status: "active" },
        { id: "m2", name: "Bafo", role: "organiser", status: "removed" }
      ]
    }));
    check("a removed organiser does not count as a second one",
      /only organiser/i.test(removedOrganiser.text));

    const plainMember = await open(groupFixture({ balance: 1500, canManage: false }));
    check("a plain member is not warned about approving their own request",
      !/only organiser/i.test(plainMember.text));

    /* ---- 4. What must not be guessed ------------------------------------ */
    // A group summary that ships no balance is not a group holding nothing.
    const unknown = await open(groupFixture({ balance: null, members: [] }));
    check("A GROUP WHOSE BALANCE IS UNKNOWN IS NOT TREATED AS EMPTY", unknown.hasForm);
    check("and with no member list to count, nothing is claimed about organisers",
      !/only organiser/i.test(unknown.text));

    check("no page errors", errors.length === 0, errors.join(" | "));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
