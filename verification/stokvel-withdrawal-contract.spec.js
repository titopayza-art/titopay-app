// DOES THE STOKVEL WITHDRAWAL SCREEN WORK AGAINST WHAT THE API ACTUALLY SENDS?
//
// THIS FILE EXITS NON-ZERO ON PURPOSE, TODAY. It pins three OPEN defects found
// in the Stokvel audit of 13 September 2026, so it fails until they are fixed:
//
//   1. an organiser cannot approve a withdrawal from the app at all
//   2. the requester's name never appears on the request
//   3. the approval-progress UI is dead code the server never feeds
//
// It is not wired into CI (npm test runs tests/run-all.js only), so a red run
// here is a report, not a broken build. When the three are fixed this file
// should go green with no edits to its assertions - if it needs its
// expectations loosened to pass, the fix was not a fix.
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
const SERVER_WITHDRAWAL = {
  id: "11111111-aaaa-4bbb-8ccc-dddddddddddd",
  requester: "Thandi Mokoena",
  amount: 1500,
  reason: "School fees for the new term",
  status: "requested",
  created_at: new Date().toISOString()
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
    role: "owner", balance: 12000, contributed: 13500, withdrawn: 1500,
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
  ok("the approval progress renders", real.seen.progressBars >= 1,
    real.seen.progressBars >= 1 ? "" : "the server sends no approvals / approvalsRequired");
  ok("no page errors", real.errors.length === 0, real.errors.slice(0, 1).join(" | "));

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
