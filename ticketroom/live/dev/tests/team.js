// Event teams and Team activity. Against a local instance from dev/serve.sh:
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/team.js <dir> [port]
//
// TM1 a TicketRoom admin adds, changes and removes event staff with every
// permission combination (same rules, invites and emails as the organiser,
// audited as TicketRoom, shown to the organiser as Added by TicketRoom; staff
// accounts refused). TM2 the API enforces each permission. TM3 support cannot
// manage teams. TM4 scans (every refusal reason, offline scans synced later by
// someone else), wristbands, top-ups with an undo, a cash-out and box office
// sales all show in Team activity against the right person, with totals that
// match the desk cash-up and the box office shifts. TM5 each person's
// timeline filters by type and time. TM6 the CSV matches the view and is
// audited. TM7 another organisation (and event staff) cannot see it.
// TM8 the admin and organiser pages show it, phone and desktop.
// TR_ONLY=TM4 runs the tests whose name starts with that.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { Client, outbox, sql, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: team.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).split("\n")[0].slice(0, 500)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const js = (v) => JSON.stringify(v);
const one = (q, p = []) => sql(DATA, q, p)[0];
const count = (q, p = []) => Number(Object.values(one(q, p))[0]);
const stamp = Date.now().toString(36);
const uuid = () => crypto.randomUUID();
const PRELUDE = `error_reporting(E_ALL); require $argv[1] . '/public_html/api/bootstrap.php'; tr_load(); tr_load_routes();
function out($v) { echo json_encode($v, JSON_UNESCAPED_SLASHES); }
`;
const php = (code, ...args) => { const o = execFileSync("php", ["-r", PRELUDE + code, DIR, ...args.map(String)], { encoding: "utf8" }); try { return JSON.parse(o || "null"); } catch { return o; } };
const refuses = async (p, status, label) => { try { await p; } catch (e) { assert(new RegExp(`-> ${status}\\b`).test(e.message), `${label}: ${e.message}`); return; } throw new Error(`${label}: was allowed`); };

async function signUp(email, name) {
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/register", { fullName: name, email, password: `Tst-${crypto.randomBytes(12).toString("base64url")}`, marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  c.me = (await c.refreshCsrf()).user;
  return c;
}
const book = (c, slug, ttId, qty = 1) => c.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: ttId, quantity: qty }], idempotencyKey: uuid() });
const codes = (email, eventId) => sql(DATA, "SELECT t.id, t.code FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.buyer_email = ? AND t.event_id = ? ORDER BY t.created_at, t.id", [email, eventId]);
const rand = (c) => (c / 100).toFixed(2);
// The server keeps times to the millisecond, rounding down.
const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 2;
function parseCsv(text) {
  const rows = [];
  for (const line of text.trim().split("\n")) {
    const cells = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur); rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
async function rawGet(c, p) {
  const res = await fetch(BASE + p, { headers: { cookie: c.cookieHeader() } });
  assert(res.status === 200, `${p} -> ${res.status}`);
  return { text: await res.text(), type: res.headers.get("content-type") || "" };
}

(async () => {
  const ORG = SEED.organiser.orgId;
  const admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const org = new Client(BASE, DATA);
  await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");

  // A cashless event of the seed organiser, starting soon (the gate is open),
  // with a free ticket and a R150 door ticket.
  const E = php(`
    $src = row('SELECT * FROM events WHERE id = ?', [$argv[2]]);
    $ev = $src; $ev['id'] = uuid(); $ev['slug'] = 'team-night-' . strtolower(random_code(6)); $ev['ref'] = new_ref('events'); $ev['title'] = 'Team Night';
    $ev['is_free'] = 0; $ev['cashless_enabled'] = 1; $ev['created_at'] = $ev['updated_at'] = now_iso();
    insert('events', $ev);
    $tt = row('SELECT * FROM ticket_types WHERE event_id = ? LIMIT 1', [$src['id']]);
    $free = $tt; $free['id'] = uuid(); $free['event_id'] = $ev['id']; $free['quantity_sold'] = 0; $free['quantity_held'] = 0; $free['per_order_limit'] = 10; $free['quantity_total'] = 500; insert('ticket_types', $free);
    $paid = $free; $paid['id'] = uuid(); $paid['name'] = 'Door ticket'; $paid['price_cents'] = 15000; insert('ticket_types', $paid);
    out(['id' => $ev['id'], 'slug' => $ev['slug'], 'free' => $free['id'], 'paid' => $paid['id']]);`, SEED.events.free.id);
  const oBase = `/api/organiser/${ORG}/events/${E.id}`;
  const aBase = `/api/admin/events/${E.id}`;

  // The team: S scans, D runs the wristband desk, B the box office, A all three.
  const S = await signUp(`scan+${stamp}@example.test`, "Sipho Scanner");
  const D = await signUp(`desk+${stamp}@example.test`, "Dineo Desk");
  const B = await signUp(`box+${stamp}@example.test`, "Bongani Box");
  const A = await signUp(`all+${stamp}@example.test`, "Ayanda Allrounder");
  // Support staff account.
  const supportEmail = `support+${stamp}@example.test`;
  const supportPw = `Tst-${crypto.randomBytes(12).toString("base64url")}`;
  await admin.call("POST", "/api/admin/staff", { email: supportEmail, fullName: "Sam Support", roles: ["support"] });
  php(`q('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?', [hash_secret($argv[2]), now_iso(), $argv[3]]);`, supportPw, supportEmail);
  const support = new Client(BASE, DATA);
  await support.staffLogin(supportEmail, supportPw);

  await test("TM1 admin adds, changes and removes event staff with each permission combination; invites, emails and audit as TicketRoom", async () => {
    const combos = [];
    for (const canScan of [true, false]) for (const canManageTags of [true, false]) for (const canSellTickets of [true, false]) combos.push({ canScan, canManageTags, canSellTickets });
    const auditsBefore = count("SELECT count(*) FROM audit_log WHERE action IN ('event.staff_set','event.staff_removed') AND json_extract(details, '$.by') = 'ticketroom'");
    for (const [i, p] of combos.entries()) {
      const email = `combo${i}+${stamp}@example.test`;
      const r = await admin.call("POST", `${aBase}/staff`, { email, fullName: `Combo Person ${i}`, ...p }, 201);
      assert(r.invited === true && r.updated === false, `add ${i} ${js(r)}`);
      const row = one("SELECT s.can_scan, s.can_manage_tags, s.can_sell_tickets FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = ? AND u.email = ?", [E.id, email]);
      assert(row && !!row.can_scan === p.canScan && !!row.can_manage_tags === p.canManageTags && !!row.can_sell_tickets === p.canSellTickets, `row ${i} ${js(row)} vs ${js(p)}`);
      outbox(DATA, email, /#\/reset\/[A-Za-z0-9_-]+/); // the organiser's staffInvite email, with a set-password link
      // Change to the opposite permissions.
      const flip = { canScan: !p.canScan, canManageTags: !p.canManageTags, canSellTickets: !p.canSellTickets };
      const u = await admin.call("POST", `${aBase}/staff`, { email, ...flip }, 201);
      assert(u.updated === true && u.invited === false, `change ${i} ${js(u)}`);
      const row2 = one("SELECT s.can_scan, s.can_manage_tags, s.can_sell_tickets FROM event_staff s WHERE s.event_id = ? AND s.user_id = ?", [E.id, r.userId]);
      assert(!!row2.can_scan === flip.canScan && !!row2.can_manage_tags === flip.canManageTags && !!row2.can_sell_tickets === flip.canSellTickets, `changed ${i} ${js(row2)}`);
      const last = one("SELECT actor_role, details FROM audit_log WHERE action = 'event.staff_set' AND entity_id = ? ORDER BY id DESC LIMIT 1", [r.userId]);
      const d = JSON.parse(last.details);
      assert(last.actor_role === "admin" && d.by === "ticketroom" && d.change === "updated" && d.before.canScan === p.canScan && d.canScan === flip.canScan, `audit ${js(last)}`);
      await admin.call("DELETE", `${aBase}/staff/${r.userId}`);
      assert(!one("SELECT 1 AS x FROM event_staff WHERE event_id = ? AND user_id = ?", [E.id, r.userId]), `removed ${i}`);
      const rm = one("SELECT actor_role, organiser_id, details FROM audit_log WHERE action = 'event.staff_removed' AND entity_id = ? ORDER BY id DESC LIMIT 1", [r.userId]);
      assert(rm && rm.actor_role === "admin" && rm.organiser_id === ORG && JSON.parse(rm.details).by === "ticketroom" && JSON.parse(rm.details).removed === true, `remove audit ${js(rm)}`);
    }
    assert(count("SELECT count(*) FROM audit_log WHERE action IN ('event.staff_set','event.staff_removed') AND json_extract(details, '$.by') = 'ticketroom'") - auditsBefore === 24, "24 audited changes by TicketRoom");
    // The real team: S, D and B by the admin (people with accounts get the staffAdded email), A by the organiser.
    const since = new Date(Date.now() - 1000).toISOString();
    await admin.call("POST", `${aBase}/staff`, { email: S.me.email, canScan: true }, 201);
    await admin.call("POST", `${aBase}/staff`, { email: D.me.email, canScan: false, canManageTags: true }, 201);
    await admin.call("POST", `${aBase}/staff`, { email: B.me.email, canScan: false, canSellTickets: true }, 201);
    outbox(DATA, S.me.email, /Team Night/, { after: since });
    await org.call("POST", `${oBase}/staff`, { email: A.me.email, canScan: true, canManageTags: true, canSellTickets: true }, 201);
    const orgAudit = one("SELECT actor_role, details FROM audit_log WHERE action = 'event.staff_set' AND entity_id = ? ORDER BY id DESC LIMIT 1", [A.me.id]);
    assert(JSON.parse(orgAudit.details).by === "organiser", `organiser audit ${js(orgAudit)}`);
    // The organiser sees who TicketRoom added.
    const { staff } = await org.call("GET", `${oBase}/staff`);
    const by = Object.fromEntries(staff.map((s) => [s.email, s.added_by_ticketroom]));
    assert(by[S.me.email] === 1 && by[D.me.email] === 1 && by[A.me.email] === 0, `added by ${js(by)}`);
    // An organiser changing someone TicketRoom added keeps the mark.
    await org.call("POST", `${oBase}/staff`, { email: S.me.email, canScan: true, canManageTags: false }, 201);
    assert((await org.call("GET", `${oBase}/staff`)).staff.find((s) => s.email === S.me.email).added_by_ticketroom === 1, "mark kept after an organiser change");
    // Staff accounts still cannot be added as scanners, from either portal.
    await refuses(admin.call("POST", `${aBase}/staff`, { email: ADMIN_EMAIL }), 409, "admin adds the owner");
    await refuses(admin.call("POST", `${aBase}/staff`, { email: supportEmail }), 409, "admin adds support");
    await refuses(org.call("POST", `${oBase}/staff`, { email: supportEmail }), 409, "organiser adds support");
  });

  await test("TM2 permissions are enforced at the API (scan, wristbands and top-ups, box office)", async () => {
    await refuses(D.call("POST", "/api/staff/scan", { eventId: E.id, payload: "ABCD-EFGH" }), 404, "scan without canScan");
    await refuses(B.call("POST", "/api/staff/scan", { eventId: E.id, payload: "ABCD-EFGH" }), 404, "box office person scanning");
    await refuses(S.call("POST", `/api/cashdesk/events/${E.id}/topups`, { userId: S.me.id, amountCents: 5000, method: "cash", idempotencyKey: uuid() }), 404, "top-up without canManageTags");
    await refuses(S.call("POST", "/api/staff/tags/link", { eventId: E.id, tagInput: "UID:04AABBCCDDEEFF", ticketPayload: "ABCD-EFGH" }), 404, "tag link without canManageTags");
    await refuses(B.call("POST", `/api/cashdesk/events/${E.id}/topups`, { userId: S.me.id, amountCents: 5000, method: "cash", idempotencyKey: uuid() }), 404, "box office person topping up");
    await refuses(S.call("POST", `/api/staff/events/${E.id}/door-shifts`, { openingFloatCents: 0 }), 404, "shift without canSellTickets");
    await refuses(D.call("POST", `/api/staff/events/${E.id}/door-orders`, { items: [{ ticketTypeId: E.paid, quantity: 1 }], idempotencyKey: uuid(), tenderMethod: "cash", buyer: { fullName: "Door Buyer", email: `door+${stamp}@example.test` } }), 404, "box office sale without canSellTickets");
  });

  await test("TM3 the support role cannot manage or see event teams", async () => {
    await refuses(support.call("POST", `${aBase}/staff`, { email: `nope+${stamp}@example.test` }), 403, "support adds");
    await refuses(support.call("DELETE", `${aBase}/staff/${S.me.id}`), 403, "support removes");
    await refuses(support.call("GET", `${aBase}/team`), 403, "support team list");
    await refuses(support.call("GET", `${aBase}/team-activity`), 403, "support activity");
    assert(one("SELECT 1 AS x FROM event_staff WHERE event_id = ? AND user_id = ?", [E.id, S.me.id]), "S still on the team");
  });

  // ---- the night's work ----
  const C1 = await signUp(`fan+${stamp}@example.test`, "Fiona Fan");
  const C2 = await signUp(`guest+${stamp}@example.test`, "Gugu Guest");
  await book(C1, E.slug, E.free, 6);
  await book(C2, E.slug, E.free, 1);
  const otherTt = one("SELECT id FROM ticket_types WHERE event_id = ? LIMIT 1", [SEED.events.free.id]).id;
  await book(C1, SEED.events.free.slug, otherTt, 1);
  const T = codes(C1.me.email, E.id);
  const W = codes(C1.me.email, SEED.events.free.id)[0];
  const G = codes(C2.me.email, E.id)[0];
  const tenMin = new Date(Date.now() - 10 * 60000).toISOString();
  const fiveMin = new Date(Date.now() - 5 * 60000).toISOString();
  const twoMin = new Date(Date.now() - 2 * 60000).toISOString();
  const nineMin = new Date(Date.now() - 9 * 60000).toISOString();
  const box = {};
  let cashoutCents = 0;

  await test("TM4 every action type shows in Team activity against the right person, with matching totals", async () => {
    // Scans by S: admit, already scanned, not valid, wrong event, replaced, refund in progress.
    const scan = (payload) => S.call("POST", "/api/staff/scan", { eventId: E.id, payload, gate: "Main gate" });
    assert((await scan(T[0].code)).outcome === "admitted", "admit");
    assert((await scan(T[0].code)).outcome === "already_used", "already");
    assert((await scan("NOT-A-TICKET")).outcome === "invalid", "not valid");
    assert((await scan(W.code)).outcome === "wrong_event", "wrong event");
    php(`$t = row('SELECT * FROM tickets WHERE id = ?', [$argv[2]]); tx(fn() => replace_ticket_code($t, 'reissue'));`, T[1].id);
    assert((await scan(T[1].code)).outcome === "replaced", "replaced");
    php(`$t = row('SELECT * FROM tickets WHERE id = ?', [$argv[2]]); $now = now_iso();
      insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => $t['order_id'], 'amount_cents' => 100, 'fee_refund_cents' => 0, 'kind' => 'customer', 'reason' => 'Team test',
        'ticket_ids' => json_encode([$t['id']]), 'status' => 'requested', 'created_at' => $now, 'updated_at' => $now, 'event_id' => $t['event_id']]);`, T[2].id);
    assert((await scan(T[2].code)).outcome === "refund_pending", "refund pending");
    // Offline scans, sent later from A's phone: one S made (stays S's), one by B
    // (not a scanner, so it is A's) and one of A's own.
    const sync = await A.call("POST", "/api/staff/scan/sync", { eventId: E.id, scans: [
      { id: "o1", payload: T[3].code, gate: "North gate", at: tenMin, by: S.me.id },
      { id: "o2", payload: T[4].code, at: fiveMin, by: B.me.id },
      { id: "o3", payload: T[5].code, at: twoMin }] });
    assert(sync.results.every((r) => r.outcome === "admitted"), `sync ${js(sync)}`);
    const o1 = one("SELECT a.scanned_by, a.synced_by, a.offline, a.occurred_at, a.gate, a.synced_at FROM admission_log a WHERE a.ticket_id = ?", [T[3].id]);
    assert(o1.scanned_by === S.me.id && o1.synced_by === A.me.id && o1.offline === 1 && near(o1.occurred_at, tenMin) && o1.gate === "North gate (offline)" && o1.synced_at, `offline row ${js(o1)}`);
    assert(one("SELECT admitted_by FROM tickets WHERE id = ?", [T[3].id]).admitted_by === S.me.id, "ticket admitted_by keeps the scanner");
    assert(one("SELECT scanned_by FROM admission_log WHERE ticket_id = ?", [T[4].id]).scanned_by === A.me.id, "a non-scanner's queued scan is the sender's");

    // Wristbands by D: link, replace, block.
    const uid1 = `UID:${crypto.randomBytes(7).toString("hex")}`, uid2 = `UID:${crypto.randomBytes(7).toString("hex")}`;
    const linked = await D.call("POST", "/api/staff/tags/link", { eventId: E.id, tagInput: uid1, ticketPayload: G.code }, 201);
    const rep = await D.call("POST", "/api/staff/tags/replace", { eventId: E.id, oldTagId: linked.tagId, newTagInput: uid2 });
    await D.call("POST", `/api/staff/tags/${rep.newTagId}/block`, { eventId: E.id, reason: "Guest lost it" });
    // Top-ups by D: R50 cash, R20 card, R10 cash undone.
    const top = (amountCents, method) => D.call("POST", `/api/cashdesk/events/${E.id}/topups`, { userId: C2.me.id, amountCents, method, idempotencyKey: uuid(), receipt: false }, 201);
    await top(5000, "cash"); await top(2000, "card");
    const t3 = await top(1000, "cash");
    await D.call("POST", `/api/cashdesk/events/${E.id}/topups/${t3.topup.reference}/undo`, {});
    // A cash-out paid by D.
    await org.call("PUT", `${oBase}/cashdesk`, { cashoutDeskOpen: true });
    const co = await C2.call("POST", `/api/me/wallets/${E.id}/cashout`, { method: "cash" }, 201);
    const paid = await D.call("POST", `/api/cashdesk/events/${E.id}/cashouts/pay`, { code: co.cashout.code });
    cashoutCents = paid.cashout.amountCents;
    assert(cashoutCents === 7000, `cash-out ${js(paid)}`);

    // Box office by B: a cash sale of two tickets and a card sale of one.
    await B.call("POST", `/api/staff/events/${E.id}/door-shifts`, { openingFloatCents: 10000 }, 201);
    const sell = async (qty, tenderMethod, tender) => {
      const o = await B.call("POST", `/api/staff/events/${E.id}/door-orders`, { items: [{ ticketTypeId: E.paid, quantity: qty }], idempotencyKey: uuid(), tenderMethod, buyer: { fullName: "Door Buyer", email: `door${qty}+${stamp}@example.test` } }, 201);
      const t = await B.call("POST", `/api/staff/events/${E.id}/door-orders/${o.order.reference}/tender`, tender(o.order.totalCents));
      return t.tender.amountCents;
    };
    box.cash = await sell(2, "cash", (c) => ({ cashReceivedCents: c + 1000 }));
    box.card = await sell(1, "external_card", () => ({ externalReference: `POS-${stamp}` }));
    const shift = (await B.call("GET", `/api/staff/events/${E.id}/door-shifts/current`)).shift;
    await B.call("POST", `/api/staff/events/${E.id}/door-shifts/${shift.id}/close`, { countedCashCents: 10000 + box.cash, countedCardCents: box.card });

    for (const [who, c] of [["organiser", org], ["admin", admin]]) {
      const a = await c.call("GET", `${who === "admin" ? aBase : oBase}/team-activity`);
      const P = Object.fromEntries(a.people.map((p) => [p.userId, p]));
      const s = P[S.me.id], d = P[D.me.id], b = P[B.me.id], all = P[A.me.id];
      assert(s && d && b && all, `${who}: people ${js(a.people.map((p) => p.name))}`);
      assert(s.scans.admitted === 2 && s.scans.offline === 1 && s.scans.refusedTotal === 5, `${who} S scans ${js(s.scans)}`);
      assert(js(s.scans.refused) === js({ already_used: 1, not_valid: 1, replaced: 1, refund_pending: 1, wrong_event: 1, not_open: 0 }), `${who} S refused ${js(s.scans.refused)}`);
      assert(s.addedByTicketroom === true && all.addedByTicketroom === false, `${who} added by`);
      assert(all.scans.admitted === 2 && all.scans.offline === 2, `${who} A scans ${js(all.scans)}`);
      assert(d.wristbands.linked === 1 && d.wristbands.replaced === 1 && d.wristbands.blocked === 1 && d.wristbands.total === 3, `${who} D bands ${js(d.wristbands)}`);
      assert(d.topups.count === 2 && d.topups.cashCents === 5000 && d.topups.cardCents === 2000 && d.topups.totalCents === 7000 && d.topups.undoneCount === 1, `${who} D topups ${js(d.topups)}`);
      assert(d.cashouts.count === 1 && d.cashouts.cents === 7000 && d.cash.takenCents === 5000 && d.cash.paidOutCents === 7000 && d.cash.netCents === -2000, `${who} D cash ${js(d.cash)}`);
      assert(b.boxOffice.count === 2 && b.boxOffice.tickets === 3 && b.boxOffice.cashCents === box.cash && b.boxOffice.cardCents === box.card && b.boxOffice.totalCents === box.cash + box.card, `${who} B ${js(b.boxOffice)}`);
      assert(b.cash.takenCents === box.cash && b.scans.admitted === 0 && s.boxOffice.count === 0 && d.scans.admitted === 0, `${who} no cross-attribution`);
      assert(s.firstAt && s.lastAt && near(s.firstAt, tenMin) && s.lastAt >= s.firstAt, `${who} S first/last ${s.firstAt} ${s.lastAt}`);
      assert(a.reconciled === true, `${who} reconciled ${js(a.reports)} ${js(a.totals)}`);
      // The same money in the existing reports.
      const cu = await org.call("GET", `/api/cashdesk/events/${E.id}/cashup`);
      assert(cu.totals.cash_cents === a.totals.topupCashCents && cu.totals.card_cents === a.totals.topupCardCents && cu.totals.cash_paid_out_cents === a.totals.cashPaidOutCents, `${who} desk cash-up ${js(cu.totals)} vs ${js(a.totals)}`);
      const bo = await org.call("GET", `/api/staff/events/${E.id}/box-office`);
      const sum = (k) => bo.shifts.reduce((n, x) => n + x[k], 0);
      assert(sum("cashSalesCents") === a.totals.boxOfficeCashCents && sum("cardSalesCents") === a.totals.boxOfficeCardCents, `${who} box office shifts vs ${js(a.totals)}`);
    }
  });

  await test("TM5 each person's timeline has every action, the offline time, and filters by type and time", async () => {
    const tl = await org.call("GET", `${oBase}/team-activity/${S.me.id}`);
    const acts = tl.items.map((i) => i.action).sort();
    assert(js(acts) === js(["admitted", "admitted", "already_used", "invalid", "refund_pending", "replaced", "wrong_event"]), `S actions ${js(acts)}`);
    const off = tl.items.find((i) => i.offline);
    assert(off && near(off.at, tenMin) && off.place === "North gate (offline)" && off.syncedAt, `offline item ${js(off)}`);
    assert(tl.items.filter((i) => !i.offline).every((i) => i.place === "Main gate"), "gate label on online scans");
    const recent = await org.call("GET", `${oBase}/team-activity/${S.me.id}?kind=scan&from=${encodeURIComponent(nineMin)}`);
    assert(recent.items.length === 6 && recent.items.every((i) => i.kind === "scan" && i.at >= nineMin), `filtered ${recent.items.length}`);
    const upTo = await admin.call("GET", `${aBase}/team-activity/${S.me.id}?to=${encodeURIComponent(nineMin)}`);
    assert(upTo.items.length === 1 && upTo.items[0].offline, `to filter ${js(upTo.items)}`);
    const d = await admin.call("GET", `${aBase}/team-activity/${D.me.id}`);
    const k = (kind) => d.items.filter((i) => i.kind === kind).map((i) => i.action).sort();
    assert(js(k("wristband")) === js(["blocked", "linked", "replaced"]), `D bands ${js(k("wristband"))}`);
    assert(js(k("topup")) === js(["topup", "topup", "topup", "topup_undone"]) && js(k("cashout")) === js(["cashout_paid"]), `D money ${js(d.items)}`);
    const onlyTopups = await admin.call("GET", `${aBase}/team-activity/${D.me.id}?kind=topup`);
    assert(onlyTopups.items.length === 4 && onlyTopups.items.every((i) => i.kind === "topup"), "kind filter");
    const b = await org.call("GET", `${oBase}/team-activity/${B.me.id}`);
    const ba = b.items.map((i) => i.action).sort();
    assert(js(ba) === js(["sale", "sale", "shift_closed", "shift_opened"]), `B ${js(ba)}`);
    assert(b.items.filter((i) => i.action === "sale").map((i) => `${i.method}:${i.amountCents}:${i.detail}`).sort().join() === [`cash:${box.cash}:2`, `external_card:${box.card}:1`].sort().join(), "sale method, amount and tickets");
  });

  await test("TM6 the CSV export matches the view and is audited", async () => {
    const before = count("SELECT count(*) FROM audit_log WHERE action = 'team_activity.exported' AND organiser_id = ?", [ORG]);
    const view = await org.call("GET", `${oBase}/team-activity`);
    const csv = await rawGet(org, `${oBase}/team-activity?format=csv`);
    assert(/text\/csv/.test(csv.type), csv.type);
    const rows = parseCsv(csv.text);
    assert(rows.length === view.people.length, `rows ${rows.length} vs ${view.people.length}`);
    for (const p of view.people) {
      const r = rows.find((x) => x.email === p.email);
      assert(r, `no row for ${p.email}`);
      const want = { scans_admitted: String(p.scans.admitted), refused_already_used: String(p.scans.refused.already_used), refused_not_valid: String(p.scans.refused.not_valid),
        refused_replaced: String(p.scans.refused.replaced), refused_refund_pending: String(p.scans.refused.refund_pending), refused_wrong_event: String(p.scans.refused.wrong_event),
        offline_scans: String(p.scans.offline), wristbands: String(p.wristbands.total), topups: String(p.topups.count), topups_cash: rand(p.topups.cashCents), topups_card: rand(p.topups.cardCents),
        cashouts_paid_total: rand(p.cashouts.cents), box_office_sales: String(p.boxOffice.count), box_office_tickets: String(p.boxOffice.tickets), box_office_cash: rand(p.boxOffice.cashCents),
        box_office_card: rand(p.boxOffice.cardCents), cash_taken: rand(p.cash.takenCents), cash_paid_out: rand(p.cash.paidOutCents), cash_in_hand: rand(p.cash.netCents),
        first_action: p.firstAt || "", last_action: p.lastAt || "", added_by_ticketroom: p.addedByTicketroom ? "yes" : "" };
      for (const [key, v] of Object.entries(want)) assert(r[key].replace(/^'/, "") === v, `${p.name} ${key}: csv ${r[key]} view ${v}`);
    }
    const dRow = rows.find((x) => x.email === D.me.email);
    assert(dRow.topups_cash === "50.00" && dRow.cash_paid_out === "70.00", `D row ${js(dRow)}`);
    const person = await rawGet(admin, `${aBase}/team-activity/${S.me.id}?format=csv`);
    assert(parseCsv(person.text).length === 7, "S timeline CSV has 7 actions");
    const after = count("SELECT count(*) FROM audit_log WHERE action = 'team_activity.exported' AND organiser_id = ?", [ORG]);
    assert(after - before === 2, `exports audited ${after - before}`);
    const last = one("SELECT actor_role, details FROM audit_log WHERE action = 'team_activity.exported' ORDER BY id DESC LIMIT 1");
    assert(last.actor_role === "admin" && JSON.parse(last.details).person === S.me.id, `audit ${js(last)}`);
  });

  await test("TM7 an organiser of another organisation, and event staff, cannot see Team activity", async () => {
    const other = new Client(BASE, DATA);
    const email = `other-org+${stamp}@example.test`;
    await other.call("POST", "/api/organiser/signup", { fullName: "Olwethu Other", email, password: `Tst-${crypto.randomBytes(12).toString("base64url")}`, organisation: "Other Events Co", acceptTerms: true }, 201);
    const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
    await other.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
    await other.refreshCsrf();
    const orgs = await other.call("GET", "/api/organiser/orgs");
    const otherOrg = (orgs.organisers || orgs.orgs || orgs)[0].id;
    await refuses(other.call("GET", `/api/organiser/${otherOrg}/events/${E.id}/team-activity`), 404, "other org, own org path");
    await refuses(other.call("GET", `${oBase}/team-activity`), 404, "other org, seed org path");
    await refuses(other.call("GET", `${oBase}/team-activity/${S.me.id}`), 404, "other org, timeline");
    await refuses(other.call("GET", `${oBase}/team-activity?format=csv`), 404, "other org, CSV");
    await refuses(S.call("GET", `${oBase}/team-activity`), 404, "event staff");
  });

  await test("TM8 the admin event page and the organiser tabs show the team and its activity (phone and desktop)", async () => {
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const open = async (client, url, size) => {
        const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] } });
        await ctx.addCookies(Object.entries(client.cookies).map(([name, value]) => ({ name, value, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" })));
        const page = await ctx.newPage();
        const errors = [];
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(BASE + url);
        return { ctx, page, errors };
      };
      const check = async (page, label) => {
        const r = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, text: document.querySelector("#main").innerText }));
        assert(!r.wide, `${label}: sideways scroll`);
        assert(!/—|!/.test(r.text), `${label}: em dash or exclamation mark`);
        return r.text;
      };
      for (const size of [[390, 844], [1366, 900]]) {
        const a = await open(admin, `/admin#/events/${E.id}`, size);
        await a.page.waitForSelector(`[data-person="${S.me.id}"]`, { timeout: 15000 });
        const text = await check(a.page, `admin ${size[0]}`);
        assert(/Event team/.test(text) && /Team activity/.test(text) && /match the desk cash-up/.test(text), `admin page text ${text.slice(0, 300)}`);
        assert(await a.page.locator(`[data-member="${S.me.id}"] .badge`, { hasText: "Added by TicketRoom" }).count() === 1, "admin sees the mark");
        await a.page.click(`[data-open="${S.me.id}"]`);
        await a.page.waitForSelector("dialog [data-tl-filter]");
        const dtext = await a.page.locator("dialog").innerText();
        assert(/Offline/.test(dtext) && /Refund in progress/.test(dtext) && /Wrong event/.test(dtext), `timeline ${dtext.slice(0, 300)}`);
        assert(!a.errors.length, `admin console ${a.errors.join(" | ")}`);
        await a.ctx.close();
        const o = await open(org, `/organisers#/events/${E.id}/staff`, size);
        await o.page.waitForSelector(`[data-member="${S.me.id}"]`, { timeout: 15000 });
        await check(o.page, `organiser staff ${size[0]}`);
        assert(await o.page.locator(`[data-member="${S.me.id}"] .badge`, { hasText: "Added by TicketRoom" }).count() === 1, "organiser sees Added by TicketRoom");
        assert(await o.page.locator(`[data-member="${A.me.id}"] .badge`).count() === 0, "no mark on the organiser's own");
        await o.page.goto(`${BASE}/organisers#/events/${E.id}/team`);
        await o.page.waitForSelector(`[data-person="${D.me.id}"]`, { timeout: 15000 });
        await check(o.page, `organiser activity ${size[0]}`);
        assert(!o.errors.length, `organiser console ${o.errors.join(" | ")}`);
        await o.ctx.close();
      }
    } finally { await browser.close(); }
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
