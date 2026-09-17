// THE HR PORTAL IN A REAL BROWSER.
//
// The API harnesses prove the server behaves. This proves a person sitting in
// front of the portal can do the things the audit said they could not:
//
//   N-02  "Open resource" on a mandatory course goes somewhere, or is not there
//   N-04  a recruitment candidate can be deleted
//   N-05  an announcement can be deleted
//   F-15  the approval counter matches the announcements on screen
//   N-03  the site scrolls, at five sizes, and the mobile drawer closes
//
// Everything here is done the way a person would do it: sign in, tap, read what
// is on screen. Nothing is asserted by reading source.
const fs = require("fs");
const { chromium } = require("playwright");
const { Client } = require("./api/node_modules/pg");

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORTAL = "http://127.0.0.1:8030/index.html";
const EMAIL = "portal.admin@titopay.local";
const DIRECTOR_EMAIL = "portal.director@titopay.local";
const PASSWORD = "PortalTest!2026#x";
const POSTGRES_URL = process.env.POSTGRES_URL
  || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(t) { console.log(`\n--- ${t} ---`); }

async function signIn(page) {
  await page.goto(PORTAL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  const inputs = await page.$$("input");
  await inputs[0].fill(EMAIL);
  await inputs[1].fill(PASSWORD);
  await page.click("text=Sign in securely");
  await page.waitForTimeout(3000);
}

// Deleting reloads the page so the counters are recalculated by the server.
// Wait for the portal to come back before asking it to do anything else.
async function ready(page) {
  await page.waitForSelector(".sidebar", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".sidebar a, .sidebar button").length > 5,
    { timeout: 20000 });
  await page.waitForTimeout(600);
}

// On a narrow screen the sidebar is a drawer and has to be opened first.
async function go(page, module, narrow = false) {
  await ready(page);
  if (narrow) {
    const open = await page.evaluate(() => Boolean(document.querySelector(".sidebar.open")));
    if (!open) { await page.click(".topbar .mobile-only, header .mobile-only"); await page.waitForTimeout(500); }
  }
  await page.click(`text="${module}"`);
  await page.waitForTimeout(1700);
}

(async () => {
  console.log(`\n${"=".repeat(78)}\n  THE HR PORTAL IN A BROWSER\n${"=".repeat(78)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters").catch(() => {});
  const stamp = Date.now();

  // Records this test will try to delete through the interface.
  const candidateEmail = `cand${stamp}@titopay.local`;
  await db.query(
    `INSERT INTO hr_recruitment_candidates (name, email, job_title, stage)
     VALUES ($1, $2, 'Support Agent', 'screening')`, [`Deletable Candidate ${stamp}`, candidateEmail]);
  const announcementTitle = `Deletable announcement ${stamp}`;
  await db.query(
    `INSERT INTO hr_announcements (title, body, audience, priority, status)
     VALUES ($1, 'Created by the portal test.', 'all', 'normal', 'published')`, [announcementTitle]);

  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const scriptErrors = [];
  page.on("pageerror", (e) => scriptErrors.push(e.message.slice(0, 120)));
  await signIn(page);
  check("an HR administrator can sign in",
    await page.evaluate(() => document.body.innerText.includes("Dashboard")));

  /* =============================================================== N-02 */
  section("1. Learning Hub resources go somewhere, or are not offered");
  await go(page, "Learning Hub");
  const learning = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a")).filter((a) => /open resource/i.test(a.textContent));
    const bad = anchors.filter((a) => {
      const href = a.getAttribute("href") || "";
      if (!href) return true;
      if (/^(https?:)?\/\//.test(href) || href.startsWith("/")) return false;
      return true; // a bare word like "hr-learning" is not somewhere to go
    });
    return { courses: document.querySelectorAll(".card").length, anchors: anchors.length,
      bad: bad.length, sample: bad.slice(0, 3).map((a) => a.getAttribute("href")) };
  });
  check("the Learning Hub lists courses", learning.courses > 5, `${learning.courses} cards`);
  check("NO COURSE OFFERS A LINK THAT GOES NOWHERE", learning.bad === 0,
    `${learning.anchors} resource link(s), ${learning.bad} broken ${JSON.stringify(learning.sample)}`);

  const mandatory = await page.evaluate(() => {
    const names = ["Anti-Fraud and AML Awareness", "Customer Service Excellence", "Cybersecurity Awareness"];
    return names.map((name) => {
      const card = Array.from(document.querySelectorAll(".card"))
        .find((c) => c.textContent.includes(name));
      if (!card) return { name, present: false };
      const dead = Array.from(card.querySelectorAll("a")).some((a) => {
        const href = a.getAttribute("href") || "";
        return href && !/^(https?:)?\/\//.test(href) && !href.startsWith("/");
      });
      const usable = Array.from(card.querySelectorAll("button")).map((b) => b.textContent.trim());
      return { name, present: true, dead, usable };
    });
  });
  for (const course of mandatory) {
    check(`mandatory course is on screen: ${course.name}`, course.present);
    if (course.present) {
      check(`   ...with no dead resource link`, !course.dead);
      check(`   ...and something to do with it`, (course.usable || []).length > 0,
        JSON.stringify(course.usable));
    }
  }

  /* =============================================================== N-04 */
  section("2. A recruitment candidate can be deleted");
  await go(page, "Recruitment");
  await page.click("text=Candidate pipeline");
  await page.waitForTimeout(1400);
  const hasCandidate = await page.evaluate((email) =>
    Array.from(document.querySelectorAll(".candidate.card")).some((c) => c.textContent.includes(email)),
  candidateEmail);
  check("the candidate is in the pipeline", hasCandidate);

  const delBtn = await page.evaluateHandle((email) => {
    const card = Array.from(document.querySelectorAll(".candidate.card")).find((c) => c.textContent.includes(email));
    return card ? card.querySelector('[data-repair="delete"]') : null;
  }, candidateEmail);
  const candidateButton = delBtn.asElement();
  check("A CANDIDATE HAS A DELETE CONTROL", Boolean(candidateButton));
  if (candidateButton) {
    await candidateButton.click();
    await page.waitForTimeout(700);
    const copy = await page.evaluate(() =>
      document.querySelector('[data-repair-modal] p')?.textContent || "");
    check("it asks first, and says what deletion means", /audit trail/i.test(copy), copy.slice(0, 80));
    check("it does NOT claim the record is gone forever", !/cannot be undone/i.test(copy));
    await page.click('[data-repair-modal] .danger');
    await page.waitForTimeout(2600);
    const row = await db.query(
      "SELECT deleted_at FROM hr_recruitment_candidates WHERE email = $1", [candidateEmail]);
    check("THE CANDIDATE IS DELETED SERVER-SIDE", row.rows[0] && row.rows[0].deleted_at !== null,
      row.rows[0] ? (row.rows[0].deleted_at ? "soft deleted" : "STILL ACTIVE") : "row missing");
    check("the record is kept for the audit trail, not destroyed", row.rows.length === 1);
  }

  /* =============================================================== N-05 */
  section("3. An announcement can be deleted");
  await go(page, "Announcements");
  const annBtn = await page.evaluateHandle((title) => {
    const card = Array.from(document.querySelectorAll(".announcement-card")).find((c) => c.textContent.includes(title));
    return card ? card.querySelector('[data-repair="delete"]') : null;
  }, announcementTitle);
  const announcementButton = annBtn.asElement();
  check("AN ANNOUNCEMENT HAS A DELETE CONTROL", Boolean(announcementButton));
  if (announcementButton) {
    await announcementButton.click();
    await page.waitForTimeout(700);
    await page.click('[data-repair-modal] .danger');
    await page.waitForTimeout(2600);
    const row = await db.query("SELECT deleted_at FROM hr_announcements WHERE title = $1", [announcementTitle]);
    check("THE ANNOUNCEMENT IS DELETED SERVER-SIDE", row.rows[0] && row.rows[0].deleted_at !== null,
      row.rows[0] ? (row.rows[0].deleted_at ? "soft deleted" : "STILL PUBLISHED") : "row missing");
    const gone = await page.evaluate((title) =>
      !Array.from(document.querySelectorAll(".announcement-card")).some((c) => c.textContent.includes(title)),
    announcementTitle);
    check("and it is off the screen", gone);
  }

  /* =============================================================== F-15 */
  section("4. The approval counter matches what is on screen");
  await go(page, "Announcements");
  const counts = await page.evaluate(() => {
    const metric = (label) => {
      const el = Array.from(document.querySelectorAll(".metric")).find((m) => m.textContent.includes(label));
      return el ? Number((el.querySelector("strong") || {}).textContent) : null;
    };
    const cards = Array.from(document.querySelectorAll(".announcement-card"));
    const statusOf = (card) => (card.querySelector(".status")?.textContent || "").trim().toLowerCase();
    return { queue: metric("CEO approval queue"), live: metric("Live announcements"),
      onScreenPending: cards.filter((c) => /pending|approval/.test(statusOf(c))).length,
      onScreenPublished: cards.filter((c) => statusOf(c) === "published").length,
      total: cards.length };
  });
  check("the approval queue counts the ones awaiting approval on screen",
    counts.queue === counts.onScreenPending, `counter ${counts.queue}, on screen ${counts.onScreenPending}`);
  check("the live counter counts the published ones on screen",
    counts.live === counts.onScreenPublished, `counter ${counts.live}, on screen ${counts.onScreenPublished}`);

  /* ======================================================== staff email */
  section("5. Staff email can be managed from the portal, by the right people");
  await go(page, "Announcements");
  const adminSees = await page.evaluate(() => Boolean(document.querySelector('[data-repair="email-panel"]')));
  check("AN HR ADMINISTRATOR IS NOT OFFERED THE STAFF EMAIL CONTROLS", !adminSees,
    "mailing every employee is not something a module permission should imply");
  await page.close();

  const dir = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  dir.on("pageerror", (e) => scriptErrors.push(e.message.slice(0, 120)));
  await dir.goto(PORTAL, { waitUntil: "domcontentloaded" });
  await dir.waitForTimeout(1600);
  const dirInputs = await dir.$$("input");
  await dirInputs[0].fill(DIRECTOR_EMAIL);
  await dirInputs[1].fill(PASSWORD);
  await dir.click("text=Sign in securely");
  await dir.waitForTimeout(3000);
  await go(dir, "Announcements");
  await dir.waitForTimeout(1200);

  // On a phone this used to sit 800px down, below four stacked metric cards, and
  // stand nearly a thousand pixels tall — present, and unfindable.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on("pageerror", (e) => scriptErrors.push(e.message.slice(0, 120)));
  await phone.goto(PORTAL, { waitUntil: "domcontentloaded" });
  await phone.waitForTimeout(1600);
  const phoneInputs = await phone.$$("input");
  await phoneInputs[0].fill(DIRECTOR_EMAIL);
  await phoneInputs[1].fill(PASSWORD);
  await phone.click("text=Sign in securely");
  await phone.waitForTimeout(3000);
  await go(phone, "Announcements", true);
  await phone.waitForTimeout(1200);
  const onPhone = await phone.evaluate(() => {
    const el = document.querySelector('[data-repair="email-panel"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), viewport: window.innerHeight,
      onFirstScreen: r.top >= 0 && r.top < window.innerHeight,
      summary: Boolean(el.querySelector('[data-repair="email-summary"]')),
      expandedControls: el.querySelectorAll('[data-repair^="email-event-"]').length };
  });
  check("ON A PHONE IT IS ON THE FIRST SCREEN, NOT BURIED", Boolean(onPhone) && onPhone.onFirstScreen,
    onPhone ? `${onPhone.top}px down a ${onPhone.viewport}px screen` : "panel missing");
  check("and it is one line until asked to open", Boolean(onPhone) && onPhone.height < 140
    && onPhone.expandedControls === 0, onPhone ? `${onPhone.height}px tall` : "");
  if (onPhone && onPhone.summary) {
    await phone.click('[data-repair="email-summary"]');
    await phone.waitForTimeout(700);
    const opened = await phone.evaluate(() => ({
      controls: document.querySelectorAll('[data-repair^="email-event-"]').length,
      contact: Boolean(document.querySelector('[data-repair="email-contact"]'))
    }));
    check("tapping Manage opens the controls", opened.controls === 5 && opened.contact,
      `${opened.controls} event controls`);
    await phone.click('[data-repair="email-summary"]');
    await phone.waitForTimeout(500);
    check("and tapping again folds it away",
      await phone.evaluate(() => document.querySelectorAll('[data-repair^="email-event-"]').length === 0));
  }
  await phone.close();

  await dir.click('[data-repair="email-summary"]').catch(() => {});
  await dir.waitForTimeout(600);
  const panel = await dir.evaluate(() => {
    const el = document.querySelector('[data-repair="email-panel"]');
    return el ? { text: el.innerText, toggle: Boolean(el.querySelector('[data-repair="email-toggle"]')),
      events: el.querySelectorAll('[data-repair^="email-event-"]').length,
      audience: el.querySelectorAll('[data-repair^="email-audience-"]').length } : null;
  });
  check("an HR Director IS offered them", Boolean(panel));
  if (panel) {
    check("it says whether staff email is on", /\bOn\b|\bOff\b/.test(panel.text));
    check("IT SAYS WHY IT IS OFF, NOT JUST THAT IT IS",
      /not configured to send staff email|switch below is off/i.test(panel.text),
      "the environment lever and the operator switch are different things");
    check("every event can be turned on or off individually", panel.events === 5, `${panel.events} controls`);
    check("and the announcement audience can be chosen", panel.audience === 2, `${panel.audience} options`);

    // Changing it must actually persist, not just move a checkbox.
    const before = await dir.evaluate(() =>
      document.querySelector('[data-repair="email-event-leave"]').checked);
    await dir.click('[data-repair="email-event-leave"]');
    await dir.waitForTimeout(1800);
    const stored = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'hr_email'").catch(() => ({ rows: [] }));
    const savedValue = stored.rows[0]?.value;
    check("TURNING AN EVENT OFF IS SAVED ON THE SERVER, NOT JUST ON SCREEN",
      savedValue && savedValue.events && savedValue.events.leave === !before,
      JSON.stringify(savedValue?.events || {}));
    const afterReload = await dir.evaluate(() =>
      document.querySelector('[data-repair="email-event-leave"]')?.checked);
    check("and the panel shows what the server now holds", afterReload === !before);
    await dir.click('[data-repair="email-event-leave"]');
    await dir.waitForTimeout(1500);
  }
  await dir.close();

  /* =============================================================== N-03 */
  section("6. The site scrolls, and the drawer lets go");
  await page.close();
  for (const [label, width, height] of [["desktop", 1440, 900], ["laptop", 1280, 720],
    ["tablet", 820, 1180], ["mobile", 390, 844], ["small phone", 360, 640]]) {
    const view = await browser.newPage({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 });
    view.on("pageerror", (e) => scriptErrors.push(e.message.slice(0, 120)));
    await signIn(view);
    await go(view, "Learning Hub", width <= 1080);
    const scroll = await view.evaluate(() => {
      const before = window.scrollY;
      window.scrollTo(0, 999999);
      const moved = window.scrollY - before;
      const cards = document.querySelectorAll(".card");
      const last = cards[cards.length - 1];
      const bottom = last ? last.getBoundingClientRect().bottom : null;
      window.scrollTo(0, before);
      return { docH: document.documentElement.scrollHeight, winH: window.innerHeight,
        moved, cards: cards.length, lastReachable: bottom === null ? null : bottom <= window.innerHeight + 6 };
    });
    const fits = scroll.docH <= scroll.winH + 4;
    check(`${label}: the whole list can be reached`,
      scroll.cards > 0 && (fits || (scroll.moved > 0 && scroll.lastReachable)),
      `${scroll.cards} cards, ${scroll.docH}px in a ${scroll.winH}px window, scrolled ${scroll.moved}px`);

    if (width <= 1080) {
      await view.click(".topbar .mobile-only, header .mobile-only");
      await view.waitForTimeout(600);
      // Scrolling is tested with a real wheel gesture, not by assigning
      // scrollTop: assignment moves an element even when overflow:hidden stops
      // a person from moving it, so it would report a lock that is not there.
      const scrollByWheel = async () => {
        const before = await view.evaluate(() => document.scrollingElement.scrollTop);
        await view.mouse.move(Math.round(width / 2), Math.round(height / 2));
        await view.mouse.wheel(0, 900);
        await view.waitForTimeout(450);
        const after = await view.evaluate(() => document.scrollingElement.scrollTop);
        return after - before;
      };
      const movedBehind = await scrollByWheel();
      const open = await view.evaluate(() => ({
        open: Boolean(document.querySelector(".sidebar.open")),
        hasClose: Boolean(document.querySelector(".sidebar .icon-button"))
      }));
      open.pageLocked = movedBehind === 0;
      check(`${label}: the menu opens`, open.open);
      check(`${label}: the menu offers its own way out`, open.hasClose);
      check(`${label}: THE PAGE DOES NOT SCROLL BEHIND THE OPEN MENU`, open.pageLocked,
        `wheel moved it ${movedBehind}px`);
      // Closed the way the design intends: the X inside the drawer.
      await view.click(".sidebar .icon-button");
      await view.waitForTimeout(600);
      const stillOpen = await view.evaluate(() => Boolean(document.querySelector(".sidebar.open")));
      const movedAfter = await scrollByWheel();
      check(`${label}: the X closes the menu`, !stillOpen);
      check(`${label}: AND THE PAGE SCROLLS AGAIN AFTERWARDS`, movedAfter > 0,
        `wheel moved it ${movedAfter}px`);

      // Tapping outside is the other way people close a drawer.
      await view.click(".topbar .mobile-only, header .mobile-only");
      await view.waitForTimeout(500);
      await view.mouse.click(width - 14, Math.round(height / 2));
      await view.waitForTimeout(600);
      check(`${label}: tapping outside also closes it`,
        await view.evaluate(() => !document.querySelector(".sidebar.open")));
    }
    await view.close();
  }

  check("no script errors anywhere in this run", scriptErrors.length === 0,
    JSON.stringify(scriptErrors.slice(0, 3)));

  await db.query("DELETE FROM hr_recruitment_candidates WHERE email = $1", [candidateEmail]);
  await db.query("DELETE FROM hr_announcements WHERE title = $1", [announcementTitle]);
  await db.end();
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(78)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`    - ${f.name}`);
  console.log(`${"=".repeat(78)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.stack || e.message); process.exit(1); });
