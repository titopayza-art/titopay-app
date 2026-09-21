// IS THE CHAT ACTUALLY FULL SCREEN, AND DOES IT SIT STILL?
//
// Reported with a screenshot: the conversation occupies the top two thirds of
// a phone and the rest is empty, and it "flickers around".
//
// Both complaints are measurable, so neither is judged by eye:
//
//   dead space      the modal's height against the viewport's. A chat that
//                   stops 500px short of the bottom is not full screen,
//                   however good it looks in isolation.
//   the composer    the message box and Send have to be reachable without
//                   scrolling - they are the point of the screen.
//   flicker         the message list's HTML is sampled repeatedly while the
//                   poller runs. A repaint that replaces identical nodes is
//                   what a person sees as flicker: it kills scroll momentum
//                   and drops text selections. Counted, not eyeballed.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8181;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "ccaa0000-1111-4222-8333-444444444444",
  fullName: "Chat Probe", username: "chatprobe",
  email: "chat@titopay.local", phone: "+27820000999",
  accountType: "personal", account_type: "personal", status: "active"
};

const THREAD_ID = "titopay-care";
const MESSAGES = [
  { id: "m1", body: "Hello", direction: "out", status: "read", createdAt: new Date(Date.now() - 900000).toISOString() },
  { id: "m2", body: "Good day", direction: "out", status: "read", createdAt: new Date(Date.now() - 800000).toISOString() },
  { id: "m3", body: "Was just confirming its working", direction: "in", status: "read", createdAt: new Date(Date.now() - 700000).toISOString() },
  { id: "m4", body: "Alright 😂", direction: "out", status: "read", createdAt: new Date(Date.now() - 600000).toISOString() }
];

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

// Three real phones, because a height capped in pixels looks fine on the
// shortest and leaves a hole on the tallest - which is exactly the reported
// shape of this bug.
const PHONES = [
  ["iPhone SE", 375, 667],
  ["iPhone 14", 390, 844],
  ["iPhone 15 Pro Max", 430, 932]
];

async function stub(context) {
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/chat/notifications") return json({ notifications: [] });
    if (p === "/transactions") return json({ items: [] });
    return json({ items: [] });
  });
}

async function openThread(browser, [label, width, height]) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await stub(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript(([user, threadId, messages]) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
    localStorage.setItem("titopay_chat_threads_v1", JSON.stringify([{
      id: threadId, title: "TitoPay", subtitle: "Online support", participant: "titopay",
      mode: "customer_care", muted: false, messages
    }]));
  }, [USER, THREAD_ID, MESSAGES]);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1200);
  await page.evaluate((id) => {
    if (typeof openTitoPayChatThread === "function") openTitoPayChatThread(id);
  }, THREAD_ID);
  await page.waitForTimeout(1200);
  return { page, context, errors, label, width, height };
}

async function geometry(page) {
  return page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    const win = document.querySelector(".titopay-chat-window");
    const compose = document.querySelector(".titopay-chat-compose");
    if (!card) return null;
    const viewport = window.innerHeight;
    const cardBox = card.getBoundingClientRect();
    const composeBox = compose ? compose.getBoundingClientRect() : null;
    // MEASURED AGAINST THE LAST THING DRAWN, NOT THE SHEET.
    //
    // The first version of this compared the modal card to the viewport and
    // passed on every phone - because the card DOES span the screen. The hole
    // was inside it: the card was full height while its contents stopped
    // around 511px of 932, and the emptiness a person sees is below the last
    // painted element, not below the card.
    const lastChild = [...card.children].filter((el) => el.getBoundingClientRect().height > 1).pop();
    const contentBottom = lastChild ? lastChild.getBoundingClientRect().bottom : cardBox.bottom;
    return {
      viewport,
      cardHeight: Math.round(cardBox.height),
      cardTop: Math.round(cardBox.top),
      cardBottom: Math.round(cardBox.bottom),
      contentBottom: Math.round(contentBottom),
      // What the person actually sees as emptiness.
      deadSpaceBelow: Math.round(viewport - contentBottom),
      windowHeight: win ? Math.round(win.getBoundingClientRect().height) : 0,
      composeVisible: Boolean(composeBox) && composeBox.bottom <= viewport + 1 && composeBox.top >= 0,
      composeBottom: composeBox ? Math.round(composeBox.bottom) : null,
      pageScrolls: document.documentElement.scrollHeight - document.documentElement.clientHeight > 1
    };
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  for (const phone of PHONES) {
    const { page, context, errors, label, height } = await openThread(browser, phone);
    const g = await geometry(page);
    if (!g) { ok(`${label}: the chat opened`, false); await context.close(); continue; }
    console.log(`\n  ${label} (${phone[1]}x${height})`);
    console.log(`    viewport ${g.viewport}  sheet ${g.cardHeight}  content ends ${g.contentBottom}  dead space ${g.deadSpaceBelow}px`);

    // A sheet that stops well short of the bottom is the reported complaint.
    // 10% of the viewport is generous - it allows a margin, not a hole.
    ok(`${label}: the chat fills the screen`, g.deadSpaceBelow <= Math.round(g.viewport * 0.1),
      `${g.deadSpaceBelow}px empty below the sheet`);
    ok(`${label}: the message box is reachable without scrolling`, g.composeVisible,
      `compose bottom ${g.composeBottom} vs viewport ${g.viewport}`);
    ok(`${label}: the page itself does not scroll`, !g.pageScrolls);
    if (phone[0] === "iPhone 15 Pro Max") {
      await page.screenshot({ path: `${ARTIFACTS}/chat-fullscreen.png` });
    }
    ok(`${label}: no page errors`, errors.length === 0, errors.slice(0, 1).join(" | "));
    await context.close();
  }

  /* ------------------------------------------------------------- flicker */
  {
    const { page, context } = await openThread(browser, PHONES[1]);
    // Sampled while the poller runs. Identical HTML replaced with identical
    // HTML is what a person sees as flicker.
    const samples = await page.evaluate(async () => {
      const win = document.querySelector(".titopay-chat-window");
      if (!win) return { error: "no window" };
      let replacements = 0;
      let lastHtml = win.innerHTML;
      const observer = new MutationObserver(() => {
        if (win.innerHTML !== lastHtml) { lastHtml = win.innerHTML; }
        replacements += 1;
      });
      observer.observe(win, { childList: true, subtree: true, characterData: true });
      await new Promise((resolve) => setTimeout(resolve, 9000));
      observer.disconnect();
      return { replacements, signature: win.dataset.chatSignature || "(unset)" };
    });
    console.log(`\n  message list mutations over 9s: ${samples.replacements}`);
    ok("THE CONVERSATION SITS STILL WHILE NOTHING IS HAPPENING", samples.replacements === 0,
      `${samples.replacements} DOM replacements with no new messages`);
    // The guard that prevents them is a signature stamped on the list. If it is
    // never set on the first paint, the first poll always replaces the nodes.
    ok("the repaint guard is armed from the first paint", samples.signature !== "(unset)",
      samples.signature === "(unset)" ? "no signature stamped at open" : "stamped");
    await context.close();
  }

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
