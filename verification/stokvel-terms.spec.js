// THE GROUP'S TERMS, DRIVEN IN THE SHIPPED APP.
//
// The API side is proved in api/test/stokvel-terms.test.js against a real
// database. This is the half a customer touches, and it has one detail that
// server tests cannot reach: Accept, Reject and Comment only are three SUBMIT
// BUTTONS on one form. Which one was pressed is the member's decision, and it
// travels as event.submitter.value - so a wiring mistake there does not throw,
// it silently records the wrong answer to a question about somebody's money.
//
// Driven against app.min.js with the API stubbed, so what is exercised is what
// ships.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8179;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "b0b00000-1111-4222-8333-444444444444",
  fullName: "Terms Probe Member", username: "termsprobe",
  email: "terms@titopay.local", phone: "+27820000888",
  accountType: "personal", account_type: "personal", status: "active"
};
const GROUP_ID = "cc11cc22-3344-4556-8778-99aabbccddee";
const TERMS_ID = "dd11dd22-3344-4556-8778-99aabbccddee";
const OLD_TERMS_ID = "ee11ee22-3344-4556-8778-99aabbccddee";

const BODY = [
  "1. Every member contributes R750 by the 7th of each month.",
  "2. A member who misses two consecutive months forfeits that cycle's payout.",
  "3. Payouts rotate in the order members joined."
].join("\n");

function group(canManage) {
  return {
    id: GROUP_ID, name: "Ubuntu Savings Club", description: "Monthly savings",
    status: "active", cadence: "monthly", contribution_amount: 750, member_limit: 12,
    invite_code: "UBU123", created_at: new Date().toISOString(),
    role: canManage ? "chair" : "member", can_manage: canManage,
    balance: 9000, contributed: 9000, withdrawn: 0,
    members: [{ id: "m1", name: "Terms Probe Member", role: canManage ? "chair" : "member",
      joined_at: new Date().toISOString() }],
    contributions: [], withdrawals: [], meetings: [], activity: []
  };
}

const TERMS_PAYLOAD = {
  current: { id: TERMS_ID, version: 2, title: "Ubuntu constitution", body: BODY,
    changeNote: "Monthly contribution raised from R500 to R750.",
    publishedBy: "Thandi Mokoena", publishedAt: new Date().toISOString() },
  tally: { accepted: 3, rejected: 1, commented: 1, responded: 5, memberCount: 8, pending: 3 },
  myResponse: null,
  responses: [
    { name: "Sipho Dlamini", decision: "accepted", comment: "", respondedAt: new Date().toISOString() },
    { name: "Naledi Khumalo", decision: "rejected", comment: "R750 is too steep for me.", respondedAt: new Date().toISOString() },
    { name: "Lerato Mbeki", decision: null, comment: "Can we discuss clause 2?", respondedAt: new Date().toISOString() }
  ],
  history: [{ id: OLD_TERMS_ID, version: 1, title: "Ubuntu constitution",
    changeNote: "", publishedBy: "Thandi Mokoena", publishedAt: new Date(Date.now() - 60 * 86400000).toISOString() }]
};

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

const posted = [];

async function openTerms(browser, { canManage = false, terms = TERMS_PAYLOAD } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (request.method() === "POST" && /\/terms\/[^/]+\/respond$/.test(p)) {
      let body = null;
      try { body = JSON.parse(request.postData() || "null"); } catch { body = request.postData(); }
      posted.push({ kind: "respond", body });
      return json({ termsId: TERMS_ID, version: 2, decision: body?.decision, comment: body?.comment });
    }
    if (request.method() === "POST" && /\/terms$/.test(p)) {
      let body = null;
      try { body = JSON.parse(request.postData() || "null"); } catch { body = request.postData(); }
      posted.push({ kind: "publish", body });
      return json({ terms: { id: "new", version: 3 } });
    }
    if (/\/terms\/[^/]+$/.test(p)) {
      return json({ terms: { id: OLD_TERMS_ID, version: 1, title: "Ubuntu constitution",
        body: "1. Every member contributes R500 by the 7th of each month.",
        publishedBy: "Thandi Mokoena", publishedAt: new Date().toISOString(),
        responses: [{ name: "Sipho Dlamini", decision: "accepted", comment: "", respondedAt: new Date().toISOString() }] } });
    }
    if (/\/terms$/.test(p)) return json(terms || { current: null, history: [] });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/stockvels") return json({ items: [group(canManage)], groups: [group(canManage)] });
    if (p === "/stockvels/invitations") return json({ items: [] });
    if (p.startsWith("/stockvels/")) return json({ group: group(canManage) });
    if (p === "/transactions") return json({ items: [] });
    return json({ items: [] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1200);
  await page.evaluate((id) => {
    if (typeof openStockvelDashboard === "function") openStockvelDashboard(id);
  }, GROUP_ID);
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    const tab = document.querySelector('[data-stockvel-section="terms"]');
    if (tab) tab.click();
  });
  await page.waitForTimeout(1200);
  return { page, context, errors };
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  /* ------------------------------------------------- a member reading them */
  {
    const { page, context, errors } = await openTerms(browser, { canManage: false });
    const seen = await page.evaluate(() => {
      const card = document.querySelector(".modal-backdrop .modal-card");
      const text = card ? (card.innerText || "") : "";
      return {
        text,
        hasTab: Boolean(document.querySelector('[data-stockvel-section="terms"]')),
        body: Boolean(card && card.querySelector(".sv-terms-body")),
        accept: Boolean(card && card.querySelector('[data-form="stockvel-terms-respond"] button[value="accepted"]')),
        reject: Boolean(card && card.querySelector('[data-form="stockvel-terms-respond"] button[value="rejected"]')),
        commentOnly: Boolean(card && card.querySelector('[data-form="stockvel-terms-respond"] button[value=""]')),
        publish: Boolean(card && card.querySelector("[data-stockvel-terms-publish]"))
      };
    });
    ok("the group sheet has a Terms tab", seen.hasTab);
    ok("the current version is shown in full", seen.body && /R750/.test(seen.text));
    ok("the version number is shown", /Version 2/i.test(seen.text), "");
    ok("what changed is shown first", /R500 to R750/.test(seen.text));
    ok("the tally counts the whole membership", /of 8 members/i.test(seen.text),
      (seen.text.match(/.{0,40}of 8 members/) || [""])[0]);
    ok("accept, reject and comment are all offered", seen.accept && seen.reject && seen.commentOnly,
      `accept ${seen.accept}, reject ${seen.reject}, comment ${seen.commentOnly}`);
    ok("what other members said is shown", /Can we discuss clause 2/.test(seen.text));
    ok("a plain member is not offered Publish", !seen.publish);
    // Asserted on what the SECTION says, not on the publish modal's wording.
    // The first version of this looked for the modal's sentence and failed on
    // a screen that does carry the disclosure, just phrased for a reader
    // rather than a publisher. The property that matters is that a member
    // reading the terms is told whose they are and who does not stand behind
    // them - not that two screens use identical prose.
    ok("the screen says whose terms these are",
      /your group's own terms/i.test(seen.text)
      && /does not write, check or enforce them/i.test(seen.text),
      (seen.text.match(/TitoPay records[^.]*\./) || [""])[0].slice(0, 90));
    await page.screenshot({ path: `${ARTIFACTS}/stokvel-terms-member.png` });
    ok("no page errors", errors.length === 0, errors.slice(0, 1).join(" | "));
    await context.close();
  }

  /* ------------- THE DETAIL SERVER TESTS CANNOT REACH: which button was it */
  for (const [label, selector, expected] of [
    ["Accept", 'button[value="accepted"]', "accepted"],
    ["Reject", 'button[value="rejected"]', "rejected"],
    ["Comment only", 'button[value=""]', null]
  ]) {
    posted.length = 0;
    const { page, context } = await openTerms(browser, { canManage: false });
    await page.fill('[data-form="stockvel-terms-respond"] [name="comment"]', "My note to the group.");
    await page.click(`[data-form="stockvel-terms-respond"] ${selector}`);
    await page.waitForTimeout(1400);
    const body = posted.filter((item) => item.kind === "respond").pop()?.body;
    ok(`pressing ${label} sends decision=${JSON.stringify(expected)}`,
      Boolean(body) && (body.decision ?? null) === expected, JSON.stringify(body));
    ok(`and carries the comment with it`, body && body.comment === "My note to the group.",
      body ? JSON.stringify(body.comment) : "(none)");
    await context.close();
  }

  /* ------------------------------------------- an organiser publishing one */
  {
    posted.length = 0;
    const { page, context } = await openTerms(browser, { canManage: true });
    const canPublish = await page.locator("[data-stockvel-terms-publish]").count();
    ok("an organiser is offered Publish an amendment", canPublish === 1, `${canPublish}`);
    await page.click("[data-stockvel-terms-publish]");
    await page.waitForSelector('[data-form="stockvel-terms-publish"]', { timeout: 10000 });
    const modal = await page.evaluate(() => (document.querySelector(".modal-backdrop .modal-card").innerText || ""));
    ok("the amendment modal says an old acceptance does not carry over",
      /does not carry over/i.test(modal), modal.slice(0, 80));
    ok("and it asks what changed", /What changed/i.test(modal));
    await page.screenshot({ path: `${ARTIFACTS}/stokvel-terms-publish.png` });

    await page.fill('[data-form="stockvel-terms-publish"] [name="changeNote"]', "Payout order changed.");
    await page.fill('[data-form="stockvel-terms-publish"] [name="body"]',
      "1. Every member contributes R750 by the 7th.\n2. Payouts rotate alphabetically.");
    await page.click('[data-form="stockvel-terms-publish"] button[type="submit"]');
    await page.waitForTimeout(1500);
    const published = posted.filter((item) => item.kind === "publish").pop()?.body;
    ok("publishing sends the body and the change note",
      Boolean(published) && /alphabetically/.test(published.body) && /Payout order/.test(published.changeNote),
      JSON.stringify(published).slice(0, 120));
    await context.close();
  }

  /* ------------------------------------------------ a group with no terms */
  {
    const { page, context } = await openTerms(browser, { canManage: false, terms: { current: null, history: [] } });
    const text = await page.evaluate(() => (document.querySelector(".modal-backdrop .modal-card").innerText || ""));
    ok("a group with no terms says so plainly", /No terms published yet/i.test(text), text.slice(0, 70));
    ok("and a member is told what will happen", /accept, reject or comment/i.test(text));
    await context.close();
  }

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
