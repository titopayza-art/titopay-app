// Money, end to end, against local stand-ins for Yoco and PayFast
// (tests-ui/mocks/providers.php). Run after php-walkthrough.js on the same
// instance (it reuses the accounts it made):
//   node tests-ui/php-payments.js http://127.0.0.1:8600 /path/to/public_html
// Covers: admin sets up Yoco in Integrations (keys never come back), a guest
// pays by card, a lost notification is recovered by asking the provider,
// forged / replayed / wrong-amount notifications, refunds with two-person
// approval, organiser payouts, PayFast ITNs and manual refunds,
// reconciliation, and a balanced ledger after every step.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert/strict");
const { spawn, execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { verifyOrganiser } = require("./kyc-helper");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
// TR_MOCK_PORT lets two test runs on one machine use different stand-ins.
const MOCK_PORT = process.env.TR_MOCK_PORT || "8701";
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1" };
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const php = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); ${code}`]).toString();

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|422|429|503)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
  return p;
}
// JSON API calls with the page's session and CSRF token.
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

(async () => {
  // Point the site at the stand-ins (data folder config, as an owner would edit it).
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  if (!original.includes("yocoApiBase")) fs.writeFileSync(cfgFile, original.replace("return [", `return [\n    'payments' => ['yocoApiBase' => '${MOCK}', 'payfastBase' => '${MOCK}'],`));
  const state = fs.mkdtempSync("/tmp/tr-mock-");
  const mock = spawn("php", ["-S", `127.0.0.1:${MOCK_PORT}`, path.join(__dirname, "mocks", "providers.php")], { env: { ...process.env, TARGET: BASE, STATE: state, PHP_CLI_SERVER_WORKERS: "4" }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    const adm = await page(browser, ADMIN);
    const a = api(adm);
    const org = await page(browser, ORG);
    const o = api(org);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;

    // 1. Before set-up, paid tickets can't be bought.
    assert.equal((await (await adm.request.get(`${BASE}/api/config`)).json()).cardPaymentsEnabled, false);

    // 2. The admin sets up Yoco on the Integrations page.
    await adm.goto(`${BASE}/admin#/integrations`);
    const card = adm.locator('[data-integ="payments"]');
    await card.getByLabel("Payment provider").selectOption("yoco");
    await card.getByLabel("Mode").selectOption("live");
    // No password box sits on the page for the browser to fill: it is asked for on Save.
    assert.equal(await adm.locator("#main input[autocomplete='current-password']").count(), 0, "no password field on the page");
    assert.equal(await adm.locator("#main input[type=password]").evaluateAll((els) => els.filter((e) => e.value).length), 0, "write-only boxes start empty");
    await card.getByLabel(/Yoco secret key/).click();
    await card.getByLabel(/Yoco secret key/).fill("sk_live_ticketroomLIVE123");
    const save = async (pw) => {
      await card.getByRole("button", { name: /Save card payments settings/ }).click();
      const dlg = adm.locator("dialog[open]");
      await dlg.getByLabel("Your password").fill(pw);
      await dlg.getByRole("button", { name: "Save" }).click();
    };
    await save("wrong-password");
    await adm.getByText(/password is incorrect/).first().waitFor();
    await save(ADMIN.password);
    await adm.locator('[data-integ="payments"] .badge', { hasText: "live" }).waitFor();
    const ig = await a.get("/api/admin/integrations");
    const text = JSON.stringify(ig.body);
    assert.ok(!text.includes("sk_live_ticketroomLIVE123"), "secret key never sent back");
    assert.ok(!/whsec_/.test(text), "webhook secret never sent back");
    const stored = fs.readFileSync(path.join(dataDir, "ticketroom.sqlite"));
    assert.ok(!stored.includes("sk_live_ticketroomLIVE123"), "secret key stored encrypted");
    const pay = ig.body.integrations.find((i) => i.key === "payments");
    assert.equal(pay.status, "active");
    assert.equal(pay.fields.find((f) => f.name === "yocoWebhookSecret").set, true, "notification address registered with Yoco");
    assert.equal((await a.post("/api/admin/integrations/payments/health")).body.ok, true);
    assert.equal((await (await adm.request.get(`${BASE}/api/config`)).json()).cardPaymentsEnabled, true);
    const audit = sql("SELECT details FROM audit_log WHERE action = 'integration.updated' ORDER BY rowid DESC LIMIT 1")[0].details;
    assert.ok(!audit.includes("sk_live_ticketroomLIVE123"), "audit log names fields, never values");
    step("admin sets up Yoco: password needed, keys stored encrypted and never shown, notifications registered");

    // 3. A paid event.
    const starts = new Date(Date.now() + 2 * 3600e3), ends = new Date(Date.now() + 6 * 3600e3);
    const ev = (await o.post(`/api/organiser/${orgId}/events`, { title: "Rooftop Sessions Live", category: "music", venueName: "The Roof", city: "Johannesburg", startsAt: starts.toISOString(), endsAt: ends.toISOString(), capacity: 300 })).body.event;
    const tt = (await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "General", priceCents: 15000, quantityTotal: 100, perOrderLimit: 6 })).body.ticketType;
    assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/submit`)).status, 200);
    assert.equal((await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" })).status, 200);

    // 4. A guest pays by card through Yoco's page.
    const g = await page(browser, null, { width: 390, height: 844 });
    await g.goto(`${BASE}/events/${ev.slug}`);
    await g.getByRole("button", { name: /More General/ }).click();
    await g.getByRole("button", { name: /More General/ }).click();
    await g.getByRole("button", { name: "Continue" }).click();
    await g.getByLabel("Full name").fill("Thandi Buyer");
    await g.getByLabel("Email", { exact: true }).fill("thandi@example.co.za");
    await g.getByLabel("Confirm email").fill("thandi@example.co.za");
    await g.getByRole("button", { name: "Pay R320.00" }).click();
    await g.waitForURL(new RegExp(`127\\.0\\.0\\.1:${MOCK_PORT}/pay/`));
    await g.getByRole("button", { name: "Pay now" }).click();
    await g.getByRole("heading", { name: /You're going/ }).waitFor({ timeout: 30000 });
    assert.equal(await g.locator(".ticket").count(), 2);
    const o1 = sql("SELECT * FROM orders WHERE buyer_email = 'thandi@example.co.za'")[0];
    assert.equal(o1.status, "paid");
    assert.equal(Number(o1.total_cents), 32000);
    assert.equal(sql("SELECT status FROM payments WHERE order_id = ?", o1.id)[0].status, "confirmed");
    await ledgerOk(a, "after payment");
    const acct = sql("SELECT SUM(amount_cents) AS s FROM ledger_entries WHERE account = ?", `organiser:${orgId}:event:${ev.id}`)[0].s;
    assert.equal(Number(acct), -28500, "organiser owed R300 less 5%");
    step("guest pays R320 on Yoco's page; tickets on the order page; ledger: organiser R285, fees R20, commission R15");

    // 5. The provider's notification never arrives: the order page asks Yoco and still confirms.
    const r2 = await (await g.request.post(`${BASE}/api/public/orders`, { data: { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: `lost-${Date.now()}`, guest: { fullName: "Lost Notice", email: "lost@example.co.za" } } })).json();
    assert.match(r2.payment.redirectUrl, new RegExp(`${MOCK_PORT}/pay/`));
    await g.goto(r2.payment.redirectUrl);
    await g.getByRole("button", { name: "Pay (notification lost)" }).click();
    await g.getByRole("heading", { name: /You're going/ }).waitFor({ timeout: 40000 });
    assert.equal(sql("SELECT status FROM orders WHERE reference = ?", r2.order.reference)[0].status, "paid");
    step("lost notification: the order page asks Yoco directly and the tickets arrive");

    // 6. Forged, replayed and wrong-amount notifications.
    const ms = JSON.parse(fs.readFileSync(path.join(state, "state.json"), "utf8"));
    const secret = Buffer.from(ms.webhooks[0].secret.slice(6), "base64");
    const signed = async (evt, mangle) => {
      const body = JSON.stringify(evt), id = `msg_${crypto.randomBytes(4).toString("hex")}`, ts = String(Math.floor(Date.now() / 1000));
      let sig = crypto.createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");
      if (mangle) sig = sig.replace(/^./, (c) => (c === "A" ? "B" : "A"));
      const r = await fetch(`${BASE}/api/webhooks/yoco`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, body });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const ch1 = sql("SELECT provider_reference FROM payments WHERE order_id = ?", o1.id)[0].provider_reference;
    const evt1 = { id: "evt_replay_1", type: "payment.succeeded", payload: { amount: 32000, metadata: { checkoutId: ch1 } } };
    assert.equal((await signed(evt1, true)).status, 400, "forged signature refused");
    const rep = await signed(evt1);
    assert.equal(rep.status, 200);
    assert.ok(rep.body.result === "duplicate" || rep.body.duplicate, "replayed payment changes nothing");
    assert.equal(sql("SELECT count(*) AS n FROM tickets WHERE order_id = ?", o1.id)[0].n, 2, "no extra tickets");
    const r3 = await (await g.request.post(`${BASE}/api/public/orders`, { data: { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: `cheap-${Date.now()}`, guest: { fullName: "Cheap Skate", email: "cheap@example.co.za" } } })).json();
    const ch3 = sql("SELECT provider_reference FROM payments WHERE order_id = (SELECT id FROM orders WHERE reference = ?)", r3.order.reference)[0].provider_reference;
    assert.equal((await signed({ id: "evt_cheap", type: "payment.succeeded", payload: { amount: 100, metadata: { checkoutId: ch3 } } })).body.result, "mismatch");
    assert.equal(sql("SELECT status FROM orders WHERE reference = ?", r3.order.reference)[0].status, "pending_payment", "underpaid order gets no tickets");
    const stale = await fetch(`${BASE}/api/webhooks/yoco`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "x", "webhook-timestamp": "1000", "webhook-signature": "v1,abc" }, body: "{}" });
    assert.equal(stale.status, 400, "old notification refused");
    await ledgerOk(a, "after bad notifications");
    step("forged, replayed, stale and underpaid notifications are refused or ignored; no extra tickets");

    // 7. Refund: customer care asks, finance approves, money goes back through Yoco.
    await adm.goto(`${BASE}/admin#/lookup`);
    await adm.locator("#oq").fill(o1.reference);
    await adm.locator("#oo button").click();
    await adm.getByRole("button", { name: "Refund" }).click();
    await adm.locator("dialog").getByLabel("Reason").fill("Customer can't attend, organiser agreed");
    await adm.locator("dialog").getByText("Refund the booking fee too").click();
    await adm.locator("dialog").getByRole("button", { name: "Ask finance to refund" }).click();
    await adm.getByText(/is waiting for finance/).waitFor();
    await adm.goto(`${BASE}/admin#/refunds`);
    await adm.getByRole("button", { name: "Approve", exact: true }).first().click();
    await adm.getByText(/Approved and processed/).waitFor();
    const rf = sql("SELECT * FROM refunds WHERE order_id = ?", o1.id)[0];
    assert.equal(rf.status, "completed");
    assert.equal(Number(rf.amount_cents) + Number(rf.fee_refund_cents), 32000);
    assert.equal(sql("SELECT status FROM orders WHERE id = ?", o1.id)[0].status, "refunded");
    assert.equal(sql("SELECT count(*) AS n FROM tickets WHERE order_id = ? AND status = 'refunded'", o1.id)[0].n, 2, "refunded tickets stop working");
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "state.json"), "utf8")).refunds[0].amount, 32000, "Yoco refunded R320");
    assert.match(sql("SELECT subject FROM message_outbox WHERE to_address = 'thandi@example.co.za' ORDER BY created_at DESC LIMIT 1")[0].subject, /refund/i);
    await ledgerOk(a, "after refund");
    step("refund: customer care asks, finance approves, Yoco pays back R320, tickets stop working, buyer emailed, ledger balanced");

    // 8. Organiser payout once the event is over.
    php(`q('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?', [iso_in(-10 * 86400), iso_in(-9 * 86400), '${ev.id}']);`);
    await o.put(`/api/organiser/${orgId}/bank`, { bankName: "FNB", accountHolder: "Soweto Community Arts", accountNumber: "62812345678", branchCode: "250655" });
    // FICA: no payout until the bank account is verified.
    assert.equal((await o.post(`/api/organiser/${orgId}/payouts`, { amountCents: 10000 })).body.error.code, "bank_not_verified", "payouts wait for a verified bank account");
    await verifyOrganiser(org.request, adm.request, BASE, orgId, { paid: true });
    const fin =(await o.get(`/api/organiser/${orgId}/finance`)).body;
    assert.equal(fin.availableCents, 14250, "R150 ticket less 5%");
    await org.goto(`${BASE}/organisers#/finance`);
    await org.getByRole("button", { name: "Request payout" }).click();
    await org.getByText(/Payout PO-[A-Z0-9]+ requested/).waitFor();
    assert.equal((await o.post(`/api/organiser/${orgId}/payouts`, { amountCents: 10000 })).body.error.code, "insufficient_balance", "can't ask twice");
    const po = sql("SELECT * FROM payouts WHERE organiser_id = ?", orgId)[0];
    await adm.goto(`${BASE}/admin#/payouts`);
    await adm.getByRole("button", { name: "Approve", exact: true }).click();
    await adm.getByRole("button", { name: "Show account no." }).waitFor();
    assert.equal((await a.post(`/api/admin/payouts/${po.id}/reveal-account`)).body.accountNumber, "62812345678");
    assert.equal((await a.post(`/api/admin/payouts/${po.id}/mark-paid`, { bankReference: "FNB-EFT-0001" })).status, 200);
    const fin2 = (await o.get(`/api/organiser/${orgId}/finance`)).body;
    assert.equal(fin2.totalCents, 0, "nothing more owed");
    assert.equal(fin2.payouts[0].status, "paid");
    await ledgerOk(a, "after payout");
    step("payout: organiser asks for R142.50 after the event, finance approves, sees the account once (logged), records the EFT; balance R0");

    // 9. PayFast: signed form, ITN confirmed with PayFast, manual refund.
    assert.equal((await a.put("/api/admin/integrations/payments", { currentPassword: ADMIN.password, values: { provider: "payfast", mode: "test", payfastMerchantId: "10000100", payfastMerchantKey: "46f0cd694581a", payfastPassphrase: "jt7NOE43FZPn" } })).status, 200);
    php(`q('UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?', [iso_in(2 * 3600), iso_in(6 * 3600), '${ev.id}']);`);
    const r4 = await (await g.request.post(`${BASE}/api/public/orders`, { data: { eventSlug: ev.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: `pf-${Date.now()}`, guest: { fullName: "Pieter Payfast", email: "pieter@example.co.za" } } })).json();
    assert.match(r4.payment.redirectUrl, /\/pay\?p=/);
    const u4 = new URL(r4.payment.redirectUrl, BASE);
    const form = await (await fetch(`${BASE}/api/public/payments/${u4.searchParams.get("p")}/payfast?k=${encodeURIComponent(u4.searchParams.get("k"))}`)).json();
    const enc = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+").replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const sign = (fields) => crypto.createHash("md5").update([...Object.entries(fields).filter(([k, v]) => k !== "signature" && String(v) !== "").map(([k, v]) => `${k}=${enc(v)}`), `passphrase=${enc("jt7NOE43FZPn")}`].join("&")).digest("hex");
    assert.equal(form.fields.signature, sign(form.fields), "form signed the way PayFast checks it");
    assert.equal(form.fields.amount, "160.00");
    const itn = { m_payment_id: form.fields.m_payment_id, pf_payment_id: "1089250", payment_status: "COMPLETE", item_name: form.fields.item_name, amount_gross: "160.00", amount_fee: "-4.60", amount_net: "155.40", merchant_id: "10000100" };
    const post = (f) => fetch(`${BASE}/api/webhooks/payfast`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() });
    assert.equal((await post({ ...itn, amount_gross: "1.00", signature: sign({ ...itn, amount_gross: "1.00" }).replace(/^./, "0") })).status, 400, "forged ITN refused");
    assert.equal((await post({ ...itn, signature: sign(itn) })).status, 200);
    assert.equal(sql("SELECT status FROM orders WHERE reference = ?", r4.order.reference)[0].status, "paid");
    const o4 = sql("SELECT reference FROM orders WHERE reference = ?", r4.order.reference)[0];
    assert.equal((await a.post(`/api/admin/orders/${o4.reference}/refund`, { reason: "Duplicate booking", includeFees: false })).status, 201);
    const rf4 = sql("SELECT r.id FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.reference = ?", o4.reference)[0];
    assert.equal((await a.post(`/api/admin/refunds/${rf4.id}/decide`, { approve: true })).body.refund.status, "manual_pending", "PayFast refunds are paid in the PayFast dashboard");
    assert.equal((await a.post(`/api/admin/refunds/${rf4.id}/complete-manually`, { providerReference: "PF-REFUND-77" })).body.refund.status, "completed");
    assert.equal(sql("SELECT status FROM orders WHERE reference = ?", o4.reference)[0].status, "partially_refunded", "ticket refunded, booking fee kept");
    await ledgerOk(a, "after PayFast");
    step("PayFast: signed form, forged ITN refused, real ITN confirmed with PayFast, manual refund recorded; ledger balanced");

    // 10. Reconciliation against the provider's report.
    const p2 = sql("SELECT provider_reference, amount_cents FROM payments WHERE provider = 'yoco' AND status IN ('confirmed','refunded')");
    const csv = ["reference,amount_cents,status", ...p2.map((p) => `${p.provider_reference},${p.amount_cents},succeeded`), "ch_unknown,5000,succeeded"].join("\n");
    const run = await a.post("/api/admin/reconciliation", { provider: "yoco", from: new Date(Date.now() - 864e5).toISOString(), to: new Date(Date.now() + 864e5).toISOString(), csv });
    assert.equal(run.body.run.summary.matched, p2.length);
    assert.equal(run.body.run.summary.exceptions, 1, "the unknown payment is flagged");
    step("reconciliation matches every Yoco payment and flags the one TicketRoom doesn't know");

    // 11. The finance pages open without errors.
    for (const [hash, h] of [["#/payments", "Payments & webhooks"], ["#/refunds", "Refunds"], ["#/payouts", "Payouts"], ["#/reconciliation", "Reconciliation"], ["#/ledger", "Ledger"], ["#/", "Overview"]]) {
      await adm.goto(`${BASE}/admin${hash}`); await adm.getByRole("heading", { name: h, exact: true }).first().waitFor();
    }
    for (const hash of ["#/finance", "#/refunds"]) { await org.goto(`${BASE}/organisers${hash}`); await org.locator("#main h1").first().waitFor(); }
    step("admin and organiser finance pages open cleanly");
  } finally {
    await browser.close();
    mock.kill();
    fs.writeFileSync(cfgFile, original);
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("PHP payment checks passed.");
})().catch((e) => { console.error(e); console.error(problems.join("\n")); process.exit(1); });
