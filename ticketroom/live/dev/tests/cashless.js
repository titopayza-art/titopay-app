// The cashless loop from end to end, over the web API, C1-C7:
//   C1 an attendee with a ticket tops up their event wallet by card (sandbox)
//      and the balance shows; without a ticket a top-up is refused
//   C2 the event team registers a wristband; the attendee links it with the
//      codes on the band
//   C3 the organiser adds a stall, its till and a menu item
//   C4 a tap at the till pays from the wallet; the same tap sent twice (a
//      dropped signal) charges once; more than the balance is declined
//   C5 the till's balance check shows the amount only
//   C6 a band reported lost is declined at once; the money stays
//   C7 once the event is over, the money left is refunded on request and the
//      wallet is then empty
//
//   node tests/cashless.js <dir from serve.sh> [port]
const path = require("path");
const { execFileSync } = require("child_process");
const { Client, sql } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: cashless.js <dir from serve.sh> [port]"); process.exit(2); }
const BASE = `http://localhost:${process.argv[3] || 8787}`;
const DATA = path.join(DIR, "ticketroom-data");
const SEED = require(path.join(DIR, "seed.json"));
const LIB = path.join(__dirname, "money-lib.php");
let passes = 0, failures = 0;
async function test(name, fn) { try { await fn(); passes++; console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}  ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const js = (v) => JSON.stringify(v);
function php(code) {
  const out = execFileSync("php", ["-r", `require ${js(LIB)}; tm_boot(${js(DIR)}); ${code}`], { encoding: "utf8" });
  const m = out.match(/@@TM@@(.*)\n?$/m);
  if (!m) throw new Error(`PHP gave no result: ${out.slice(0, 500)}`);
  return JSON.parse(m[1]);
}
const idem = () => `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
async function pay(c, payment) {
  const u = new URL(payment.redirectUrl, BASE);
  await c.call("POST", `/api/public/payments/${u.searchParams.get("p")}/sandbox`, { k: u.searchParams.get("k"), outcome: "paid" });
}
const refused = async (p, status) => { try { await p; } catch (e) { if (new RegExp(`-> ${status}\\b`).test(e.message)) return e.message; throw e; } throw new Error(`expected ${status}, it went through`); };

(async () => {
  // An event of its own: a copy of the seeded paid one, cashless, on now.
  const ev = php(`$src = row('SELECT * FROM events WHERE id = ?', [${js(SEED.events.paid.id)}]); $id = uuid();
    $src['id'] = $id; $src['slug'] = 'cashless-test-' . strtolower(random_code(6)); $src['ref'] = new_ref('events'); $src['title'] = 'Cashless Test Fest';
    $src['cashless_enabled'] = 1; $src['status'] = 'published'; $src['starts_at'] = iso_in(-1800); $src['ends_at'] = iso_in(6 * 3600);
    insert('events', $src);
    $tt = row('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order LIMIT 1', [${js(SEED.events.paid.id)}]);
    $tt['id'] = uuid(); $tt['event_id'] = $id; $tt['quantity_sold'] = 0; $tt['quantity_held'] = 0; insert('ticket_types', $tt);
    tm_out(['id' => $id, 'slug' => $src['slug'], 'tt' => $tt['id']]);`);
  const org = new Client(BASE, DATA); await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  const cust = new Client(BASE, DATA); await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  const O = `/api/organiser/${SEED.organiser.orgId}/events/${ev.id}`;
  const wallet = async () => (await cust.call("GET", `/api/me/wallets/${ev.id}`));
  const balance = (w) => Number(w.wallet?.balanceCents ?? w.balanceCents ?? w.wallet?.balance_cents ?? NaN);

  await test("C1 an attendee with a ticket tops up R200 by card and the balance shows; no ticket, no top-up", async () => {
    await refused(cust.call("POST", `/api/me/wallets/${ev.id}/topups`, { amountCents: 20000, idempotencyKey: idem() }), 409);
    const o = await cust.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ev.tt, quantity: 1 }], idempotencyKey: idem() });
    await pay(cust, o.payment);
    const t = await cust.call("POST", `/api/me/wallets/${ev.id}/topups`, { amountCents: 20000, idempotencyKey: idem() });
    assert(t.payment?.redirectUrl, `no payment page: ${js(t)}`);
    await pay(cust, t.payment);
    const w = await wallet();
    assert(balance(w) === 20000, `balance after top-up: ${js(w).slice(0, 400)}`);
  });

  let band;
  await test("C2 the event team registers a wristband and the attendee links it with the codes on the band", async () => {
    const r = await org.call("POST", `/api/staff/events/${ev.id}/tags`, { uids: ["04A1B2C3D4E5F6"] });
    band = r.tags[0];
    assert(band.tagId && band.displayCode && band.activationCode, js(band));
    let wrong = await refused(cust.call("POST", "/api/me/tags/link", { displayCode: band.displayCode, activationCode: band.activationCode === "AAAAAA" ? "BBBBBB" : "AAAAAA", eventId: ev.id }), "4\\d\\d");
    assert(wrong, "a wrong activation code linked the band");
    await cust.call("POST", "/api/me/tags/link", { displayCode: band.displayCode, activationCode: band.activationCode, eventId: ev.id });
    const mine = await cust.call("GET", "/api/me/tags");
    assert(mine.tags.some((x) => x.id === band.tagId && x.status === "active"), `not linked: ${js(mine).slice(0, 300)}`);
  });

  let key, product;
  await test("C3 the organiser adds a stall, its till and a menu item", async () => {
    const v = await org.call("POST", `${O}/vendors`, { name: "Kota King", category: "food", firstTill: "Till 1" });
    key = v.terminal?.terminalKey || v.terminalKey;
    assert(key, `no till key: ${js(v).slice(0, 300)}`);
    product = (await org.call("POST", `${O}/vendors/${v.vendor.id}/products`, { name: "Kota", priceCents: 6500 })).product;
    assert(product?.id, "no product");
  });

  let sale;
  await test("C4 a tap pays from the wallet; the same tap sent twice charges once; more than the balance is declined", async () => {
    const H = { "x-terminal-key": key };
    const k = idem();
    const body = { items: [{ productId: product.id, quantity: 2 }], tagInput: "04A1B2C3D4E5F6", idempotencyKey: k };
    sale = await org.call("POST", "/api/pos/sales", body, undefined, H);
    assert(sale.status === "confirmed" && sale.totalCents === 13000, `sale: ${js(sale).slice(0, 300)}`);
    const again = await org.call("POST", "/api/pos/sales", body, undefined, H);
    assert(again.id === sale.id, `the same tap made a second sale: ${again.id} / ${sale.id}`);
    assert(balance(await wallet()) === 20000 - 13000, `balance after R130: ${balance(await wallet())}`);
    const over = await org.call("POST", "/api/pos/sales", { items: [{ productId: product.id, quantity: 2 }], tagInput: "04A1B2C3D4E5F6", idempotencyKey: idem() }, undefined, H);
    assert(over.status === "declined", `R130 on R70 was not declined: ${js(over).slice(0, 200)}`);
    assert(balance(await wallet()) === 7000, "a declined sale took money");
  });

  await test("C5 the till's balance check shows the amount only", async () => {
    const b = await org.call("POST", "/api/pos/balance", { tagInput: "04A1B2C3D4E5F6" }, undefined, { "x-terminal-key": key });
    assert(b.found === true && b.balanceCents === 7000 && Object.keys(b).sort().join() === "balanceCents,found", js(b));
  });

  await test("C6 a band reported lost is declined at once; the money stays on the account", async () => {
    await cust.call("POST", `/api/me/tags/${band.tagId}/lost`, {});
    const r = await org.call("POST", "/api/pos/sales", { items: [{ productId: product.id, quantity: 1 }], tagInput: "04A1B2C3D4E5F6", idempotencyKey: idem() }, undefined, { "x-terminal-key": key });
    assert(r.status === "declined", `a lost band still paid: ${js(r).slice(0, 200)}`);
    assert(balance(await wallet()) === 7000, "the balance changed");
  });

  await test("C7 once the event is over, the money left is refunded on request and the wallet is then empty", async () => {
    await refused(cust.call("POST", `/api/me/wallets/${ev.id}/refund`, {}), 409);
    php(`q("UPDATE events SET ends_at = ? WHERE id = ?", [iso_in(-600), ${js(ev.id)}]); tm_out(1);`);
    const r = await cust.call("POST", `/api/me/wallets/${ev.id}/refund`, {});
    assert(r.refund.amountCents === 7000, js(r));
    assert(balance(await wallet()) === 0, `balance after refund request: ${balance(await wallet())}`);
  });

  php(`q("UPDATE events SET status = 'draft' WHERE id = ?", [${js(ev.id)}]); tm_out(1);`);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
