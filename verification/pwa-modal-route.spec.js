// A ROUTE LINK INSIDE A MODAL HAS TO GO SOMEWHERE.
//
// Business Ticketing shows "Business verification required" with an Open
// Profile button when a business has not finished FICA. The button carries
// data-route="profile", which sets location.hash — and the modal it sits in
// stays open on top of the page it just navigated to, so the tap looks dead.
//
// This drives the app's own openModal() and its own click handler, with the
// markup the ticketing screen actually renders.
const { chromium } = require("playwright");
const PWA = "http://127.0.0.1:8010";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

(async () => {
  console.log(`\n${"=".repeat(76)}\n  PWA — a route link inside a modal\n${"=".repeat(76)}\n`);
  const browser = await chromium.launch({ executablePath: CHROME });
  // The PWA caches its own bundle in a service worker, so without this the
  // test happily exercises the previous build and reports on code that is no
  // longer on disk.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const hasOpenModal = await page.evaluate(() => typeof openModal === "function");
  check("the app exposes its modal opener to drive", hasOpenModal);
  if (!hasOpenModal) { await browser.close(); process.exit(1); }

  await page.evaluate(() => { location.hash = "dashboard"; });
  await page.waitForTimeout(400);

  // The exact block the ticketing screen renders when verification is missing.
  await page.evaluate(() => {
    openModal(`
      <div class="modal-head">
        <div><p class="eyebrow">Business Ticketing</p><h2>Events and tickets</h2></div>
        <button class="icon-btn" data-close aria-label="Close">x</button>
      </div>
      <section class="empty-state compact-state">
        <strong>Business verification required</strong>
        <p>Full business FICA verification is required before creating events.</p>
        <button class="btn primary" type="button" data-route="profile">Open Profile</button>
      </section>
    `);
  });
  await page.waitForTimeout(600);
  check("the verification modal is open",
    await page.evaluate(() => Boolean(document.querySelector(".modal-backdrop"))));

  await page.click('.modal-backdrop [data-route="profile"]');
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => ({
    hash: location.hash,
    modalStillUp: Boolean(document.querySelector(".modal-backdrop")),
    modalText: (document.querySelector(".modal-backdrop")?.innerText || "").replace(/\n+/g, " ").slice(0, 70)
  }));
  check("tapping Open Profile navigates to the profile route", after.hash === "#profile", after.hash);
  check("AND THE MODAL GETS OUT OF THE WAY SO THE PROFILE IS VISIBLE",
    !after.modalStillUp,
    after.modalStillUp ? `still covering the page: "${after.modalText}"` : "closed");

  // A route link that is NOT in a modal must be unaffected — it navigates, and
  // nothing tries to close a modal that was never there.
  await page.evaluate(() => { location.hash = "dashboard"; });
  await page.waitForTimeout(600);
  const outside = await page.evaluate(() => {
    const link = document.createElement("button");
    link.setAttribute("data-route", "services");
    link.textContent = "Services";
    document.body.appendChild(link);
    link.click();
    const result = { hash: location.hash, modal: Boolean(document.querySelector(".modal-backdrop")) };
    link.remove();
    return result;
  });
  check("a route link OUTSIDE a modal still navigates", outside.hash === "#services", outside.hash);
  check("and nothing is broken by there being no modal to close", !outside.modal);

  // And a modal that is not being navigated away from stays put.
  await page.evaluate(() => openModal('<div class="modal-head"><h2>Stays open</h2>'
    + '<button class="icon-btn" data-close>x</button></div><p>Nothing to navigate to.</p>'));
  await page.waitForTimeout(500);
  check("a modal with no route link is left alone",
    await page.evaluate(() => Boolean(document.querySelector(".modal-backdrop"))));
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(300);
  check("no script errors", errors.length === 0, JSON.stringify(errors.slice(0, 2)));

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(76)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`    - ${f.name}`);
  console.log(`${"=".repeat(76)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.stack || e.message); process.exit(1); });
