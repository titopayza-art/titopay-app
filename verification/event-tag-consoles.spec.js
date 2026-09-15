// The two consoles that manage Event Tags, driven in a real browser.
//
//   1. The ORGANISER, in the PWA's Business Ticketing dashboard: switch
//      cashless on, authorise a vendor, mint blank credentials, assign one to
//      an attendee. The credentials must be shown once and never again.
//
//   2. The ADMIN, in the ticketing console: see what the tags are doing, block
//      one, read its history. Admin must be able to stop a tag and must not be
//      able to see a credential or a balance — there is no balance to see.
const { chromium } = require("playwright");
const crypto = require("crypto");
// Harness screenshots go here, not into the repo root. A verification run
// must never leave build artifacts in the working tree; three got committed
// that way before this existed. The directory is gitignored.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });
const PWA = "http://127.0.0.1:8010";
const ADMIN = "http://127.0.0.1:8020";
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";

const stamp = Date.now();
const tail = String(stamp).slice(-7);
const PASSWORD = "TagConsole!2026#x";

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /frame-ancestors|429|Failed to load resource|favicon|manifest|WebSocket connection/;
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

const PREFIXES = ["74", "75", "76", "77"];
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
  const key = `tagcon-${stamp}-${amount}-${crypto.randomBytes(3).toString("hex")}`;
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

const proxyToLocalApi = async (route) => {
  const rq = route.request();
  const target = rq.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
  try {
    const up = await fetch(target, {
      method: rq.method(), headers: { ...rq.headers(), host: undefined },
      body: ["GET", "HEAD"].includes(rq.method()) ? undefined : rq.postData() || undefined
    });
    route.fulfill({
      status: up.status,
      headers: { "content-type": up.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" },
      body: await up.text()
    });
  } catch { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
};

(async () => {
  console.log("\n=============================================================");
  console.log("  EVENT TAGS — the organiser console and the admin console");
  console.log("=============================================================\n");

  const { Client } = require("./api/node_modules/pg");
  const db = new Client({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL });
  await db.connect();

  /* ---- an approved event, a vendor merchant and a ticket ------------------ */
  const admin = (await call("/admin/login", {
    method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" }
  })).payload;
  const organiser = await register("corg", "Console Organiser", "business");
  const vendorOwner = await register("cven", "Console Vendor", "business");
  const attendee = await register("catt", "Console Attendee");
  await db.query("UPDATE users SET fica_status = 'verified' WHERE id = ANY($1::uuid[])",
    [[organiser.user?.id, vendorOwner.user?.id, attendee.user?.id]]);

  const makeMerchant = async (user, name) => {
    const created = await call("/merchants", { token: user.accessToken, method: "POST", body: { businessName: name } });
    const id = (created.payload.merchant || created.payload).id;
    await call(`/merchants/${id}/verify`, { token: admin.accessToken, method: "POST", body: { verificationStatus: "verified" } });
    return id;
  };
  await makeMerchant(organiser, `Console Fest ${tail}`);
  const vendorMerchantId = await makeMerchant(vendorOwner, `Console Bar ${tail}`);

  const created = await call("/ticketing/business/events", {
    token: organiser.accessToken, method: "POST",
    body: {
      eventName: `Console Fest ${tail}`, category: "music", description: "Driving the tag consoles.",
      eventDate: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10),
      startTime: "18:00", endTime: "23:00", venueName: "Console Grounds", fullVenueAddress: "1 Console Road",
      city: "Johannesburg", province: "Gauteng", contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 100, ticketTypes: [{ name: "General", price: 40, quantity: 40 }]
    }
  });
  const eventId = created.payload.event?.id;
  await call(`/ticketing/business/events/${eventId}/submit`, { token: organiser.accessToken, method: "POST", body: {} });
  await call(`/ticketing/admin/events/${eventId}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "approve" } });
  await fundWallet(attendee.accessToken, 200);
  const full = (await call(`/ticketing/business/events/${eventId}`, { token: organiser.accessToken })).payload.event;
  const buy = await call(`/ticketing/public/events/${full.slug}/purchase`, {
    token: attendee.accessToken, method: "POST",
    body: {
      items: [{ ticketTypeId: full.ticketTypes[0].id, quantity: 1 }],
      attendee: { fullName: attendee.fullName, email: attendee.email, phone: attendee.phone }
    }
  });
  const ticketCode = buy.payload.order?.tickets?.[0]?.ticketCode || buy.payload.order?.tickets?.[0]?.ticket_code;
  check("an approved event with a sold ticket is ready", Boolean(eventId && ticketCode), ticketCode);

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

  /* ======================================================================
     1. The organiser's console, in the PWA
     ====================================================================== */
  console.log("\n--- the organiser turns cashless on and mints tags ---\n");

  const orgCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await orgCtx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_account_type_v1", "business");
  }, [organiser.accessToken, organiser.refreshToken]);
  await orgCtx.route("https://api.titopay.co.za/**", proxyToLocalApi);
  const orgPage = await orgCtx.newPage();
  const orgErrors = [];
  orgPage.on("pageerror", (e) => orgErrors.push(e.message));
  orgPage.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) orgErrors.push(m.text()); });
  await orgPage.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await orgPage.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await sleep(1200);
  await orgPage.evaluate(() => { state.accountType = "business"; });
  await orgPage.evaluate(() => openBusinessTicketingDashboard());
  await orgPage.waitForSelector('[data-form="ticketing-cashless"]', { timeout: 20000 }).catch(() => {});
  await sleep(1000);

  const panel = await orgPage.evaluate(() => {
    const forms = ["ticketing-cashless", "ticketing-vendor", "ticketing-tag-issue", "ticketing-tag-assign"]
      .map((f) => Boolean(document.querySelector(`[data-form="${f}"]`)));
    const section = document.querySelector('[data-form="ticketing-cashless"]')?.closest("section");
    return { forms, text: section ? section.innerText.replace(/\s+/g, " ").trim() : "" };
  });
  check("the organiser gets a full Event Tag panel", panel.forms.every(Boolean), panel.forms.join(","));
  check("it explains the organiser holds no float",
    /pay from their own titopay wallet/i.test(panel.text) && /no event balance/i.test(panel.text),
    panel.text.slice(0, 120));
  check("there is no control to load money onto a tag",
    !/load|top ?up the tag|tag balance|add funds/i.test(panel.text), panel.text.slice(0, 100));

  // Switch cashless on through the form itself.
  await orgPage.evaluate(() => {
    const form = document.querySelector('[data-form="ticketing-cashless"]');
    form.querySelector('[name="enabled"]').value = "true";
    form.requestSubmit();
  });
  await sleep(3500);
  const enabledInDb = (await db.query("SELECT cashless_tags_enabled FROM events WHERE id = $1", [eventId])).rows[0];
  check("the toggle actually switched cashless on", enabledInDb?.cashless_tags_enabled === true);

  // Authorise the vendor.
  await orgPage.evaluate(() => openBusinessTicketingDashboard());
  await orgPage.waitForSelector('[data-form="ticketing-vendor"]', { timeout: 20000 });
  await sleep(800);
  await orgPage.evaluate((merchantId) => {
    const form = document.querySelector('[data-form="ticketing-vendor"]');
    form.querySelector('[name="merchantId"]').value = merchantId;
    form.requestSubmit();
  }, vendorMerchantId);
  await sleep(3000);
  const vendorRows = await db.query("SELECT status FROM event_vendors WHERE event_id = $1 AND merchant_id = $2", [eventId, vendorMerchantId]);
  check("the vendor is authorised for this event", vendorRows.rows[0]?.status === "active", vendorRows.rows[0]?.status);

  // Mint blank tags and read them off the screen.
  await orgPage.evaluate(() => {
    const form = document.querySelector('[data-form="ticketing-tag-issue"]');
    form.querySelector('[name="count"]').value = "3";
    form.requestSubmit();
  });
  await orgPage.waitForSelector(".event-tag-token-list", { timeout: 20000 }).catch(() => {});
  await sleep(800);

  const minted = await orgPage.evaluate(() => {
    const host = document.querySelector(".event-tag-issued");
    if (!host) return null;
    return {
      text: host.innerText.replace(/\s+/g, " ").trim(),
      tokens: Array.from(host.querySelectorAll("code")).map((c) => c.textContent.trim())
    };
  });
  check("three blank credentials are shown once", minted?.tokens.length === 3, `${minted?.tokens.length} shown`);
  check("the screen warns they cannot be read back",
    /shown once and cannot be read back/i.test(minted?.text || ""), (minted?.text || "").slice(0, 90));
  check("each is a real opaque credential",
    (minted?.tokens || []).every((t) => /^ETAG_[A-Za-z0-9_-]{43}$/.test(t)));

  const stored = await db.query("SELECT token_hash FROM event_tags WHERE event_id = $1", [eventId]);
  const hashes = stored.rows.map((r) => r.token_hash);
  check("the database holds only their hashes",
    (minted?.tokens || []).every((t) => !hashes.includes(t)
      && hashes.includes(crypto.createHash("sha256").update(t).digest("hex"))));

  await orgPage.screenshot({ path: `${ARTIFACTS}/event-tag-organiser.png` });

  // Assign one to the attendee.
  await orgPage.evaluate((code) => { window.__ticketCode = code; }, ticketCode);
  await orgPage.evaluate((token) => {
    const form = document.querySelector('[data-form="ticketing-tag-assign"]');
    form.querySelector('[name="token"]').value = token;
    form.querySelector('[name="ticketCode"]').value = window.__ticketCode;
    form.requestSubmit();
  }, minted.tokens[0]);
  await sleep(3000);

  const assigned = await db.query("SELECT id, status FROM event_tags WHERE event_id = $1 AND status = 'ACTIVE'", [eventId]);
  check("assigning from the panel activates the tag", assigned.rows.length === 1, `${assigned.rows.length} active`);
  const tagId = assigned.rows[0]?.id;

  // Once hidden, the credentials are gone from the screen for good.
  await orgPage.evaluate(() => document.querySelector('[data-action="event-tag-clear-tokens"]')?.click());
  await sleep(500);
  await orgPage.evaluate(() => openBusinessTicketingDashboard());
  await sleep(2500);
  const afterReopen = await orgPage.evaluate(() => document.body.innerText);
  check("reopening the dashboard never shows a credential again",
    minted.tokens.every((t) => !afterReopen.includes(t)));

  check("no script errors in the organiser console", orgErrors.length === 0, orgErrors.slice(0, 2).join(" | ").slice(0, 160));

  /* ======================================================================
     2. The admin console
     ====================================================================== */
  console.log("\n--- the admin ticketing console ---\n");

  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await adminCtx.addInitScript(([t, r]) => localStorage.setItem("titopay_admin_auth_v1", JSON.stringify({
    accessToken: t, refreshToken: r, role: "super_admin", scope: "admin", clientLastSeenAt: Date.now()
  })), [admin.accessToken, admin.refreshToken]);
  const adminPage = await adminCtx.newPage();
  const adminErrors = [];
  adminPage.on("pageerror", (e) => adminErrors.push(e.message));
  adminPage.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) adminErrors.push(m.text()); });
  adminPage.on("dialog", (d) => d.accept("Blocked from the admin console during testing").catch(() => {}));
  await adminPage.goto(`${ADMIN}/ticketing/`, { waitUntil: "domcontentloaded", timeout: 25000 });
  await adminPage.waitForTimeout(4000);

  const queue = await adminPage.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  check("the ticketing console loads", /Event Approval Queue/i.test(queue), queue.slice(0, 70));
  check("a cashless event offers an Event Tags button",
    await adminPage.evaluate(() => Boolean(document.querySelector('[data-ticketing-action="tags"]'))));

  await adminPage.evaluate(() => document.querySelector('[data-ticketing-action="tags"]')?.click());
  await adminPage.waitForSelector("#event-tag-audit-host", { timeout: 20000 }).catch(() => {});
  await adminPage.waitForTimeout(2500);

  const tagPanel = await adminPage.evaluate(() => {
    const host = document.getElementById("ticketing-detail-host");
    return host ? host.innerText.replace(/\s+/g, " ").trim() : "";
  });
  check("the Event Tag panel opens", /Event Tags/i.test(tagPanel), tagPanel.slice(0, 70));
  // The metric labels are uppercased by the console's stylesheet, so innerText
  // returns them in caps. Match without regard to case.
  check("it counts tags issued, active, lost and replaced",
    ["Tags Issued", "Active", "Lost or Blocked", "Replaced"]
      .every((l) => new RegExp(l.replace(/ /g, "\\s+"), "i").test(tagPanel)),
    tagPanel.slice(0, 160));
  check("it reports tap sales from the ledger", /Tap Sales/i.test(tagPanel) && /Tap Payments/i.test(tagPanel));
  check("it says plainly that a tag holds no money",
    /a tag holds no money/i.test(tagPanel), tagPanel.slice(0, 140));
  check("it lists the authorised vendors", /Authorised vendors/i.test(tagPanel));
  check("no credential appears anywhere in the admin panel",
    minted.tokens.every((t) => !tagPanel.includes(t)));
  check("there is no balance column and no way to load funds",
    !/\bbalance\b/i.test(tagPanel) && !/load funds|top ?up/i.test(tagPanel),
    tagPanel.slice(0, 100));

  await adminPage.screenshot({ path: `${ARTIFACTS}/event-tag-admin.png`, fullPage: true });

  // Read the tag's history.
  await adminPage.evaluate(() => document.querySelector('[data-event-tag-action="audit"]')?.click());
  await adminPage.waitForTimeout(2500);
  const audit = await adminPage.evaluate(() => document.getElementById("event-tag-audit-host")?.innerText.replace(/\s+/g, " ").trim() || "");
  check("the tag's history is readable", /Tag history/i.test(audit) && /issued/i.test(audit), audit.slice(0, 90));
  check("the history holds no credential", minted.tokens.every((t) => !audit.includes(t)));

  // Block it.
  const balanceBefore = Number((await db.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1", [attendee.user.id])).rows[0].available_balance);
  await adminPage.evaluate(() => document.querySelector('[data-event-tag-action="BLOCKED"]')?.click());
  await adminPage.waitForTimeout(3500);

  const blocked = await db.query("SELECT status FROM event_tags WHERE id = $1", [tagId]);
  check("an admin can block a tag from the console", blocked.rows[0]?.status === "BLOCKED", blocked.rows[0]?.status);
  const balanceAfter = Number((await db.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1", [attendee.user.id])).rows[0].available_balance);
  check("blocking moved no money", Math.abs(balanceAfter - balanceBefore) < 0.005,
    `R${balanceBefore.toFixed(2)} -> R${balanceAfter.toFixed(2)}`);

  const reason = await db.query(
    "SELECT action, metadata FROM event_tag_events WHERE tag_id = $1 ORDER BY created_at DESC LIMIT 1", [tagId]);
  check("the block is recorded with its reason", reason.rows[0]?.action === "status_blocked"
    && String(reason.rows[0]?.metadata?.reason || "").length > 0, reason.rows[0]?.metadata?.reason);

  check("no script errors in the admin console", adminErrors.length === 0, adminErrors.slice(0, 2).join(" | ").slice(0, 160));

  /* ---- an event without cashless is untouched ----------------------------- */
  const plain = await call("/ticketing/business/events", {
    token: organiser.accessToken, method: "POST",
    body: {
      eventName: `Plain Console ${tail}`, category: "general", description: "No tags here.",
      eventDate: new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10),
      startTime: "10:00", endTime: "14:00", venueName: "Hall", fullVenueAddress: "9 Console Road",
      city: "Durban", province: "KwaZulu-Natal", contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 20, ticketTypes: [{ name: "Entry", price: 10, quantity: 20 }]
    }
  });
  await call(`/ticketing/business/events/${plain.payload.event.id}/submit`, { token: organiser.accessToken, method: "POST", body: {} });
  await call(`/ticketing/admin/events/${plain.payload.event.id}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "approve" } });
  await adminPage.reload({ waitUntil: "domcontentloaded" });
  await adminPage.waitForTimeout(4000);
  const buttonsPerEvent = await adminPage.evaluate((plainName) => {
    const rows = Array.from(document.querySelectorAll("tr"));
    const row = rows.find((r) => r.innerText.includes(plainName));
    return row ? Boolean(row.querySelector('[data-ticketing-action="tags"]')) : null;
  }, `Plain Console ${tail}`);
  check("an event without cashless offers no Event Tags button", buttonsPerEvent === false,
    buttonsPerEvent === null ? "row not found" : String(buttonsPerEvent));

  await db.end();
  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
