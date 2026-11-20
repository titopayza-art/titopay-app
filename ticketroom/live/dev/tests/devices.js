// Linked devices and hardware readers, DV1-DV8:
//   DV1 the organiser links a device for the gate and the top-up desk: a
//       one-time pairing code with its QR, waiting until it is used
//   DV2 a wrong code is refused; the right one links the device, which then
//       sees only its event; the code works once
//   DV3 the device scans a ticket; the scan carries its name; the organiser
//       sees it online with its scan count
//   DV4 the device can reach nothing else (account, orders, organiser tools,
//       changing the account)
//   DV5 the device takes a top-up at the desk; the organiser sees the count
//   DV6 the device session has no 15-minute idle timeout: it lasts to the day
//       after the event
//   DV7 a new code signs the device out at once; unlinking stops it for good
//   DV8 hardware reader input: chip numbers in hex (with or without colons),
//       decimal, reverse byte order and long-range RFID tags become the form
//       the server reads; ticket QR codes and typed ticket codes pass as they are
//
//   node tests/devices.js <dir from serve.sh> [port]
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { Client, sql } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: devices.js <dir from serve.sh> [port]"); process.exit(2); }
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
const idem = () => `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const status = async (p) => { try { await p; return 200; } catch (e) { const m = e.message.match(/-> (\d{3})/); return m ? Number(m[1]) : 0; } };
const one = (q, p = []) => sql(DATA, q, p)[0];

(async () => {
  const ev = php(`$src = row('SELECT * FROM events WHERE id = ?', [${js(SEED.events.paid.id)}]); $id = uuid();
    $src['id'] = $id; $src['slug'] = 'devices-test-' . strtolower(random_code(6)); $src['ref'] = new_ref('events'); $src['title'] = 'Devices Test Night';
    $src['cashless_enabled'] = 1; $src['status'] = 'published'; $src['starts_at'] = iso_in(-1800); $src['ends_at'] = iso_in(5 * 3600);
    insert('events', $src);
    $tt = row('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order LIMIT 1', [${js(SEED.events.paid.id)}]);
    $tt['id'] = uuid(); $tt['event_id'] = $id; $tt['quantity_sold'] = 0; $tt['quantity_held'] = 0; insert('ticket_types', $tt);
    tm_out(['id' => $id, 'slug' => $src['slug'], 'tt' => $tt['id'], 'ends' => $src['ends_at']]);`);
  const org = new Client(BASE, DATA); await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  const O = `/api/organiser/${SEED.organiser.orgId}/events/${ev.id}`;
  const dev = new Client(BASE, DATA);
  let made, deviceId;

  await test("DV1 the organiser links a device for the gate and the top-up desk: a one-time code with its QR", async () => {
    let bad = await status(org.call("POST", `${O}/devices`, { name: "Nothing", canScan: false, canTopup: false }));
    assert(bad === 422, `a device for nothing was made (${bad})`);
    made = await org.call("POST", `${O}/devices`, { name: "Gate 1 handheld", canScan: true, canTopup: true, gate: "North gate" });
    deviceId = made.device.id;
    assert(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/.test(made.code) && made.pairUrl.endsWith(`/scan?pair=${made.code.replace("-", "")}`) && made.qrSvg.startsWith("<svg"), js({ code: made.code, url: made.pairUrl }));
    const list = await org.call("GET", `${O}/devices`);
    assert(list.devices.length === 1 && list.devices[0].status === "pending" && list.devices[0].gate === "North gate", js(list.devices));
  });

  await test("DV2 a wrong code is refused; the right one links the device to its event only; the code works once", async () => {
    assert(await status(dev.call("POST", "/api/devices/pair", { code: "ZZZZ-ZZZZ" })) === 400, "a wrong code linked");
    const r = await dev.call("POST", "/api/devices/pair", { code: made.code.toLowerCase() });
    assert(r.event.id === ev.id && r.device.status === "active", js(r));
    const me = await dev.refreshCsrf();
    assert(me.user.device?.name === "Gate 1 handheld" && me.user.device.eventId === ev.id && me.user.device.gate === "North gate", js(me.user.device));
    const evs = await dev.call("GET", "/api/staff/events");
    assert(evs.events.length === 1 && evs.events[0].id === ev.id, `events: ${evs.events.map((e) => e.title)}`);
    assert(await status(new Client(BASE, DATA).call("POST", "/api/devices/pair", { code: made.code })) === 400, "the code worked twice");
  });

  await test("DV3 the device scans a ticket; the scan carries its name; the organiser sees it online with its count", async () => {
    const buyer = new Client(BASE, DATA);
    const o = await buyer.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ev.tt, quantity: 1 }], guest: { fullName: "Door Guest", email: `door-${Date.now()}@example.test` }, idempotencyKey: idem() });
    const u = new URL(o.payment.redirectUrl, BASE);
    await buyer.call("POST", `/api/public/payments/${u.searchParams.get("p")}/sandbox`, { k: u.searchParams.get("k"), outcome: "paid" });
    const t = php(`$t = row('SELECT t.* FROM tickets t JOIN orders o ON o.id = t.order_id WHERE o.reference = ?', [${js(o.order.reference)}]); q('UPDATE tickets SET test = 0 WHERE id = ?', [$t['id']]); tm_out(['payload' => qr_payload($t), 'id' => $t['id']]);`);
    const scan = await dev.call("POST", "/api/staff/scan", { eventId: ev.id, payload: t.payload, gate: "North gate" });
    assert(scan.outcome === "admitted", js(scan));
    const log = one("SELECT u.full_name, a.gate FROM admission_log a JOIN users u ON u.id = a.scanned_by WHERE a.ticket_id = ?", [t.id]);
    assert(log.full_name === "Gate 1 handheld" && log.gate === "North gate", js(log));
    const d = (await org.call("GET", `${O}/devices`)).devices[0];
    assert(d.status === "active" && d.scans === 1 && d.lastSeenAt, js(d));
  });

  await test("DV4 the device reaches nothing else", async () => {
    const tries = [["GET", "/api/me/tickets"], ["GET", "/api/me/wallets"], ["POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ev.tt, quantity: 1 }], idempotencyKey: idem() }],
      ["PATCH", "/api/auth/me", { fullName: "Hacker" }], ["GET", `${O}/devices`], ["GET", `/api/organiser/${SEED.organiser.orgId}/events`], ["POST", "/api/auth/password", { currentPassword: "x", newPassword: "y" }]];
    for (const [m, p, b] of tries) { const s = await status(dev.call(m, p, b)); assert(s === 403, `${m} ${p} gave ${s}`); }
  });

  await test("DV5 the device takes a top-up at the desk; the organiser sees the count", async () => {
    const guestId = one("SELECT o.user_id FROM orders o WHERE o.event_id = ? AND o.status = 'paid' LIMIT 1", [ev.id]).user_id;
    const r = await dev.call("POST", `/api/cashdesk/events/${ev.id}/topups`, { userId: guestId, amountCents: 10000, method: "cash", idempotencyKey: idem(), receipt: false }, 201);
    assert(r.topup?.reference, js(r));
    const d = (await org.call("GET", `${O}/devices`)).devices[0];
    assert(d.topups === 1, js(d));
  });

  await test("DV6 the device session lasts to the day after the event, with no idle timeout", async () => {
    const s = one("SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.device_id = ? AND s.revoked_at IS NULL", [deviceId]);
    const left = Date.parse(s.expires_at) - Date.parse(ev.ends);
    assert(Math.abs(left - 86400000) < 120000, `expires ${s.expires_at}, event ends ${ev.ends}`);
  });

  await test("DV7 a new code signs the device out at once; unlinking stops it for good", async () => {
    const r = await org.call("POST", `${O}/devices/${deviceId}/code`, {});
    assert(await status(dev.call("GET", "/api/staff/events")) === 401, "still signed in after a new code");
    await dev.call("POST", "/api/devices/pair", { code: r.code });
    await dev.refreshCsrf();
    assert((await dev.call("GET", "/api/staff/events")).events.length === 1, "the new code did not link it");
    await org.call("POST", `${O}/devices/${deviceId}/revoke`, {});
    assert(await status(dev.call("GET", "/api/staff/events")) === 401, "still working after unlinking");
    assert((await org.call("GET", `${O}/devices`)).devices.length === 0, "still listed");
    assert(await status(new Client(BASE, DATA).call("POST", "/api/devices/pair", { code: r.code })) === 400, "a used code linked an unlinked device");
  });

  await test("DV8 hardware reader input becomes the form the server reads", async () => {
    globalThis.window = {}; globalThis.document = { addEventListener() {} };
    const R = await import(pathToFileURL(path.join(DIR, "public_html/assets/reader.js")).href);
    const cases = [
      [{}, "04:A1:B2:C3:D4:E5:F6", "UID:04A1B2C3D4E5F6"], [{}, "04a1b2c3d4e5f6", "UID:04A1B2C3D4E5F6"], [{}, "1A2B3C4D", "UID:1A2B3C4D"],
      [{}, "E2003412012345678901ABCD", "UID:E2003412012345678901ABCD"],
      [{ format: "decimal" }, "0012345678", "UID:00BC614E"], [{ format: "decimal", reverse: true }, "0012345678", "UID:4E61BC00"],
      [{ reverse: true }, "04A1B2C3", "UID:C3B2A104"],
      [{}, "TR1.KCS6V8DTNM.1.abcdefghijklmnopqrstuv", "TR1.KCS6V8DTNM.1.abcdefghijklmnopqrstuv"], [{}, "KCS6V8DTNM", "KCS6V8DTNM"], [{}, "TRT1.abcdefghijklmnop1234", "TRT1.abcdefghijklmnop1234"],
    ];
    for (const [opts, input, want] of cases) {
      R.setReaderOptions({ format: "hex", reverse: false, ...opts });
      const got = R.readerValue(input);
      assert(got === want, `${input} with ${js(opts)} gave ${got}, want ${want}`);
    }
    // The server reads the long-range RFID number as a chip number too.
    const n = php(`tm_out(tag_normalise('UID:E2003412012345678901ABCD'));`);
    assert(n && n.kind === "uid", js(n));
  });

  php(`q("UPDATE events SET status = 'draft' WHERE id = ?", [${js(ev.id)}]); tm_out(1);`);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
