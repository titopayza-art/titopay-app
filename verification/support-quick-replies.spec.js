// Does the Quick replies panel survive a busy support desk?
//
// The report was flicker and disappearance. Both come from the same thing:
// renderSupport() replaces #page-content wholesale, and it is driven straight
// off the support socket, so on a desk taking a message every couple of
// seconds the panel is torn down and rebuilt that often — losing its open
// state each time, because that was the one piece of the workspace the
// refresh did not restore.
//
// This opens the panel, then fires a burst of support socket messages at the
// console the way a live queue does, and asks two questions: is the panel
// still open, and how many times did the DOM underneath it get rebuilt.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ADMIN = "/home/user/titopay-app/admin";
const PORT = 8126;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
function startServer() {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(ADMIN, clean === "/" ? "index.html" : clean);
    if (!file.startsWith(ADMIN)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const CONVERSATION = {
  ok: true,
  conversation: { id: "c1", reference: "TC048187", status: "AGENT_ACTIVE", subject: "Failed payment",
    customer: { name: "Ntsako Masia", id: "u9" }, assignedAgentName: "Thuso" },
  messages: [
    { id: "m1", senderType: "CUSTOMER", senderName: "Ntsako Masia", body: "Failed payment", createdAt: "2026-08-23T09:35:00Z" },
    { id: "m2", senderType: "SYSTEM", body: "Your conversation has been escalated to TitoPay Customer Care.", createdAt: "2026-08-23T09:36:00Z" }
  ]
};

function stub(page) {
  return page.route("**/api.titopay.co.za/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    let body = { ok: true, items: [] };
    if (/\/context$/.test(p)) body = CONVERSATION;
    else if (p === "/admin/me" || p === "/v1/admin/me") {
      body = { ok: true, user: { id: "a1", fullName: "Thuso", role: "SUPER_ADMIN", permissions: ["*"] } };
    }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await stub(page);
  await page.goto(ORIGIN + "/support/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  // PAGE_EXPORTS is a module const, so it cannot be reached from here. That is
  // fine: the fix is a contract between two real functions, and both are on
  // window. The refresh cycle is exactly this — captureSupportWorkspace() reads
  // the live DOM, then the view is rebuilt from scratch — so driving those two
  // in turn tests the thing that was broken, not a mock of it.
  // A REAL .admin-shell[data-page="support"], because that selector is the
  // guard scheduleSupportRefresh() checks. Setting the attribute on <body>
  // instead made the guard fail, the scheduler early-return, and the burst
  // measure nothing at all — which is exactly what the first run reported.
  await page.evaluate(() => {
    document.querySelector(".auth-shell")?.remove();
    let shell = document.querySelector(".admin-shell");
    if (!shell) { shell = document.createElement("div"); shell.className = "admin-shell"; document.body.appendChild(shell); }
    shell.setAttribute("data-page", "support");
    let host = document.getElementById("page-content");
    if (!host) { host = document.createElement("div"); host.id = "page-content"; shell.appendChild(host); }
  });

  const rebuild = (conversation) => page.evaluate((c) => {
    document.getElementById("page-content").innerHTML = window.renderSupportConversationView(c);
  }, conversation);

  await rebuild(CONVERSATION);
  await page.waitForTimeout(200);
  if (!await page.$("details.support-quick-replies")) {
    console.log("FAIL  the quick replies panel did not render at all");
    await browser.close(); server.close(); process.exit(1);
  }
  const replyCount = await page.$$eval("details.support-quick-replies .sqr-item", (n) => n.length);
  console.log(`  ${replyCount > 0 ? "PASS" : "FAIL"}  the panel renders its replies (${replyCount})`);

  // The agent opens it.
  await page.click("details.support-quick-replies > summary");
  await page.waitForTimeout(150);
  const openedByAgent = await page.$eval("details.support-quick-replies", (d) => d.open);
  console.log(`  ${openedByAgent ? "PASS" : "FAIL"}  the agent can open it`);

  // Twelve refreshes, the way a busy queue drives them.
  let closedOn = 0;
  for (let i = 0; i < 12; i += 1) {
    await page.evaluate(() => window.captureSupportWorkspace());
    await rebuild(CONVERSATION);
    await page.waitForTimeout(60);
    const open = await page.$eval("details.support-quick-replies", (d) => d.open).catch(() => null);
    if (open !== true) closedOn += 1;
  }
  console.log(`  ${closedOn === 0 ? "PASS" : "FAIL"}  it stayed open across 12 refreshes${closedOn ? ` (closed on ${closedOn})` : ""}`);

  // Closing it must stick too — a preserved state that only ever says "open"
  // would be its own bug.
  await page.click("details.support-quick-replies > summary");
  await page.waitForTimeout(150);
  await page.evaluate(() => window.captureSupportWorkspace());
  await rebuild(CONVERSATION);
  await page.waitForTimeout(150);
  const stayedClosed = (await page.$eval("details.support-quick-replies", (d) => d.open)) === false;
  console.log(`  ${stayedClosed ? "PASS" : "FAIL"}  closing it also survives a refresh`);

  // And the passive refreshes coalesce, which is the flicker half.
  await page.click("details.support-quick-replies > summary");
  await page.waitForTimeout(150);
  const coalesced = await page.evaluate(async () => {
    // The guard has to actually pass, or this measures nothing.
    const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
    if (!["support", "chatbot-escalations"].includes(page)) return "guard did not pass";
    let renders = 0;
    const real = window.renderSupport;
    window.renderSupport = async () => { renders += 1; };
    for (let i = 0; i < 12; i += 1) window.scheduleSupportRefresh();
    await new Promise((r) => setTimeout(r, 900));
    window.renderSupport = real;
    // Prove the spy was reachable at all: one direct call must register.
    let direct = 0;
    const real2 = window.renderSupport;
    window.renderSupport = async () => { direct += 1; };
    await window.renderSupport();
    window.renderSupport = real2;
    return direct === 1 ? renders : "spy not reachable";
  });
  const coalesceOk = typeof coalesced === "number" && coalesced >= 1 && coalesced <= 2;
  console.log(`  ${coalesceOk ? "PASS" : "FAIL"}  12 messages in a burst caused ${coalesced} repaint${coalesced === 1 ? "" : "s"} (was one per message)`);

  const after = { present: true, open: true, count: replyCount, rebuilds: coalesced };
  const failed = !openedByAgent || closedOn > 0 || !stayedClosed || !coalesceOk || replyCount === 0;

  await page.screenshot({ path: "/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/quick-replies.png", fullPage: false });
  await browser.close();
  server.close();

  process.exit(failed ? 1 : 0);
})();
