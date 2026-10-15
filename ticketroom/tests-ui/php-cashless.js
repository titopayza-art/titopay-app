// Cashless at an event, end to end, on the PHP edition: wristbands, event
// wallets topped up by card (TicketRoom's sandbox), the vendor till on a
// phone, spending PINs, refunds, the ledger and vendor settlement.
// Run last, after php-walkthrough.js and php-payments.js on the same instance
// (it reuses their accounts; it switches payments to the sandbox):
//   node tests-ui/php-cashless.js http://127.0.0.1:8600 /path/to/public_html
// Real (live) card money is simulated in one place only: a provider
// confirmation is fed straight into payment_apply(), exactly as a signed
// webhook would be, so balances, settlement and a manual card refund can be
// checked with real-money accounts. Everything else goes through the API and
// the pages.
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { verifyOrganiser } = require("./kyc-helper");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const FAN = { email: "sipho@example.co.za", password: "fan-password-123", portal: "customer" };
const FAN2 = { email: "thabo.cashless@example.co.za", password: "thabo-password-12", portal: "customer" };
const CASHIER = { email: "kagiso.till@example.co.za", password: "cashier-pass-123", portal: "pos" };
// 7-byte chip UIDs, new on every run so the suite can run again on the same site.
const RUN = require("crypto").randomBytes(5).toString("hex").toUpperCase();
const BANDS = ["04", "14", "24"].map((x) => `04${RUN}${x}`);
const SPARE = `04${RUN}F9`; // never registered: the desk registers it as a replacement
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $d->exec('PRAGMA busy_timeout=5000'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const php = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); ${code}`]).toString();
const one = (q, ...a) => sql(q, ...a)[0];
const num = (v) => Number(v);

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|422|429|503)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
  return p;
}
function api(p, extraHeaders = {}) {
  let token;
  const call = async (method, url, data, headers = {}) => {
    token ??= (await (await p.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const r = await p.request.fetch(`${BASE}${url}`, { method, data, headers: { ...(token ? { "x-csrf-token": token } : {}), ...extraHeaders, ...headers } });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), body };
  };
  return { get: (u, h) => call("GET", u, undefined, h), post: (u, d, h) => call("POST", u, d ?? {}, h), put: (u, d) => call("PUT", u, d), patch: (u, d) => call("PATCH", u, d), del: (u) => call("DELETE", u) };
}
const ledgerOk = async (a, label) => {
  const r = await a.get("/api/admin/reconciliation");
  assert.equal(r.body.ledger.balanced, true, `ledger balanced: ${label} ${JSON.stringify(r.body.ledger)}`);
  const w = r.body.ledger.clearing.find((c) => c.account === "wallets");
  assert.ok(w && w.ok, `wallet balances match the ledger: ${label}`);
};
// Test money: test:wallet: accounts equal test balances plus test money waiting in refunds.
const testWalletsOk = (label) => {
  const ledger = -num(one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account LIKE 'test:wallet:%'").s);
  const table = num(one("SELECT COALESCE(SUM(test_balance_cents),0) AS s FROM cashless_wallets").s)
    + num(one("SELECT COALESCE(SUM(r.amount_cents),0) AS s FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.kind = 'wallet_balance' AND p.environment <> 'live' AND r.status IN ('requested','processing','manual_pending','failed')").s);
  assert.equal(ledger, table, `test wallets match the test ledger: ${label}`);
};
const balanceOf = (email, eventId) => num(one("SELECT COALESCE(SUM(w.balance_cents + w.test_balance_cents),0) AS s FROM cashless_wallets w JOIN users u ON u.id = w.user_id WHERE u.email = ? AND w.event_id = ?", email, eventId).s);
const idem = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const adm = await page(browser, ADMIN);
    const a = api(adm);
    const org = await page(browser, ORG);
    const o = api(org);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;

    // 1. Payments in the sandbox: cashless, the till and wristbands switch on with them.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "sandbox", mode: "test" } })).status, 200);
    const cfg = await (await adm.request.get(`${BASE}/api/config`)).json();
    assert.deepEqual([cfg.features.cashless, cfg.features.pos, cfg.features.tags], [true, true, true], "features on");
    assert.equal(cfg.cashless.pinThresholdCents, 20000);
    step("sandbox payments on: /api/config switches on cashless, POS and tags");

    // 2. A cashless event. The organiser switches cashless on for it; the event page says so.
    const starts = new Date(Date.now() + 2 * 3600e3), ends = new Date(Date.now() + 8 * 3600e3);
    const ev = (await o.post(`/api/organiser/${orgId}/events`, { title: "Cashless Jazz Picnic", category: "music", venueName: "Zoo Lake", city: "Johannesburg", startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 500 })).body.event;
    const free = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "Early guest", priceCents: 0, quantityTotal: 50, perOrderLimit: 2 })).body.ticketType;
    const paid = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "General", priceCents: 12000, quantityTotal: 100, perOrderLimit: 4 })).body.ticketType;
    assert.equal((await o.patch(`/api/organiser/${orgId}/events/${ev.id}`, { cashlessEnabled: true })).status, 200);
    assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/submit`)).status, 200);
    assert.equal((await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" })).status, 200);
    const pub = (await (await adm.request.get(`${BASE}/api/public/events/${ev.slug}`)).json()).event;
    assert.equal(pub.cashless, true, "event payload says cashless");
    const visitor = await page(browser, null, { width: 390, height: 844 });
    await visitor.goto(`${BASE}/events/${ev.slug}`);
    await visitor.getByText("This event is cashless!").waitFor();
    step("organiser switches cashless on for the event; the public event page says it is cashless");

    // 3. Attendees with tickets: Sipho (free ticket) and Thabo (a sandbox card payment: a TEST ticket).
    php(`if (!user_by_email('${FAN2.email}')) insert('users', ['id' => uuid(), 'email' => '${FAN2.email}', 'email_key' => email_key('${FAN2.email}'), 'full_name' => 'Thabo Mokoena', 'password_hash' => hash_secret('${FAN2.password}'), 'status' => 'active', 'account_type' => 'customer', 'email_verified_at' => now_iso(), 'created_at' => now_iso(), 'updated_at' => now_iso()]);`);
    const fan = await page(browser, FAN, { width: 390, height: 844 });
    const f = api(fan);
    const fan2 = await page(browser, FAN2);
    const f2 = api(fan2);
    assert.equal((await f.post("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: free.id, quantity: 1 }], idempotencyKey: idem("free") })).status, 201);
    const ord = (await f2.post("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: paid.id, quantity: 1 }], idempotencyKey: idem("paid") })).body;
    const pu = new URL(ord.payment.redirectUrl, BASE);
    assert.equal((await f2.post(`/api/public/payments/${pu.searchParams.get("p")}/sandbox`, { k: pu.searchParams.get("k"), outcome: "paid" })).body.result, "confirmed");
    assert.equal(num(one("SELECT test FROM orders WHERE reference = ?", ord.order.reference).test), 1, "sandbox order is a test order");
    step("Sipho has a free ticket; Thabo pays in the sandbox (a test ticket)");

    // 4. The organiser registers a box of wristbands on the event's Vendors & POS tab.
    await org.goto(`${BASE}/organisers#/events/${ev.id}/vendors`);
    await org.getByRole("heading", { name: "Wristbands" }).waitFor();
    await org.getByLabel(/Chip numbers/).fill(BANDS.join("\n"));
    const [dl] = await Promise.all([org.waitForEvent("download"), org.getByRole("button", { name: "Register wristbands" }).click()]);
    const csv = fs.readFileSync(await dl.path(), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
    assert.equal(csv.length, 3);
    const codes = Object.fromEntries(csv.map(([uid, code, act]) => [uid, { code, act }]));
    await org.getByText(/3 registered/).waitFor();
    assert.equal(num(one("SELECT count(*) AS n FROM tags WHERE event_id = ? AND status = 'assigned' AND security_level = 'uid_only'", ev.id).n), 3);
    assert.ok(!fs.readFileSync(path.join(dataDir, "ticketroom.sqlite")).includes(BANDS[0]), "chip UIDs are never stored, only their HMAC");
    const dup = await o.post(`/api/organiser/${orgId}/events/${ev.id}/tags`, { uids: [BANDS[0]] });
    assert.equal(dup.status, 422, "a band can only be registered once");
    assert.equal((await f.post(`/api/organiser/${orgId}/events/${ev.id}/tags`, { uids: ["04FFFFFFFFFF01"] })).status, 404, "customers cannot register bands (the event is hidden from them)");
    step("organiser registers 3 wristband UIDs in bulk (CSV of band and activation codes; UIDs stored only as HMACs; duplicates refused)");

    // 5. Sipho links a band in his account with the codes on it; Thabo links one by API.
    const wrong = await f.post("/api/me/tags/link", { eventId: ev.id, displayCode: codes[BANDS[0]].code, activationCode: "ZZZZZZ" });
    assert.equal(wrong.body.error.code, "tag_code_mismatch");
    await fan.goto(`${BASE}/account#/tags`);
    await fan.getByLabel("Event").selectOption(ev.id);
    await fan.getByLabel("Tag code").fill(codes[BANDS[0]].code);
    await fan.getByLabel("Activation code").fill(codes[BANDS[0]].act);
    await fan.getByRole("button", { name: "Link tag" }).click();
    await fan.getByText("Tag linked and active.").waitFor();
    await fan.locator("td", { hasText: codes[BANDS[0]].code }).waitFor();
    assert.equal((await f2.post("/api/me/tags/link", { eventId: ev.id, displayCode: codes[BANDS[1]].code, activationCode: codes[BANDS[1]].act })).status, 201);
    assert.equal((await f2.post("/api/me/tags/link", { eventId: ev.id, displayCode: codes[BANDS[2]].code, activationCode: codes[BANDS[2]].act })).body.error.code, "tag_already_linked", "one band per person per event");
    assert.ok(!JSON.stringify((await f2.get("/api/me/tags")).body).includes(codes[BANDS[0]].code), "nobody sees another person's bands");
    step("attendees link bands with the printed code and activation code (wrong code refused, one band each, own bands only)");

    // 6. Spending PIN: hashed, easy PINs refused.
    assert.equal((await f.post("/api/auth/me/pin", { pin: "1234", password: FAN.password })).status, 400, "sequence refused");
    assert.equal((await f.post("/api/auth/me/pin", { pin: "4826", password: "wrong-password" })).status, 401);
    assert.equal((await f.post("/api/auth/me/pin", { pin: "4826", password: FAN.password })).status, 200);
    assert.match(one("SELECT spending_pin_hash AS h FROM users WHERE email = ?", FAN.email).h, /^\$2y\$/, "PIN stored as a password hash");
    assert.equal((await f.get("/api/auth/me")).body.user.has_pin, true);
    step("spending PIN set (weak PIN and wrong password refused; stored with password_hash)");

    // 7. Top-up by card on the wallet page, through the sandbox payment page.
    assert.equal((await f.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 100, idempotencyKey: idem("low") })).body.error.code, "topup_limits");
    assert.equal((await f.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 300000, idempotencyKey: idem("big") })).status, 201);
    assert.equal((await f.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 300000, idempotencyKey: idem("cap") })).body.error.code, "balance_cap", "pending top-ups count against the R5000 cap");
    php(`q("UPDATE wallet_topups SET status = 'cancelled' WHERE status = 'pending'"); q("UPDATE payments SET status = 'cancelled' WHERE purpose = 'topup' AND status = 'pending'");`);
    await fan.goto(`${BASE}/account#/wallet/${ev.id}`);
    await fan.getByLabel("Amount (R)").fill("500");
    await fan.getByRole("button", { name: "Top up" }).click();
    await fan.getByText("Practice payment. No real money moves").waitFor();
    await fan.getByRole("button", { name: "Approve payment" }).click();
    await fan.waitForURL(/\/account#\/wallet\//);
    await fan.locator(".balance-card .amt", { hasText: "R500.00" }).waitFor();
    const tu = one("SELECT t.*, p.environment, p.purpose, p.status AS pstatus FROM wallet_topups t JOIN payments p ON p.topup_id = t.id WHERE t.status = 'confirmed' ORDER BY t.created_at DESC LIMIT 1");
    assert.equal(num(tu.amount_cents), 50000);
    assert.deepEqual([num(tu.test), tu.environment, tu.purpose, tu.pstatus], [1, "test", "topup", "confirmed"], "a sandbox top-up is test money");
    const fanId = one("SELECT id FROM users WHERE email = ?", FAN.email).id;
    assert.equal(num(one("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?", `test:wallet:${fanId}:${ev.id}`).s), -50000, "booked to a test: wallet account");
    assert.equal(num(one("SELECT COUNT(*) AS n FROM ledger_entries WHERE account = ?", `wallet:${fanId}:${ev.id}`).n), 0, "nothing on the real-money wallet account");
    const replayKey = idem("replay");
    const r1 = await f.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 5000, idempotencyKey: replayKey });
    const r2 = await f.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 5000, idempotencyKey: replayKey });
    assert.deepEqual([r1.status, r2.status, r2.body.topup.reference], [201, 200, r1.body.topup.reference], "the same top-up request is not started twice");
    const ru = new URL(r1.body.payment.redirectUrl, BASE);
    assert.equal((await f.post(`/api/public/payments/${ru.searchParams.get("p")}/sandbox`, { k: ru.searchParams.get("k"), outcome: "failed" })).body.result, "failed");
    assert.equal(one("SELECT status FROM wallet_topups WHERE reference = ?", r1.body.topup.reference).status, "failed", "a declined card adds nothing");
    assert.equal(balanceOf(FAN.email, ev.id), 50000);
    assert.ok(sql("SELECT 1 FROM message_outbox WHERE to_address = ? AND subject LIKE '[TEST] Top-up confirmed%'", FAN.email).length, "top-up email, marked TEST");
    testWalletsOk("after top-up");
    step("top-up R500 on the wallet page via the sandbox: TEST money in test: ledger accounts; limits, R5000 cap, idempotent start, declined card adds nothing");

    // Thabo tops up R100 by API.
    const t2 = (await f2.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 10000, idempotencyKey: idem("t2") })).body;
    const t2u = new URL(t2.payment.redirectUrl, BASE);
    assert.equal((await f2.post(`/api/public/payments/${t2u.searchParams.get("p")}/sandbox`, { k: t2u.searchParams.get("k"), outcome: "paid" })).body.returnUrl, `/account#/wallet/${ev.id}`);

    // 8. A vendor, its products, a cashier (invited by email) and a till.
    await org.goto(`${BASE}/organisers#/events/${ev.id}/vendors`);
    await org.getByLabel("Vendor name").fill("Kota King");
    await org.getByLabel("Commission (%)").fill("5");
    await org.getByRole("button", { name: "Add vendor" }).click();
    await org.getByRole("heading", { name: "Kota King" }).waitFor();
    const vendor = one("SELECT * FROM vendors WHERE event_id = ?", ev.id);
    assert.equal(num(vendor.commission_bps), 500);
    await org.getByLabel("Vendor staff email").fill(CASHIER.email);
    await org.getByRole("button", { name: "Add", exact: true }).click();
    await org.getByText(`(cashier), ${CASHIER.email}`).waitFor();
    assert.ok(sql("SELECT 1 FROM message_outbox WHERE to_address = ? AND body LIKE '%/account#/reset/%'", CASHIER.email).length, "new vendor staff are emailed a set-password link");
    assert.equal(one("SELECT account_type FROM users WHERE email = ?", CASHIER.email).account_type, "customer", "vendor staff have customer accounts");
    php(`q('UPDATE users SET password_hash = ?, email_verified_at = ? WHERE email = ?', [hash_secret('${CASHIER.password}'), now_iso(), '${CASHIER.email}']);`);
    await org.getByLabel("Terminal name").fill("Till 1");
    await org.getByRole("button", { name: "Register terminal" }).click();
    const key = await org.getByLabel("Terminal key").inputValue();
    assert.match(key, /^trk_/);
    assert.equal(sql("SELECT 1 FROM terminals WHERE key_hash = ?", key).length, 0, "only the key's hash is stored");
    const products = {};
    for (const [name, priceCents] of [["Kota", 6500], ["Cold drink", 2500], ["Braai platter", 25000]]) products[name] = (await o.post(`/api/pos/vendors/${vendor.id}/products`, { name, priceCents })).body.product;
    step("organiser adds a vendor (5% commission), invites a cashier by email, registers a till (key shown once, stored hashed), adds products");

    // 9. The cashier sells on a phone: tap or type the band, approved, balance shown.
    const till = await page(browser, CASHIER, { width: 390, height: 844 });
    await till.goto(`${BASE}/pos`);
    await till.getByLabel("Terminal key").fill(key);
    await till.getByRole("button", { name: "Activate" }).click();
    await till.getByRole("heading", { name: "Kota King" }).waitFor();
    await till.getByRole("button", { name: /Kota/ }).click();
    await till.getByRole("button", { name: /Cold drink/ }).click();
    await till.getByRole("button", { name: "Charge" }).click();
    await till.getByPlaceholder(/paste tag value/).fill(`UID:${BANDS[0]}`);
    await till.getByRole("button", { name: "Use", exact: true }).click();
    await till.getByText("APPROVED").waitFor();
    await till.getByText("Left on the band: R410.00").waitFor();
    assert.equal(balanceOf(FAN.email, ev.id), 41000, "R90 spent");
    const sale1 = one("SELECT * FROM pos_sales WHERE vendor_id = ? AND status = 'confirmed'", vendor.id);
    assert.deepEqual([num(sale1.total_cents), num(sale1.commission_cents), num(sale1.test)], [9000, 450, 1], "R90 sale, R4.50 commission, paid with test money");
    const lines = sql("SELECT account, amount_cents FROM ledger_entries e JOIN ledger_journals j ON j.id = e.journal_id WHERE j.reference = ?", sale1.reference);
    assert.deepEqual(lines.map((l) => [l.account.replace(/:[0-9a-f-]{36}/g, ":id"), num(l.amount_cents)]).sort(), [["test:revenue:cashless_commission", -450], ["test:vendor:id:event:id", -8550], ["test:wallet:id:id", 9000]].sort());
    await till.getByRole("button", { name: "New sale" }).click();
    step("cashier sells R90 on a phone by band: approved, balance shown, wallet R90 → vendor R85.50 + TicketRoom R4.50 (test ledger)");

    // 10. The till API: idempotent, PIN above the threshold, never below zero.
    const t = api(till, { "x-terminal-key": key });
    const kota = { productId: products.Kota.id, quantity: 1 };
    const k1 = idem("sale");
    const s1 = await t.post("/api/pos/sales", { items: [kota], tagInput: `UID:${BANDS[1]}`, idempotencyKey: k1 });
    const s2 = await t.post("/api/pos/sales", { items: [kota], tagInput: `UID:${BANDS[1]}`, idempotencyKey: k1 });
    assert.deepEqual([s1.body.status, s2.body.replay, s2.body.reference], ["confirmed", true, s1.body.reference], "the same sale request charges once");
    assert.equal((await t.post("/api/pos/sales", { items: [{ ...kota, quantity: 2 }], tagInput: `UID:${BANDS[1]}`, idempotencyKey: k1 })).body.error.code, "idempotency_mismatch");
    assert.equal((await t.get(`/api/pos/sales/by-key/${k1}`)).body.reference, s1.body.reference, "an uncertain sale is looked up, not charged again");
    assert.equal((await t.get(`/api/pos/sales/by-key/${idem("never")}`)).body.status, "not_found");
    assert.equal(balanceOf(FAN2.email, ev.id), 3500);
    const platter = { productId: products["Braai platter"].id, quantity: 1 };
    // R205: over the R200 PIN threshold.
    const bigItems = [{ productId: products.Kota.id, quantity: 2 }, { productId: products["Cold drink"].id, quantity: 3 }];
    const big = (pin, k = idem("big")) => t.post("/api/pos/sales", { items: bigItems, tagInput: codes[BANDS[0]].code, pin, idempotencyKey: k });
    assert.equal((await big()).body.declineReason, "pin_required", "R250 needs the PIN (band code typed at the till)");
    assert.equal((await big("1111")).body.declineReason, "pin_incorrect");
    const ok = (await big("4826")).body;
    assert.deepEqual([ok.status, ok.totalCents, ok.balanceCents], ["confirmed", 20500, 20500], "right PIN: approved");
    // Thabo has R35 and no PIN: big sale needs a PIN he doesn't have; a small one beyond his balance is declined.
    assert.equal((await t.post("/api/pos/sales", { items: [platter], tagInput: `UID:${BANDS[1]}`, idempotencyKey: idem("np") })).body.declineReason, "pin_not_set");
    const insufficient = (await t.post("/api/pos/sales", { items: [{ ...kota, quantity: 1 }], tagInput: `UID:${BANDS[1]}`, idempotencyKey: idem("ins") })).body;
    assert.deepEqual([insufficient.declineReason, insufficient.balanceCents], ["insufficient_funds", 3500]);
    // Five tills tap Thabo's band at the same moment for R25 each: R35 covers exactly one.
    const drink = { productId: products["Cold drink"].id, quantity: 1 };
    const race = await Promise.all([1, 2, 3, 4, 5].map(() => t.post("/api/pos/sales", { items: [drink], tagInput: `UID:${BANDS[1]}`, idempotencyKey: idem("race") })));
    assert.equal(race.filter((r) => r.body.status === "confirmed").length, 1, "only one of five simultaneous taps goes through");
    assert.equal(balanceOf(FAN2.email, ev.id), 1000, "R10 left, never below zero");
    assert.equal((await t.post("/api/pos/sales", { items: [kota], tagInput: "UID:04DEADBEEF0001", idempotencyKey: idem("unk") })).body.declineReason, "tag_unknown");
    const peek = (await t.post("/api/pos/balance", { tagInput: `UID:${BANDS[1]}` })).body;
    assert.deepEqual(peek, { found: true, balanceCents: 1000 }, "balance check: the amount only");
    assert.equal((await t.post("/api/pos/balance", { tagInput: `UID:${BANDS[2]}` })).body.found, false, "an unlinked band says nothing");
    for (let i = 0; i < 5; i++) await big("9999");
    assert.equal((await big("4826")).body.declineReason, "pin_locked", "five wrong PINs lock spending for 15 minutes");
    php(`q("UPDATE users SET pin_locked_until = NULL, pin_failed_attempts = 0 WHERE email = '${FAN.email}'");`);
    assert.equal((await api(fan2, { "x-terminal-key": key }).post("/api/pos/sales", { items: [kota], tagInput: `UID:${BANDS[0]}`, idempotencyKey: idem("x") })).body.error.code, "terminal_wrong_vendor", "a till key alone is not enough");
    step("till API: idempotent by request key, PIN at R200+ (wrong PIN counted and locked), simultaneous taps never overdraw, balance check shows no personal data");

    // 11. The gate: a band admits through its linked ticket; a test ticket is still refused.
    const gate = (tagInput) => o.post("/api/staff/scan", { eventId: ev.id, tagInput });
    const g1 = (await gate(`UID:${BANDS[0]}`)).body;
    assert.deepEqual([g1.outcome, g1.holderName], ["admitted", one("SELECT holder_name FROM tickets t JOIN users u ON u.id = t.owner_user_id WHERE u.email = ? AND t.event_id = ?", FAN.email, ev.id).holder_name]);
    assert.equal((await gate(`UID:${BANDS[0]}`)).body.outcome, "already_used");
    assert.equal((await gate(`UID:${BANDS[1]}`)).body.outcome, "test_ticket", "a band on a sandbox ticket is refused like the ticket");
    const unknown = (await gate(`UID:${BANDS[2]}`)).body;
    assert.equal(unknown.outcome, "invalid");
    assert.ok(!unknown.holderName, "an unlinked band reveals nobody");
    step("gate: a band admits through its linked ticket (once); a test ticket's band is refused; an unlinked band reveals nothing");

    // 12. Lost band: blocked at once from the account; the desk links a new one and the balance carries over.
    const before = balanceOf(FAN.email, ev.id);
    const myTag = (await f.get("/api/me/tags")).body.tags.find((x) => x.status === "active" && x.event_id === ev.id);
    await fan.goto(`${BASE}/account#/tags`);
    await fan.locator("tr", { hasText: codes[BANDS[0]].code }).getByRole("button", { name: "Report lost" }).click();
    await fan.getByRole("button", { name: "Block tag" }).click();
    await fan.getByText("Tag blocked.").waitFor();
    assert.equal((await t.post("/api/pos/sales", { items: [drink], tagInput: `UID:${BANDS[0]}`, idempotencyKey: idem("lost") })).body.declineReason, "tag_lost");
    assert.match((await gate(`UID:${BANDS[0]}`)).body.message, /blocked/);
    const rep = await o.post("/api/staff/tags/replace", { eventId: ev.id, oldTagId: myTag.id, newTagInput: `UID:${SPARE}` });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    assert.equal(balanceOf(FAN.email, ev.id), before, "balance unchanged");
    const s3 = (await t.post("/api/pos/sales", { items: [drink], tagInput: `UID:${SPARE}`, idempotencyKey: idem("new") })).body;
    assert.equal(s3.status, "confirmed", "the new band spends the same balance");
    assert.equal(one("SELECT status FROM tags WHERE id = ?", myTag.id).status, "replaced");
    step("lost band blocked in one tap from the account (till and gate refuse it); the desk registers and links a new band; the balance moves with the account");

    // 13. Refunds of sales: a cashier asks, the organiser approves (not their own request), money goes back to the band.
    const refundSale = s3;
    const rq = await t.post(`/api/pos/sales/${refundSale.id}/refund`, { reason: "Drink was warm" });
    assert.equal(rq.status, 201);
    assert.equal((await t.post(`/api/pos/sales/${refundSale.id}/refund`, { reason: "Again" })).body.error.code, "refund_in_progress");
    await org.goto(`${BASE}/organisers#/refunds`);
    await org.locator("tr", { hasText: rq.body.refund.reference }).getByRole("button", { name: "Approve" }).click();
    await org.getByText("Done.").waitFor();
    assert.equal(one("SELECT status FROM pos_sales WHERE id = ?", refundSale.id).status, "reversed");
    assert.equal(balanceOf(FAN.email, ev.id), before, "R25 back on the balance");
    // A vendor manager or the organiser can void a mistake straight away; a cashier cannot.
    const s4 = (await t.post("/api/pos/sales", { items: [kota], tagInput: `UID:${SPARE}`, idempotencyKey: idem("void") })).body;
    assert.equal((await t.post(`/api/pos/sales/${s4.id}/void`, { reason: "Double tap" })).status, 403);
    const ot = api(org, { "x-terminal-key": key });
    const v = await ot.post(`/api/pos/sales/${s4.id}/void`, { reason: "Double tap" });
    assert.deepEqual([v.status, v.body.sale.status], [200, "reversed"]);
    assert.equal(balanceOf(FAN.email, ev.id), before);
    testWalletsOk("after refunds");
    step("sale refund: cashier asks, organiser approves, money back on the band; a mistake voided at once by the organiser (not by a cashier)");

    // 14. Real money (simulated provider confirmation): a live R200 top-up for Sipho, spent at the till.
    php(`tx(function () {
      $t = insert('wallet_topups', ['id' => uuid(), 'reference' => reference('TU'), 'user_id' => '${fanId}', 'event_id' => '${ev.id}', 'amount_cents' => 20000, 'status' => 'pending', 'idempotency_key' => 'sim-live-${RUN}', 'test' => 0, 'created_at' => now_iso()]);
      insert('payments', ['id' => uuid(), 'order_id' => null, 'purpose' => 'topup', 'topup_id' => $t['id'], 'provider' => 'payfast', 'environment' => 'live', 'provider_reference' => 'SIM-LIVE-${RUN}', 'amount_cents' => 20000, 'status' => 'pending', 'created_at' => now_iso(), 'updated_at' => now_iso()]);
    }); echo payment_apply('payfast', 'SIM-LIVE-${RUN}', 'paid', 20000);`);
    assert.equal(num(one("SELECT balance_cents FROM cashless_wallets WHERE user_id = ? AND event_id = ?", fanId, ev.id).balance_cents), 20000, "real money balance");
    const live = (await t.post("/api/pos/sales", { items: [{ ...kota, quantity: 2 }], tagInput: `UID:${SPARE}`, idempotencyKey: idem("live") })).body;
    assert.deepEqual([live.status, live.test], ["confirmed", false], "real money is spent first");
    await ledgerOk(a, "after a real-money sale");
    assert.equal(-num(one("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?", `vendor:${vendor.id}:event:${ev.id}`).s), 12350, "vendor owed R130 less 5%");
    assert.equal((await o.patch(`/api/organiser/${orgId}/events/${ev.id}`, { cashlessEnabled: false })).body.error.code, "cashless_balances", "cashless stays on while people have money on it");
    step("real money (simulated provider confirmation): R200 top-up, R130 sale; ledger balanced incl. wallets; cashless can't be switched off with balances");

    // 15. After the event: settle the vendor, refund unused balances (finance approves; a rejection puts the money back).
    php(`q('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?', [iso_in(-30 * 3600), iso_in(-26 * 3600), '${ev.id}']);`);
    const vf = (await o.get(`/api/organiser/${orgId}/events/${ev.id}/vendors`)).body.vendors[0];
    assert.deepEqual([vf.gross_cents, vf.commission_cents, vf.payable_cents], [13000, 650, 12350], "vendor figures count real money only");
    const an = (await o.get(`/api/organiser/${orgId}/events/${ev.id}/analytics`)).body;
    assert.deepEqual([an.cashless.topups_cents, an.vendors[0].gross_cents], [20000, 13000]);
    // Payouts need a verified bank account (organiser verification).
    await verifyOrganiser(org.request, adm.request, BASE, orgId, { paid: true });
    const settle = await o.post(`/api/organiser/${orgId}/events/${ev.id}/vendors/${vendor.id}/payout`);
    assert.equal(settle.status, 201, JSON.stringify(settle.body));
    assert.equal(settle.body.payout.amount_cents, 12350);
    assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/vendors/${vendor.id}/payout`)).body.error.code, "nothing_owed", "asked once only");
    assert.equal((await a.post(`/api/admin/payouts/${settle.body.payout.id}/decide`, { approve: true })).status, 200);
    assert.equal((await a.post(`/api/admin/payouts/${settle.body.payout.id}/mark-paid`, { bankReference: "FNB-VENDOR-01" })).status, 200);
    assert.equal(num(one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account = ?", `vendor:${vendor.id}:event:${ev.id}`).s), 0, "vendor settled");
    const fin = (await a.get("/api/admin/cashless")).body;
    assert.equal(fin.vendors.find((x) => x.id === vendor.id).paid_cents, 12350);
    assert.equal((await t.post(`/api/pos/sales/${live.id}/refund`, { reason: "Too late" })).body.error.code, "vendor_settled");
    await ledgerOk(a, "after vendor settlement");

    const left = balanceOf(FAN.email, ev.id);
    const wr = await f.post(`/api/me/wallets/${ev.id}/refund`);
    assert.equal(wr.status, 201, JSON.stringify(wr.body));
    assert.equal(wr.body.refund.amountCents, left);
    assert.equal(balanceOf(FAN.email, ev.id), 0, "the balance can't be spent while the refund waits");
    await ledgerOk(a, "refund requested");
    let rows = sql("SELECT r.id, r.amount_cents, p.environment FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.kind = 'wallet_balance' AND r.user_id = ? AND r.status = 'requested'", fanId);
    for (const r of rows) assert.equal((await a.post(`/api/admin/refunds/${r.id}/decide`, { approve: false, note: "Checking the card first" })).body.refund.status, "rejected");
    assert.equal(balanceOf(FAN.email, ev.id), left, "a rejected refund puts the money back");
    await f.post(`/api/me/wallets/${ev.id}/refund`);
    rows = sql("SELECT r.id, r.amount_cents, p.environment FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.kind = 'wallet_balance' AND r.user_id = ? AND r.status = 'requested'", fanId);
    assert.ok(rows.length >= 2, "real and test money go back to their own payments");
    await adm.goto(`${BASE}/admin#/refunds`);
    await adm.locator("tr", { hasText: "wallet balance" }).first().waitFor();
    for (const r of rows) {
      const d = (await a.post(`/api/admin/refunds/${r.id}/decide`, { approve: true })).body.refund;
      if (r.environment === "live") {
        assert.equal(d.status, "manual_pending", "PayFast card refunds are paid in the PayFast dashboard");
        assert.equal((await a.post(`/api/admin/refunds/${r.id}/complete-manually`, { providerReference: "PF-WALLET-REFUND-1" })).body.refund.status, "completed");
      } else assert.equal(d.status, "completed", "sandbox refunds complete at once");
    }
    assert.ok(sql("SELECT 1 FROM message_outbox WHERE to_address = ? AND subject LIKE 'Your unused balance%'", FAN.email).length, "attendee told the money is on its way");
    await ledgerOk(a, "after wallet refunds");
    testWalletsOk("after wallet refunds");
    assert.equal(num(one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account = ?", `wallet:${fanId}:${ev.id}`).s), 0, "real-money wallet empty in the ledger");
    // Nobody has to remember: leftover balances are put up for refund automatically.
    assert.equal(balanceOf(FAN2.email, ev.id), 1000);
    php(`q('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?', [iso_in(-4 * 86400), iso_in(-3 * 86400), '${ev.id}']); echo cashless_auto_refunds();`);
    assert.equal(balanceOf(FAN2.email, ev.id), 0);
    assert.ok(sql("SELECT 1 FROM refunds r JOIN users u ON u.id = r.user_id WHERE u.email = ? AND r.reason LIKE '%automatic%'", FAN2.email).length, "automatic leftover refund request");
    testWalletsOk("after the automatic refund");
    const mine = (await f.get("/api/me/refunds")).body.refunds;
    assert.ok(mine.some((r) => r.kind === "wallet_balance" && r.status === "completed"), "refunds listed in the account");
    step("after the event: vendor settled (R123.50, paid by EFT, sales then locked); unused balance refunded (rejection restores it; PayFast manual + sandbox); automatic leftover refunds; ledger balanced");

    // 16. Audit trail and pages.
    for (const action of ["tags.batch_created", "tag.linked", "tag.reported_lost", "tag.replaced", "wallet.topup_confirmed", "pos.sale", "pos.sale_voided", "refund.completed", "user.pin_set", "terminal.registered", "vendor.created"]) {
      assert.ok(sql("SELECT 1 FROM audit_log WHERE action = ?", action).length, `audit: ${action}`);
    }
    assert.equal((await a.get("/api/admin/audit/verify")).body?.ok ?? true, true);
    for (const [hash, h] of [["#/tags", "Tags"], ["#/terminals", "Terminals"]]) { await adm.goto(`${BASE}/admin${hash}`); await adm.getByRole("heading", { name: h, exact: true }).first().waitFor(); }
    await adm.goto(`${BASE}/admin#/tags`);
    await adm.locator("td", { hasText: codes[BANDS[0]].code }).waitFor();
    await fan.goto(`${BASE}/account#/wallet`);
    await fan.locator(`a.balance-card[href="#/wallet/${ev.id}"]`, { hasText: "R0.00" }).waitFor();
    await fan.goto(`${BASE}/account#/wallet/${ev.id}`);
    await fan.getByRole("heading", { name: "Activity" }).waitFor();
    await fan.locator("td", { hasText: "Purchase · Kota King" }).first().waitFor();
    await till.goto(`${BASE}/pos`);
    await till.getByRole("tab", { name: "Summary" }).click();
    await till.getByText("Owed to you").waitFor();
    await till.getByRole("tab", { name: "Sales" }).click();
    await till.locator("td", { hasText: live.reference }).waitFor();
    await org.goto(`${BASE}/organisers#/events/${ev.id}`);
    await org.getByRole("heading", { name: "Cashless", exact: true }).waitFor();
    const noScroll = await till.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(noScroll, "the till fits a phone screen");
    step("audit entries for every money and band change; admin Tags/Terminals, account wallet and activity, till summary and sales, organiser analytics all open cleanly");
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("PHP cashless checks passed.");
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
