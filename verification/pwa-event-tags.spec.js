// What an attendee actually sees when they hold an Event Tag.
//
// The spec is blunt about this: the customer must never be shown an event
// balance, must never be offered an event top-up, and must be able to block a
// lost wristband without believing it costs them money. This drives the real
// PWA in a real browser and checks all three, plus that Top Up is the SAME
// button the wallet already has rather than a second one built for events.
const { chromium } = require("playwright");
const crypto = require("crypto");
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";

const stamp = Date.now();
const tail = String(stamp).slice(-7);
const PASSWORD = "EventTagPwa!2026#x";

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket connection to .wss:\/\/api\.titopay\.co\.za/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRateLimit(send) {
  for (let i = 0; i < 6; i += 1) {
    const r = await send();
    if (r.status !== 429) return r;
    const wait = Number(r.payload?.retryAfterSeconds) || 15;
    console.log(`  ...rate limited, waiting ${wait + 2}s`);
    await sleep((wait + 2) * 1000);
  }
  throw new Error("still rate limited");
}
async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return withRateLimit(async () => {
    const r = await fetch(`${API}${path}`, {
      method: options.method || "GET", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await r.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return { status: r.status, payload };
  });
}

const PREFIXES = ["70", "71", "72", "73"];
let phoneIndex = 0;
async function register(kind, label, accountType = "personal") {
  const body = {
    fullName: label, email: `${kind}${tail}@titopay.local`,
    phone: `+27${PREFIXES[phoneIndex++]}${tail}`, password: PASSWORD, accountType
  };
  const reg = await call("/auth/register", { method: "POST", body });
  if (reg.payload.accessToken) return { ...body, ...reg.payload };
  const login = await call("/auth/login", { method: "POST", body: { identifier: body.email, password: PASSWORD } });
  return { ...body, ...login.payload };
}

async function fundWallet(token, amount) {
  const key = `pwatag-${stamp}-${amount}-${crypto.randomBytes(3).toString("hex")}`;
  const created = await call("/payments/topup", {
    token, method: "POST", headers: { "idempotency-key": key },
    body: { amount, currency: "ZAR", idempotencyKey: key }
  });
  if (!created.payload.checkoutId) throw new Error(`top-up failed: ${JSON.stringify(created.payload).slice(0, 160)}`);
  await fetch(`${PEACH}/__complete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkoutId: created.payload.checkoutId, outcome: "successful" })
  });
  for (let i = 0; i < 15; i += 1) {
    const s = await call(`/payments/topup/${encodeURIComponent(created.payload.reference)}`, { token });
    if (s.payload.status === "completed") return;
    await sleep(300);
  }
  throw new Error("funding did not complete");
}

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — an Event Tag reads as a credential, never as a wallet");
  console.log("=============================================================\n");

  const { Client } = require("./api/node_modules/pg");
  const db = new Client({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL });
  await db.connect();

  /* ---- set the event up over the API, exactly as an organiser would ------- */
  const admin = (await call("/admin/login", {
    method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" }
  })).payload;
  const organiser = await register("porg", "PWA Tag Organiser", "business");
  const attendee = await register("patt", "PWA Tag Attendee");
  await db.query("UPDATE users SET fica_status = 'verified' WHERE id = ANY($1::uuid[])",
    [[organiser.user?.id, attendee.user?.id]]);
  const merchant = (await call("/merchants", {
    token: organiser.accessToken, method: "POST", body: { businessName: `PWA Tag Fest ${tail}` }
  })).payload;
  const merchantId = (merchant.merchant || merchant).id;
  await call(`/merchants/${merchantId}/verify`, {
    token: admin.accessToken, method: "POST", body: { verificationStatus: "verified" } });

  const event = (await call("/ticketing/business/events", {
    token: organiser.accessToken, method: "POST",
    body: {
      eventName: `PWA Tag Fest ${tail}`, category: "music", description: "Event Tags on the phone.",
      eventDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
      startTime: "18:00", endTime: "23:00", venueName: "Phone Grounds", fullVenueAddress: "1 Screen Road",
      city: "Johannesburg", province: "Gauteng", contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 100, ticketTypes: [{ name: "General", price: 50, quantity: 50 }]
    }
  })).payload.event;
  await call(`/ticketing/business/events/${event.id}/submit`, { token: organiser.accessToken, method: "POST", body: {} });
  await call(`/ticketing/admin/events/${event.id}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "approve" } });
  await call(`/ticketing/business/events/${event.id}/cashless`, {
    token: organiser.accessToken, method: "POST", body: { enabled: true } });

  await fundWallet(attendee.accessToken, 300);
  const full = (await call(`/ticketing/business/events/${event.id}`, { token: organiser.accessToken })).payload.event;
  const buy = await call(`/ticketing/public/events/${full.slug}/purchase`, {
    token: attendee.accessToken, method: "POST",
    body: {
      items: [{ ticketTypeId: full.ticketTypes[0].id, quantity: 1 }],
      attendee: { fullName: attendee.fullName, email: attendee.email, phone: attendee.phone }
    }
  });
  const ticketCode = buy.payload.order?.tickets?.[0]?.ticketCode || buy.payload.order?.tickets?.[0]?.ticket_code;
  const issued = (await call(`/ticketing/business/events/${event.id}/tags/issue`, {
    token: organiser.accessToken, method: "POST", body: { count: 1 } })).payload.issued[0];
  const assigned = await call(`/ticketing/business/events/${event.id}/tags/assign`, {
    token: organiser.accessToken, method: "POST", body: { token: issued.token, ticketCode } });
  check("an attendee holds a live Event Tag", assigned.payload.tag?.status === "ACTIVE",
    assigned.payload.tag?.status || JSON.stringify(assigned.payload).slice(0, 140));
  const tagId = assigned.payload.tag?.tagId;

  /* ---- now open the real app -------------------------------------------- */
  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [attendee.accessToken, attendee.refreshToken]);
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: undefined },
        body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
      });
      route.fulfill({
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" },
        body: await upstream.text()
      });
    } catch { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
  await sleep(1200);

  console.log("\n--- the tag on the My Tickets screen ---\n");
  await page.evaluate(() => openMyTicketsModal());
  await page.waitForSelector(".event-tag-card", { timeout: 15000 }).catch(() => {});
  await sleep(800);

  const card = await page.evaluate(() => {
    const el = document.querySelector(".event-tag-card");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const buttons = Array.from(el.querySelectorAll("button")).map((b) => ({
      text: b.textContent.trim(),
      action: b.dataset.action || "",
      service: b.dataset.service || "",
      height: Math.round(b.getBoundingClientRect().height)
    }));
    return { text: el.innerText.replace(/\s+/g, " ").trim(), buttons, width: Math.round(rect.width) };
  });
  check("the Event Tag appears with the attendee's tickets", Boolean(card));
  check("it names the event", /PWA Tag Fest/.test(card.text || ""), (card.text || "").slice(0, 60));
  check("it shows the tag's status", /\bActive\b/.test(card.text || ""));

  // The single most important sentence on the card.
  check("it says the money is in the TitoPay Wallet",
    /uses your titopay wallet/i.test(card.text || ""));
  check("it says there is no separate event balance",
    /no separate event balance/i.test(card.text || ""));

  // And the single most important absence.
  check("the card shows NO balance figure at all",
    !/R\s?\d/.test(card.text || "") && !/balance of|available/i.test(card.text || ""),
    (card.text || "").slice(0, 120));

  const labels = (card.buttons || []).map((b) => b.text);
  check("Top Up, View Transactions, Event Information and Report Tag Lost are all offered",
    ["Top Up Wallet", "View Transactions", "Event Information", "Report Tag Lost"].every((l) => labels.some((t) => t.includes(l))),
    labels.join(" | "));

  // Reusing the existing button is the whole point: no event top-up exists.
  const topUp = (card.buttons || []).find((b) => b.text.includes("Top Up"));
  check("Top Up is the app's OWN wallet Top Up, not an event one",
    topUp?.service === "top-up" && !topUp.action, `data-service="${topUp?.service}" data-action="${topUp?.action}"`);
  check("nothing on the card offers to load money onto the tag",
    !/load|add to tag|tag balance|event wallet|event balance(?! )/i.test((card.text || "").replace(/no separate event balance/i, "")),
    (card.text || "").slice(0, 100));

  check("every button meets the 24px minimum target size",
    (card.buttons || []).every((b) => b.height >= 24),
    (card.buttons || []).map((b) => `${b.text}:${b.height}`).join(" "));

  await page.screenshot({ path: "pwa-event-tag.png" });

  console.log("\n--- Top Up opens the ordinary wallet top-up ---\n");
  await page.evaluate(() => document.querySelector('.event-tag-card [data-service="top-up"]')?.click());
  await sleep(1500);
  const topUpScreen = await page.evaluate(() => (document.querySelector(".modal-card, .modal") || document.body).innerText.replace(/\s+/g, " ").trim());
  check("the ordinary Top Up screen opens", /top up/i.test(topUpScreen), topUpScreen.slice(0, 80));
  check("and it is the wallet top-up, with no mention of the event",
    !/PWA Tag Fest|event tag/i.test(topUpScreen), topUpScreen.slice(0, 80));

  console.log("\n--- reporting it lost ---\n");
  await page.evaluate(() => openMyTicketsModal());
  await page.waitForSelector(".event-tag-card", { timeout: 15000 });
  await sleep(600);
  const balanceBefore = await page.evaluate(async () => {
    const r = await api("/v1/wallets");
    return Number((r.items || [])[0]?.available_balance);
  });

  await page.evaluate(() => document.querySelector('[data-action^="event-tag-lost:"]')?.click());
  await sleep(900);
  const confirmText = await page.evaluate(() => (document.querySelector(".modal-card, .modal") || document.body).innerText.replace(/\s+/g, " ").trim());
  check("it asks before blocking the tag", /report this tag lost/i.test(confirmText), confirmText.slice(0, 70));
  check("and it reassures the customer their money is untouched",
    /money stays in your titopay wallet/i.test(confirmText));
  check("it offers a way out", /cancel/i.test(confirmText));

  await page.evaluate(() => document.querySelector('[data-action^="event-tag-lost-confirm:"]')?.click());
  await sleep(3000);

  // Once a tag is reported lost the ticket is waiting for a wristband again, so
  // the screen now carries two cards: the offer to link a replacement, and the
  // lost tag itself. Read them separately rather than whichever is first.
  const afterLost = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".event-tag-card"))
      .map((el) => el.innerText.replace(/\s+/g, " ").trim());
    return {
      all: cards,
      lost: cards.find((t) => /reported lost/i.test(t)) || "",
      link: cards.find((t) => /not linked/i.test(t)) || ""
    };
  });
  check("the tag now reads as reported lost", Boolean(afterLost.lost), afterLost.all.join(" || ").slice(0, 120));
  check("a lost tag no longer offers Report Tag Lost", !/report tag lost/i.test(afterLost.lost));
  check("and the attendee is offered a replacement to link", Boolean(afterLost.link), afterLost.link.slice(0, 80));

  const balanceAfter = await page.evaluate(async () => {
    const r = await api("/v1/wallets");
    return Number((r.items || [])[0]?.available_balance);
  });
  check("blocking the tag moved no money", Math.abs(balanceAfter - balanceBefore) < 0.005,
    `R${balanceBefore.toFixed(2)} -> R${balanceAfter.toFixed(2)}`);

  const serverSide = await db.query("SELECT status FROM event_tags WHERE id = $1", [tagId]);
  check("the server agrees the tag is blocked", serverSide.rows[0]?.status === "LOST", serverSide.rows[0]?.status);

  await page.screenshot({ path: "pwa-event-tag-lost.png" });

  console.log("\n--- an attendee with no Event Tag sees no change ---\n");
  const plain = await register("pnon", "PWA No Tag");
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx2.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [plain.accessToken, plain.refreshToken]);
  await ctx2.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: undefined },
        body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
      });
      route.fulfill({ status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" }, body: await upstream.text() });
    } catch { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
  });
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on("pageerror", (e) => errors2.push(e.message));
  page2.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors2.push(m.text()); });
  await page2.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await sleep(1200);
  await page2.evaluate(() => openMyTicketsModal());
  await sleep(3000);
  const plainScreen = await page2.evaluate(() => ({
    tagCards: document.querySelectorAll(".event-tag-card").length,
    text: (document.querySelector(".modal-card, .modal") || document.body).innerText.replace(/\s+/g, " ").trim()
  }));
  check("someone with no Event Tag sees no Event Tag area", plainScreen.tagCards === 0);
  check("and still gets the ordinary empty-tickets screen",
    /no tickets yet|browse events/i.test(plainScreen.text), plainScreen.text.slice(0, 70));
  check("no script errors on that screen", errors2.length === 0, errors2.slice(0, 2).join(" | ").slice(0, 140));

  check("no script errors anywhere", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));

  await db.end();
  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
