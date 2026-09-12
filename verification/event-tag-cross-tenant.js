// Can one event organiser reach another event's wristbands?
//
// The existing event-tag-e2e builds a second event, but the SAME organiser owns
// it — so it never tested the case that mattered: two different businesses.
// requireTagStaff authorises the caller against :id in the URL, and the tag
// arrives separately as :tagId. Until they were compared, being staff at any
// approved cashless event authorised acting on every other event's tags.
//
// The direction that costs money is setting a BLOCKED or LOST tag back to
// ACTIVE: the credential resumes authorising payments from that attendee's
// wallet. So this checks the block AND that the four legitimate paths still work.

const { Client } = require("./api/node_modules/pg");
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";
const PASSWORD = "CrossTenant!2026#x";
const tail = String(Date.now()).slice(-7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

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
      method: options.method || "GET", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await r.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return { status: r.status, payload };
  });
}

const PREFIX = ["70", "71", "72", "73", "74", "75"];
let phoneIndex = 0;
async function register(kind, label, accountType = "personal") {
  const body = {
    fullName: label, email: `${kind}x${tail}@titopay.local`,
    phone: `+27${PREFIX[phoneIndex++]}${tail}`, password: PASSWORD, accountType
  };
  const reg = await call("/auth/register", { method: "POST", body });
  if (reg.payload.accessToken) return { ...body, token: reg.payload.accessToken, userId: reg.payload.user?.id };
  const login = await call("/auth/login", { method: "POST", body: { identifier: body.email, password: body.password } });
  return { ...body, token: login.payload.accessToken, userId: login.payload.user?.id };
}

// The only way money enters a wallet here: a real verified card top-up.
async function fundWallet(token, amount) {
  const key = `xt-fund-${tail}-${amount}-${Math.random().toString(16).slice(2, 8)}`;
  const created = await call("/payments/topup", {
    token, method: "POST", headers: { "idempotency-key": key },
    body: { amount, currency: "ZAR", idempotencyKey: key } });
  if (!created.payload.checkoutId) throw new Error(`top-up failed: ${JSON.stringify(created.payload).slice(0, 200)}`);
  await fetch(`${PEACH}/__complete`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkoutId: created.payload.checkoutId, outcome: "successful" }) });
  for (let i = 0; i < 20; i += 1) {
    const st = await call(`/payments/topup/${encodeURIComponent(created.payload.reference)}`, { token });
    if (st.payload.status === "completed") return;
    await sleep(400);
  }
  throw new Error("top-up never completed");
}

async function approvedCashlessEvent(adminToken, organiser, name) {
  const draft = await call("/ticketing/business/events", {
    token: organiser.token, method: "POST",
    body: {
      eventName: `${name} ${tail}`, category: "music", description: "Cross-tenant probe.",
      eventDate: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
      startTime: "18:00", endTime: "23:00", venueName: name, fullVenueAddress: "1 Test Road",
      city: "Cape Town", province: "Western Cape",
      contactEmail: organiser.email, contactNumber: organiser.phone,
      capacity: 100, ticketTypes: [{ name: "General", price: 50, quantity: 50 }]
    }
  });
  const eventId = draft.payload.event?.id;
  if (!eventId) throw new Error(`event draft failed: ${JSON.stringify(draft.payload).slice(0, 200)}`);
  await call(`/ticketing/business/events/${eventId}/submit`, { token: organiser.token, method: "POST", body: {} });
  await call(`/ticketing/admin/events/${eventId}/action`, { token: adminToken, method: "POST", body: { action: "approve" } });
  await call(`/ticketing/business/events/${eventId}/cashless`, { token: organiser.token, method: "POST", body: { enabled: true } });
  const full = await call(`/ticketing/business/events/${eventId}`, { token: organiser.token });
  return { eventId, slug: full.payload.event?.slug, ticketTypeId: full.payload.event?.ticketTypes?.[0]?.id };
}

(async () => {
  console.log(`\n${"=".repeat(78)}\nEVENT TAGS — can organiser B touch organiser A's wristbands?\n${"=".repeat(78)}\n`);

  const admin = (await call("/admin/login", {
    method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" }
  })).payload;
  check("admin signed in", Boolean(admin.accessToken));

  const orgA = await register("oa", "Organiser A", "business");
  const orgB = await register("ob", "Organiser B", "business");
  const attendee = await register("aa", "Cross Attendee");

  // FICA and merchant verification are operator decisions taken through KYC
  // review; they are preconditions for creating a ticketed event, not part of
  // what is being tested. Set the same way event-tag-e2e.js sets them.
  const db = new Client({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL });
  await db.connect();
  await db.query("UPDATE users SET fica_status = 'verified' WHERE id = ANY($1::uuid[])",
    [[orgA.userId, orgB.userId, attendee.userId]]);
  for (const [org, name] of [[orgA, `Festival A Co ${tail}`], [orgB, `Festival B Co ${tail}`]]) {
    const created = await call("/merchants", { token: org.token, method: "POST", body: { businessName: name } });
    const merchant = created.payload.merchant || created.payload;
    await call(`/merchants/${merchant.id}/verify`, {
      token: admin.accessToken, method: "POST", body: { verificationStatus: "verified" } });
  }

  const evA = await approvedCashlessEvent(admin.accessToken, orgA, "Festival A");
  const evB = await approvedCashlessEvent(admin.accessToken, orgB, "Festival B");
  check("two organisers each own an approved cashless event",
    Boolean(evA.eventId && evB.eventId && evA.eventId !== evB.eventId));

  // A live tag at organiser A's event.
  const issued = await call(`/ticketing/business/events/${evA.eventId}/tags/issue`, {
    token: orgA.token, method: "POST", body: { count: 1 } });
  const tag = issued.payload.issued?.[0];
  await fundWallet(attendee.token, 300);
  const buy = await call(`/ticketing/public/events/${evA.slug}/purchase`, {
    token: attendee.token, method: "POST",
    body: { items: [{ ticketTypeId: evA.ticketTypeId, quantity: 1 }],
      attendee: { fullName: attendee.fullName, email: attendee.email, phone: attendee.phone } }
  });
  const ticketCode = buy.payload.order?.tickets?.[0]?.ticketCode || buy.payload.order?.tickets?.[0]?.ticket_code;
  const assigned = await call(`/ticketing/business/events/${evA.eventId}/tags/assign`, {
    token: orgA.token, method: "POST", body: { token: tag.token, ticketCode } });
  const tagId = assigned.payload.tag?.tagId;
  check("organiser A has a live tag on a real ticket", assigned.payload.tag?.status === "ACTIVE" && Boolean(tagId),
    assigned.payload.tag?.status || `assign HTTP ${assigned.status} ${JSON.stringify(assigned.payload).slice(0, 160)} | ticketCode=${ticketCode} | buy HTTP ${buy.status} ${JSON.stringify(buy.payload).slice(0, 120)}`);
  if (!tagId) { await db.end(); console.log("\n  setup did not produce a tag; the checks below would be meaningless.\n"); process.exit(1); }

  console.log(`\n-- the attack --`);

  // B is legitimately tag-staff at their OWN event, and puts A's tag id in the URL.
  const hijackBlock = await call(`/ticketing/business/events/${evB.eventId}/tags/${tagId}/status`, {
    token: orgB.token, method: "POST", body: { status: "BLOCKED", reason: "not mine to block" } });
  check("organiser B cannot BLOCK organiser A's tag", hijackBlock.status === 404,
    `HTTP ${hijackBlock.status} ${hijackBlock.payload.error || ""}`);

  const hijackReplace = await call(`/ticketing/business/events/${evB.eventId}/tags/${tagId}/replace`, {
    token: orgB.token, method: "POST", body: { token: "ETAG_whatever" } });
  check("organiser B cannot REPLACE organiser A's tag", hijackReplace.status === 404,
    `HTTP ${hijackReplace.status} ${hijackReplace.payload.error || ""}`);

  // And with A's event id in the URL, requireTagStaff should already refuse B.
  const hijackViaOwnersEvent = await call(`/ticketing/business/events/${evA.eventId}/tags/${tagId}/status`, {
    token: orgB.token, method: "POST", body: { status: "BLOCKED" } });
  check("organiser B cannot use organiser A's event id either", hijackViaOwnersEvent.status === 404,
    `HTTP ${hijackViaOwnersEvent.status}`);

  const stillActive = await call(`/ticketing/business/events/${evA.eventId}/tags`, { token: orgA.token });
  const row = (stillActive.payload.items || []).find((t) => t.tagId === tagId);
  check("the tag is untouched after all three attempts", row?.status === "ACTIVE", row?.status);

  console.log(`\n-- the four legitimate paths must still work --`);

  const ownerBlock = await call(`/ticketing/business/events/${evA.eventId}/tags/${tagId}/status`, {
    token: orgA.token, method: "POST", body: { status: "BLOCKED", reason: "owner blocking" } });
  check("1. organiser A CAN block their own tag", ownerBlock.status === 200 && ownerBlock.payload.tag?.status === "BLOCKED",
    `HTTP ${ownerBlock.status} ${ownerBlock.payload.tag?.status || ownerBlock.payload.error || ""}`);

  const ownerReactivate = await call(`/ticketing/business/events/${evA.eventId}/tags/${tagId}/status`, {
    token: orgA.token, method: "POST", body: { status: "ACTIVE" } });
  check("2. organiser A CAN reactivate their own tag", ownerReactivate.status === 200 && ownerReactivate.payload.tag?.status === "ACTIVE",
    `HTTP ${ownerReactivate.status} ${ownerReactivate.payload.tag?.status || ownerReactivate.payload.error || ""}`);

  const adminSet = await call(`/admin/ticketing/tags/${tagId}/status`, {
    token: admin.accessToken, method: "POST", body: { status: "BLOCKED", reason: "platform admin" } });
  check("3. the platform admin CAN still act on any tag", adminSet.status === 200 && adminSet.payload.tag?.status === "BLOCKED",
    `HTTP ${adminSet.status} ${adminSet.payload.tag?.status || adminSet.payload.error || ""}`);

  await call(`/ticketing/business/events/${evA.eventId}/tags/${tagId}/status`, {
    token: orgA.token, method: "POST", body: { status: "ACTIVE" } });
  const lost = await call(`/ticketing/tags/${tagId}/lost`, { token: attendee.token, method: "POST", body: {} });
  check("4. the attendee CAN still report their own tag lost", lost.status === 200 && lost.payload.tag?.status === "LOST",
    `HTTP ${lost.status} ${lost.payload.tag?.status || lost.payload.error || ""}`);

  const strangerLost = await call(`/ticketing/tags/${tagId}/lost`, { token: orgB.token, method: "POST", body: {} });
  check("   ...and a stranger still cannot report it lost for them", strangerLost.status === 404, `HTTP ${strangerLost.status}`);

  await db.end();
  console.log(`\n${"=".repeat(78)}\n  ${passed}/${passed + failed} checks passed\n${"=".repeat(78)}\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("\n  HARNESS ERROR:", e.message, "\n"); process.exit(1); });
