// Money regression tests (TRIAGE.md M3, M5-M15 and N1) against a harness
// instance started with dev/serve.sh.
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/money.js <dir> [port]
//
// Scenarios are built in the PHP CLI through the site's own functions
// (tests/money-lib.php: orders, sandbox payments, refunds, resale), and the
// admin and organiser steps go through the HTTP API like the portals do.
// Settings a scenario needs only for itself (live mode, webhook secrets) are
// changed inside a transaction that is rolled back, so the web server never
// sees them. A small mock of Yoco's refund endpoint runs on port 8790.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { Client, outbox, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const MOCK_PORT = Number(process.env.TR_MONEY_MOCK_PORT || 8790);
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: money.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const LIB = path.join(__dirname, "money-lib.php");
const ENV = { ...process.env, no_proxy: "localhost,127.0.0.1", NO_PROXY: "localhost,127.0.0.1" };

let failures = 0;
const ok = (name, detail = "") => console.log(`PASS  ${name}${detail ? "  " + detail : ""}`);
const bad = (name, detail) => { failures++; console.log(`FAIL  ${name}  ${detail}`); };
const check = (cond, name, detail = "") => (cond ? ok(name) : bad(name, detail || "condition false"));
const js = (v) => JSON.stringify(v);

// Runs PHP with the package loaded; returns what the snippet passed to tm_out().
const prelude = (code) => `require ${js(LIB)}; tm_boot(${js(DIR)}); ${code}`;
function php(code) {
  let out;
  try { out = execFileSync("php", ["-r", prelude(code)], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`PHP failed: ${(e.stderr || "") + (e.stdout || "")}`.slice(0, 1500)); }
  const m = out.match(/@@TM@@(.*)\n?$/m);
  if (!m) throw new Error(`PHP gave no result: ${out.slice(0, 800)}`);
  return JSON.parse(m[1]);
}
// A PHP process in the background (for the races): resolves once it prints READY.
function phpBackground(code) {
  const p = spawn("php", ["-r", prelude(code)], { env: ENV });
  let out = "";
  const done = new Promise((res) => p.on("exit", (c) => res({ code: c, out })));
  const ready = new Promise((res, rej) => {
    p.stdout.on("data", (d) => { out += d; if (out.includes("READY")) res(); });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", () => rej(new Error("background PHP ended early: " + out.slice(0, 500))));
  });
  return { ready, done };
}
// TR_ONLY=M10 runs only the steps whose name contains it.
async function step(name, fn) {
  if (process.env.TR_ONLY && !name.includes(process.env.TR_ONLY)) return;
  try { await fn(); } catch (e) { bad(name, (e.message || String(e)).split("\n").slice(0, 4).join(" ")); }
}
// The error code of an API call that should be refused, or "ok".
async function refusal(promise) {
  try { await promise; return "ok"; } catch (e) { const m = e.message.match(/"code":"([^"]+)"/); return m ? m[1] : e.message.slice(0, 200); }
}

// Yoco's refund endpoint, refusing every refund (so they fail and get
// retried). It runs in its own process: the PHP calls below block this one.
const MOCK_LOG = path.join(DIR, "money-yoco-mock.jsonl");
const MOCK_SRC = `const http = require("http"), fs = require("fs");
http.createServer((req, res) => { let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
  fs.appendFileSync(process.argv[1], JSON.stringify({ method: req.method, url: req.url, idem: req.headers["idempotency-key"] || null }) + "\\n");
  res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ description: "Mock: try again later" })); }); })
  .listen(Number(process.argv[2]), "127.0.0.1", () => console.log("READY"));`;
let mock;
function startMock() {
  fs.writeFileSync(MOCK_LOG, "");
  mock = spawn(process.execPath, ["-e", MOCK_SRC, MOCK_LOG, String(MOCK_PORT)]);
  return new Promise((res, rej) => { mock.stdout.on("data", (d) => { if (String(d).includes("READY")) res(); }); mock.on("exit", () => rej(new Error("Yoco mock did not start"))); });
}
const mockCalls = () => fs.readFileSync(MOCK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const stopMock = () => { if (mock && mock.exitCode === null) mock.kill(); };

(async () => {
  await startMock();
  // Sign-in codes are limited per hour; the harness signs in often.
  php(`q("DELETE FROM rate_limits WHERE key LIKE 'staff-code-send:%' OR key LIKE 'login:%' OR key LIKE 'staff-code-verify-ip:%'"); tm_out(true);`);
  const admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);

  // ------------------------------------------------------------- M3
  await step("M3 refund closes the ticket's resale listing", async () => {
    const r = php(`$ev = tm_event(); $o = tm_buy($ev, 1); $l = tm_list($o); $t = tm_tickets($o['id'])[0];
      $rf = tx(fn() => refund_create($o, tm_admin(), [$t['id']], true, 'customer', 'Money test'));
      tm_out(['listing' => val('SELECT status FROM resale_listings WHERE id = ?', [$l['id']]), 'refund' => $rf['status']]);`);
    check(r.listing === "closed" && r.refund === "requested", "M3 refund closes the ticket's resale listing", js(r));
  });
  await step("M3 a ticket with an open refund cannot be listed", async () => {
    const r = php(`$ev = tm_event(); $o = tm_buy($ev, 1); $t = tm_tickets($o['id'])[0];
      tx(fn() => refund_create($o, tm_admin(), [$t['id']], true, 'customer', 'Money test'));
      tm_out(['list' => tm_err(fn() => tm_list($o)), 'helper' => function_exists('ticket_has_open_refund') ? ticket_has_open_refund($t['id']) : null,
        'other' => function_exists('ticket_has_open_refund') ? ticket_has_open_refund(tm_tickets(tm_buy($ev, 1)['id'])[0]['id']) : null]);`);
    check(r.list === "refund_pending" && r.helper === true && r.other === false, "M3 a ticket with an open refund cannot be listed", js(r));
  });

  // --------------------------------------- M3, M6, M7: cancelling an event
  await step("event cancel", async () => {
    const s = php(`$ev = tm_event();
      $a = tm_buy($ev, 1); $la = tm_list($a);
      $b = tm_buy($ev, 1); $lb = tm_list($b); $rb = tm_resale_order($lb['id']);
      $c = tm_buy($ev, 2); $tc = tm_tickets($c['id']); tx(fn() => refund_create($c, null, [$tc[0]['id']], false, 'customer', 'Money test'));
      $d = tm_order($ev, 2); tm_start($d);
      tm_out(['event' => $ev['id'], 'tt' => $ev['ticketTypeId'], 'la' => $la['id'], 'lb' => $lb['id'], 'rb' => $rb['id'], 'bTicket' => tm_tickets($b['id'])[0]['id'],
        'c' => $c['id'], 'cRef' => $c['reference'], 'd' => $d['id']]);`);
    const res = await admin.call("POST", `/api/admin/events/${s.event}/cancel`, { reason: "Money test: venue closed" });
    const after = php(`tm_out(['la' => val('SELECT status FROM resale_listings WHERE id = ?', [${js(s.la)}]), 'd' => val('SELECT status FROM orders WHERE id = ?', [${js(s.d)}]),
      'held' => (int) val('SELECT quantity_held FROM ticket_types WHERE id = ?', [${js(s.tt)}])]);`);
    check(after.la === "closed", "M3 event cancel closes resale listings", js(after));
    const skipped = (res.skipped || []).map((x) => x.reference);
    check(skipped.includes(s.cRef), "M6 event cancel reports orders it could not refund", js(res));
    check(after.d === "cancelled" && after.held === 0 && res.unpaidCancelled === 2, "M7 event cancel cancels unpaid orders and frees their places", js({ after, res }));
    // The held resale order and the unpaid order are paid after the cancel.
    const late = php(`$rb = tm_pay(row('SELECT * FROM orders WHERE id = ?', [${js(s.rb)}])); $d = tm_pay(row('SELECT * FROM orders WHERE id = ?', [${js(s.d)}]));
      tm_out(['rb' => $rb['status'], 'seller' => val('SELECT status FROM tickets WHERE id = ?', [${js(s.bTicket)}]), 'd' => $d['status'],
        'dTickets' => (int) val("SELECT count(*) FROM tickets WHERE order_id = ? AND status = 'valid'", [${js(s.d)}]),
        'dRefund' => val("SELECT status FROM refunds WHERE order_id = ? AND kind = 'unfulfilled'", [${js(s.d)}]),
        'rbRefund' => val("SELECT status FROM refunds WHERE order_id = ? AND kind = 'unfulfilled'", [${js(s.rb)}])]);`);
    check(late.rb === "paid_unfulfilled" && late.seller === "valid" && late.rbRefund === "completed", "M3 a resale payment after the event was cancelled is refunded", js(late));
    check(late.d === "paid_unfulfilled" && late.dTickets === 0 && late.dRefund === "completed", "M7 a payment after the event was cancelled issues no tickets and is refunded", js(late));
    // The order with a refund already on its way: once that refund is settled, the rest is raised.
    const rest = php(`$open = row("SELECT * FROM refunds WHERE order_id = ? AND status = 'requested'", [${js(s.c)}]);
      fin_decide_refund(tm_admin(), $open['id'], false, 'Money test: the cancel refund covers it');
      tm_out(['rest' => val("SELECT status FROM refunds WHERE order_id = ? AND kind = 'event_cancelled'", [${js(s.c)}])]);`);
    check(rest.rest === "requested", "M6 the rest of a skipped order is raised once its open refund is settled", js(rest));
  });

  // ------------------------------------------------------------- M5
  await step("M5 a resale order refund comes from resale clearing", async () => {
    const r = php(`$ev = tm_event(); $s = tm_buy($ev, 1); $l = tm_list($s, 12000); $ro = tm_pay(tm_resale_order($l['id']));
      $org = "organiser:{$ev['organiser_id']}:event:{$ev['id']}";
      $before = tm_balance($org); $sellers = tm_balance('resale:sellers');
      $rf = tx(fn() => refund_create($ro, tm_admin(), [], true, 'customer', 'Money test resale refund'));
      $done = refund_process($rf['id'], tm_admin());
      tm_out(['sold' => $ro['status'], 'refund' => $done['status'], 'orgDelta' => tm_balance($org) - $before, 'sellersDelta' => tm_balance('resale:sellers') - $sellers]);`);
    check(r.sold === "paid" && r.refund === "completed" && r.orgDelta === 0 && r.sellersDelta === 12000, "M5 a resale order refund comes from resale clearing, not the organiser", js(r));
  });

  // ------------------------------------------------------------- M8
  await step("M8 payouts", async () => {
    // The organiser's payout checks: proof of address and bank letter, approved.
    const org = new Client(BASE, DATA);
    await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
    php(`q("UPDATE organisers SET bank_name = 'FNB', bank_account_holder = 'Test Organiser', bank_branch_code = '250655', bank_account_last4 = '4321', bank_account_enc = ? WHERE id = ?", [encrypt_str('62004321'), ${js(SEED.organiser.orgId)}]); tm_out(true);`);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==", "base64");
    for (const req of ["proof_of_address", "bank_confirmation"]) {
      const d = await org.call("POST", `/api/organiser/${SEED.organiser.orgId}/verification/documents?requirement=${req}`, png, 201, { "content-type": "image/png", "x-file-name": `${req}.png` });
      if (d.document.status !== "approved") await admin.call("POST", `/api/admin/verification/documents/${d.document.id}/decide`, { approve: true });
    }
    // R500 owed for an event that ended two months ago, and four payouts.
    const s = php(`$org = row('SELECT * FROM organisers WHERE id = ?', [${js(SEED.organiser.orgId)}]);
      $ev = tm_event(['starts_at' => iso_in(-61 * 86400), 'ends_at' => iso_in(-60 * 86400)]);
      ledger_post('adjustment', 'MONEYTEST-' . substr($ev['id'], 0, 8), [['bank:money-test', 50000], ["organiser:{$org['id']}:event:{$ev['id']}", -50000]]);
      $mk = function (int $cents, string $status) use ($org) { $now = now_iso(); return insert('payouts', ['id' => uuid(), 'reference' => reference('PO'), 'organiser_id' => $org['id'], 'amount_cents' => $cents, 'status' => $status,
        'bank_name' => 'FNB', 'bank_account_holder' => 'Test Organiser', 'bank_account_last4' => '4321', 'bank_branch_code' => '250655', 'created_at' => $now, 'updated_at' => $now])['id']; };
      tm_out(['big' => $mk(5000000, 'requested'), 'bigApproved' => $mk(5000000, 'approved'), 'race' => $mk(10000, 'requested'), 'fine' => $mk(10000, 'requested')]);`);
    const tooBig = await refusal(admin.call("POST", `/api/admin/payouts/${s.big}/decide`, { approve: true }));
    check(tooBig === "insufficient_balance", "M8 approving a payout re-checks the organiser's balance", tooBig);
    const paidTooBig = await refusal(admin.call("POST", `/api/admin/payouts/${s.bigApproved}/mark-paid`, { bankReference: "MONEYTEST1" }));
    check(paidTooBig === "insufficient_balance", "M8 marking a payout paid re-checks the organiser's balance", paidTooBig);
    // A reject lands while the approve is on its way: the payout stays rejected.
    const lock = phpBackground(`tx(function () { q("UPDATE payouts SET status = 'rejected', note = 'Money test race' WHERE id = ?", [${js(s.race)}]); echo "READY\\n"; usleep(2000000); });`);
    await lock.ready;
    const raced = await refusal(admin.call("POST", `/api/admin/payouts/${s.race}/decide`, { approve: true }));
    await lock.done;
    const raceAfter = php(`tm_out(val('SELECT status FROM payouts WHERE id = ?', [${js(s.race)}]));`);
    check(raceAfter === "rejected" && raced === "bad_transition", "M8 a payout decision only moves a payout that is still requested", js({ raced, raceAfter }));
    // Finance turns the two oversized payouts down; then one within the balance goes through.
    php(`q("UPDATE payouts SET status = 'rejected', note = 'Money test' WHERE id IN (?, ?)", [${js(s.big)}, ${js(s.bigApproved)}]); tm_out(true);`);
    const fine = await refusal(admin.call("POST", `/api/admin/payouts/${s.fine}/decide`, { approve: true }));
    const finePaid = await refusal(admin.call("POST", `/api/admin/payouts/${s.fine}/mark-paid`, { bankReference: "MONEYTEST2" }));
    check(fine === "ok" && finePaid === "ok", "M8 a payout within the balance is approved and paid", js({ fine, finePaid }));
  });

  // ------------------------------------------------------------- M9
  await step("M9 PayFast in live mode", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      tm_go_live(); $GLOBALS['TR_CONFIG']['payments']['payfastBase'] = 'https://sandbox.payfast.co.za';
      $host = payfast_host(); $mode = pay_mode();
      integration_save('payments', ['payfastMerchantId' => '10000100', 'payfastMerchantKey' => '46f0cd694581a'], [], tm_admin()['id']); $GLOBALS['TR_INTEG_RESET'] = true;
      return ['host' => $host, 'mode' => $mode, 'sandboxMerchant' => pay_mode()];
    }));`);
    check(r.host === "https://www.payfast.co.za" && r.mode === "live", "M9 live PayFast payments never go to the sandbox host", js(r));
    check(r.sandboxMerchant === "test", "M9 PayFast's shared sandbox merchant is always test money", js(r));
  });

  // ------------------------------------------------------------- M10
  await step("M10 Promote refund retry", async () => {
    const s = php(`$GLOBALS['TR_CONFIG']['payments']['yocoApiBase'] = 'http://127.0.0.1:${MOCK_PORT}';
      integration_save('payments', ['yocoTestSecretKey' => 'sk_test_moneysuite'], [], tm_admin()['id']); $GLOBALS['TR_INTEG_RESET'] = true;
      $ev = tm_event(['status' => 'cancelled']); $now = now_iso();
      $promo = insert('event_promotions', ['id' => uuid(), 'reference' => reference('PR'), 'event_id' => $ev['id'], 'organiser_id' => $ev['organiser_id'], 'status' => 'active', 'price_cents' => 160000,
        'paid_with' => 'card', 'test' => 1, 'created_by' => tm_admin()['id'], 'paid_at' => $now, 'ends_at' => $ev['ends_at'], 'created_at' => $now, 'updated_at' => $now]);
      insert('promotion_payments', ['id' => uuid(), 'promotion_id' => $promo['id'], 'provider' => 'yoco', 'environment' => 'test', 'provider_reference' => 'ch_money_' . substr($promo['id'], 0, 8),
        'amount_cents' => 160000, 'status' => 'confirmed', 'created_at' => $now, 'updated_at' => $now, 'confirmed_at' => $now]);
      $first = promo_refund($promo, tm_admin(), 'Money test: event cancelled');
      $second = promo_refund(row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]), tm_admin(), 'Money test: retry');
      integration_save('payments', [], ['yocoTestSecretKey'], tm_admin()['id']);
      tm_out(['id' => $promo['id'], 'first' => $first['refund_status'], 'second' => $second['refund_status'], 'why' => $second['refund_failure']]);`);
    const keys = mockCalls().filter((c) => c.url.includes("/refund")).map((c) => c.idem);
    check(s.first === "failed" && s.second === "failed" && keys.length === 2 && keys[0] && keys[0] === keys[1], "M10 a retried Promote refund keeps its idempotency key", js({ s, keys }));
    const manual = await refusal(admin.call("POST", `/api/admin/promotions/${s.id}/refund/complete`, { providerReference: "YOCO-PORTAL-1" }));
    const after = php(`tm_out(val('SELECT refund_status FROM event_promotions WHERE id = ?', [${js(s.id)}]));`);
    check(manual === "ok" && after === "completed", "M10 a failed Promote refund can be recorded as paid by hand", js({ manual, after }));
  });

  // ------------------------------------------------------------- M11
  await step("M11 refund approve and reject at the same time", async () => {
    const s = php(`$ev = tm_event(); $o = tm_buy($ev, 2); $t = tm_tickets($o['id'])[0];
      $rf = tx(fn() => refund_create($o, null, [$t['id']], false, 'customer', 'Money test race'));
      tm_out(['refund' => $rf['id'], 'ticket' => $t['id'], 'finance' => tm_finance()['id'], 'admin' => tm_admin()['id']]);`);
    const lock = phpBackground(`tx(function () { fin_decide_refund(tm_finance(), ${js(s.refund)}, false, 'Money test: no'); echo "READY\\n"; usleep(2000000); });`);
    await lock.ready;
    const approve = php(`tm_out(tm_err(fn() => fin_decide_refund(tm_admin(), ${js(s.refund)}, true, null)));`);
    await lock.done;
    const r = php(`tm_out(['refund' => row('SELECT status, decided_by FROM refunds WHERE id = ?', [${js(s.refund)}]), 'ticket' => val('SELECT status FROM tickets WHERE id = ?', [${js(s.ticket)}])]);`);
    check(approve === "bad_transition" && r.refund.status === "rejected" && r.refund.decided_by === s.finance && r.ticket === "valid", "M11 a refund rejected first is not approved too", js({ approve, r }));
  });

  // ------------------------------------------------------------- M12
  await step("M12 discount rounding", async () => {
    const r = php(`$ev = tm_event(['_price' => 10000]); $o = tm_order($ev, 3);
      q('UPDATE orders SET discount_cents = 1000, total_cents = total_cents - 1000 WHERE id = ?', [$o['id']]);
      tm_start($o); $o = tm_pay($o); $sum = 0;
      foreach (tm_tickets($o['id']) as $t) {
        $cur = row('SELECT * FROM orders WHERE id = ?', [$o['id']]);
        $rf = tx(fn() => refund_create($cur, null, [$t['id']], false, 'customer', 'Money test'));
        refund_process($rf['id']); $sum += (int) $rf['amount_cents'];
      }
      tm_out(['net' => (int) $o['subtotal_cents'] - (int) $o['discount_cents'], 'refunded' => $sum]);`);
    check(r.refunded === r.net, "M12 per-ticket refunds of a discounted order add up to what was paid", js(r));
  });

  // ------------------------------------------------------------- M13
  await step("M13 practice money at a live stall", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      $ev = tm_event(['cashless_enabled' => 1]); $buyer = tm_buyer(); $a = tm_admin(); $now = now_iso();
      $v = insert('vendors', ['id' => uuid(), 'event_id' => $ev['id'], 'organiser_id' => $ev['organiser_id'], 'name' => 'Money test bar', 'status' => 'active', 'commission_bps' => 0, 'created_at' => $now, 'updated_at' => $now]);
      $p = insert('products', ['id' => uuid(), 'vendor_id' => $v['id'], 'name' => 'Lemonade', 'price_cents' => 5000, 'active' => 1, 'created_at' => $now, 'updated_at' => $now]);
      $t = insert('terminals', ['id' => uuid(), 'vendor_id' => $v['id'], 'event_id' => $ev['id'], 'label' => 'Till 1', 'key_hash' => bin2hex(random_bytes(16)), 'status' => 'active', 'registered_by' => $a['id'], 'created_at' => $now]);
      $code = random_code(8);
      insert('tags', ['id' => uuid(), 'tag_type' => 'qr_tag', 'token_hash' => bin2hex(random_bytes(16)), 'display_code' => $code, 'security_level' => 'random_token', 'event_id' => $ev['id'], 'user_id' => $buyer['id'], 'status' => 'active', 'created_at' => $now, 'updated_at' => $now]);
      wallet_credit($buyer['id'], $ev['id'], 20000, true);
      tm_go_live();
      $term = ['id' => $t['id'], 'vendor_id' => $v['id'], 'event_id' => $ev['id'], 'cashless_enabled' => 1, 'event_status' => 'published', 'commission_bps' => 0, 'organiser_id' => $ev['organiser_id'],
        'vendor' => ['id' => $v['id'], 'event_id' => $ev['id'], 'commission_bps' => 0, 'organiser_id' => $ev['organiser_id']]];
      $s = pos_charge($a, $term, ['items' => [['productId' => $p['id'], 'quantity' => 1]], 'tagInput' => tag_display($code), 'idempotencyKey' => uuid()]);
      return ['sale' => $s, 'testLeft' => (int) wallet_get($buyer['id'], $ev['id'])['test_balance_cents']];
    }));`);
    const status = r.sale.status, reason = r.sale.declineReason || r.sale.decline_reason || r.sale.reason;
    check(status === "declined" && r.testLeft === 20000, "M13 practice (TEST) wristband money cannot buy at a stall once payments are live", js({ status, reason, testLeft: r.testLeft }));
  });
  await step("M13 large cash-outs at the desk", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      $ev = tm_event(); $buyer = tm_buyer(); $a = tm_admin();
      cashless_event_settings_save($a, $ev, ['cashoutDeskOpen' => true, 'deskDailyCapCents' => 100000]);
      $mk = function (int $cents) use ($ev, $buyer) { $code = random_code(8); $now = now_iso();
        insert('wallet_cashouts', ['id' => uuid(), 'reference' => reference('CO'), 'event_id' => $ev['id'], 'user_id' => $buyer['id'], 'method' => 'cash', 'amount_cents' => $cents, 'fee_cents' => 0,
          'test' => 0, 'status' => 'requested', 'code_hash' => cashout_code_hash($code), 'code_enc' => encrypt_str($code), 'created_at' => $now, 'updated_at' => $now]); return $code; };
      $acc = ['event' => row('SELECT * FROM events WHERE id = ?', [$ev['id']]), 'kind' => 'staff', 'manager' => true];
      $big = tm_err(fn() => cashout_desk_pay($a, $acc, $mk(250000)));
      $one = tm_err(fn() => cashout_desk_pay($a, $acc, $mk(60000)));
      $two = tm_err(fn() => cashout_desk_pay($a, $acc, $mk(60000)));
      return ['big' => $big, 'one' => $one, 'two' => $two];
    }));`);
    check(r.big === "cashout_too_large", "M13 a large cash-out is not paid in cash at the desk", js(r));
    check(r.one === "none" && r.two === "desk_cashout_cap", "M13 cash paid out at one desk stops at its daily limit", js(r));
  });
  await step("M13 PayFast payments with no notification", async () => {
    const s = php(`$ev = tm_event(); $o = tm_order($ev, 1); $now = now_iso(); $old = iso_in(-2 * 3600);
      $p = insert('payments', ['id' => uuid(), 'order_id' => $o['id'], 'provider' => 'payfast', 'environment' => 'test', 'amount_cents' => (int) $o['total_cents'], 'status' => 'pending', 'created_at' => $old, 'updated_at' => $old]);
      q('UPDATE payments SET provider_reference = id WHERE id = ?', [$p['id']]);
      tm_out($p['id']);`);
    const list = await admin.call("GET", "/api/admin/payments");
    const st = (list.stale || []).find((p) => p.id === s);
    php(`q("UPDATE payments SET status = 'cancelled' WHERE id = ?", [${js(s)}]); tm_out(true);`);
    check(st && /PayFast/.test(st.what_to_do || ""), "M13 a PayFast payment with no notification is listed with what to do", js(st || Object.keys(list)));
  });
  await step("M13 refunds made in the Yoco portal", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      $raw = random_bytes(24); integration_save('payments', ['yocoTestWebhookSecret' => 'whsec_' . base64_encode($raw)], [], tm_admin()['id']); $GLOBALS['TR_INTEG_RESET'] = true;
      $ev = tm_event(); $o = tm_buy($ev, 1);
      q("UPDATE payments SET provider = 'yoco', provider_reference = 'ch_money_portal' WHERE order_id = ?", [$o['id']]);
      $body = json_encode(['id' => 'evt_' . bin2hex(random_bytes(6)), 'type' => 'refund.succeeded', 'payload' => ['id' => 'rf_portal_1', 'refundId' => 'rf_portal_1', 'amount' => 5000, 'currency' => 'ZAR', 'mode' => 'test',
        'metadata' => ['checkoutId' => 'ch_money_portal']]]);
      $id = 'msg_' . bin2hex(random_bytes(6)); $ts = time();
      $sig = base64_encode(hash_hmac('sha256', "$id.$ts.$body", $raw, true));
      $res = payment_webhook('yoco', $body, ['webhook-id' => $id, 'webhook-timestamp' => (string) $ts, 'webhook-signature' => "v1,$sig"]);
      return ['result' => $res['result'] ?? null, 'kinds' => array_values(array_unique(array_column(ledger_check()['exceptions'] ?? [], 'kind')))];
    }));`);
    check(r.result === "refund_unmatched" && r.kinds.includes("provider_refund"), "M13 a refund made in the Yoco portal is recorded for finance", js(r));
  });

  // ------------------------------------------------------------- M14
  await step("M14 practice money once payments are live", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      $ev = tm_event(); $buyer = tm_buyer(); $a = tm_admin(); $now = now_iso();
      cashless_event_settings_save($a, $ev, ['cashoutDeskOpen' => true]);
      $eft = insert('wallet_cashouts', ['id' => uuid(), 'reference' => reference('CO'), 'event_id' => $ev['id'], 'user_id' => $buyer['id'], 'method' => 'eft', 'amount_cents' => 5000, 'fee_cents' => 0, 'test' => 1, 'status' => 'requested',
        'bank_account_holder' => 'Money Tester', 'bank_name' => 'FNB', 'bank_branch_code' => '250655', 'bank_account_enc' => encrypt_str('62001111'), 'bank_account_last4' => '1111', 'created_at' => $now, 'updated_at' => $now]);
      $code = random_code(8);
      insert('wallet_cashouts', ['id' => uuid(), 'reference' => reference('CO'), 'event_id' => $ev['id'], 'user_id' => $buyer['id'], 'method' => 'cash', 'amount_cents' => 5000, 'fee_cents' => 0, 'test' => 1, 'status' => 'requested',
        'code_hash' => cashout_code_hash($code), 'code_enc' => encrypt_str($code), 'created_at' => $now, 'updated_at' => $now]);
      $promo = insert('event_promotions', ['id' => uuid(), 'reference' => reference('PR'), 'event_id' => $ev['id'], 'organiser_id' => $ev['organiser_id'], 'status' => 'active', 'price_cents' => 160000,
        'paid_with' => 'card', 'test' => 1, 'created_by' => $a['id'], 'paid_at' => $now, 'ends_at' => $ev['ends_at'], 'created_at' => $now, 'updated_at' => $now]);
      $promoBefore = promo_active($ev['id']) !== null;
      tm_go_live();
      return ['decide' => tm_err(fn() => cashout_decide($a, $eft['id'], true, null)),
        'desk' => tm_err(fn() => cashout_desk_pay($a, ['event' => row('SELECT * FROM events WHERE id = ?', [$ev['id']]), 'kind' => 'staff', 'manager' => true], $code)),
        'promoBefore' => $promoBefore, 'promoAfter' => promo_active($ev['id']) !== null];
    }));`);
    check(r.decide === "test_money" && r.desk === "test_money", "M14 practice cash-outs are not paid once payments are live", js(r));
    check(r.promoBefore === true && r.promoAfter === false, "M14 a TEST Promote package stops counting once payments are live", js(r));
  });

  // ------------------------------------------------------------- M15
  await step("M15 reconciliation", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      $ev = tm_event(); $org = $ev['organiser_id']; $now = now_iso();
      $o = tm_order($ev, 1); q("UPDATE orders SET test = 0, status = 'refunded', refunded_cents = total_cents + 100 WHERE id = ?", [$o['id']]);
      $o2 = tm_order($ev, 1); q("UPDATE orders SET test = 0, status = 'paid' WHERE id = ?", [$o2['id']]);
      foreach ([1, 2] as $i) insert('payments', ['id' => uuid(), 'order_id' => $o2['id'], 'provider' => 'payfast', 'environment' => 'live', 'provider_reference' => "pf-money-$i-" . substr($o2['id'], 0, 6),
        'amount_cents' => (int) $o2['total_cents'], 'status' => 'confirmed', 'created_at' => $now, 'updated_at' => $now, 'confirmed_at' => $now]);
      ledger_post('desk_topup', 'MT-DT-' . substr($ev['id'], 0, 6), [["organiser:$org:event:{$ev['id']}:desk_cash", 3000000], ["wallet:money:{$ev['id']}", -3000000]]);
      $v = insert('vendors', ['id' => uuid(), 'event_id' => $ev['id'], 'organiser_id' => $org, 'name' => 'Money test stall', 'status' => 'active', 'commission_bps' => 0, 'created_at' => $now, 'updated_at' => $now]);
      insert('payouts', ['id' => uuid(), 'reference' => reference('PO'), 'organiser_id' => $org, 'vendor_id' => $v['id'], 'amount_cents' => 20000, 'status' => 'paid', 'created_at' => $now, 'updated_at' => $now, 'paid_at' => $now]);
      $c = ledger_check();
      return ['balanced' => $c['balanced'], 'kinds' => array_values(array_unique(array_column($c['exceptions'] ?? [], 'kind'))), 'refs' => array_column($c['exceptions'] ?? [], 'reference'),
        'o' => $o['reference'], 'o2' => $o2['reference']];
    }));`);
    for (const k of ["paid_twice", "over_refunded", "organiser_negative", "desk_not_netted"]) check(r.kinds.includes(k), `M15 reconciliation finds ${k.replace(/_/g, " ")}`, js(r));
    check(r.balanced === false && r.refs.includes(r.o) && r.refs.includes(r.o2), "M15 those findings mark the books as not balanced and name the orders", js(r));
    const clean = await admin.call("GET", "/api/admin/reconciliation");
    check(Array.isArray(clean.ledger.exceptions), "M15 the reconciliation page gets the findings", js(Object.keys(clean.ledger)));
  });

  // ------------------------------------------------------------- N1
  await step("N1 saved image of a test ticket", async () => {
    const { chromium } = require("playwright");
    const code = php(`$c = row('SELECT * FROM users WHERE email = ?', [${js(SEED.customer.email)}]); $ev = tm_event();
      $o = tm_buy($ev, 1, exchange_buyer($c)); tm_out(tm_tickets($o['id'])[0]['code']);`);
    const cust = new Client(BASE, DATA);
    await cust.login(SEED.customer.email, SEED.customer.password, "customer");
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
      await ctx.addCookies(Object.entries(cust.cookies).map(([name, value]) => ({ name, value, url: BASE })));
      await ctx.addInitScript(() => {
        window.__drawn = [];
        const fill = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (t, ...rest) { window.__drawn.push(String(t)); return fill.call(this, t, ...rest); };
      });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/account#/tickets`, { waitUntil: "networkidle" });
      const btn = p.locator(`[data-wallet][data-code="${code}"] [data-img]`);
      await btn.waitFor({ timeout: 15000 });
      const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 15000 }), btn.click()]);
      await dl.cancel().catch(() => {});
      const drawn = await p.evaluate(() => window.__drawn);
      check(drawn.some((t) => /TEST TICKET/.test(t)) && drawn.some((t) => /not valid for entry/i.test(t)), "N1 the saved image of a test ticket is marked TEST", js(drawn.filter((t) => t.length > 3).slice(0, 12)));
    } finally { await browser.close(); }
  });

  // ------------------------------------------------- M14: going live (last)
  await step("M14 switching payments to live", async () => {
    php(`tm_buy(tm_event(), 1); tm_out(true);`);
    const before = php(`tm_out((int) val("SELECT count(*) FROM orders WHERE test = 1 AND status <> 'cancelled'"));`);
    let res;
    try {
      res = await admin.call("PUT", "/api/admin/integrations/payments", { currentPassword: ADMIN_PW, values: { provider: "payfast", mode: "live", payfastMerchantId: "19876543", payfastMerchantKey: "tmlivemerchant01" } });
      const after = php(`tm_out(['orders' => (int) val("SELECT count(*) FROM orders WHERE test = 1 AND status <> 'cancelled'"), 'audit' => (int) val("SELECT count(*) FROM audit_log WHERE action = 'payments.went_live'")]);`);
      check(before > 0 && after.orders === 0 && after.audit === 1 && /Test orders were cleared/.test(res.notice || ""), "M14 switching payments to live clears test orders first", js({ before, after, notice: res.notice }));
    } finally {
      await admin.call("PUT", "/api/admin/integrations/payments", { currentPassword: ADMIN_PW, values: { mode: "test" } });
      await admin.call("POST", "/api/admin/integrations/payments/sandbox", { currentPassword: ADMIN_PW, kind: "ticketroom" });
    }
  });

  stopMock();
  console.log(failures ? `\nmoney: ${failures} failed` : "\nmoney: all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || String(e)); stopMock(); process.exit(1); });
