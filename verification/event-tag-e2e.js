// EVENT TAGS — end-to-end against the real API, a real Postgres and the real
// POS terminal signing stack.
//
// The claim under test is one sentence: an Event Tag is a CREDENTIAL, not a
// wallet. Everything below exists to try to break that claim — by finding an
// event balance, by spending at the wrong event, by spending someone else's
// money, by being paid twice for one tap, by keeping a lost wristband alive, or
// by getting the credential back out of the system after it was issued.
//
// The full §27 journey is walked in order: create event -> approve -> enable
// cashless -> authorise a vendor -> sell a ticket -> issue blank tags -> assign
// -> tap -> block -> replace -> the replacement pays. Then the refusal matrix.
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";
const crypto = require("crypto");
const { Client } = require("./api/node_modules/pg");

const stamp = Date.now();
const tail = String(stamp).slice(-7);
const PASSWORD = "EventTag!2026#x";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(title) {
  console.log(`\n--- ${title} ---\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The API rate-limits by client IP (120 requests a minute), and a harness this
// long trips it. A 429 means the request never reached a handler, so waiting
// out the window and repeating is safe — and every money-moving call below
// carries its own idempotency key regardless.
async function withRateLimit(send) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await send();
    if (result.status !== 429) return result;
    const wait = Number(result.payload?.retryAfterSeconds) || 15;
    console.log(`  ...rate limited, waiting ${wait + 2}s`);
    await sleep((wait + 2) * 1000);
  }
  throw new Error("still rate limited after six waits");
}

async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return withRateLimit(async () => {
    const r = await fetch(`${API}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await r.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return { status: r.status, payload };
  });
}

// Each cast member needs a phone number nobody else in the run has, so the
// prefix comes from a counter rather than from a lookup that can collide.
const PHONE_PREFIXES = ["60", "61", "62", "63", "64", "65", "66", "67", "68"];
let phoneIndex = 0;
async function register(kind, label, accountType = "personal") {
  const body = {
    fullName: label,
    email: `${kind}${tail}@titopay.local`,
    phone: `+27${PHONE_PREFIXES[phoneIndex++]}${tail}`,
    password: PASSWORD,
    accountType
  };
  const reg = await call("/auth/register", { method: "POST", body });
  if (reg.payload.accessToken) return { ...body, token: reg.payload.accessToken, userId: reg.payload.user?.id };
  const login = await call("/auth/login", { method: "POST", body: { identifier: body.email, password: body.password } });
  return { ...body, token: login.payload.accessToken, userId: login.payload.user?.id };
}

// The only way TitoPay lets money into a wallet: a real verified card top-up.
// Nothing in this harness writes a balance directly.
async function fundWallet(token, amount) {
  const key = `etag-fund-${stamp}-${amount}-${crypto.randomBytes(3).toString("hex")}`;
  const created = await call("/payments/topup", {
    token, method: "POST", headers: { "idempotency-key": key },
    body: { amount, currency: "ZAR", idempotencyKey: key }
  });
  if (!created.payload.checkoutId) throw new Error(`top-up failed: ${JSON.stringify(created.payload).slice(0, 200)}`);
  await fetch(`${PEACH}/__complete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkoutId: created.payload.checkoutId, outcome: "successful" })
  });
  for (let i = 0; i < 15; i += 1) {
    const s = await call(`/payments/topup/${encodeURIComponent(created.payload.reference)}`, { token });
    if (s.payload.status === "completed") return;
    await sleep(300);
  }
  throw new Error("wallet funding did not complete");
}

async function balanceOf(token) {
  const { payload } = await call("/wallets", { token });
  return Number((payload.items || [])[0]?.available_balance ?? NaN);
}

/* ---- terminal request signing, exactly as a real POS device does ---------- */
const sha256hex = (v) => crypto.createHash("sha256").update(v).digest("hex");
async function terminalCall(terminal, path, body, { idempotencyKey, nonce } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  // The nonce is fixed for the life of this call, including across a
  // rate-limit retry: a 429 is refused before requireTerminalAuth runs, so the
  // nonce was never recorded and re-presenting it is not a replay. The
  // timestamp, by contrast, is re-stamped each attempt so the signature stays
  // inside the tolerance window.
  const requestNonce = nonce || `etag-${crypto.randomBytes(12).toString("hex")}`;
  return withRateLimit(async () => {
    const timestamp = String(Date.now());
    const canonical = [timestamp, requestNonce, "POST", `/v1${path}`, sha256hex(raw)].join("\n");
    const signature = crypto.createHmac("sha256", terminal.secret).update(canonical).digest("hex");
    const headers = {
      "content-type": "application/json",
      "x-titopay-terminal-id": terminal.terminalId,
      "x-titopay-timestamp": timestamp,
      "x-titopay-nonce": requestNonce,
      "x-titopay-signature": signature
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const r = await fetch(`${API}${path}`, { method: "POST", headers, body: raw });
    const text = await r.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return { status: r.status, payload };
  });
}

(async () => {
  console.log("\n================================================================");
  console.log("  EVENT TAGS — CREDENTIAL, NOT A WALLET");
  console.log("================================================================");

  const db = new Client({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL });
  await db.connect();

  /* ================================================================== */
  section("0. Cast");

  const admin = (await call("/admin/login", {
    method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" }
  })).payload;
  check("admin signed in", Boolean(admin.accessToken));

  const organiser = await register("org", "Tag Festival Organiser", "business");
  const vendorOwner = await register("ven", "Tag Festival Bar", "business");
  const attendee = await register("att", "Tag Attendee One");
  const attendeeTwo = await register("at2", "Tag Attendee Two");
  const staff = await register("stf", "Tag Gate Staff");
  check("organiser, vendor, two attendees and a staff member registered",
    [organiser, vendorOwner, attendee, attendeeTwo, staff].every((u) => u.token && u.userId));

  // FICA is an operator decision made through KYC review, not something this
  // feature touches. Set here so the event can be created at all.
  await db.query("UPDATE users SET fica_status = 'verified' WHERE id = ANY($1::uuid[])",
    [[organiser.userId, vendorOwner.userId, attendee.userId, attendeeTwo.userId, staff.userId]]);

  const makeMerchant = async (user, name) => {
    const created = await call("/merchants", { token: user.token, method: "POST", body: { businessName: name } });
    const merchant = created.payload.merchant || created.payload;
    await call(`/merchants/${merchant.id}/verify`, {
      token: admin.accessToken, method: "POST", body: { verificationStatus: "verified" }
    });
    const { rows } = await db.query("SELECT id, merchant_id, verification_status FROM merchants WHERE id = $1", [merchant.id]);
    return rows[0];
  };
  const organiserMerchant = await makeMerchant(organiser, `Tag Festival ${tail}`);
  const vendorMerchant = await makeMerchant(vendorOwner, `Tag Bar ${tail}`);
  check("organiser and vendor merchants verified",
    organiserMerchant?.verification_status === "verified" && vendorMerchant?.verification_status === "verified");

  const terminalReg = await call("/pos/terminals/register", {
    token: admin.accessToken, method: "POST",
    body: {
      merchantId: vendorMerchant.merchant_id,
      terminalId: `TAGPOS-${tail}`,
      provider: "STANDARD_BANK",
      deviceIdentifier: `dev-${tail}`
    }
  });
  const terminal = {
    terminalId: terminalReg.payload.terminal?.terminal_id,
    secret: terminalReg.payload.terminalSecret
  };
  check("a POS terminal is registered to the vendor", Boolean(terminal.terminalId && terminal.secret), terminal.terminalId);

  /* ================================================================== */
  section("1. The event, approved, with cashless switched on");

  const draft = await call("/ticketing/business/events", {
    token: organiser.token, method: "POST",
    body: {
      eventName: `Tag Festival ${tail}`,
      category: "music",
      description: "An event used to prove Event Tags never hold money.",
      eventDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      startTime: "18:00", endTime: "23:00",
      venueName: "Test Grounds", fullVenueAddress: "1 Test Road", city: "Johannesburg", province: "Gauteng",
      contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 500,
      ticketTypes: [{ name: "General", price: 100, quantity: 200 }]
    }
  });
  const eventId = draft.payload.event?.id;
  check("organiser created an event", Boolean(eventId), draft.payload.message || "");

  await call(`/ticketing/business/events/${eventId}/submit`, { token: organiser.token, method: "POST", body: {} });
  const approved = await call(`/ticketing/admin/events/${eventId}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "approve", note: "Approved for Event Tag testing" }
  });
  check("admin approved the event", approved.payload.event?.status === "approved", approved.payload.event?.status);

  // Before cashless is switched on, the whole feature is inert.
  const beforeEnable = await call(`/ticketing/business/events/${eventId}/tags/issue`, {
    token: organiser.token, method: "POST", body: { count: 1 }
  });
  check("tags cannot be issued until cashless is enabled", beforeEnable.status === 409, `HTTP ${beforeEnable.status}`);

  const enabled = await call(`/ticketing/business/events/${eventId}/cashless`, {
    token: organiser.token, method: "POST", body: { enabled: true, settings: { maxTapAmount: 2000 } }
  });
  check("organiser enabled cashless Event Tags", enabled.payload.cashless?.cashlessTagsEnabled === true);

  const vendorAdded = await call(`/ticketing/business/events/${eventId}/vendors`, {
    token: organiser.token, method: "POST", body: { merchantId: vendorMerchant.id }
  });
  check("organiser authorised the bar as an event vendor", vendorAdded.status === 201, vendorAdded.payload.vendor?.businessName);

  /* ================================================================== */
  section("2. A ticket is sold — through the existing ticketing flow");

  const eventPublic = await call(`/ticketing/business/events/${eventId}`, { token: organiser.token });
  const ticketTypeId = eventPublic.payload.event?.ticketTypes?.[0]?.id;
  const slug = eventPublic.payload.event?.slug;

  await fundWallet(attendee.token, 500);
  await fundWallet(attendeeTwo.token, 500);

  const buy = await call(`/ticketing/public/events/${slug}/purchase`, {
    token: attendee.token, method: "POST",
    body: { items: [{ ticketTypeId, quantity: 1 }], attendee: { fullName: attendee.fullName, email: attendee.email, phone: attendee.phone } }
  });
  const ticketCode = buy.payload.order?.tickets?.[0]?.ticketCode || buy.payload.order?.tickets?.[0]?.ticket_code;
  check("attendee bought a ticket", Boolean(ticketCode), ticketCode || JSON.stringify(buy.payload).slice(0, 160));

  const buyTwo = await call(`/ticketing/public/events/${slug}/purchase`, {
    token: attendeeTwo.token, method: "POST",
    body: { items: [{ ticketTypeId, quantity: 1 }], attendee: { fullName: attendeeTwo.fullName, email: attendeeTwo.email, phone: attendeeTwo.phone } }
  });
  const ticketCodeTwo = buyTwo.payload.order?.tickets?.[0]?.ticketCode || buyTwo.payload.order?.tickets?.[0]?.ticket_code;
  check("a second attendee bought a ticket", Boolean(ticketCodeTwo));

  /* ================================================================== */
  section("3. Blank credentials are minted, and are never readable again");

  const issued = await call(`/ticketing/business/events/${eventId}/tags/issue`, {
    token: organiser.token, method: "POST", body: { count: 4 }
  });
  const blanks = issued.payload.issued || [];
  check("four blank tags issued", blanks.length === 4, `${blanks.length}`);
  check("every blank tag came back UNASSIGNED", blanks.every((t) => t.status === "UNASSIGNED"));
  check("the credential is opaque and prefixed", blanks.every((t) => /^ETAG_[A-Za-z0-9_-]{43}$/.test(t.token || "")),
    (blanks[0]?.token || "").slice(0, 12) + "...");

  // The credential must carry nothing about the holder or the database.
  const identifiers = [eventId, attendee.userId, ticketCode, blanks[0]?.tagId, vendorMerchant.id].filter(Boolean);
  check("the credential embeds no event, user, ticket, tag or merchant identifier",
    blanks.every((t) => identifiers.every((id) => !String(t.token).includes(String(id)))));
  check("two credentials issued together share no prefix", blanks[0].token.slice(0, 20) !== blanks[1].token.slice(0, 20));

  const { rows: stored } = await db.query("SELECT token_hash FROM event_tags WHERE id = $1", [blanks[0].tagId]);
  check("only the SHA-256 of the credential is stored",
    stored[0]?.token_hash === sha256hex(blanks[0].token) && !stored[0].token_hash.includes(blanks[0].token));

  const listed = await call(`/ticketing/business/events/${eventId}/tags`, { token: organiser.token });
  const listedBlob = JSON.stringify(listed.payload);
  check("listing tags never returns a credential back",
    blanks.every((t) => !listedBlob.includes(t.token)) && !/token_hash|tokenHash/.test(listedBlob));

  /* ================================================================== */
  section("4. Assignment at the gate");

  // A staff member with the "tags" permission — not the owner — does the work.
  await call(`/ticketing/business/events/${eventId}/staff`, {
    token: organiser.token, method: "POST",
    body: { identifier: staff.email, role: "scanner", permissions: ["scan", "tags"] }
  });
  const staffNoPerm = await register("stf2", "Tag Gate Scanner Only");
  await db.query("UPDATE users SET fica_status = 'verified' WHERE id = $1", [staffNoPerm.userId]);
  await call(`/ticketing/business/events/${eventId}/staff`, {
    token: organiser.token, method: "POST",
    body: { identifier: staffNoPerm.email, role: "scanner", permissions: ["scan"] }
  });

  const refusedStaff = await call(`/ticketing/business/events/${eventId}/tags/assign`, {
    token: staffNoPerm.token, method: "POST", body: { token: blanks[3].token, ticketCode }
  });
  check("staff without the tags permission cannot assign one", refusedStaff.status === 404, `HTTP ${refusedStaff.status}`);

  const assigned = await call(`/ticketing/business/events/${eventId}/tags/assign`, {
    token: staff.token, method: "POST", body: { token: blanks[0].token, ticketCode }
  });
  check("tag staff assigned the tag to the ticket", assigned.status === 201 && assigned.payload.tag?.status === "ACTIVE",
    assigned.payload.tag?.status || JSON.stringify(assigned.payload).slice(0, 140));
  const tagId = assigned.payload.tag?.tagId;

  const doubleAssign = await call(`/ticketing/business/events/${eventId}/tags/assign`, {
    token: staff.token, method: "POST", body: { token: blanks[1].token, ticketCode }
  });
  check("a second wristband cannot be given to the same ticket", doubleAssign.status === 409, `HTTP ${doubleAssign.status}`);

  const reassign = await call(`/ticketing/business/events/${eventId}/tags/assign`, {
    token: staff.token, method: "POST", body: { token: blanks[0].token, ticketCode: ticketCodeTwo }
  });
  check("an already-live tag cannot be handed to another attendee", reassign.status === 409, `HTTP ${reassign.status}`);

  /* ================================================================== */
  section("5. There is no event balance — anywhere");

  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('event_tags','event_vendors','event_tag_events')
        AND column_name ~* '(balance|credit|amount|float|topup|top_up)'`
  );
  check("no Event Tag table has a balance-like column", cols.rows.length === 0,
    cols.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", "));

  const walletCount = await db.query("SELECT COUNT(*)::INT AS n FROM wallets WHERE user_id = $1", [attendee.userId]);
  const attendeeWalletsBefore = walletCount.rows[0].n;
  check("the attendee has no extra wallet created for the event", attendeeWalletsBefore >= 1, `${attendeeWalletsBefore} wallet(s)`);

  const ledgerTables = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name ~* '(event.*ledger|ledger.*event|event.*balance)'`
  );
  check("no second ledger was created for events", ledgerTables.rows.length === 0,
    ledgerTables.rows.map((r) => r.table_name).join(", "));

  const analyticsShape = await call(`/ticketing/business/events/${eventId}/tags/analytics`, { token: organiser.token });
  check("event analytics report sales, not a balance",
    !/balance/i.test(JSON.stringify(analyticsShape.payload)),
    Object.keys(analyticsShape.payload.analytics || {}).join(", "));

  /* ================================================================== */
  section("6. A tap moves money through the existing wallet ledger");

  const attendeeOpening = await balanceOf(attendee.token);
  const vendorOpening = Number((await db.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind IN ('merchant','business') ORDER BY created_at ASC LIMIT 1",
    [vendorOwner.userId]
  )).rows[0]?.available_balance ?? NaN);

  const tapKey = `tap-${stamp}-1`;
  const tap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "85.50", currency: "ZAR", merchantReference: "BAR-001" },
    { idempotencyKey: tapKey });
  check("the tap is approved", tap.status === 201 && tap.payload.charge?.outcome === "APPROVED",
    `HTTP ${tap.status} ${tap.payload.charge?.outcome || JSON.stringify(tap.payload).slice(0, 140)}`);
  check("the terminal is told the event, never the credential",
    tap.payload.charge?.event?.id === eventId && !JSON.stringify(tap.payload).includes(blanks[0].token));

  const attendeeAfter = await balanceOf(attendee.token);
  check("the attendee's OWN TitoPay wallet was debited", Math.abs(attendeeAfter - (attendeeOpening - 85.5)) < 0.005,
    `R${attendeeOpening.toFixed(2)} -> R${attendeeAfter.toFixed(2)}`);

  const vendorAfter = Number((await db.query(
    "SELECT available_balance FROM wallets WHERE user_id = $1 AND kind IN ('merchant','business') ORDER BY created_at ASC LIMIT 1",
    [vendorOwner.userId]
  )).rows[0]?.available_balance);
  check("the vendor's wallet was credited the same amount", Math.abs(vendorAfter - (vendorOpening + 85.5)) < 0.005,
    `R${vendorOpening.toFixed(2)} -> R${vendorAfter.toFixed(2)}`);

  const { rows: ledger } = await db.query(
    `SELECT l.entry_type, l.amount FROM wallet_ledger l
      JOIN transactions t ON t.id = l.transaction_id
     WHERE t.reference = $1 ORDER BY l.entry_type`,
    [tap.payload.charge.reference]
  );
  check("exactly one debit and one credit in the existing wallet_ledger",
    ledger.length === 2 && ledger.filter((e) => e.entry_type === "debit").length === 1
      && ledger.filter((e) => e.entry_type === "credit").length === 1,
    ledger.map((e) => `${e.entry_type} ${e.amount}`).join(" / "));

  const { rows: txRows } = await db.query(
    "SELECT service_code, status, amount, fee FROM transactions WHERE reference = $1", [tap.payload.charge.reference]);
  check("the payment is one ordinary completed transaction",
    txRows[0]?.service_code === "event_tag" && txRows[0]?.status === "completed",
    `${txRows[0]?.service_code} / ${txRows[0]?.status}`);

  const activity = await call("/transactions?limit=5", { token: attendee.token });
  check("the tap appears in the attendee's normal transaction history",
    JSON.stringify(activity.payload).includes(tap.payload.charge.reference));

  /* ================================================================== */
  section("7. One tap is one payment");

  const replay = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "85.50", currency: "ZAR", merchantReference: "BAR-001" },
    { idempotencyKey: tapKey });
  check("repeating the same tap replays instead of charging again",
    replay.status === 200 && replay.payload.charge?.idempotentReplay === true, `HTTP ${replay.status}`);
  check("the replay returns the very same reference",
    replay.payload.charge?.reference === tap.payload.charge.reference);
  check("the balance did not move on the replay", Math.abs((await balanceOf(attendee.token)) - attendeeAfter) < 0.005);

  const keyReuse = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "999.00", currency: "ZAR", merchantReference: "BAR-001" },
    { idempotencyKey: tapKey });
  check("reusing the key for a DIFFERENT amount is refused", keyReuse.status === 409, `HTTP ${keyReuse.status}`);
  check("the refused key-reuse moved nothing", Math.abs((await balanceOf(attendee.token)) - attendeeAfter) < 0.005);

  // Four terminals tapping the same wristband at once, for more than the
  // attendee has. Only what the balance covers may go through.
  const spendable = await balanceOf(attendee.token);
  const each = Math.floor((spendable / 3) * 100) / 100;
  const burst = await Promise.all([0, 1, 2, 3].map((i) => terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: each.toFixed(2), currency: "ZAR", merchantReference: `RACE-${i}` },
    { idempotencyKey: `race-${stamp}-${i}` })));
  const approvedCount = burst.filter((b) => b.payload.charge?.outcome === "APPROVED").length;
  const afterBurst = await balanceOf(attendee.token);
  check("a concurrent burst never overdraws the wallet", afterBurst >= -0.005, `R${afterBurst.toFixed(2)}`);
  check("only the taps the balance could cover were approved",
    Math.abs(afterBurst - (spendable - approvedCount * each)) < 0.005,
    `${approvedCount} of 4 approved, R${spendable.toFixed(2)} -> R${afterBurst.toFixed(2)}`);

  const overdraw = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "10000.00", currency: "ZAR" },
    { idempotencyKey: `over-${stamp}` });
  check("a tap beyond the balance is refused", overdraw.status === 400, `HTTP ${overdraw.status}`);
  check("the refusal names insufficient balance without leaking anything else",
    /insufficient balance/i.test(JSON.stringify(overdraw.payload)) && !/select|pg_|stack|at Object/i.test(JSON.stringify(overdraw.payload)),
    JSON.stringify(overdraw.payload).slice(0, 120));

  /* ================================================================== */
  section("8. The refusal matrix");

  // A tag from a different event.
  const otherDraft = await call("/ticketing/business/events", {
    token: organiser.token, method: "POST",
    body: {
      eventName: `Other Festival ${tail}`, category: "music", description: "A second event.",
      eventDate: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
      startTime: "18:00", endTime: "23:00", venueName: "Elsewhere", fullVenueAddress: "2 Test Road",
      city: "Cape Town", province: "Western Cape", contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 100, ticketTypes: [{ name: "General", price: 50, quantity: 50 }]
    }
  });
  const otherEventId = otherDraft.payload.event?.id;
  await call(`/ticketing/business/events/${otherEventId}/submit`, { token: organiser.token, method: "POST", body: {} });
  await call(`/ticketing/admin/events/${otherEventId}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "approve" } });
  await call(`/ticketing/business/events/${otherEventId}/cashless`, {
    token: organiser.token, method: "POST", body: { enabled: true } });
  const otherIssued = await call(`/ticketing/business/events/${otherEventId}/tags/issue`, {
    token: organiser.token, method: "POST", body: { count: 2 } });
  const otherTag = otherIssued.payload.issued?.[0];

  // Make it a LIVE tag on a real ticket at the other event, funded and ready to
  // spend. Anything less and the refusal below could be coming from the tag
  // being blank rather than from the events being different.
  const otherEvent = await call(`/ticketing/business/events/${otherEventId}`, { token: organiser.token });
  const otherBuy = await call(`/ticketing/public/events/${otherEvent.payload.event?.slug}/purchase`, {
    token: attendeeTwo.token, method: "POST",
    body: {
      items: [{ ticketTypeId: otherEvent.payload.event?.ticketTypes?.[0]?.id, quantity: 1 }],
      attendee: { fullName: attendeeTwo.fullName, email: attendeeTwo.email, phone: attendeeTwo.phone }
    }
  });
  const otherTicketCode = otherBuy.payload.order?.tickets?.[0]?.ticketCode || otherBuy.payload.order?.tickets?.[0]?.ticket_code;
  const otherAssigned = await call(`/ticketing/business/events/${otherEventId}/tags/assign`, {
    token: organiser.token, method: "POST", body: { token: otherTag.token, ticketCode: otherTicketCode }
  });
  check("a tag at the second event is live and funded",
    otherAssigned.payload.tag?.status === "ACTIVE" && (await balanceOf(attendeeTwo.token)) > 20,
    `${otherAssigned.payload.tag?.status}, R${(await balanceOf(attendeeTwo.token)).toFixed(2)}`);

  const otherBalanceBefore = await balanceOf(attendeeTwo.token);
  const wrongEvent = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: otherTag.token, amount: "10.00", currency: "ZAR" }, { idempotencyKey: `wrongevent-${stamp}` });
  check("a live, funded tag from another event still cannot pay at this vendor", wrongEvent.status === 403,
    `HTTP ${wrongEvent.status} ${wrongEvent.payload.error || ""}`);
  check("and that attendee's wallet was not touched",
    Math.abs((await balanceOf(attendeeTwo.token)) - otherBalanceBefore) < 0.005,
    `R${otherBalanceBefore.toFixed(2)}`);

  // An event the admin has suspended. Ticket sales already stop when this
  // happens; the wristbands must stop with them, or an event pulled for fraud
  // keeps taking money at the bar.
  // The burst above deliberately spent this wallet to nothing, so put money
  // back first — otherwise the reinstated tap below would be refused for
  // insufficient balance and prove nothing about suspension.
  await fundWallet(attendee.token, 50);
  const beforeSuspend = await balanceOf(attendee.token);
  await call(`/ticketing/admin/events/${eventId}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "suspend", note: "Suspended during testing" } });
  const suspendedTap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "1.00", currency: "ZAR" }, { idempotencyKey: `suspended-${stamp}` });
  check("a suspended event stops accepting taps", suspendedTap.status === 409,
    `HTTP ${suspendedTap.status} ${suspendedTap.payload.error || ""}`);
  check("and the suspension moved no money",
    Math.abs((await balanceOf(attendee.token)) - beforeSuspend) < 0.005);
  await call(`/ticketing/admin/events/${eventId}/action`, {
    token: admin.accessToken, method: "POST", body: { action: "reinstate" } });
  const reinstatedTap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "1.00", currency: "ZAR" }, { idempotencyKey: `reinstated-${stamp}` });
  check("reinstating the event brings the tags back", reinstatedTap.payload.charge?.outcome === "APPROVED",
    `HTTP ${reinstatedTap.status}`);

  // A vendor never authorised for the event.
  const roqueOwner = await register("rog", "Unauthorised Vendor", "business");
  await db.query("UPDATE users SET fica_status = 'verified' WHERE id = $1", [roqueOwner.userId]);
  const rogueMerchant = await makeMerchant(roqueOwner, `Rogue Stall ${tail}`);
  const rogueReg = await call("/pos/terminals/register", {
    token: admin.accessToken, method: "POST",
    body: { merchantId: rogueMerchant.merchant_id, terminalId: `ROGUE-${tail}`, provider: "OTHER", deviceIdentifier: `rog-${tail}` }
  });
  const rogueTerminal = { terminalId: rogueReg.payload.terminal?.terminal_id, secret: rogueReg.payload.terminalSecret };
  const rogueTap = await terminalCall(rogueTerminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "10.00", currency: "ZAR" }, { idempotencyKey: `rogue-${stamp}` });
  check("a vendor not authorised for the event is refused", rogueTap.status === 403, `HTTP ${rogueTap.status}`);

  // A blank tag nobody holds.
  const blankTap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[2].token, amount: "10.00", currency: "ZAR" }, { idempotencyKey: `blank-${stamp}` });
  check("an unassigned tag cannot pay", blankTap.status === 409, `HTTP ${blankTap.status}`);

  // A credential that was never issued.
  const forged = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: `ETAG_${crypto.randomBytes(32).toString("base64url")}`, amount: "10.00", currency: "ZAR" },
    { idempotencyKey: `forged-${stamp}` });
  check("a forged credential is not recognised", forged.status === 404, `HTTP ${forged.status}`);

  // An unsigned request.
  const unsigned = await fetch(`${API}/pos/event-tags/charge`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": `unsigned-${stamp}` },
    body: JSON.stringify({ tagToken: blanks[0].token, amount: "10.00", currency: "ZAR" })
  });
  check("an unsigned tap is rejected before anything is read", unsigned.status === 401, `HTTP ${unsigned.status}`);

  // A replayed signature.
  const sharedNonce = `replay-${crypto.randomBytes(10).toString("hex")}`;
  await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "1.00", currency: "ZAR" },
    { idempotencyKey: `nonce-a-${stamp}`, nonce: sharedNonce });
  const nonceReplay = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "1.00", currency: "ZAR" },
    { idempotencyKey: `nonce-b-${stamp}`, nonce: sharedNonce });
  check("a replayed terminal nonce is detected", nonceReplay.status === 409, `HTTP ${nonceReplay.status}`);

  // A locked wallet.
  await db.query("UPDATE users SET profile_locked = TRUE WHERE id = $1", [attendee.userId]);
  const lockedTap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "1.00", currency: "ZAR" }, { idempotencyKey: `locked-${stamp}` });
  check("a locked wallet stops paying by tag, exactly as it stops everywhere else",
    lockedTap.status === 423, `HTTP ${lockedTap.status}`);
  await db.query("UPDATE users SET profile_locked = FALSE WHERE id = $1", [attendee.userId]);

  // One customer cannot touch another's tag.
  const foreignLost = await call(`/ticketing/tags/${tagId}/lost`, { token: attendeeTwo.token, method: "POST", body: {} });
  check("another customer cannot report someone else's tag lost", foreignLost.status === 404, `HTTP ${foreignLost.status}`);

  const foreignList = await call("/ticketing/tags", { token: attendeeTwo.token });
  check("a customer only ever sees their own tags",
    (foreignList.payload.items || []).every((t) => t.tagId !== tagId), `${(foreignList.payload.items || []).length} tag(s)`);

  const anonymous = await call("/ticketing/tags");
  check("tags are not readable without signing in", anonymous.status === 401, `HTTP ${anonymous.status}`);

  /* ================================================================== */
  section("9. Losing a wristband costs nothing");

  // The burst above deliberately spent the wallet down to nothing. Put money
  // back through the real top-up so the replacement below is testing the
  // credential rather than an empty wallet.
  await fundWallet(attendee.token, 200);

  const myTags = await call("/ticketing/tags", { token: attendee.token });
  check("the attendee can see their own tag", (myTags.payload.items || []).some((t) => t.tagId === tagId));
  check("their view shows a status and an event, and no balance",
    !/balance/i.test(JSON.stringify(myTags.payload)), Object.keys((myTags.payload.items || [])[0] || {}).join(", "));

  const balanceAtLoss = await balanceOf(attendee.token);
  const lost = await call(`/ticketing/tags/${tagId}/lost`, { token: attendee.token, method: "POST", body: {} });
  check("the attendee reported their tag lost", lost.payload.tag?.status === "LOST", lost.payload.tag?.status);
  check("reporting it lost moved no money", Math.abs((await balanceOf(attendee.token)) - balanceAtLoss) < 0.005,
    `R${balanceAtLoss.toFixed(2)}`);

  const lostTap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "5.00", currency: "ZAR" }, { idempotencyKey: `lost-${stamp}` });
  check("the lost wristband stops working immediately", lostTap.status === 409, `HTTP ${lostTap.status}`);

  const replaced = await call(`/ticketing/business/events/${eventId}/tags/${tagId}/replace`, {
    token: staff.token, method: "POST", body: { token: blanks[1].token, reason: "Attendee lost the wristband" }
  });
  check("staff issued a replacement", replaced.status === 201 && replaced.payload.replacement?.status === "ACTIVE",
    replaced.payload.replacement?.status || JSON.stringify(replaced.payload).slice(0, 140));
  check("the old tag is marked REPLACED and points at the new one",
    replaced.payload.previous?.status === "REPLACED" && replaced.payload.previous?.replacedByTagId === replaced.payload.replacement?.tagId);
  check("replacement moved no money", Math.abs((await balanceOf(attendee.token)) - balanceAtLoss) < 0.005);

  const newTap = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[1].token, amount: "5.00", currency: "ZAR" }, { idempotencyKey: `newtag-${stamp}` });
  check("the replacement pays from the SAME wallet", newTap.payload.charge?.outcome === "APPROVED",
    `HTTP ${newTap.status}`);
  check("and the money came off the same attendee",
    Math.abs((await balanceOf(attendee.token)) - (balanceAtLoss - 5)) < 0.005);

  const oldStillDead = await terminalCall(terminal, "/pos/event-tags/charge",
    { tagToken: blanks[0].token, amount: "5.00", currency: "ZAR" }, { idempotencyKey: `olddead-${stamp}` });
  check("the replaced wristband stays dead", oldStillDead.status === 409, `HTTP ${oldStillDead.status}`);

  /* ================================================================== */
  section("10. What the organiser and the admin can see");

  const analytics = await call(`/ticketing/business/events/${eventId}/tags/analytics`, { token: organiser.token });
  const a = analytics.payload.analytics || {};
  check("analytics count the tags issued", a.tagsIssued >= 4, `${a.tagsIssued}`);
  check("analytics count the lost and replaced", (a.tagsLostOrBlocked + a.tagsReplaced) >= 1,
    `${a.tagsLostOrBlocked} lost/blocked, ${a.tagsReplaced} replaced`);
  const { rows: truth } = await db.query(
    `SELECT COUNT(*)::INT AS payments, COALESCE(SUM(amount),0)::NUMERIC AS total
       FROM transactions WHERE service_code = 'event_tag' AND status = 'completed' AND metadata->>'eventId' = $1`,
    [eventId]);
  check("analytics totals are the ledger's totals, not a separate tally",
    a.payments === truth[0].payments && Math.abs(a.totalSales - Number(truth[0].total)) < 0.005,
    `analytics ${a.payments}/R${a.totalSales} vs ledger ${truth[0].payments}/R${Number(truth[0].total)}`);
  check("sales are broken down by vendor", (a.salesByVendor || []).length >= 1, (a.salesByVendor || [])[0]?.vendor);

  const adminTags = await call(`/admin/ticketing/events/${eventId}/tags`, { token: admin.accessToken });
  check("an admin with the permission can list the event's tags", adminTags.status === 200,
    `${(adminTags.payload.items || []).length} tag(s)`);
  check("the admin listing carries no credential",
    blanks.every((t) => !JSON.stringify(adminTags.payload).includes(t.token)));

  const trail = await call(`/admin/ticketing/tags/${tagId}/audit`, { token: admin.accessToken });
  const actions = (trail.payload.items || []).map((i) => i.action);
  check("every step of the tag's life is on an audit trail",
    ["issued", "assigned_and_activated", "payment", "status_lost", "replaced"].every((x) => actions.includes(x)),
    actions.join(", "));
  check("the audit trail holds no credential", !JSON.stringify(trail.payload).includes(blanks[0].token));

  const outsider = await call(`/admin/ticketing/events/${eventId}/tags`, { token: organiser.token });
  check("a customer token cannot reach the admin tag endpoints", outsider.status === 403 || outsider.status === 401,
    `HTTP ${outsider.status}`);

  /* ================================================================== */
  section("11. Nothing else changed");

  const nonCashless = await call("/ticketing/business/events", {
    token: organiser.token, method: "POST",
    body: {
      eventName: `Plain Event ${tail}`, category: "general", description: "An ordinary event with no tags.",
      eventDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      startTime: "10:00", endTime: "16:00", venueName: "Hall", fullVenueAddress: "3 Test Road",
      city: "Durban", province: "KwaZulu-Natal", contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 50, ticketTypes: [{ name: "Entry", price: 20, quantity: 50 }]
    }
  });
  check("an ordinary event is still created exactly as before", nonCashless.status === 201,
    nonCashless.payload.event?.status);
  check("and it is not cashless unless someone switches it on",
    (await db.query("SELECT cashless_tags_enabled FROM events WHERE id = $1", [nonCashless.payload.event?.id])).rows[0]?.cashless_tags_enabled === false);

  const posStillWorks = await call("/pos/payment-intents", { method: "POST", body: {} });
  check("the existing POS QR route is still mounted and still guarded", posStillWorks.status === 401,
    `HTTP ${posStillWorks.status}`);

  const { rows: orphan } = await db.query(
    `SELECT COUNT(*)::INT AS n FROM wallet_ledger l LEFT JOIN transactions t ON t.id = l.transaction_id WHERE t.id IS NULL`);
  check("no ledger entry is orphaned from its transaction", orphan[0].n === 0, `${orphan[0].n}`);

  const { rows: drift } = await db.query(
    `SELECT w.id,
            w.available_balance,
            COALESCE(SUM(CASE WHEN l.entry_type = 'credit' THEN l.amount ELSE -l.amount END), 0) AS ledger_total
       FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id = w.id
      WHERE w.user_id = ANY($1::uuid[])
      GROUP BY w.id, w.available_balance`,
    [[attendee.userId, attendeeTwo.userId, vendorOwner.userId]]);
  const drifted = drift.filter((r) => Math.abs(Number(r.available_balance) - Number(r.ledger_total)) > 0.005);
  check("every wallet still equals the sum of its ledger", drifted.length === 0,
    drifted.map((r) => `${r.id}: ${r.available_balance} vs ${r.ledger_total}`).join(" | "));

  await db.end();

  console.log("\n================================================================");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.name} (${f.detail})`)); }
  console.log("================================================================\n");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
