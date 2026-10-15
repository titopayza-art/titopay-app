const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const ACCOUNT = process.argv[2] || "business";
const MODE = process.argv[3] || "all";

const EVENTS = [
  { id: "e1", slug: "amapiano-fest", eventName: "Amapiano Summer Festival", eventDate: "2026-12-16T18:00:00Z", venueName: "Mary Fitzgerald Square", city: "Johannesburg", status: "approved", marketingLink: "https://app.titopay.co.za/e/amapiano-fest", ticketTypes: [{ id: "t1", name: "General", price: 350, quantityAvailable: 500, quantitySold: 320 }, { id: "t2", name: "VIP", price: 750, quantityAvailable: 100, quantitySold: 40 }] },
  { id: "e2", slug: "comedy-night", eventName: "Cape Town Comedy Night", eventDate: "2026-09-04T19:30:00Z", venueName: "Baxter Theatre", city: "Cape Town", status: "submitted", ticketTypes: [{ id: "t3", name: "Standard", price: 180, quantityAvailable: 200, quantitySold: 0 }] },
  { id: "e3", slug: "draft-event", eventName: "Unnamed Draft Event", eventDate: "", status: "draft", ticketTypes: [] }
];

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));

  let lookupMode = "found";       // found | notfound | fail
  let threadsVersion = 0;         // bumping this makes syncTitoPayChatThreads report a change
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const J = (b, st = 200) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });

    if (u.pathname === "/v1/ticketing/eligibility") { await sleep(150); return J({ eligibility: { eligible: true, blockers: [] } }); }
    if (u.pathname === "/v1/ticketing/business/events") { await sleep(150); return J({ items: EVENTS }); }
    if (u.pathname.includes("/ticketing/public/events") && u.pathname.endsWith("/purchase")) {
      return J({ order: { orderReference: "TPO-2026-0042", total: 700, deliveryStatus: "issued", buyerName: "Naledi Mokoena", eventName: "Amapiano Summer Festival", eventDate: "2026-12-16T18:00:00Z", venueName: "Mary Fitzgerald Square", city: "Johannesburg" },
        tickets: [
          { ticketCode: "AMA-4471-8890", ticketTypeName: "General", holderName: "Naledi Mokoena", seat: "GA", qrImageDataUrl: "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="30" height="30"/><rect x="80" y="10" width="30" height="30"/><rect x="10" y="80" width="30" height="30"/><rect x="55" y="55" width="12" height="12"/></svg>').toString("base64") },
          { ticketCode: "AMA-4471-8891", ticketTypeName: "General", holderName: "Naledi Mokoena", seat: "GA" }
        ] });
    }
    if (u.pathname.includes("/ticketing/public/events/")) return J({ event: { slug: "amapiano-fest", eventName: "Amapiano Summer Festival", eventDate: "2026-12-16T18:00:00Z", venueName: "Mary Fitzgerald Square", city: "Johannesburg", description: "Summer festival", ticketTypes: [{ id: "t1", name: "General", price: 350, quantityAvailable: 500, quantitySold: 320 }] } });
    if (u.pathname === "/v1/ticketing/public/events") return J({ items: EVENTS });

    if (u.pathname.includes("/chat/users/lookup")) {
      if (lookupMode === "fail") return J({ error: "upstream" }, 500);
      if (lookupMode === "notfound") return J({ user: null });
      return J({ user: { id: "u2", name: "Thabo Ndlovu", username: "thabo", accountType: "personal", verified: true } });
    }
    if (u.pathname.includes("/recipient/verify") || u.pathname.includes("/recipients/resolve")) {
      if (lookupMode === "fail") return J({ error: "upstream" }, 500);
      if (lookupMode === "notfound") return J({ registered: false });
      return J({ registered: true, user: { id: "u2", fullName: "Thabo Ndlovu", username: "thabo", verified: true } });
    }
    if (u.pathname === "/v1/chat/threads") {
      return J({ items: [{ id: "th1", threadId: "th1", title: "Thabo Ndlovu", subtitle: "@thabo", mode: "direct", updatedAt: new Date(Date.now() + threadsVersion * 1000).toISOString(), participant: { id: "u2", name: "Thabo Ndlovu", username: "thabo" }, messages: [{ id: `m${threadsVersion}`, sender: "them", text: `Incoming message ${threadsVersion}`, createdAt: new Date().toISOString(), status: "delivered" }] }] });
    }
    if (u.pathname.includes("/chat/")) return J({ items: [], messages: [] });

    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "Naledi Mokoena", businessName: "Naledi Trading", username: "naledi", accountType: ACCOUNT, status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    J(body);
  });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 170)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 150)); });
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3400);

  const R = { account: ACCOUNT };
  const dismiss = async () => {
    for (let i = 0; i < 5; i += 1) {
      if (!(await page.evaluate(() => !!document.querySelector(".modal-backdrop")))) break;
      await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
      await page.waitForTimeout(240);
    }
  };
  const open = async (svc, wait = 900) => {
    await dismiss();
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(420);
    const t = await page.$(`[data-service="${svc}"]`);
    if (!t) return false;
    await t.click(); await page.waitForTimeout(wait); return true;
  };

  R.tiles = await page.evaluate(() => [...document.querySelectorAll("[data-service]")].map((e) => ({ id: e.dataset.service, label: e.querySelector("strong")?.textContent.trim() })));
  R.hasBusinessProfileTile = R.tiles.some((t) => t.id === "business-profile");
  R.airtimeTiles = R.tiles.filter((t) => /airtime|data/i.test(t.label || ""));

  // ---- QR LABELS ----
  if (await open("receive-money", 800)) {
    R.receiveQrLabel = await page.evaluate(() => document.querySelector('[name="label"]')?.value);
  }
  if (await open("tip", 800)) {
    R.tipQrLabel = await page.evaluate(() => document.querySelector('[name="label"]')?.value);
  }

  // ---- PAYOUTS (business) ----
  if (ACCOUNT === "business" && await open("payouts", 900)) {
    R.payout = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        heading: c.querySelector("h2")?.textContent.trim(),
        balance: c.querySelector(".balance-context")?.textContent.replace(/\s+/g, " ").trim(),
        quickAmounts: [...c.querySelectorAll("[data-quick-amount]")].map((b) => b.textContent.trim()),
        hint: c.querySelector("[data-payout-hint]")?.textContent.trim().slice(0, 40),
        explains: [...c.querySelectorAll(".integration-note p")].map((p) => p.textContent.replace(/\s+/g, " ").trim().slice(0, 60))
      };
    });
    await page.selectOption("[data-payout-speed]", "instant_peach_business_payout");
    await page.waitForTimeout(300);
    R.payoutInstantHint = await page.evaluate(() => document.querySelector("[data-payout-hint]")?.textContent.trim().slice(0, 40));
    await page.screenshot({ path: `${OUT}/r4-payout.png` });
  }

  // ---- BUSINESS TICKETING ----
  if (ACCOUNT === "business" && await open("ticketing", 2200)) {
    R.ticketing = await page.evaluate(() => {
      const c = document.querySelector(".modal-card");
      return {
        heading: c.querySelector("h2")?.textContent.trim(),
        events: c.querySelectorAll(".ticket-event").length,
        statuses: [...c.querySelectorAll(".ticket-status")].map((e) => e.textContent.trim()),
        figures: [...c.querySelectorAll(".ticket-event")].map((row) => [...row.querySelectorAll(".ticket-event-figures div")].map((d) => d.textContent.replace(/\s+/g, " ").trim())),
        progressWidths: [...c.querySelectorAll("[data-ticket-progress]")].map((e) => e.style.width),
        notes: [...c.querySelectorAll(".ticket-event-note")].map((e) => e.textContent.trim()),
        actions: [...c.querySelectorAll(".ticket-event-actions button, .ticket-event-actions a")].map((b) => b.textContent.trim())
      };
    });
    await page.screenshot({ path: `${OUT}/r4-ticketing.png` });
  }

  // ---- TICKET PREVIEW (purchase confirmation) ----
  if (MODE === "all") {
    await dismiss();
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(400);
    const t = await page.$('[data-service="tickets"]');
    if (t) {
      await t.click();
      await page.waitForTimeout(2000);
      const view = await page.$(".ticket-cta:not([disabled])");
      if (view) {
        await view.click();
        await page.waitForTimeout(1600);
        const form = await page.$('form[data-form="ticketing-purchase"]');
        if (form) {
          await page.evaluate(() => {
            const f = document.querySelector('form[data-form="ticketing-purchase"]');
            const q = f.querySelector('[name="quantity"]'); if (q) q.value = "2";
          });
          await page.click('form[data-form="ticketing-purchase"] button[type="submit"]');
          await page.waitForTimeout(2000);
          R.ticketConfirmation = await page.evaluate(() => {
            const c = document.querySelector(".modal-card");
            return {
              heading: c.querySelector("h2")?.textContent.trim(),
              stubs: c.querySelectorAll(".ticket-stub").length,
              codes: [...c.querySelectorAll(".ticket-code")].map((e) => e.textContent.trim()),
              hasQr: c.querySelectorAll(".ticket-stub-scan img").length,
              noCode: c.querySelectorAll(".ticket-stub-nocode").length,
              rows: [...c.querySelectorAll(".settings-list .settings-row, .settings-list article")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).slice(0, 4)
            };
          });
          await page.evaluate(() => document.querySelector(".ticket-stub")?.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${OUT}/r4-ticket-stub.png` });
          R.ticketStubClip = await page.evaluate(() => {
            const card = document.querySelector(".modal-card");
            const cr = card.getBoundingClientRect();
            const bad = [];
            card.querySelectorAll(".ticket-stub, .ticket-stub *").forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width && (r.right > cr.right + 1 || r.left < cr.left - 1)) bad.push(el.className || el.tagName);
            });
            return { clipped: bad, cardScrollX: card.scrollWidth > card.clientWidth + 1 };
          });
        }
      }
    }
  }

  // ---- CHAT ----
  await dismiss();
  await page.evaluate(() => { location.hash = "services"; });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-action="chatbot"]')?.click());
  await page.waitForTimeout(600);
  await dismiss();

  // open chat via the chat route used by the app
  await page.evaluate(() => { if (typeof openTitoPayChatModal === "function") openTitoPayChatModal(); });
  await page.waitForTimeout(1500);
  R.chatOpened = await page.evaluate(() => !!document.querySelector(".titopay-chat-shell"));

  if (R.chatOpened) {
    // typing survives a background thread change (the old code reopened the modal)
    await page.fill('[name="identifier"]', "@thabo");
    threadsVersion += 1;
    await page.waitForTimeout(2500);
    R.lookupSurvives = await page.evaluate(() => ({
      value: document.querySelector('[name="identifier"]')?.value,
      shellStillOpen: !!document.querySelector(".titopay-chat-shell")
    }));

    // lookup failure must not claim the user is unregistered
    lookupMode = "fail";
    await page.click('form[data-form="titopay-chat-lookup"] button[type="submit"]');
    await page.waitForTimeout(2200);
    R.lookupFail = await page.evaluate(() => ({
      heading: document.querySelector(".modal-card h2")?.textContent.trim(),
      hasRetry: !!document.querySelector('[data-action="chat-retry-lookup"]')
    }));

    // successful lookup -> preview -> thread
    lookupMode = "found";
    await page.evaluate(() => document.querySelector('[data-action="chat-retry-lookup"]')?.click());
    await page.waitForTimeout(2200);
    R.lookupOk = await page.evaluate(() => document.querySelector(".modal-card h2")?.textContent.trim());
    await page.evaluate(() => document.querySelector('[data-action="chat-confirm-user"]')?.click());
    await page.waitForTimeout(1800);
    R.threadOpen = await page.evaluate(() => !!document.querySelector(".titopay-chat-compose"));

    if (R.threadOpen) {
      // THE bug: type a message, let a poll land, confirm the draft survives
      await page.fill('[name="message"]', "Hi Thabo, sending the deposit now");
      const before = await page.evaluate(() => document.querySelector('[name="message"]').value);
      threadsVersion += 1;
      await page.waitForTimeout(3000);
      threadsVersion += 1;
      await page.waitForTimeout(3000);
      const after = await page.evaluate(() => document.querySelector('[name="message"]')?.value);
      R.draftSurvivesPolling = { before, after, preserved: before === after };
      R.composerStillPresent = await page.evaluate(() => !!document.querySelector(".titopay-chat-compose"));
      await page.screenshot({ path: `${OUT}/r4-chat-thread.png` });
      await page.click(".chat-send-btn");
      await page.waitForTimeout(1800);
      R.afterSend = await page.evaluate(() => ({
        composerEmpty: document.querySelector('[name="message"]')?.value === "",
        composerFocused: document.activeElement?.getAttribute?.("name") === "message",
        messages: document.querySelectorAll(".titopay-chat-window > *").length,
        stillOpen: !!document.querySelector(".titopay-chat-compose")
      }));
    }
  }

  R.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  R.errors = errs;
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
