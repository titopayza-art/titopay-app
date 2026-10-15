// Cashless in person on the PHP edition: the top-up desk (cash or the event's
// card machine), undo and manager reversal, desk limits, the cash-up, and
// guests cashing out what is left (to their card, by EFT, or as cash at the
// venue's cash-out desk). Run after php-cashless.js on the same instance:
//   node tests-ui/php-cashdesk.js http://127.0.0.1:8600 /path/to/public_html
// Set TR_SHOTS to a folder to save screenshots of the desk, cash-up and
// cash-out screens there (TR_SHOTS=1 saves them in tests-ui/artifacts/php/).
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const FAN = { email: "sipho@example.co.za", password: "fan-password-123", portal: "customer" };
const RUN = require("crypto").randomBytes(4).toString("hex");
const STAFF = { email: `desk.${RUN}@example.co.za`, password: "desk-staff-pass-1", portal: "scanner" };
const GUEST2 = { email: `zanele.${RUN}@example.co.za`, password: "zanele-pass-123", portal: "customer" };
const GUEST3 = { email: `pieter.${RUN}@example.co.za`, password: "pieter-pass-123", portal: "customer" };
const FIN2 = { email: `finance2.${RUN}@example.co.za`, password: "finance-two-pass-1", portal: "admin" };
const BAND = `04${RUN.toUpperCase()}C0DE`;
const SHOTS = process.env.TR_SHOTS && process.env.TR_SHOTS !== "1" ? process.env.TR_SHOTS : path.join(__dirname, "artifacts", "php");
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $d->exec('PRAGMA busy_timeout=5000'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const php = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); ${code}`]).toString();
const one = (q, ...a) => sql(q, ...a)[0];
const num = Number;
const idem = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function shot(p, name) {
  if (!process.env.TR_SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `cashdesk-${name}.png`), fullPage: true });
}

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|422|429|503)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) { const r = await p.request.post(`${BASE}/api/auth/login`, { data: creds }); assert.equal(r.status(), 200, `sign in ${creds.email}: ${await r.text()}`); }
  return p;
}
function api(p) {
  let token;
  const call = async (method, url, data) => {
    token ??= (await (await p.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const r = await p.request.fetch(`${BASE}${url}`, { method, data, headers: token ? { "x-csrf-token": token } : {} });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), body };
  };
  return { get: (u) => call("GET", u), post: (u, d) => call("POST", u, d ?? {}), put: (u, d) => call("PUT", u, d), patch: (u, d) => call("PATCH", u, d) };
}
const ledgerOk = async (a, label) => {
  const r = await a.get("/api/admin/reconciliation");
  assert.equal(r.body.ledger.balanced, true, `ledger balanced: ${label} ${JSON.stringify(r.body.ledger)}`);
};
const testWalletsOk = (label) => {
  const ledger = -num(one("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE account LIKE 'test:wallet:%'").s);
  const table = num(one("SELECT COALESCE(SUM(test_balance_cents),0) AS s FROM cashless_wallets").s)
    + num(one("SELECT COALESCE(SUM(r.amount_cents),0) AS s FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.kind = 'wallet_balance' AND p.environment <> 'live' AND r.status IN ('requested','processing','manual_pending','failed')").s)
    + num(one("SELECT COALESCE(SUM(amount_cents + fee_cents),0) AS s FROM wallet_cashouts WHERE test = 1 AND status IN ('requested','approved_once','approved')").s);
  assert.equal(ledger, table, `test wallets match the test ledger: ${label}`);
};
const bal = (email, ev) => num(one("SELECT COALESCE(SUM(w.balance_cents + w.test_balance_cents),0) AS s FROM cashless_wallets w JOIN users u ON u.id = w.user_id WHERE u.email = ? AND w.event_id = ?", email, ev).s);
const newUser = (u, name, type = "customer") => php(`if (!user_by_email('${u.email}')) insert('users', ['id' => uuid(), 'email' => '${u.email}', 'email_key' => email_key('${u.email}'), 'full_name' => '${name}', 'password_hash' => hash_secret('${u.password}'), 'status' => 'active', 'account_type' => '${type}', 'email_verified_at' => now_iso(), 'created_at' => now_iso(), 'updated_at' => now_iso()]);`);

(async () => {
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  // Cash-outs of R250 or more need two people in finance (lower than the default, to test it).
  fs.writeFileSync(cfgFile, original.replace("return [", "return [\n    'cashless' => ['dualApprovalCents' => 25000],"));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const adm = await page(browser, ADMIN);
    const a = api(adm);
    const org = await page(browser, ORG);
    const o = api(org);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "sandbox", mode: "test" } })).status, 200);
    assert.equal((await (await adm.request.get(`${BASE}/api/config`)).json()).features.cashDesk, true);

    // A cashless event, three guests with tickets, one band.
    const starts = new Date(Date.now() + 2 * 3600e3), ends = new Date(Date.now() + 8 * 3600e3);
    const ev = (await o.post(`/api/organiser/${orgId}/events`, { title: `Desk Day ${RUN}`, category: "music", venueName: "Mary Fitzgerald Square", city: "Johannesburg", startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 500, cashlessEnabled: true })).body.event;
    assert.ok(ev, "event created");
    const tt = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "Guest list", priceCents: 0, quantityTotal: 50, perOrderLimit: 2 })).body.ticketType;
    assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/submit`)).status, 200);
    assert.equal((await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" })).status, 200);
    newUser(GUEST2, "Zanele Khumalo"); newUser(GUEST3, "Pieter van Wyk"); newUser(FIN2, "Second Finance", "staff");
    php(`insert('platform_roles', ['user_id' => user_by_email('${FIN2.email}')['id'], 'role' => 'finance', 'granted_at' => now_iso()]);`);
    const fan = await page(browser, FAN, { width: 390, height: 844 });
    const f = api(fan);
    const g2 = await page(browser, GUEST2); const z = api(g2);
    const g3 = await page(browser, GUEST3); const pv = api(g3);
    for (const x of [f, z, pv]) assert.equal((await x.post("/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: idem("o") })).status, 201);
    const band = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/tags`, { uids: [BAND] })).body.tags[0];
    assert.equal((await f.post("/api/me/tags/link", { eventId: ev.id, displayCode: band.displayCode, activationCode: band.activationCode })).status, 201);
    // Gate staff who may manage wristbands run the desk; they are invited by email.
    assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/staff`, { email: STAFF.email, fullName: "Bongani Desk", canScan: true, canManageTags: true })).status, 201);
    php(`q('UPDATE users SET password_hash = ?, email_verified_at = ? WHERE email = ?', [hash_secret('${STAFF.password}'), now_iso(), '${STAFF.email}']);`);
    const desk = await page(browser, STAFF, { width: 390, height: 844 });
    const d = api(desk);
    step("a cashless event with three guests, a linked wristband and a desk person (gate staff who manage wristbands)");

    // 1. The desk on a phone: find by band code, R200, cash, confirm.
    await desk.goto(`${BASE}/scan`);
    await desk.locator("[data-ev]", { hasText: ev.title }).click();
    await desk.getByRole("tab", { name: "Top-up desk" }).click();
    await desk.getByRole("heading", { name: "Top-up desk" }).waitFor();
    await desk.getByPlaceholder("Band code, email or mobile").fill(band.displayCode);
    await shot(desk, "1-find");
    await desk.getByRole("button", { name: "Find", exact: true }).click();
    await desk.getByRole("heading", { name: "Sipho" }).first().waitFor();
    await desk.getByRole("button", { name: "R200", exact: true }).click();
    await desk.getByRole("button", { name: "Cash", exact: true }).click();
    await shot(desk, "2-amount");
    await desk.getByRole("button", { name: "Top up R200 (cash)" }).click();
    await desk.getByRole("button", { name: "Yes, top up R200" }).click();
    await desk.getByText("TOPPED UP").waitFor();
    await desk.getByText("New balance R200.00").waitFor();
    await shot(desk, "3-done");
    assert.ok(await desk.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll at 390px");
    assert.equal(bal(FAN.email, ev.id), 20000);
    const t1 = one("SELECT * FROM desk_topups WHERE event_id = ? ORDER BY created_at DESC LIMIT 1", ev.id);
    assert.deepEqual([t1.method, num(t1.test), t1.staff_kind, num(t1.amount_cents)], ["cash", 1, "event_staff", 20000], "test mode: a desk top-up is test money");
    const fanId = one("SELECT id FROM users WHERE email = ?", FAN.email).id;
    const orgAcct = `organiser:${orgId}:event:${ev.id}`;
    assert.equal(num(one("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?", `test:${orgAcct}:desk_cash`).s), 20000, "the organiser holds the desk cash (test ledger)");
    assert.ok(sql("SELECT 1 FROM message_outbox WHERE to_address = ? AND subject LIKE '[TEST] R%added to your wristband%'", FAN.email).length, "receipt emailed, marked TEST");
    await desk.getByRole("button", { name: "Next guest" }).click();
    step("desk on a phone: band found, R200 cash, confirmed, big green result with the new balance; TEST money held by the organiser; receipt emailed");

    // 2. Undo within 10 minutes by the same desk; nobody else; managers reverse later with a reason.
    const top = (x, userId, amountCents, method = "cash", key = idem("t")) => x.post(`/api/cashdesk/events/${ev.id}/topups`, { userId, amountCents, method, idempotencyKey: key, receipt: false });
    const k = idem("dup");
    const r1 = await top(d, fanId, 5000, "card", k);
    const r2 = await top(d, fanId, 5000, "card", k);
    assert.deepEqual([r1.status, r2.status, r2.body.topup.reference], [201, 200, r1.body.topup.reference], "same request key, one top-up");
    assert.equal((await o.post(`/api/cashdesk/events/${ev.id}/topups/${r1.body.topup.reference}/undo`)).status, 403, "only the person who made it can undo it");
    const u1 = await d.post(`/api/cashdesk/events/${ev.id}/topups/${r1.body.topup.reference}/undo`);
    assert.deepEqual([u1.status, u1.body.topup.status, u1.body.guest.balanceCents], [200, "undone", 20000]);
    const r3 = await top(d, fanId, 5000);
    php(`q("UPDATE desk_topups SET created_at = ? WHERE reference = ?", [iso_in(-3600), '${r3.body.topup.reference}']);`);
    assert.equal((await d.post(`/api/cashdesk/events/${ev.id}/topups/${r3.body.topup.reference}/undo`)).body.error.code, "undo_window_passed");
    assert.equal((await d.post(`/api/cashdesk/events/${ev.id}/topups/${r3.body.topup.reference}/reverse`, { reason: "Wrong guest" })).status, 403, "desk staff cannot reverse");
    assert.equal((await o.post(`/api/cashdesk/events/${ev.id}/topups/${r3.body.topup.reference}/reverse`, { reason: "Wrong guest" })).body.topup.status, "reversed");
    assert.equal(bal(FAN.email, ev.id), 20000);
    // Limits: a day's desk cap per person, and the most a balance can hold.
    assert.equal((await o.put(`/api/organiser/${orgId}/events/${ev.id}/cashdesk`, { deskDailyCapCents: 25000 })).status, 200);
    assert.equal((await top(d, fanId, 10000)).body.error.code, "desk_cap", "R200 taken today + R100 is over a R250 day (undone and reversed top-ups do not count)");
    assert.equal((await o.put(`/api/organiser/${orgId}/events/${ev.id}/cashdesk`, { deskDailyCapCents: 2000000 })).status, 200);
    assert.equal((await top(o, fanId, 300000)).status, 201);
    assert.equal((await top(o, fanId, 200000)).body.error.code, "balance_cap", "R5000 is the most a balance can hold");
    php(`q("UPDATE desk_topups SET created_at = ? WHERE event_id = ? AND amount_cents = 300000", [iso_in(-3600), '${ev.id}']);`);
    const big = one("SELECT reference FROM desk_topups WHERE event_id = ? AND amount_cents = 300000", ev.id).reference;
    assert.equal((await o.post(`/api/cashdesk/events/${ev.id}/topups/${big}/reverse`, { reason: "Card machine declined after all" })).body.topup.status, "reversed");
    assert.equal((await top(d, fanId, 100, "cash")).status, 422, "R10 is the smallest desk top-up");
    testWalletsOk("after undo and reversal");
    step("undo within 10 minutes by the same desk only; managers reverse later with a reason; idempotent; daily desk limit; R5000 balance cap");

    // 3. Spending desk money at a vendor, then undo is refused (already spent).
    const vendor = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/vendors`, { name: "Pap en Vleis" })).body.vendor;
    const key = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/vendors/${vendor.id}/terminals`, { label: "Till A" })).body.terminal.terminalKey;
    const prod = (await o.post(`/api/pos/vendors/${vendor.id}/products`, { name: "Plate", priceCents: 6000 })).body.product;
    const r4 = await top(d, fanId, 5000, "card");
    const tok = (await (await org.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const sale = await (await org.request.post(`${BASE}/api/pos/sales`, { data: { items: [{ productId: prod.id, quantity: 1 }], tagInput: `UID:${BAND}`, idempotencyKey: idem("s") }, headers: { "x-csrf-token": tok, "x-terminal-key": key } })).json();
    assert.equal(sale.status, "confirmed", "desk money spends like any other");
    assert.equal(sale.balanceCents, 19000);
    php(`q("UPDATE cashless_wallets SET test_balance_cents = test_balance_cents - 19000 + 3000 WHERE event_id = '${ev.id}' AND user_id = '${fanId}'");`);
    assert.equal((await d.post(`/api/cashdesk/events/${ev.id}/topups/${r4.body.topup.reference}/undo`)).body.error.code, "already_spent", "money already spent cannot be taken back");
    php(`q("UPDATE cashless_wallets SET test_balance_cents = test_balance_cents + 19000 - 3000 WHERE event_id = '${ev.id}' AND user_id = '${fanId}'");`);
    testWalletsOk("after a sale");
    step("desk money spends at the till; once spent, an undo is refused");

    // 4. Cash-up: this desk's totals, every desk for the organiser, print and CSV.
    const cu = (await d.get(`/api/cashdesk/events/${ev.id}/cashup`)).body;
    assert.deepEqual([cu.mine.cash_cents, cu.mine.cash_count, cu.mine.card_cents, cu.mine.card_count, cu.mine.undone_count], [20000, 1, 5000, 1, 2]);
    assert.equal(cu.desks, undefined, "desk staff see only their own desk");
    const all = (await o.get(`/api/cashdesk/events/${ev.id}/cashup`)).body;
    assert.equal(all.desks.length, 2, "the organiser sees every desk");
    assert.equal(all.totals.cash_cents, 20000);
    await desk.getByRole("tab", { name: "Cash-up" }).click();
    await desk.getByText("Cash in the drawer").waitFor();
    const [dl] = await Promise.all([desk.waitForEvent("download"), desk.getByRole("button", { name: "Download CSV" }).click()]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    assert.match(csv, /"cash_taken","200.00"/);
    await shot(desk, "4-cashup");
    step("cash-up: each desk sees its cash, card and drawer totals (print or CSV); the organiser sees every desk");

    // 5. Real money at the desk (live mode): it comes off what TicketRoom pays the organiser.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "payfast", mode: "live", payfastMerchantId: "10000100", payfastMerchantKey: "46f0cd694581a" } })).status, 200);
    const zId = one("SELECT id FROM users WHERE email = ?", GUEST2.email).id;
    const pId = one("SELECT id FROM users WHERE email = ?", GUEST3.email).id;
    const live1 = await top(d, zId, 30000, "cash");
    const live2 = await top(o, pId, 25000, "card");
    assert.deepEqual([live1.body.topup.test, live2.body.topup.test], [false, false]);
    const fin = (await o.get(`/api/organiser/${orgId}/finance`)).body.events.find((e) => e.event_id === ev.id);
    assert.deepEqual([fin.desk_cash_cents, fin.desk_card_cents, fin.balance_cents], [30000, 25000, -55000], "desk takings come off the organiser's balance");
    const adminFig = (await a.get("/api/admin/cashless")).body.events.find((e) => e.id === ev.id);
    assert.deepEqual([adminFig.desk_cash_cents, adminFig.desk_card_cents], [30000, 25000]);
    await ledgerOk(a, "after live desk top-ups");
    step("real money at the desk: R300 cash and R250 card held by the organiser, shown in organiser finance and admin, ledger balanced");

    // 6. Guests cash out after the event, or at the venue while the cash-out desk is open.
    assert.equal((await z.post(`/api/me/wallets/${ev.id}/cashout`, { method: "eft", bank: { accountHolder: "Z Khumalo", bankName: "Capitec", branchCode: "470010", accountNumber: "1234567890" } })).body.error.code, "cashout_closed", "not before the event is over");
    await org.goto(`${BASE}/organisers#/events/${ev.id}/vendors`);
    await org.getByRole("button", { name: "Open the cash-out desk" }).click();
    await org.getByText("Cash-out desk open.").waitFor();
    await shot(org, "5-organiser-desk-card");
    // Desk money can only go back as cash or EFT: no card refund for it.
    assert.equal((await pv.post(`/api/me/wallets/${ev.id}/cashout`, { method: "card" })).body.error.code, "no_card_money");
    // Pieter: cash at the venue. His wallet shows a code; the desk scans it and pays.
    await g3.setViewportSize({ width: 390, height: 844 });
    await g3.goto(`${BASE}/account#/wallet/${ev.id}`);
    await g3.getByRole("button", { name: "Cash out my balance" }).click();
    await g3.getByRole("radio", { name: /Cash at the venue/ }).click();
    await shot(g3, "6-guest-cashout-choice");
    await g3.getByRole("button", { name: "Get a code for R250.00 in cash" }).click();
    const code = (await g3.locator(".cashout-code").innerText()).trim();
    await g3.locator(".cashout-qr img").waitFor();
    await shot(g3, "7-guest-cash-code");
    assert.equal(bal(GUEST3.email, ev.id), 0, "the balance is held while the cash-out waits");
    await ledgerOk(a, "cash-out waiting");
    await desk.getByRole("tab", { name: "Cash out" }).click();
    await desk.getByPlaceholder(/Cash-out code/).fill(code);
    await desk.getByRole("button", { name: "Find", exact: true }).click();
    await desk.getByRole("button", { name: "I have paid R250 in cash" }).waitFor();
    await shot(desk, "8-cashout-desk");
    await desk.getByRole("button", { name: "I have paid R250 in cash" }).click();
    await desk.getByText("PAID OUT").waitFor();
    assert.equal((await d.post(`/api/cashdesk/events/${ev.id}/cashouts/pay`, { code })).body.error.code, "already_paid", "a code pays once");
    assert.equal(num(one("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?", `${orgAcct}:desk_cash`).s), 30000 - 25000, "cash paid out comes back to the organiser's balance");
    const cu2 = (await d.get(`/api/cashdesk/events/${ev.id}/cashup`)).body.mine;
    assert.deepEqual([cu2.cash_paid_out_cents, cu2.drawer_cents], [25000, 20000 + 30000 - 25000], "the cash-up counts cash paid out");
    await ledgerOk(a, "after a cash payout");
    step("cash-out at the venue (organiser opened the desk): the guest gets a code and QR, the desk pays once; desk money cannot go to a card");

    // 7. Zanele: EFT after the event; R300 needs two people in finance; a rejection puts the money back.
    php(`q('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?', [iso_in(-30 * 3600), iso_in(-26 * 3600), '${ev.id}']);`);
    php("echo cashout_reminders();");
    assert.ok(sql("SELECT 1 FROM message_outbox WHERE to_address = ? AND subject LIKE 'You have R%left from%'", GUEST2.email).length, "after the event: one email with a one-tap cash-out link");
    await g2.goto(`${BASE}/account#/wallet/${ev.id}`);
    await g2.getByRole("button", { name: "Cash out my balance" }).click();
    assert.equal(await g2.getByRole("radio", { name: /Back to my card/ }).isDisabled(), true, "desk cash can't go to a card");
    await g2.getByRole("radio", { name: /To my bank account/ }).click();
    await g2.getByLabel("Account holder").fill("Zanele Khumalo");
    await g2.getByLabel("Bank", { exact: true }).fill("Capitec");
    await g2.getByLabel("Branch code").fill("470010");
    await g2.getByLabel("Account number").fill("1234567890");
    await g2.getByRole("button", { name: "Pay R300.00 to my bank account" }).click();
    await g2.getByText(/Waiting for TicketRoom finance/).waitFor();
    assert.ok(!fs.readFileSync(path.join(dataDir, "ticketroom.sqlite")).includes("1234567890"), "bank account stored encrypted");
    let co = one("SELECT * FROM wallet_cashouts WHERE user_id = ? AND method = 'eft' ORDER BY created_at DESC LIMIT 1", zId);
    assert.equal((await a.post(`/api/admin/cashouts/${co.id}/decide`, { approve: false, note: "The bank name and branch code do not match" })).body.cashout.status, "rejected");
    assert.equal(bal(GUEST2.email, ev.id), 30000, "rejected: the money is back on the balance");
    assert.equal((await z.post(`/api/me/wallets/${ev.id}/cashout`, { method: "eft", bank: { accountHolder: "Zanele Khumalo", bankName: "Capitec", branchCode: "470010", accountNumber: "1234567891" } })).status, 201);
    co = one("SELECT * FROM wallet_cashouts WHERE user_id = ? AND method = 'eft' AND status = 'requested'", zId);
    await adm.goto(`${BASE}/admin#/refunds`);
    await adm.getByRole("heading", { name: "Wallet cash-outs by EFT" }).waitFor();
    await adm.locator("tr", { hasText: co.reference }).getByRole("button", { name: "Approve" }).click();
    await adm.locator("tr", { hasText: co.reference }).getByText("needs second approval").waitFor();
    await shot(adm, "9-admin-eft-cashouts");
    assert.equal((await a.post(`/api/admin/cashouts/${co.id}/decide`, { approve: true })).status, 403, "the same person cannot give the second approval");
    const fin2 = await page(browser, FIN2);
    const f2 = api(fin2);
    assert.equal((await f2.post(`/api/admin/cashouts/${co.id}/decide`, { approve: true })).body.cashout.status, "approved");
    assert.equal((await a.post(`/api/admin/cashouts/${co.id}/reveal-account`)).body.accountNumber, "1234567891");
    assert.equal((await a.post(`/api/admin/cashouts/${co.id}/mark-paid`, { bankReference: "FNB-CASHOUT-01" })).body.cashout.status, "paid");
    assert.ok(sql("SELECT 1 FROM message_outbox WHERE to_address = ? AND subject LIKE 'Your cash-out % is on its way'", GUEST2.email).length);
    await ledgerOk(a, "after an EFT cash-out");
    step("EFT cash-out after the event: reminder email, bank details encrypted, rejection restores the balance, two-person approval for large amounts, account shown once, paid");

    // 8. Sipho: online card money goes back to his card; the rest he takes in cash.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "sandbox", mode: "test" } })).status, 200);
    php(`q('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?', [iso_in(-3600), iso_in(3600), '${ev.id}']);`);
    const tu = (await f.post(`/api/me/wallets/${ev.id}/topups`, { amountCents: 10000, idempotencyKey: idem("on") })).body;
    const u = new URL(tu.payment.redirectUrl, BASE);
    assert.equal((await f.post(`/api/public/payments/${u.searchParams.get("p")}/sandbox`, { k: u.searchParams.get("k"), outcome: "paid" })).body.result, "confirmed");
    const before = bal(FAN.email, ev.id);
    const card = await f.post(`/api/me/wallets/${ev.id}/cashout`, { method: "card" });
    assert.deepEqual([card.status, card.body.cashout.amountCents, card.body.leftCents], [201, 10000, before - 10000], "only the online card top-up goes back to the card");
    const rf = one("SELECT id FROM refunds WHERE reference = ?", card.body.cashout.reference);
    assert.equal((await a.post(`/api/admin/refunds/${rf.id}/decide`, { approve: true })).body.refund.status, "completed");
    const cash = await f.post(`/api/me/wallets/${ev.id}/cashout`, { method: "cash" });
    assert.equal(cash.body.cashout.amountCents, before - 10000);
    assert.equal((await f.post(`/api/me/cashouts/${cash.body.cashout.reference}/cancel`)).body.cashout.status, "cancelled");
    assert.equal(bal(FAN.email, ev.id), before - 10000, "cancelled: back on the balance");
    testWalletsOk("after card refund and cancelled cash-out");
    await ledgerOk(a, "at the end");
    step("card cash-out refunds only the online card top-up (finance approves); a cash-out can be cancelled and the money comes back");

    // 9. The admin's Wristbands & wallets page runs a desk too.
    await adm.goto(`${BASE}/admin#/wallets`);
    await adm.getByRole("heading", { name: "Wristbands & wallets" }).waitFor();
    await adm.locator("td", { hasText: ev.title }).first().waitFor();
    await adm.locator("[data-ev]", { hasText: ev.title }).click();
    await adm.getByRole("heading", { name: "Top-up desk" }).waitFor();
    await adm.getByPlaceholder("Band code, email or mobile").fill(GUEST3.email);
    await adm.getByRole("button", { name: "Find", exact: true }).click();
    await adm.getByRole("heading", { name: "Pieter van Wyk" }).waitFor();
    await shot(adm, "10-admin-desk");
    const at = one("SELECT count(*) AS n FROM audit_log WHERE action IN ('wallet.desk_topup','wallet.desk_topup_undone','wallet.desk_topup_reversed','wallet.cashout_requested','wallet.cashout_paid','wallet.cashout_rejected','wallet.cashout_account_revealed','cashless.settings')").n;
    assert.ok(num(at) >= 10, "every desk and cash-out step is in the audit log");
    step("admin Wristbands & wallets: per-event money and a desk for TicketRoom staff; every step audited");
  } finally {
    await browser.close();
    fs.writeFileSync(cfgFile, original);
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("PHP cash desk checks passed.");
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
