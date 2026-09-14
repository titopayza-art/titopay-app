// DOES THE MESSAGE SOMEBODY WROTE ACTUALLY APPEAR?
//
// Reported with a screenshot: R500 sent for a birthday arrived as "Wallet
// Transfer", "Money in", and nothing else. The message was not lost - it was
// stored in the transaction's metadata and never rendered, because the detail
// view's gift card was gated on the service being send_gift, and TitoKids
// writes service_code 'wallet_transfer' with the note in metadata.
//
// Three things are checked here, and the third is the one that stops this fix
// from becoming its own bug: a note is not a gift. Money sent to a child for
// school lunch carries a note too, and captioning that "You've received a
// gift" would have the app inventing a sentiment nobody expressed.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8193;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "dd110000-2222-4333-8444-555555555555",
  fullName: "Gift Probe", username: "giftprobe",
  email: "gift@titopay.local", phone: "+27820000777",
  accountType: "personal", account_type: "personal", status: "active"
};

const NOW = new Date().toISOString();
// Shaped exactly as the API returns them - a real send_gift row, and a real
// TitoKids funding row with the metadata titokids-service actually writes.
const TRANSACTIONS = [
  { id: "t-gift", service_code: "send_gift", service_name: "Send Gift",
    direction: "credit", amount: "500.00", total: "500.00", fee: "0.00",
    status: "completed", reference: "TX-GIFT-0001", created_at: NOW,
    metadata: { occasion: "Birthday", message: "Happy birthday Lesedi! Enjoy your day." } },
  { id: "t-kids", service_code: "wallet_transfer", service_name: "Wallet Transfer",
    direction: "debit", amount: "500.00", total: "500.00", fee: "0.00",
    status: "completed", reference: "TKID-MU15FTT3", created_at: NOW,
    metadata: { titokids: true, childName: "Lesedi", purpose: "funding",
      note: "Happy birthday my girl, buy something nice." } },
  { id: "t-plain", service_code: "wallet_transfer", service_name: "Wallet Transfer",
    direction: "credit", amount: "120.00", total: "120.00", fee: "0.00",
    status: "completed", reference: "TX-PLAIN-0003", created_at: NOW, metadata: {} }
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

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });

  await context.route("https://api.titopay.co.za/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/transactions") return json({ items: TRANSACTIONS });
    if (p === "/chat/notifications") return json({ notifications: [] });
    return json({ items: [] });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe", refreshToken: "probe", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(1800);

  async function openDetail(id) {
    // Close whatever is open first, through the app's own closeModal, so the
    // body scroll lock is released rather than left pinned.
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
    await page.waitForTimeout(250);
    await page.evaluate((key) => {
      if (typeof openTransactionDetailModal === "function") openTransactionDetailModal(key);
    }, id);
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const card = document.querySelector(".gift-receipt-card");
      if (!card) return { present: false, bodyText: document.body.innerText };
      return {
        present: true,
        title: card.querySelector(".gift-receipt-title")?.textContent.trim() || "",
        occasion: card.querySelector(".gift-receipt-occasion")?.textContent.trim() || "",
        message: card.querySelector(".gift-receipt-message")?.textContent.trim() || "",
        from: card.querySelector(".gift-receipt-from")?.textContent.trim() || ""
      };
    });
  }

  /* -------------------------------------------------- a real Send a Gift */
  const gift = await openDetail("t-gift");
  console.log("\n  a received gift");
  ok("the gift card is shown", gift.present);
  ok("it says a gift was received", /received a gift/i.test(gift.title || ""), gift.title);
  ok("the occasion is shown", /birthday/i.test(gift.occasion || ""), gift.occasion);
  ok("THE MESSAGE IS SHOWN", /Happy birthday Lesedi/.test(gift.message || ""), gift.message);

  /* ------------------------------- the reported case: a TitoKids transfer */
  const kids = await openDetail("t-kids");
  console.log("\n  the reported case: money to a child, with a note");
  ok("a card is shown at all", kids.present,
    "this is the bug that was reported - it used to render nothing");
  ok("THE NOTE IS SHOWN", /buy something nice/.test(kids.message || ""), kids.message);
  ok("the child is named", /Lesedi/.test(kids.title || ""), kids.title);
  // The fix must not overclaim. This transfer is not the R3 gift service.
  ok("A NOTE IS NOT CALLED A GIFT", !/gift/i.test(kids.title || ""), kids.title);

  /* ------------------------------------ an ordinary transfer, unchanged */
  const plain = await openDetail("t-plain");
  console.log("\n  an ordinary transfer with nothing written");
  ok("no empty card is drawn", !plain.present,
    plain.present ? "an empty card is worse than the plain row it replaced" : "");

  /* ------------------------------ THE RECEIVER'S HALF, WHICH DID NOT EXIST */
  //
  // The sender owns the transaction row, so they got the card. The receiver
  // owns no row at all, so the gift reached them as a line of notification
  // text while the person who SENT it got the nice screen - the wrong way
  // round, since the gift is for the receiver. The notification now carries
  // the gift and opens it.
  const received = await page.evaluate(async () => {
    // Seeded exactly as transaction-service writes it for gift_received.
    const notice = {
      id: "n-gift-1", unread: true, title: "Lerato Mokoena sent you a gift of R500.00",
      body: "The money is in your wallet now.", createdAt: new Date().toISOString(),
      metadata: { gift: true, senderName: "Lerato Mokoena", occasion: "Birthday",
        message: "Happy birthday! Enjoy your day.", amount: 500,
        transactionId: "t-gift", reference: "TX-GIFT-0001" }
    };
    state.notifications = [notice, ...(state.notifications || [])];
    if (typeof closeModal === "function") closeModal();
    await new Promise((r) => setTimeout(r, 200));
    openReceivedGiftModal("n-gift-1");
    await new Promise((r) => setTimeout(r, 400));
    const card = document.querySelector(".gift-receipt-card");
    // The notification must also be tappable in the first place.
    const attrs = typeof notificationActionAttributes === "function"
      ? notificationActionAttributes(notice) : "";
    return {
      present: Boolean(card),
      tappable: /data-notification-gift/.test(attrs),
      title: card?.querySelector(".gift-receipt-title")?.textContent.trim() || "",
      occasion: card?.querySelector(".gift-receipt-occasion")?.textContent.trim() || "",
      amount: card?.querySelector(".gift-receipt-amount")?.textContent.trim() || "",
      message: card?.querySelector(".gift-receipt-message")?.textContent.trim() || "",
      from: card?.querySelector(".gift-receipt-from")?.textContent.trim() || "",
      markedRead: (state.notifications || []).find((n) => n.id === "n-gift-1")?.unread === true
    };
  });
  console.log("\n  the receiver opens their gift");
  ok("the gift notification is tappable", received.tappable,
    "it used to fall through to the sender's transaction, which the receiver cannot open");
  ok("THE RECEIVER GETS A GIFT CARD", received.present);
  ok("it says a gift was received", /received a gift/i.test(received.title || ""), received.title);
  ok("the occasion is shown", /birthday/i.test(received.occasion || ""), received.occasion);
  ok("the amount is shown", /500/.test(received.amount || ""), received.amount);
  ok("THE SENDER'S MESSAGE IS SHOWN", /Happy birthday/.test(received.message || ""), received.message);
  ok("the sender is named", /Lerato Mokoena/.test(received.from || ""), received.from);

  /* ------------------------------------------------- how the gift moves */
  //
  // Twelve occasions, three motion families. The check that matters is not
  // that something animates - it is that the RIGHT temperament is chosen, and
  // that a custom occasion (somebody's own words, whose mood cannot be
  // guessed) gets no accent rather than a wrong one.
  const motion = await page.evaluate(async (cases) => {
    const out = {};
    for (const [label, occasion] of cases) {
      state.notifications = [{ id: "n-m", unread: true, title: "Gift", body: "",
        createdAt: new Date().toISOString(),
        metadata: { gift: true, senderName: "Lerato", occasion, message: "Enjoy", amount: 100 } }];
      if (typeof closeModal === "function") closeModal();
      await new Promise((r) => setTimeout(r, 120));
      openReceivedGiftModal("n-m");
      await new Promise((r) => setTimeout(r, 200));
      const card = document.querySelector(".gift-receipt-card");
      out[label] = card ? (card.getAttribute("data-gift-motion") || "") : "(no card)";
    }
    return out;
  }, [["birthday", "Birthday"], ["thanks", "Thank You"], ["wedding", "Wedding"],
    ["graduation", "Graduation"], ["custom", "My own words"]]);

  console.log("\n  the motion chosen for each occasion");
  ok("a birthday celebrates", motion.birthday === "celebration", motion.birthday);
  ok("a graduation celebrates too", motion.graduation === "celebration", motion.graduation);
  ok("a wedding is affection, not celebration", motion.wedding === "affection", motion.wedding);
  ok("A THANK YOU DOES NOT GET CONFETTI", motion.thanks === "gratitude", motion.thanks);
  ok("a custom occasion gets no guessed mood", motion.custom === "", motion.custom || "(none)");

  /* ------------------------------------------ motion is a preference */
  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: "reduce" });
  await reduced.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe", refreshToken: "probe", user }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await reduced.goto(ORIGIN, { waitUntil: "load" });
  await reduced.waitForTimeout(1800);
  const stillness = await reduced.evaluate(async () => {
    state.notifications = [{ id: "n-r", unread: true, title: "Gift", body: "",
      createdAt: new Date().toISOString(),
      metadata: { gift: true, senderName: "Lerato", occasion: "Birthday", message: "Enjoy", amount: 100 } }];
    openReceivedGiftModal("n-r");
    await new Promise((r) => setTimeout(r, 400));
    const card = document.querySelector(".gift-receipt-card");
    if (!card) return { present: false };
    const child = card.firstElementChild;
    return {
      present: true,
      cardAnimation: getComputedStyle(card).animationName,
      childAnimation: child ? getComputedStyle(child).animationName : "none",
      sheen: getComputedStyle(card, "::after").display,
      // It must still be fully readable, not merely still.
      visible: getComputedStyle(card).opacity === "1"
    };
  });
  console.log("\n  with prefers-reduced-motion: reduce");
  ok("the gift still opens", stillness.present);
  ok("NOTHING ANIMATES", stillness.cardAnimation === "none" && stillness.childAnimation === "none",
    `card ${stillness.cardAnimation}, contents ${stillness.childAnimation}`);
  ok("the sweep is not drawn at all", stillness.sheen === "none", stillness.sheen);
  ok("and it is fully visible, not stuck mid-fade", stillness.visible);
  await reduced.close();

  ok("no page errors", errors.length === 0, errors.slice(0, 1).join(" | "));

  await page.screenshot({ path: path.join(__dirname, "artifacts", "transaction-message.png") })
    .catch(() => null);
  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
