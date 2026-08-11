// STARTER TEMPLATES IN THE MARKETING CENTRE, in a real browser.
//
// The three composers on /marketing/ (in-app announcement, bulk SMS, email
// production) previously offered "Saved templates (0)" on every machine,
// because the only templates were ones you had typed yourself into that one
// browser's localStorage. This adds fourteen built-in ones.
//
// What has to be true, and is checked here by driving the page:
//
//   T-01  each composer offers its starters, grouped apart from browser-saved
//   T-02  applying a starter fills the composer's fields
//   T-03  a starter still carrying [[PLACEHOLDER]] cannot be submitted
//         — nothing reaches the API
//   T-04  once the placeholders are filled in, the same form submits
//   T-05  a starter cannot be deleted, and survives the attempt
//   T-06  saving your own template still works, and still deletes
//   T-07  no starter exceeds the field limit the composer enforces
//   T-08  no page error anywhere in the above
//
// T-03 is the one that matters: an announcement reaching every TitoPay
// customer with the words "[[DATE]]" in it is worse than no announcement.
const { chromium } = require("playwright");

const ADMIN = "http://127.0.0.1:8020";
const API = "http://127.0.0.1:8110/v1";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const COMPOSERS = [
  { type: "announcement", form: "marketing-announcement-form", starters: 6, long: "body" },
  { type: "sms", form: "marketing-sms-form", starters: 4, long: "message" },
  { type: "email", form: "marketing-email-form", starters: 4, long: "textBody" }
];

(async () => {
  console.log(`\n${"=".repeat(72)}\n  MARKETING CENTRE — starter templates\n${"=".repeat(72)}\n`);

  const fs = require("fs");
  const { Client } = require("./api/node_modules/pg");
  const db = new Client({ connectionString: process.env.POSTGRES_URL
    || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1] });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters");
  await db.end();

  const login = await fetch(`${API}/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" })
  }).then((r) => r.json());
  check("admin signed in", Boolean(login.accessToken));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1",
    JSON.stringify({ accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now() })),
  [login.accessToken, login.refreshToken]);

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/frame-ancestors|Failed to load resource|WebSocket/.test(m.text())) errors.push(m.text());
  });

  // Every POST the page attempts to a composer endpoint. T-03 asserts this
  // stays empty while a placeholder is unfilled — reading a toast would only
  // prove a message was shown, not that the request was actually stopped.
  const posted = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/admin\/marketing\/(announcements|sms-campaigns|email-campaigns)/.test(req.url())) {
      posted.push(req.url());
    }
  });

  async function openMarketing() {
    await page.goto(`${ADMIN}/marketing/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#marketing-announcement-form", { timeout: 25000 });
    await page.waitForTimeout(600);
  }
  await openMarketing();

  /* ------------------------------------------------------- T-01 grouping */
  for (const c of COMPOSERS) {
    const shape = await page.evaluate((type) => {
      const select = document.querySelector(`.mkt-template-row[data-mkt-type="${type}"] [data-mkt-select]`);
      if (!select) return null;
      return {
        groups: [...select.querySelectorAll("optgroup")].map((g) => g.label),
        starterCount: [...select.querySelectorAll("option")].filter((o) => o.value.startsWith("starter_")).length,
        names: [...select.querySelectorAll("option")].filter((o) => o.value.startsWith("starter_")).map((o) => o.textContent)
      };
    }, c.type);
    check(`${c.type}: the composer offers ${c.starters} starter templates`,
      Boolean(shape) && shape.starterCount === c.starters, shape ? `${shape.starterCount} found` : "no select");
    check(`${c.type}: starters sit under their own heading, not mixed in with saved ones`,
      Boolean(shape) && shape.groups.includes("TitoPay starter templates"),
      shape ? JSON.stringify(shape.groups) : "");
    if (shape) console.log(`         ${shape.names.join(" | ")}`);
  }

  /* ------------------------------------------------ T-02 / T-03 announcement */
  // Every composer has a "Planned maintenance" starter, and all three carry
  // placeholders — so one name drives the same proof through all three.
  async function applyStarterNamed(type, name) {
    await page.evaluate(([t, n]) => {
      const row = document.querySelector(`.mkt-template-row[data-mkt-type="${t}"]`);
      const select = row.querySelector("[data-mkt-select]");
      const option = [...select.querySelectorAll("option")].find((o) => o.textContent.trim() === n);
      select.value = option.value;
      row.querySelector("[data-mkt-apply]").click();
    }, [type, name]);
    await page.waitForTimeout(250);
  }
  async function formValues(formId) {
    return page.evaluate((id) => {
      const form = document.getElementById(id);
      return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, String(v)]));
    }, formId);
  }

  for (const c of COMPOSERS) {
    await applyStarterNamed(c.type, "Planned maintenance");
    const values = await formValues(c.form);
    check(`${c.type}: applying "Planned maintenance" fills the composer`,
      /maintenance/i.test(values[c.long] || ""), `${(values[c.long] || "").length} characters`);
    check(`${c.type}: the applied text still shows what has to be filled in`,
      /\[\[DATE\]\]/.test(JSON.stringify(values)));
  }

  posted.length = 0;
  for (const c of COMPOSERS) {
    await page.evaluate((id) => document.getElementById(id).querySelector("button[type=submit]").click(), c.form);
    await page.waitForTimeout(400);
  }
  check("T-03 nothing reaches the API while a [[PLACEHOLDER]] is unfilled",
    posted.length === 0, posted.length ? posted.join(", ") : "no POST attempted");
  const toast = await page.textContent("body");
  check("T-03 the page says which placeholders are outstanding",
    /Still to fill in:/.test(toast) && /\[\[DATE\]\]/.test(toast));

  /* ------------------------------------------------------------ T-04 submit */
  // Fill the placeholders in the announcement composer the way an operator
  // would — by editing the text — then submit for real.
  await page.evaluate(() => {
    const form = document.getElementById("marketing-announcement-form");
    ["title", "body"].forEach((name) => {
      const field = form.elements[name];
      field.value = field.value
        .replace(/\[\[DATE\]\]/g, "Saturday 5 September 2026")
        .replace(/\[\[START_TIME\]\]/g, "22:00")
        .replace(/\[\[END_TIME\]\]/g, "23:30");
    });
  });
  posted.length = 0;
  const response = page.waitForResponse((r) => /\/admin\/marketing\/announcements$/.test(r.url()) && r.request().method() === "POST", { timeout: 15000 })
    .catch(() => null);
  await page.evaluate(() => document.getElementById("marketing-announcement-form").querySelector("button[type=submit]").click());
  const settled = await response;
  check("T-04 with every placeholder filled in, the same form submits",
    Boolean(settled), settled ? `HTTP ${settled.status()}` : "no request was made");
  check("T-04 the API accepted it", Boolean(settled) && settled.status() < 400,
    settled ? String(settled.status()) : "");

  /* ------------------------------------------------------- T-05 delete guard */
  await openMarketing();
  const beforeDelete = await page.evaluate(() =>
    document.querySelectorAll('.mkt-template-row[data-mkt-type="sms"] option[value^="starter_"]').length);
  await page.evaluate(() => {
    const row = document.querySelector('.mkt-template-row[data-mkt-type="sms"]');
    const select = row.querySelector("[data-mkt-select]");
    select.value = [...select.querySelectorAll("option")].find((o) => o.value.startsWith("starter_")).value;
    row.querySelector("[data-mkt-delete]").click();
  });
  await page.waitForTimeout(300);
  const afterDelete = await page.evaluate(() =>
    document.querySelectorAll('.mkt-template-row[data-mkt-type="sms"] option[value^="starter_"]').length);
  const deleteToast = await page.textContent("body");
  check("T-05 a starter template refuses to be deleted",
    /built in and cannot be deleted/i.test(deleteToast));
  check("T-05 and it is still there afterwards",
    afterDelete === beforeDelete && afterDelete > 0, `${beforeDelete} before, ${afterDelete} after`);

  /* ---------------------------------------------- T-06 your own still works */
  await page.evaluate(() => {
    const form = document.getElementById("marketing-sms-form");
    form.elements.title.value = "Spec harness template";
    form.elements.message.value = "A message typed by the operator, no placeholders.";
    document.querySelector('.mkt-template-row[data-mkt-type="sms"] [data-mkt-save]').click();
  });
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => {
    const select = document.querySelector('.mkt-template-row[data-mkt-type="sms"] [data-mkt-select]');
    return {
      groups: [...select.querySelectorAll("optgroup")].map((g) => g.label),
      mine: [...select.querySelectorAll('optgroup[label="Saved in this browser"] option')].map((o) => o.textContent)
    };
  });
  check("T-06 a template you save still appears, under its own heading",
    saved.groups.includes("Saved in this browser") && saved.mine.includes("Spec harness template"),
    JSON.stringify(saved.mine));
  await page.evaluate(() => {
    const row = document.querySelector('.mkt-template-row[data-mkt-type="sms"]');
    const select = row.querySelector("[data-mkt-select]");
    select.value = [...select.querySelectorAll('optgroup[label="Saved in this browser"] option')]
      .find((o) => o.textContent.trim() === "Spec harness template").value;
    row.querySelector("[data-mkt-delete]").click();
  });
  await page.waitForTimeout(300);
  const goneAndStartersIntact = await page.evaluate(() => {
    const select = document.querySelector('.mkt-template-row[data-mkt-type="sms"] [data-mkt-select]');
    return {
      mine: [...select.querySelectorAll('optgroup[label="Saved in this browser"] option')].length,
      starters: [...select.querySelectorAll('option[value^="starter_"]')].length
    };
  });
  check("T-06 and deleting it removes yours without touching the starters",
    goneAndStartersIntact.mine === 0 && goneAndStartersIntact.starters === 4,
    JSON.stringify(goneAndStartersIntact));

  /* ------------------------------------------------------ T-07 field limits */
  const overLimit = await page.evaluate(() => {
    const limits = {};
    document.querySelectorAll("#marketing-announcement-form [maxlength], #marketing-sms-form [maxlength], #marketing-email-form [maxlength]")
      .forEach((el) => { limits[el.name] = Number(el.getAttribute("maxlength")); });
    const bad = [];
    // eslint-disable-next-line no-undef
    MARKETING_STARTER_TEMPLATES.forEach((template) => {
      Object.entries(template.fields).forEach(([key, value]) => {
        if (limits[key] && String(value).length > limits[key]) {
          bad.push(`${template.type}/${template.name}/${key} ${String(value).length}>${limits[key]}`);
        }
      });
    });
    return bad;
  });
  check("T-07 no starter is longer than the field it goes into",
    overLimit.length === 0, overLimit.join("; "));

  /* -------------------------------------------------------- T-08 no errors */
  check("T-08 no page error while doing any of the above",
    errors.length === 0, errors.slice(0, 3).join(" | "));

  await page.screenshot({ path: "marketing-templates.png", fullPage: false });
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`  FAILED: ${failed.map((f) => f.name).join(" | ")}`);
    process.exit(1);
  }
})().catch((error) => { console.error(error); process.exit(1); });
