// WhatsApp tickets, add-ons and reserved seats, X1-X10:
//   X1  WhatsApp (practice mode): a buyer who asks gets their tickets on
//       WhatsApp instead of an SMS; the message carries the event and a link
//   X2  WhatsApp Business API: the approved template with four values goes to
//       Meta's API; a number not on WhatsApp fails at once, never retried
//   X3  add-ons: organiser sets up parking; buyers see it; the quote adds it at
//       its price with no booking fee and no promo discount
//   X4  add-ons are held with the order and sold on payment; sold out is refused;
//       a cancelled order gives its extras back
//   X5  the gate sees the extras with the ticket and hands them over once
//   X6  refunding an order's last tickets gives the extras' money back too
//   X7  seat map: a section of rows and seats makes the ticket type sell
//       exactly those seats; buyers pick seats and the ticket shows the seat
//   X8  a seat taken a moment ago is refused; "best available" gives seats
//       side by side; a cancelled order frees its seats
//   X9  blocked seats are not sold and the quantity follows; the gate shows the seat
//   X10 upgrade: an older message queue is rebuilt to accept WhatsApp, rows kept
//   X11 venue blocks: rows of different lengths (a wedge), shorter rows centred
//   X12 venue map: blocks placed, turned and curved over the venue's plan, as
//       buyers see it; only the organiser's own picture; wrong values refused
//   X13 the seat map copied to another show at the venue: blocks, seats off
//       sale, positions and plan; missing ticket types made at the same price
//   X14 copying only from the organiser's own events; never onto a map
//
//   node tests/extras.js <dir from serve.sh> [port]
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, execFile } = require("child_process");
const { Client, sql, driver, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: extras.js <dir from serve.sh> [port]"); process.exit(2); }
const BASE = `http://localhost:${process.argv[3] || 8787}`;
const DATA = path.join(DIR, "ticketroom-data");
const SEED = require(path.join(DIR, "seed.json"));
const PW = process.env.TR_TEST_ADMIN_PASSWORD;
const LIB = path.join(__dirname, "money-lib.php");
const ENV = { ...process.env, no_proxy: "localhost,127.0.0.1", NO_PROXY: "localhost,127.0.0.1" };
const MOCK_PORT = Number(process.env.TR_EXTRAS_MOCK_PORT || 8795);
let passes = 0, failures = 0;
async function test(name, fn) { try { await fn(); passes++; console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}  ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const js = (v) => JSON.stringify(v);
function php(code) {
  let out;
  try { out = execFileSync("php", ["-r", `require ${js(LIB)}; tm_boot(${js(DIR)}); ${code}`], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`PHP failed: ${(e.stderr || "") + (e.stdout || "")}`.slice(0, 1200)); }
  const m = out.match(/@@TM@@(.*)\n?$/m);
  if (!m) throw new Error(`PHP gave no result: ${out.slice(0, 600)}`);
  return JSON.parse(m[1]);
}
// The same, without blocking this process (for calls to the mock server here).
function phpAsync(code) {
  return new Promise((res, rej) => execFile("php", ["-r", `require ${js(LIB)}; tm_boot(${js(DIR)}); ${code}`], { encoding: "utf8", env: ENV }, (err, out, errOut) => {
    const m = String(out).match(/@@TM@@(.*)\n?$/m);
    if (err || !m) return rej(new Error(`PHP failed: ${String(errOut) + String(out)}`.slice(0, 1200)));
    res(JSON.parse(m[1]));
  }));
}
const idem = () => `x-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
// Pays a sandbox order the way the practice payment page does.
async function pay(c, res) {
  const u = new URL(res.payment.redirectUrl, BASE);
  await c.call("POST", `/api/public/payments/${u.searchParams.get("p")}/sandbox`, { k: u.searchParams.get("k"), outcome: "paid" });
}
const guest = (n) => ({ fullName: `Extras Buyer ${n}`, email: `extras-${n}-${Date.now()}@example.test` });
const one = (q, p = []) => sql(DATA, q, p)[0];

(async () => {
  // An event of its own (a copy of the seeded paid one), so the other suites'
  // events are left exactly as they were.
  const mine = php(`$src = ${js(SEED.events.paid.id)};
    $e = row('SELECT * FROM events WHERE id = ?', [$src]); $id = uuid();
    $e['id'] = $id; $e['slug'] = 'extras-test-' . strtolower(random_code(6)); $e['ref'] = new_ref('events'); $e['title'] = 'Extras Test Night';
    insert('events', $e);
    $tt = row('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order LIMIT 1', [$src]);
    $tt['id'] = uuid(); $tt['event_id'] = $id; $tt['quantity_sold'] = 0; $tt['quantity_held'] = 0; insert('ticket_types', $tt);
    tm_out(['id' => $id, 'slug' => $e['slug']]);`);
  const slug = mine.slug, eventId = mine.id;
  const admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, PW);
  const org = new Client(BASE, DATA); await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  const cust = new Client(BASE, DATA); await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  const O = `/api/organiser/${SEED.organiser.orgId}/events/${eventId}`;
  const free = SEED.events.free;
  const freeTt = (await cust.call("GET", `/api/public/events/${free.slug}`)).ticketTypes[0];
  const gaTt = (await cust.call("GET", `/api/public/events/${slug}`)).ticketTypes.find((t) => t.name === "General admission");

  await test("X1 WhatsApp practice mode: tickets go on WhatsApp instead of an SMS, with the event and a link", async () => {
    await admin.call("PUT", "/api/admin/integrations/whatsapp", { currentPassword: PW, values: { provider: "log" } });
    assert((await cust.call("GET", "/api/config")).features.whatsapp === true, "feature flag off");
    const r = await new Client(BASE, DATA).call("POST", "/api/public/orders", { eventSlug: free.slug, items: [{ ticketTypeId: freeTt.id, quantity: 1 }], buyerPhone: "082 555 0101", whatsapp: true, guest: guest(0), idempotencyKey: idem() });
    const o = one("SELECT id, whatsapp_opt_in FROM orders WHERE reference = ?", [r.order.reference]);
    assert(Number(o.whatsapp_opt_in) === 1, "opt-in not stored");
    const msgs = sql(DATA, "SELECT channel, to_address, body, status FROM message_outbox WHERE user_id = (SELECT user_id FROM orders WHERE id = ?) AND channel <> 'email' AND created_at >= (SELECT created_at FROM orders WHERE id = ?)", [o.id, o.id]);
    assert(msgs.length === 1 && msgs[0].channel === "whatsapp", `messages: ${js(msgs)}`);
    assert(msgs[0].to_address === "+27825550101" && msgs[0].body.includes(free.title) && msgs[0].body.includes(`/orders/${r.order.reference}?k=`), js(msgs[0]));
    const sent = php(`out_(outbox_deliver(50)); function out_($n) { tm_out(['n' => $n, 'row' => row("SELECT status, provider FROM message_outbox WHERE channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1")]); }`);
    assert(sent.row.status === "sent" && sent.row.provider === "log", js(sent));
  });

  await test("X2 WhatsApp Business API: the approved template goes to Meta; a number not on WhatsApp fails without retries", async () => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || "{}") });
        const bad = seen.length > 1;
        res.writeHead(bad ? 400 : 200, { "content-type": "application/json" });
        res.end(js(bad ? { error: { message: "Recipient phone number not in allowed list", code: 131026 } } : { messages: [{ id: "wamid.TEST1" }] }));
      });
    });
    await new Promise((r) => srv.listen(MOCK_PORT, "127.0.0.1", r));
    try {
      const r = await phpAsync(`tm_out(tm_rollback(function () {
        integration_save('whatsapp', ['provider' => 'cloud', 'phoneNumberId' => '1098765', 'accessToken' => 'EAAG-test-token', 'templateName' => 'ticket_ready', 'templateLanguage' => 'en'], [], (string) val("SELECT id FROM users LIMIT 1"));
        $GLOBALS['TR_CONFIG']['whatsapp']['graphBase'] = 'http://127.0.0.1:${MOCK_PORT}';
        $m = whatsapp_ticket_message(['buyer_name' => 'Lerato Mokoena'], ['title' => 'Harbour Lights', 'starts_at' => '2026-12-12T17:00:00Z'], 2, 'https://ticketroom.co.za/orders/TR-1?k=x');
        $id = whatsapp_send('+27821234567', $m['body'], $m['subject']);
        outbox_enqueue(['channel' => 'whatsapp', 'to' => '+27829999999'] + $m);
        outbox_deliver(50);
        return ['id' => $id, 'failed' => row("SELECT status, attempts, next_attempt_at, last_error FROM message_outbox WHERE channel = 'whatsapp' AND to_address = '+27829999999'")];
      }));`);
      assert(r.id === "wamid.TEST1", js(r));
      const s = seen[0];
      assert(s.url === "/1098765/messages" && s.auth === "Bearer EAAG-test-token", js(s));
      assert(s.body.to === "27821234567" && s.body.type === "template" && s.body.template.name === "ticket_ready" && s.body.template.language.code === "en", js(s.body));
      const p = s.body.template.components[0].parameters.map((x) => x.text);
      assert(p.length === 4 && p[0] === "Lerato" && p[1] === "Harbour Lights" && p[3].startsWith("https://ticketroom.co.za/orders/"), js(p));
      assert(r.failed.status === "failed" && !r.failed.next_attempt_at && /131026/.test(r.failed.last_error) && !String(r.failed.last_error).includes("EAAG-test-token"), js(r.failed));
    } finally { srv.close(); }
  });

  let parking;
  await test("X3 add-ons: parking set up by the organiser, shown to buyers, quoted at its price with no fee or discount", async () => {
    parking = (await org.call("POST", `${O}/addons`, { name: "Parking", kind: "parking", description: "Secure parking next to the venue", priceCents: 5000, quantityTotal: 3, perOrderLimit: 2 })).addon;
    let refused = false; try { await org.call("POST", `${O}/addons`, { name: "Cheap", kind: "other", priceCents: 200, quantityTotal: 5 }); } catch { refused = true; }
    assert(refused, "a R2 extra was allowed");
    const ev = (await cust.call("GET", `/api/public/events/${slug}`)).event;
    assert(ev.addons.length === 1 && ev.addons[0].name === "Parking" && ev.addons[0].remaining === 3, js(ev.addons));
    const q = (await cust.call("POST", "/api/public/checkout/quote", { eventSlug: slug, items: [{ ticketTypeId: gaTt.id, quantity: 1 }], addons: [{ addonId: parking.id, quantity: 2 }] })).quote;
    assert(q.addonsCents === 10000 && q.ticketSubtotalCents === 15000 && q.subtotalCents === 25000, js(q));
    assert(q.totalCents === 25000 + q.feeCents && q.feeCents === gaTt.fee_cents, `fee charged on extras: ${js(q)}`);
    let over = false; try { await cust.call("POST", "/api/public/checkout/quote", { eventSlug: slug, items: [{ ticketTypeId: gaTt.id, quantity: 1 }], addons: [{ addonId: parking.id, quantity: 3 }] }); } catch { over = true; }
    assert(over, "per-order limit not enforced");
  });

  let paidRef;
  await test("X4 add-ons held with the order, sold on payment; sold out refused; a cancelled order gives them back", async () => {
    const c = new Client(BASE, DATA);
    const r = await c.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: gaTt.id, quantity: 1 }], addons: [{ addonId: parking.id, quantity: 2 }], guest: guest(1), idempotencyKey: idem() });
    assert(Number(one("SELECT quantity_held AS n FROM event_addons WHERE id = ?", [parking.id]).n) === 2, "not held");
    await pay(c, r);
    paidRef = r.order.reference;
    const a = one("SELECT quantity_sold, quantity_held FROM event_addons WHERE id = ?", [parking.id]);
    assert(Number(a.quantity_sold) === 2 && Number(a.quantity_held) === 0, js(a));
    const view = await c.call("GET", `/api/public/orders/${paidRef}?k=${encodeURIComponent(r.accessKey)}`);
    assert(view.addons.length === 1 && view.addons[0].quantity === 2 && view.addons[0].status === "valid", js(view.addons));
    const mail = one("SELECT body FROM message_outbox WHERE to_address = (SELECT buyer_email FROM orders WHERE reference = ?) AND channel = 'email' ORDER BY created_at DESC LIMIT 1", [paidRef]);
    assert(/Extras: 2 × Parking/.test(mail.body), "the email does not list the extras");
    let soldOut = "";
    try { await new Client(BASE, DATA).call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: gaTt.id, quantity: 1 }], addons: [{ addonId: parking.id, quantity: 2 }], guest: guest(2), idempotencyKey: idem() }); }
    catch (e) { soldOut = e.message; }
    assert(/409/.test(soldOut) && /Parking/.test(soldOut), soldOut || "sold out was not refused");
    const c3 = new Client(BASE, DATA);
    const r3 = await c3.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: gaTt.id, quantity: 1 }], addons: [{ addonId: parking.id, quantity: 1 }], guest: guest(3), idempotencyKey: idem() });
    assert(Number(one("SELECT quantity_held AS n FROM event_addons WHERE id = ?", [parking.id]).n) === 1, "the last one not held");
    await c3.call("POST", `/api/public/orders/${r3.order.reference}/cancel?k=${encodeURIComponent(r3.accessKey)}`);
    assert(Number(one("SELECT quantity_held AS n FROM event_addons WHERE id = ?", [parking.id]).n) === 0, "a cancelled order kept its extra");
    assert(one("SELECT x.status FROM order_addons x JOIN orders o ON o.id = x.order_id WHERE o.reference = ?", [r3.order.reference]).status === "cancelled", "line not cancelled");
  });

  await test("X5 the gate sees the extras with the ticket and hands them over once", async () => {
    // Sandbox payments make TEST tickets, which the gate refuses: these count as real here.
    await php(`q("UPDATE events SET starts_at = ?, ends_at = ? WHERE id = ?", [iso_in(600), iso_in(4 * 3600), ${js(eventId)}]); q("UPDATE orders SET test = 0 WHERE event_id = ?", [${js(eventId)}]); q("UPDATE tickets SET test = 0 WHERE event_id = ?", [${js(eventId)}]); tm_out(true);`);
    const t = one("SELECT t.code, t.qr_version FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.reference = ?", [paidRef]);
    const payload = php(`tm_out(qr_payload(['code' => ${js(t.code)}, 'qr_version' => ${Number(t.qr_version)}]));`);
    const scan = await org.call("POST", "/api/staff/scan", { eventId, payload });
    assert(scan.outcome === "admitted" && scan.extras?.length === 1 && scan.extras[0].name === "Parking" && scan.extras[0].quantity === 2 && scan.extras[0].collected === 0, js(scan));
    const x = scan.extras[0].id;
    const c1 = await org.call("POST", `/api/staff/events/${eventId}/extras/${x}/collect`, { quantity: 2 });
    assert(c1.extras[0].collected === 2, js(c1));
    let again = ""; try { await org.call("POST", `/api/staff/events/${eventId}/extras/${x}/collect`, {}); } catch (e) { again = e.message; }
    assert(/409/.test(again) && /Already handed over/.test(again), again || "handed over twice");
  });

  await test("X6 refunding the last tickets of an order gives the extras' money back too", async () => {
    const r = php(`tm_out(tm_rollback(function () {
      $o = row('SELECT * FROM orders WHERE reference = ?', [${js(paidRef)}]);
      $rf = refund_create($o, null, [], false, 'customer', 'Cannot attend');
      refund_complete($rf['id'], 'test-ref', null);
      return ['amount' => (int) $rf['amount_cents'], 'subtotal' => (int) $o['subtotal_cents'], 'discount' => (int) $o['discount_cents'],
        'addons' => (int) $o['addons_cents'], 'lines' => array_column(rows('SELECT status FROM order_addons WHERE order_id = ?', [$o['id']]), 'status')];
    }));`);
    assert(r.addons === 10000 && r.amount === r.subtotal - r.discount, `refund ${r.amount} of ${r.subtotal - r.discount}: ${js(r)}`);
    assert(r.lines.every((s) => s === "refunded"), js(r.lines));
  });

  // ---- reserved seats
  let stalls, ttSeat;
  await test("X7 seat map: rows and seats make the ticket type sell exactly those seats; picked seats are on the tickets", async () => {
    await php(`q("UPDATE events SET status = 'draft' WHERE id = ?", [${js(eventId)}]); tm_out(true);`);
    ttSeat = (await org.call("POST", `${O}/ticket-types`, { name: "Stalls", kind: "general", priceCents: 20000, quantityTotal: 1, perOrderLimit: 6, status: "on_sale" })).ticketType;
    stalls = await org.call("POST", `${O}/seats/sections`, { ticketTypeId: ttSeat.id, section: "Stalls", rows: "A-C", seatsPerRow: 4, accessibleRows: "C" });
    await php(`q("UPDATE events SET status = 'published' WHERE id = ?", [${js(eventId)}]); tm_out(true);`);
    assert(Number(one("SELECT quantity_total AS n FROM ticket_types WHERE id = ?", [ttSeat.id]).n) === 12, "quantity does not follow the seats");
    let dup = false; try { await org.call("POST", `${O}/seats/sections`, { ticketTypeId: ttSeat.id, section: "Stalls", rows: "D", seatsPerRow: 2 }); } catch { dup = true; }
    assert(dup, "a second section with the same name was allowed");
    const pub = await cust.call("GET", `/api/public/events/${slug}`);
    assert(pub.event.seated && pub.ticketTypes.find((t) => t.id === ttSeat.id).seated, "not marked seated");
    const map = (await cust.call("GET", `/api/public/events/${slug}/seats`)).sections;
    assert(map.length === 1 && map[0].rows.length === 3 && map[0].rows[0].seats.length === 4 && map[0].rows[2].seats[0].a === 1, js(map).slice(0, 300));
    const seat = (row, n) => map[0].rows.find((r) => r.label === row).seats.find((s) => s.n === n).id;
    const c = new Client(BASE, DATA);
    const r = await c.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: ttSeat.id, quantity: 2 }], seats: [seat("A", 1), seat("A", 2)], guest: guest(4), idempotencyKey: idem() });
    await pay(c, r);
    const view = await c.call("GET", `/api/public/orders/${r.order.reference}?k=${encodeURIComponent(r.accessKey)}`);
    const labels = view.tickets.map((t) => t.seat_label).sort();
    assert(js(labels) === js(["Stalls, row A, seat 1", "Stalls, row A, seat 2"]), js(labels));
    const after = (await cust.call("GET", `/api/public/events/${slug}/seats`)).sections[0].rows[0].seats;
    assert(after[0].s === "taken" && after[1].s === "taken" && after[2].s === "open", js(after));
    stalls = { map, seat };
  });

  await test("X8 a taken seat is refused; best available gives seats side by side; a cancelled order frees its seats", async () => {
    let taken = ""; try { await new Client(BASE, DATA).call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: ttSeat.id, quantity: 1 }], seats: [stalls.seat("A", 1)], guest: guest(5), idempotencyKey: idem() }); }
    catch (e) { taken = e.message; }
    assert(/409/.test(taken) && /row A, seat 1 was just taken/.test(taken), taken || "a sold seat was sold again");
    let count = ""; try { await new Client(BASE, DATA).call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: ttSeat.id, quantity: 2 }], seats: [stalls.seat("B", 1)], guest: guest(5), idempotencyKey: idem() }); }
    catch (e) { count = e.message; }
    assert(/seat_count/.test(count), count || "1 seat for 2 tickets was accepted");
    const c = new Client(BASE, DATA);
    const r = await c.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: ttSeat.id, quantity: 3 }], guest: guest(6), idempotencyKey: idem() });
    const held = sql(DATA, "SELECT row_label, seat_number FROM seats WHERE order_id = (SELECT id FROM orders WHERE reference = ?) ORDER BY seat_number", [r.order.reference]);
    assert(held.length === 3 && held.every((s) => s.row_label === "B") && js(held.map((s) => Number(s.seat_number))) === "[1,2,3]", `best available gave ${js(held)}`);
    await c.call("POST", `/api/public/orders/${r.order.reference}/cancel?k=${encodeURIComponent(r.accessKey)}`);
    assert(Number(one("SELECT count(*) AS n FROM seats WHERE event_id = ? AND status = 'held'", [eventId]).n) === 0, "seats still held after cancel");
  });

  await test("X9 blocked seats are not sold and the quantity follows; the gate shows the seat", async () => {
    const ids = stalls.map[0].rows.find((r) => r.label === "C").seats.map((s) => s.id);
    const b = await org.call("POST", `${O}/seats/block`, { seatIds: ids, blocked: true });
    assert(b.changed === 4 && Number(one("SELECT quantity_total AS n FROM ticket_types WHERE id = ?", [ttSeat.id]).n) === 8, js(b.summary));
    let refused = ""; try { await new Client(BASE, DATA).call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: ttSeat.id, quantity: 1 }], seats: [ids[0]], guest: guest(7), idempotencyKey: idem() }); }
    catch (e) { refused = e.message; }
    assert(/409/.test(refused), refused || "a blocked seat was sold");
    await php(`q("UPDATE tickets SET test = 0 WHERE event_id = ?", [${js(eventId)}]); tm_out(true);`);
    const t = one("SELECT code, qr_version FROM tickets WHERE ticket_type_id = ? AND seat_label = 'Stalls, row A, seat 1'", [ttSeat.id]);
    const payload = php(`tm_out(qr_payload(['code' => ${js(t.code)}, 'qr_version' => ${Number(t.qr_version)}]));`);
    const scan = await org.call("POST", "/api/staff/scan", { eventId, payload });
    assert(scan.outcome === "admitted" && scan.seat === "Stalls, row A, seat 1", js(scan));
  });

  await test("X10 upgrade: the message queue is rebuilt to accept WhatsApp, every row kept", async () => {
    if (driver(DATA) === "mysql") return; // MySQL installs start from schema.mysql.sql, which has it
    const r = php(`tm_out(tm_rollback(function () {
      $old = (string) val("SELECT sql FROM sqlite_master WHERE name = 'message_outbox'");
      db()->exec('CREATE TABLE mo_old AS SELECT * FROM message_outbox');
      db()->exec('DROP TABLE message_outbox');
      db()->exec(str_replace("'email','sms','whatsapp'", "'email','sms'", $old));
      db()->exec("INSERT INTO message_outbox SELECT * FROM mo_old WHERE channel IN ('email','sms')");
      db()->exec('DROP TABLE mo_old');
      $before = (int) val('SELECT count(*) FROM message_outbox');
      try { outbox_enqueue(['channel' => 'whatsapp', 'to' => '+27820000000', 'body' => 'x']); } catch (PDOException $e) { /* refused */ }
      $refusedBefore = (int) val('SELECT count(*) FROM message_outbox') === $before ? 'check_failed' : 'accepted';
      tr_upgrade_outbox_channels();
      outbox_enqueue(['channel' => 'whatsapp', 'to' => '+27820000000', 'body' => 'x']);
      $idx = array_column(rows("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'message_outbox'"), 'name');
      return ['before' => $before, 'after' => (int) val('SELECT count(*) FROM message_outbox'), 'refusedBefore' => $refusedBefore, 'idx' => $idx];
    }));`);
    assert(r.refusedBefore === "check_failed", `the old table accepted WhatsApp: ${js(r)}`);
    assert(r.after === r.before + 1 && r.idx.includes("message_outbox_due_idx") && r.idx.includes("message_outbox_campaign_user_uq"), js(r));
  });

  let wedge;
  await test("X11 a wedge block: each row its own number of seats, shorter rows centred", async () => {
    await php(`q("UPDATE events SET status = 'draft' WHERE id = ?", [${js(eventId)}]); tm_out(true);`);
    const tt = (await org.call("POST", `${O}/ticket-types`, { name: "Block E", kind: "general", priceCents: 28500, quantityTotal: 1, perOrderLimit: 6, status: "on_sale" })).ticketType;
    let bad = ""; try { await org.call("POST", `${O}/seats/sections`, { ticketTypeId: tt.id, section: "Block E", rowSeats: "A:4, B" }); } catch (e) { bad = e.message; }
    assert(/422/.test(bad) && /rowSeats/.test(bad), bad || "a broken row list was accepted");
    const r = await org.call("POST", `${O}/seats/sections`, { ticketTypeId: tt.id, section: "Block E", rowSeats: "A:4, B:6, C-D:8" });
    const sec = r.sections.find((x) => x.name === "Block E");
    const rows = sec.rows.map((x) => [x.label, x.seats.length, x.seats[0].p, x.seats[0].n]);
    assert(js(rows) === js([["A", 4, 2, 1], ["B", 6, 1, 1], ["C", 8, 0, 1], ["D", 8, 0, 1]]), js(rows));
    assert(Number(one("SELECT quantity_total AS n FROM ticket_types WHERE id = ?", [tt.id]).n) === 26, "quantity is not the seat count");
    assert(sec.x === null && sec.y === null, "a new block should wait to be placed");
    wedge = { tt, sec };
  });

  await test("X12 the venue map: blocks placed, turned and curved over the plan, as buyers see it", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const up = await org.call("POST", `/api/organiser/${SEED.organiser.orgId}/uploads`, png, undefined, { "content-type": "image/png" });
    const r = await org.call("PUT", `${O}/seats/layout`, { sections: [{ name: "Stalls", x: 500, y: 120, rotation: 0, curve: 0 }, { name: "Block E", x: 500, y: 300, rotation: -12.5, curve: 40 }], imageUploadId: up.uploadId, imageWidth: 1200, imageHeight: 900 });
    assert(r.layout.imageUrl === `/media/${up.uploadId}` && r.layout.imageWidth === 1200 && r.layout.imageHeight === 900, js(r.layout));
    await php(`q("UPDATE events SET status = 'published' WHERE id = ?", [${js(eventId)}]); tm_out(true);`);
    const pub = await cust.call("GET", `/api/public/events/${slug}/seats`);
    const e = pub.sections.find((x) => x.name === "Block E");
    assert(e.x === 500 && e.y === 300 && e.rotation === -12.5 && e.curve === 40 && pub.layout.imageUrl === r.layout.imageUrl, js({ e: { ...e, rows: undefined }, layout: pub.layout }));
    let bad = ""; try { await org.call("PUT", `${O}/seats/layout`, { sections: [{ name: "Nowhere", x: 1, y: 1, rotation: 0, curve: 0 }] }); } catch (err) { bad = err.message; }
    assert(/422/.test(bad), bad || "a block that does not exist was saved");
    bad = ""; try { await org.call("PUT", `${O}/seats/layout`, { sections: [{ name: "Block E", x: 1, y: 1, rotation: 0, curve: 400 }] }); } catch (err) { bad = err.message; }
    assert(/422/.test(bad), bad || "a curve of 400 degrees was saved");
    // A picture someone else uploaded cannot be put behind this map.
    const other = php(`$u = row("SELECT id FROM users WHERE account_type = 'customer' LIMIT 1"); $id = uuid(); q("INSERT INTO uploads (id, owner_id, organiser_id, mime_type, size_bytes, created_at) VALUES (?,?,NULL,'image/png',10,?)", [$id, $u['id'], now_iso()]); tm_out($id);`);
    bad = ""; try { await org.call("PUT", `${O}/seats/layout`, { sections: [], imageUploadId: other }); } catch (err) { bad = err.message; }
    assert(/422/.test(bad) && /imageUploadId/.test(bad), bad || "another person's upload was accepted");
    // Buying in the curved, turned block works like any other.
    const c = new Client(BASE, DATA);
    const seat = pub.sections.find((x) => x.name === "Block E").rows[0].seats[1];
    const o = await c.call("POST", "/api/public/orders", { eventSlug: slug, items: [{ ticketTypeId: wedge.tt.id, quantity: 1 }], seats: [seat.id], guest: guest(8), idempotencyKey: idem() });
    await pay(c, o);
    assert(one("SELECT seat_label FROM tickets WHERE order_id = (SELECT id FROM orders WHERE reference = ?)", [o.order.reference]).seat_label === "Block E, row A, seat 2", "wrong seat on the ticket");
  });

  let copyTo;
  await test("X13 the seat map copied to another show: blocks, seats off sale, positions, plan, ticket types made", async () => {
    copyTo = php(`$src = ${js(eventId)};
      $e = row('SELECT * FROM events WHERE id = ?', [$src]); $id = uuid();
      $e['id'] = $id; $e['slug'] = 'extras-copy-' . strtolower(random_code(6)); $e['ref'] = new_ref('events'); $e['title'] = 'Extras Test Night 2'; $e['status'] = 'draft';
      insert('events', $e);
      tm_out(['id' => $id]);`);
    const O2 = `/api/organiser/${SEED.organiser.orgId}/events/${copyTo.id}`;
    const src = await org.call("GET", `${O2}/seats/sources`);
    assert(src.events.some((x) => x.id === eventId), "the event with a map is not offered");
    const r = await org.call("POST", `${O2}/seats/copy`, { fromEventId: eventId });
    assert(r.seats === 38 && js(r.ticketTypesMade.sort()) === js(["Block E", "Stalls"]), js({ seats: r.seats, made: r.ticketTypesMade }));
    const types = sql(DATA, "SELECT name, price_cents, quantity_total FROM ticket_types WHERE event_id = ? ORDER BY name", [copyTo.id]);
    assert(js(types.map((t) => [t.name, Number(t.price_cents), Number(t.quantity_total)])) === js([["Block E", 28500, 26], ["Stalls", 20000, 8]]), js(types));
    const counts = one("SELECT SUM(status = 'open') AS open, SUM(status = 'blocked') AS blocked, SUM(status NOT IN ('open','blocked')) AS other FROM seats WHERE event_id = ?", [copyTo.id]);
    assert(Number(counts.open) === 34 && Number(counts.blocked) === 4 && Number(counts.other) === 0, `sold seats must come over as open: ${js(counts)}`);
    const e = r.sections.find((x) => x.name === "Block E");
    assert(e.x === 500 && e.rotation === -12.5 && e.curve === 40 && r.layout.imageWidth === 1200, js({ ...e, rows: undefined }));
    let again = ""; try { await org.call("POST", `${O2}/seats/copy`, { fromEventId: eventId }); } catch (err) { again = err.message; }
    assert(/409/.test(again) && /seats_exist/.test(again), again || "copied on top of an existing map");
  });

  await test("X14 seat maps are only copied from the organiser's own events", async () => {
    const foreign = php(`$o = uuid(); $now = now_iso();
      $org = row('SELECT * FROM organisers WHERE id = ?', [${js(SEED.organiser.orgId)}]); $org['id'] = $o; $org['name'] = 'Other Org'; $org['slug'] = 'other-org-' . strtolower(random_code(5)); if (array_key_exists('ref', $org)) $org['ref'] = new_ref('organisers'); insert('organisers', $org);
      $e = row('SELECT * FROM events WHERE id = ?', [${js(eventId)}]); $id = uuid();
      $e['id'] = $id; $e['organiser_id'] = $o; $e['slug'] = 'foreign-' . strtolower(random_code(6)); $e['ref'] = new_ref('events'); insert('events', $e);
      tm_out($id);`);
    const fresh = php(`$e = row('SELECT * FROM events WHERE id = ?', [${js(eventId)}]); $id = uuid(); $e['id'] = $id; $e['slug'] = 'extras-copy-' . strtolower(random_code(6)); $e['ref'] = new_ref('events'); $e['status'] = 'draft'; insert('events', $e); tm_out($id);`);
    let r = ""; try { await org.call("POST", `/api/organiser/${SEED.organiser.orgId}/events/${fresh}/seats/copy`, { fromEventId: foreign }); } catch (err) { r = err.message; }
    assert(/404/.test(r), r || "copied from another organiser's event");
    php(`foreach ([${js(fresh)}, ${js(foreign)}, ${js(copyTo.id)}] as $id) q("UPDATE events SET status = 'draft' WHERE id = ?", [$id]); tm_out(true);`);
  });

  // Back to how the other suites expect it.
  await admin.call("PUT", "/api/admin/integrations/whatsapp", { currentPassword: PW, values: { provider: "none" } });
  php(`q("UPDATE events SET status = 'draft' WHERE id = ?", [${js(eventId)}]); tm_out(true);`);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
