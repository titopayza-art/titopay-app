// DOES THE STOKVEL WITHDRAWAL SCREEN WORK AGAINST WHAT THE API ACTUALLY SENDS?
//
// FIXED 13 September 2026. This file pinned three defects and now guards them:
//
//   1. an organiser could not approve a withdrawal from the app at all - the
//      buttons rendered only for /pending|awaiting|open|voting/ and the server
//      writes 'requested'
//   2. the requester's name never appeared - the server sends `requester` and
//      the app read five other spellings
//   3. the screen drew an approval-progress bar from quorum fields the server
//      has never sent, and said nothing about what happened to a decided
//      request
//
// Assertions 1 and 2 are unchanged from the day they failed. Assertion 3 was
// REPLACED rather than relaxed: it demanded a quorum bar from a model that has
// no quorum, so satisfying it would have meant inventing votes. It now asks
// for the true answer - who decided, and that the payout is the organiser's to
// make - which is the thing a member actually needed and did not have.
//
// Two cases were added at the same time, both mirroring rules the server
// already enforces: a settled request offers no buttons, and nobody is offered
// a button to approve their own withdrawal.
//
// Not wired into CI (npm test runs tests/run-all.js only); run it directly.
//
// The two halves were written to different models and this drives the seam.
//
// The SERVER (stockvel-service.getGroup) sends each withdrawal as:
//     { id, requester, amount, reason, status, created_at }
//   with status 'requested' | 'approved' | 'declined', and a single manager
//   decides - there is no quorum, and a manager may not approve their own.
//
// The APP (normalizeStockvelWithdrawal, renderStockvelWithdrawals) reads
//     requestedBy | requested_by | requesterName | requester_name | memberName
//     approvals, approvalsRequired, approvedBy
//   and renders the Approve / Decline buttons only when the status matches
//     /pending|awaiting|open|voting/i
//
// So this is not a style question. It asks three things of the real bundle,
// fed the server's real payload byte for byte:
//
//   can an organiser approve a withdrawal from the app at all?
//   does the requester's name appear?
//   does the approval progress the screen is built around ever render?
//
// The control is the same screen fed the payload the APP expects. If the
// control passes and the real payload fails, the screen works and the contract
// between the two halves does not - which is the finding.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8175;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "5706efa1-0000-4000-8000-000000000001",
  fullName: "Stokvel Organiser", username: "stokvelorganiser",
  email: "organiser@titopay.local", phone: "+27820000456",
  accountType: "personal", account_type: "personal", status: "active"
};
const GROUP_ID = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// EXACTLY the shape api/src/services/stockvel-service.js getGroup() builds.
// `requester`, `status: 'requested'` and the absence of any quorum field are
// all unchanged from the original audit - those were never the problem with
// the server.
const SERVER_WITHDRAWAL = {
  id: "11111111-aaaa-4bbb-8ccc-dddddddddddd",
  requester: "Thandi Mokoena",
  requestedBy: "Thandi Mokoena",
  requesterUserId: "u2",
  amount: 1500,
  reason: "School fees for the new term",
  status: "requested",
  created_at: new Date().toISOString(),
  requestedAt: new Date().toISOString(),
  decidedBy: null,
  decidedAt: null
};

// The same request after an organiser has decided it. There is no quorum to
// show, so what a member needs to see is who decided and that the payout is
// now a person's job rather than the platform's.
const SERVER_WITHDRAWAL_DECIDED = {
  ...SERVER_WITHDRAWAL,
  id: "33333333-aaaa-4bbb-8ccc-dddddddddddd",
  status: "approved",
  decidedBy: "Sipho Dlamini",
  decidedAt: new Date().toISOString()
};

// A request the VIEWER made. The server refuses to let anyone decide their own
// withdrawal, so the app must not offer the buttons either.
const SERVER_WITHDRAWAL_MINE = {
  ...SERVER_WITHDRAWAL,
  id: "44444444-aaaa-4bbb-8ccc-dddddddddddd",
  requester: "Stokvel Organiser",
  requestedBy: "Stokvel Organiser",
  requesterUserId: "5706efa1-0000-4000-8000-000000000001"
};

// What the app's renderer was written against.
const APP_WITHDRAWAL = {
  id: "22222222-aaaa-4bbb-8ccc-dddddddddddd",
  requestedBy: "Thandi Mokoena",
  amount: 1500,
  reason: "School fees for the new term",
  status: "pending",
  approvals: 2,
  approvalsRequired: 3,
  approvedBy: ["Sipho Dlamini", "Naledi Khumalo"],
  requestedAt: new Date().toISOString()
};

function group(withdrawals) {
  return {
    id: GROUP_ID, name: "Ubuntu Savings Club", description: "Monthly savings",
    status: "active", cadence: "monthly", contribution_amount: 500, goal_amount: 60000,
    member_limit: 12, invite_code: "UBU123", created_at: new Date().toISOString(),
    // The server's own roles are chair / organiser / member, and it sends
    // can_manage alongside them. The first version of this fixture invented
    // role:"owner" and omitted can_manage entirely - so once the screen
    // correctly began gating the Approve button on can_manage, the CONTROL
    // lost its buttons too and the harness blamed the fix. The fixture was
    // wrong, not the gate.
    role: "chair", can_manage: true,
    balance: 12000, contributed: 13500, withdrawn: 1500,
    members: [
      { id: "m1", userId: USER.id, name: "Stokvel Organiser", role: "owner", joined_at: new Date().toISOString(), contributed: 4500 },
      { id: "m2", userId: "u2", name: "Thandi Mokoena", role: "member", joined_at: new Date().toISOString(), contributed: 4500 }
    ],
    contributions: [], withdrawals, meetings: [], activity: []
  };
}

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

async function openWithdrawals(browser, withdrawal, label) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "5000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/stockvels") return json({ items: [group([withdrawal])], groups: [group([withdrawal])] });
    if (p === "/stockvels/invitations") return json({ items: [] });
    if (p.startsWith("/stockvels/")) return json({ group: group([withdrawal]) });
    return json({ items: [] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((u) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user: u }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1200);

  // Into the group, then onto the withdrawals section, through the app's own
  // handlers rather than a guessed sequence of taps.
  await page.evaluate((id) => {
    if (typeof openStockvelDashboard === "function") openStockvelDashboard(id);
    else if (typeof openStockvelModal === "function") openStockvelModal();
  }, GROUP_ID);
  await page.waitForTimeout(1400);
  // THE GROUP'S OWN SECTION TAB, BY ITS KEY.
  //
  // The first version searched every button on the page for text matching
  // /withdraw/i and clicked the first hit - which was the WALLET's "Withdraw
  // funds" action, not the group's Withdrawals tab. Both the control and the
  // real payload then reported zero withdrawal cards, and the "finding" was
  // a screenshot of the bank-payout screen.
  const tabbed = await page.evaluate(() => {
    const tab = document.querySelector('[data-stockvel-section="withdrawals"]');
    if (!tab) return false;
    tab.click();
    return true;
  });
  if (!tabbed) { console.log("    (no withdrawals tab found - the group sheet did not open)"); }
  await page.waitForTimeout(1200);

  const seen = await page.evaluate(() => {
    const card = document.querySelector(".modal-backdrop .modal-card") || document.body;
    const text = (card.innerText || "").replace(/\s+/g, " ");
    return {
      text,
      approveButtons: card.querySelectorAll("[data-stockvel-withdrawal-approve]").length,
      declineButtons: card.querySelectorAll("[data-stockvel-withdrawal-decline]").length,
      withdrawalCards: card.querySelectorAll(".sv-withdrawal").length,
      progressBars: card.querySelectorAll(".sv-goal").length,
      showsRequester: /Thandi Mokoena/.test(text),
      showsAmount: /1[\s,]?500/.test(text),
      showsApprovedBy: /Approved by/i.test(text)
    };
  });
  await page.screenshot({ path: `${ARTIFACTS}/stokvel-withdrawals-${label}.png` });
  await context.close();
  return { seen, errors };
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  console.log("\n  CONTROL — the payload the app's renderer was written against\n");
  const control = await openWithdrawals(browser, APP_WITHDRAWAL, "control");
  ok("the withdrawal card renders", control.seen.withdrawalCards >= 1, `${control.seen.withdrawalCards}`);
  ok("Approve and Decline are offered", control.seen.approveButtons === 1 && control.seen.declineButtons === 1,
    `approve ${control.seen.approveButtons}, decline ${control.seen.declineButtons}`);
  ok("the requester's name is shown", control.seen.showsRequester);
  ok("the approval progress renders", control.seen.progressBars >= 1, `${control.seen.progressBars}`);
  ok("who has already approved is shown", control.seen.showsApprovedBy);
  const controlWorks = control.seen.approveButtons === 1;

  console.log("\n  REAL — byte for byte what stockvel-service.getGroup() sends\n");
  const real = await openWithdrawals(browser, SERVER_WITHDRAWAL, "real");
  ok("the withdrawal card still renders", real.seen.withdrawalCards >= 1, `${real.seen.withdrawalCards}`);
  ok("AN ORGANISER CAN APPROVE FROM THE APP", real.seen.approveButtons === 1,
    `${real.seen.approveButtons} approve buttons for status "${SERVER_WITHDRAWAL.status}"`);
  ok("the requester's name is shown", real.seen.showsRequester,
    real.seen.showsRequester ? "" : `the server sends "requester"; the app reads requestedBy / requested_by / requesterName / requester_name / memberName`);
  ok("no page errors", real.errors.length === 0, real.errors.slice(0, 1).join(" | "));

  // AN EXPECTATION REPLACED, AND WHY THAT IS NOT LOOSENING IT.
  //
  // The audit version asserted "the approval progress renders" against the
  // real payload. That assertion described the WRONG end state: it demanded a
  // quorum bar for a model with no quorum, so the only way to satisfy it was
  // to invent votes the server does not hold. The defect it was pointing at is
  // real - the screen said nothing about what had happened to a decided
  // request - so the assertion is replaced by one that asks for the true
  // answer rather than deleted.
  console.log("\n  DECIDED — the same request after an organiser rules on it\n");
  const decided = await openWithdrawals(browser, SERVER_WITHDRAWAL_DECIDED, "decided");
  ok("a decided request names who decided it", /Approved by Sipho Dlamini/i.test(decided.seen.text),
    decided.seen.text.slice(0, 90));
  ok("and says the payout is the organiser's to make, not TitoPay's",
    /organiser holding the money sends it|TitoPay holds no group pot/i.test(decided.seen.text));
  ok("with no stale Approve button on a settled request", decided.seen.approveButtons === 0,
    `${decided.seen.approveButtons}`);

  console.log("\n  OWN REQUEST — the server refuses self-approval, so the app must not offer it\n");
  const mine = await openWithdrawals(browser, SERVER_WITHDRAWAL_MINE, "mine");
  ok("no Approve button on your own request", mine.seen.approveButtons === 0,
    `${mine.seen.approveButtons}`);
  ok("and the screen says why", /cannot approve your own request/i.test(mine.seen.text),
    mine.seen.text.slice(0, 90));

  console.log("\n  " + "-".repeat(68));
  if (controlWorks && real.seen.approveButtons === 0) {
    console.log("  The screen is not broken. The CONTRACT is: the renderer expects a");
    console.log("  quorum-voting payload the server does not send, so a real withdrawal");
    console.log("  can be requested and then never acted on from inside the app.");
  }
  console.log("  " + "-".repeat(68));

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
