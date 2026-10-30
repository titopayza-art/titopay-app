// Vendors & POS for organisers. Against a local instance from dev/serve.sh:
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/vendors.js <dir> [port]
//
// V1 "Add vendor" is one dialog (a bottom sheet on phones) that creates the
// vendor, invites its contact person as the vendor manager and registers the
// first till, showing the till key once with a Copy button; it is all or
// nothing. V2 the list shows one row per vendor with staff, tills, menu
// items, sales and the commission ("No commission" at 0), and the KPIs add
// up. V3 the organiser manages a vendor's menu with the till's rules (owners
// and managers change it, finance reads it, viewers, marketing and vendor
// cashiers are refused; the vendor manager still can at /api/pos). V4
// "Request settlement" only when money is owed and the event is over, with
// the amount. V5 wristbands and the top-up desk are in their own tab. V6
// cashless off: a draft switches it on, a live event sends a change request.
// V7 phone and desktop: empty state, dialog, list, every vendor section and
// the Wristbands & desk tab without sideways scroll, console errors, em
// dashes or exclamation marks. V8 the admin event page lists the vendors and
// sets the rate. V9 upgrade 55 is in place and safe to run again.
// TR_ONLY=V3 runs one item; TR_VEND_SHOTS=<folder> saves screenshots.
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
const SHOTS = process.env.TR_VEND_SHOTS || "";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: vendors.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).replace(/\s+/g, " ").slice(0, 600)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const js = (v) => JSON.stringify(v);
const one = (q, p = []) => sql(DATA, q, p)[0];
const count = (q, p = []) => Number(Object.values(one(q, p))[0]);
const stamp = Date.now().toString(36);
const PRELUDE = `error_reporting(E_ALL); require $argv[1] . '/public_html/api/bootstrap.php'; tr_load(); tr_load_routes();
function out($v) { echo json_encode($v, JSON_UNESCAPED_SLASHES); }
`;
const php = (code, ...args) => { const o = execFileSync("php", ["-r", PRELUDE + code, DIR, ...args.map(String)], { encoding: "utf8" }); try { return JSON.parse(o || "null"); } catch { return o; } };
const refuses = async (p, status, label) => { try { await p; } catch (e) { assert(new RegExp(`-> ${status}\\b`).test(e.message), `${label}: ${e.message}`); return; } throw new Error(`${label}: was allowed`); };

async function signUp(email, name) {
  const c = new Client(BASE, DATA);
  const password = `Tst-${crypto.randomBytes(12).toString("base64url")}`;
  await c.call("POST", "/api/auth/register", { fullName: name, email, password, marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  c.me = (await c.refreshCsrf()).user;
  c.password = password;
  return c;
}
// A member of the seed organiser's team with the given role.
async function teamMember(role) {
  const c = await signUp(`${role}+${stamp}@example.test`, `${role[0].toUpperCase()}${role.slice(1)} Person`);
  php(`q("UPDATE users SET account_type = 'organiser' WHERE id = ?", [$argv[2]]); insert('organiser_members', ['organiser_id' => $argv[3], 'user_id' => $argv[2], 'role' => $argv[4], 'created_at' => now_iso()]);`, c.me.id, SEED.organiser.orgId, role);
  const s = new Client(BASE, DATA);
  await s.login(c.me.email, c.password, "organiser");
  return s;
}
// A copy of the seed's paid event (published), with its own state.
const makeEvent = (title, { cashless = 1, status = "published", ended = false } = {}) => php(`
  $src = row('SELECT * FROM events WHERE id = ?', [$argv[2]]);
  $ev = $src; $ev['id'] = uuid(); $ev['slug'] = 'vend-' . strtolower(random_code(8)); $ev['ref'] = new_ref('events'); $ev['title'] = $argv[3];
  $ev['cashless_enabled'] = (int) $argv[4]; $ev['status'] = $argv[5]; $ev['created_at'] = $ev['updated_at'] = now_iso();
  if ($argv[6] === '1') { $ev['starts_at'] = iso_in(-2 * 86400); $ev['ends_at'] = iso_in(-86400); }
  insert('events', $ev);
  out(['id' => $ev['id']]);`, SEED.events.paid.id, title, cashless, status, ended ? 1 : 0).id;
// A confirmed (real money) sale at a vendor's first till, posted to the ledger like pos_charge does.
const sale = (vendorId, cents, cashierId) => php(`
  $v = row('SELECT * FROM vendors WHERE id = ?', [$argv[2]]);
  $t = row('SELECT * FROM terminals WHERE vendor_id = ? ORDER BY created_at LIMIT 1', [$v['id']]);
  $total = (int) $argv[3]; $c = bps_of($total, (int) $v['commission_bps']); $ref = reference('PS');
  tx(function () use ($v, $t, $total, $c, $ref) {
    ledger_post('pos_sale', $ref, [[wallet_account($GLOBALS['argv'][4], $v['event_id']), $total], [vendor_account($v), -($total - $c)], [CASHLESS_COMMISSION, -$c]]);
    insert('pos_sales', ['id' => uuid(), 'reference' => $ref, 'event_id' => $v['event_id'], 'vendor_id' => $v['id'], 'terminal_id' => $t['id'], 'cashier_id' => $GLOBALS['argv'][4], 'total_cents' => $total,
      'commission_cents' => $c, 'status' => 'confirmed', 'idempotency_key' => uuid(), 'request_hash' => sha256(uuid()), 'test' => 0, 'created_at' => now_iso()]);
  });
  out(['ref' => $ref, 'commission' => $c]);`, vendorId, cents, cashierId);
const rands = (c) => `R${Math.floor(c / 100).toLocaleString("en-ZA").replace(/[ ,]/g, " ")}.${String(c % 100).padStart(2, "0")}`;

(async () => {
  const ORG = SEED.organiser.orgId;
  const admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const org = new Client(BASE, DATA);
  await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  const OWNER = (await org.refreshCsrf()).user.id;

  const E = makeEvent("Vendor Fair");                                   // live, cashless on, no vendors yet
  const ENDED = makeEvent("Vendor Fair Last Week", { ended: true });   // over: settlements open
  const OFF = makeEvent("Quiet Night", { cashless: 0 });               // live, cashless off
  const DRAFT = makeEvent("Draft Market", { cashless: 0, status: "draft" });
  const oBase = (id) => `/api/organiser/${ORG}/events/${id}`;

  const browser = await chromium.launch({ executablePath: CHROME });
  const PHONE = [390, 844], DESKTOP = [1366, 900];
  const open = async (client, url, size) => {
    const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, isMobile: size[0] < 500, hasTouch: size[0] < 500 });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await ctx.addCookies(Object.entries(client.cookies).map(([name, value]) => ({ name, value, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" })));
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE + url);
    return { ctx, page, errors };
  };
  const goto = async (page, hash, sel) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector(sel, { timeout: 15000 }); await page.waitForTimeout(150); };
  const check = async (page, label) => {
    const r = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, text: (document.querySelector("dialog[open]") || document.querySelector("#main")).innerText }));
    assert(!r.wide, `${label}: sideways scroll`);
    assert(!/—|!/.test(r.text), `${label}: em dash or exclamation mark`);
    assert(!/\b(1 items|1 sales|1 tills|0 sale\b)/.test(r.text), `${label}: wrong plural`);
    return r.text;
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };

  let V1;      // the vendor made through the dialog
  const contact = `bar.manager+${stamp}@example.test`;

  await test("V1 the Add vendor dialog creates the vendor, invites the manager and registers the first till in one go", async () => {
    for (const size of [PHONE, DESKTOP]) {
      const tag = size[0] < 500 ? "phone" : "desktop";
      const o = await open(org, `/organisers#/events/${E}/vendors`, size);
      await o.page.waitForSelector("[data-vendor-guide]", { timeout: 15000 });
      const t = await check(o.page, `empty ${tag}`);
      assert(/Add a vendor/.test(t) && /Invite their staff/.test(t) && /Register a till/.test(t), `guide ${t.slice(0, 400)}`);
      assert(await o.page.locator("[data-vendor-guide] [data-add-vendor]").count() === 1, "Add vendor in the guide");
      await shot(o.page, `1-empty-${tag}`);
      await o.page.click("[data-add-vendor]");
      await o.page.waitForSelector("dialog[open] [data-vendor-form]");
      await o.page.waitForTimeout(400); // the sheet slides up
      const box = await o.page.evaluate(() => { const d = document.querySelector("dialog[open]"); const r = d.getBoundingClientRect(); return { sheet: d.classList.contains("sheet"), bottom: Math.round(r.bottom), width: Math.round(r.width), vh: innerHeight, vw: innerWidth }; });
      assert(box.sheet, "dialog is a sheet");
      if (size === PHONE) assert(Math.abs(box.bottom - box.vh) <= 2 && box.width >= box.vw - 2, `phone bottom sheet ${js(box)}`);
      await check(o.page, `dialog ${tag}`);
      await shot(o.page, `2-add-vendor-dialog-${tag}`);
      if (size === PHONE) { await o.page.click("dialog[open] [data-close]"); await o.ctx.close(); continue; }
      const f = "dialog[open] [data-vendor-form]";
      await o.page.fill(`${f} [name=name]`, "Harbour Bar");
      await o.page.selectOption(`${f} [name=category]`, "bar");
      await o.page.fill(`${f} [name=description]`, "Craft beer and soft drinks");
      await o.page.fill(`${f} [name=contactName]`, "Zodwa Khumalo");
      await o.page.fill(`${f} [name=contactEmail]`, contact);
      await o.page.fill(`${f} [name=contactPhone]`, "082 555 0101");
      await o.page.fill(`${f} [name=firstTill]`, "Main bar till");
      await o.page.click(`${f} button.btn-primary`);
      await o.page.waitForSelector("dialog[open] [data-till-key]", { timeout: 15000 });
      const key = await o.page.inputValue("dialog[open] [data-key]");
      assert(/^trk_/.test(key), `key ${key}`);
      const kt = await check(o.page, "till key dialog");
      assert(/ticketroom\.co\.za\/pos/.test(kt) && /shown only once/.test(kt), `instructions ${kt}`);
      await o.page.click("dialog[open] [data-copy]");
      await o.page.waitForTimeout(200);
      assert(await o.page.evaluate(() => navigator.clipboard.readText()) === key, "Copy key copies the key");
      await shot(o.page, "3-till-key-dialog-desktop");
      await o.page.click("dialog[open] [data-close]");
      await o.page.waitForSelector('[data-vsection="tills"]', { timeout: 15000 });
      assert(await o.page.locator('[data-vsection="tills"]').innerText().then((x) => /Main bar till/.test(x)), "lands on the vendor's tills");
      assert(!o.errors.length, `console ${o.errors.join(" | ")}`);
      await o.ctx.close();
    }
    const v = one("SELECT * FROM vendors WHERE event_id = ? AND name = 'Harbour Bar'", [E]);
    assert(v && v.category === "bar" && v.contact_name === "Zodwa Khumalo" && v.contact_email === contact && v.contact_phone === "+27825550101", `vendor row ${js(v)}`);
    V1 = v.id;
    const m = one("SELECT vm.role, u.full_name, u.account_type FROM vendor_members vm JOIN users u ON u.id = vm.user_id WHERE vm.vendor_id = ?", [V1]);
    assert(m && m.role === "manager" && m.full_name === "Zodwa Khumalo" && m.account_type === "customer", `manager ${js(m)}`);
    assert(outbox(DATA, contact, /\/account#\/reset\/([A-Za-z0-9_-]+)/), "invite email");
    assert(count("SELECT count(*) FROM terminals WHERE vendor_id = ? AND label = 'Main bar till' AND status = 'active'", [V1]) === 1, "till registered");
    // All or nothing: a refused contact leaves no half-made vendor behind.
    const before = count("SELECT count(*) FROM vendors WHERE event_id = ?", [E]);
    await refuses(org.call("POST", `${oBase(E)}/vendors`, { name: "Ghost Stall", category: "food", contactName: "Staff Person", contactEmail: ADMIN_EMAIL, contactPhone: "0825550102", firstTill: "Till 1" }), 409, "staff email as contact");
    await refuses(org.call("POST", `${oBase(E)}/vendors`, { name: "Ghost Stall", category: "food", contactName: "Some One", contactEmail: "x@example.test", contactPhone: "12345" }), 422, "bad mobile");
    assert(count("SELECT count(*) FROM vendors WHERE event_id = ?", [E]) === before, "nothing created on refusal");
    // The old one-field call (used elsewhere) still works.
    await org.call("POST", `${oBase(E)}/vendors`, { name: "Kasi Kitchen", description: "Bunny chow and vetkoek" }, 201);
  });

  // Vendor manager and cashier logins for V3.
  const mgrPw = `Tst-${crypto.randomBytes(12).toString("base64url")}`;
  php(`q('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?', [hash_secret($argv[2]), now_iso(), $argv[3]]);`, mgrPw, contact);
  const manager = new Client(BASE, DATA);
  if (V1) await manager.login(contact, mgrPw);
  const cashier = await signUp(`cashier+${stamp}@example.test`, "Thabo Cashier");
  if (V1) await org.call("POST", `${oBase(E)}/vendors/${V1}/members`, { email: cashier.me.email, role: "cashier" }, 201);
  const finance = await teamMember("finance");
  const viewer = await teamMember("viewer");
  const marketing = await teamMember("marketing");

  await test("V3 the organiser manages a vendor's menu with the till's rules; finance reads it; viewer, marketing and cashiers are refused", async () => {
    assert(V1, "needs V1");
    const P = `${oBase(E)}/vendors/${V1}/products`;
    const a = (await org.call("POST", P, { name: "Lager", priceCents: 4500 }, 201)).product;
    const b = (await org.call("POST", P, { name: "Still water", priceCents: 2000 }, 201)).product;
    await refuses(org.call("POST", P, { name: "Too cheap", priceCents: 50 }), 422, "price under R1 (POS rule)");
    const edited = (await org.call("PATCH", `${P}/${a.id}`, { priceCents: 5000 })).product;
    assert(edited.price_cents === 5000 && !!edited.active, `edit price keeps the item on sale ${js(edited)}`);
    assert((await org.call("PATCH", `${P}/${b.id}`, { active: false })).product.active == false, "hide");
    const list = (await org.call("GET", P)).products;
    assert(list.length === 2 && list[0].name === "Lager" && !list[1].active, `list ${js(list)}`);
    assert(count("SELECT count(*) FROM audit_log WHERE action IN ('product.created','product.updated') AND entity_id IN (?, ?)", [a.id, b.id]) >= 4, "audited");
    // The vendor manager still runs the same menu at the till.
    const pm = (await manager.call("POST", `/api/pos/vendors/${V1}/products`, { name: "Cider", priceCents: 5500 }, 201)).product;
    assert((await manager.call("GET", `/api/pos/vendors/${V1}/products`)).products.length === 3, "till sees all items");
    await manager.call("PATCH", `/api/pos/vendors/${V1}/products/${pm.id}`, { priceCents: 6000 });
    // Finance: read-only.
    assert((await finance.call("GET", P)).products.length === 3, "finance reads the menu");
    await refuses(finance.call("POST", P, { name: "Nope", priceCents: 1000 }), 403, "finance adds");
    await refuses(finance.call("PATCH", `${P}/${a.id}`, { priceCents: 100 }), 403, "finance edits");
    // Viewer and marketing: refused.
    for (const [who, c] of [["viewer", viewer], ["marketing", marketing]]) {
      await refuses(c.call("GET", P), 403, `${who} reads`);
      await refuses(c.call("POST", P, { name: "Nope", priceCents: 1000 }), 403, `${who} adds`);
    }
    // Vendor cashier: not on the organiser's team, and not a menu manager at the till.
    await refuses(cashier.call("GET", P), 404, "cashier, organiser route");
    await refuses(cashier.call("PATCH", `${P}/${a.id}`, { priceCents: 100 }), 404, "cashier, organiser edit");
    await refuses(cashier.call("POST", `/api/pos/vendors/${V1}/products`, { name: "Nope", priceCents: 1000 }), 403, "cashier, till add");
    // Another vendor's product cannot be reached through this vendor.
    const other = (await org.call("GET", `${oBase(E)}/vendors`)).vendors.find((v) => v.name === "Kasi Kitchen");
    await refuses(org.call("PATCH", `${oBase(E)}/vendors/${other.id}/products/${a.id}`, { priceCents: 9900 }), 404, "cross-vendor edit");
    // In the browser: owner adds, edits and hides; finance sees no buttons.
    const o = await open(org, `/organisers#/events/${E}/vendors/${V1}/menu`, DESKTOP);
    await o.page.waitForSelector("[data-menu]", { timeout: 15000 });
    await o.page.click("[data-add-item]");
    await o.page.fill("dialog[open] [name=name]", "Rooibos iced tea");
    await o.page.fill("dialog[open] [name=price]", "32.50");
    await o.page.click("dialog[open] button.btn-primary");
    await o.page.waitForSelector('[data-product] >> text=Rooibos iced tea', { timeout: 15000 });
    const tea = one("SELECT id, price_cents FROM products WHERE vendor_id = ? AND name = 'Rooibos iced tea'", [V1]);
    assert(tea && tea.price_cents === 3250, `tea ${js(tea)}`);
    await o.page.click(`[data-price="${tea.id}"]`);
    await o.page.fill("dialog[open] [name=price]", "35");
    await o.page.click("dialog[open] button.btn-primary");
    await o.page.waitForFunction((id) => /R35\.00/.test(document.querySelector(`[data-product="${id}"]`)?.innerText || ""), tea.id, { timeout: 15000 });
    await o.page.click(`[data-show="${tea.id}"]`);
    await o.page.waitForFunction((id) => /Hidden/.test(document.querySelector(`[data-product="${id}"]`)?.innerText || ""), tea.id, { timeout: 15000 });
    assert(one("SELECT active FROM products WHERE id = ?", [tea.id]).active === 0, "hidden in the database");
    assert(!o.errors.length, `console ${o.errors.join(" | ")}`);
    await o.ctx.close();
    const f = await open(finance, `/organisers#/events/${E}/vendors/${V1}/menu`, DESKTOP);
    await f.page.waitForSelector("[data-menu]", { timeout: 15000 });
    assert(await f.page.locator("[data-add-item], [data-price], [data-show], [data-vstatus], [data-add-vendor]").count() === 0, "finance sees no edit buttons");
    await f.ctx.close();
    const w = await open(viewer, `/organisers#/events/${E}/vendors/${V1}/menu`, DESKTOP);
    await w.page.waitForSelector('[data-vsection="menu"] .card', { timeout: 15000 });
    assert(/can see the menu/.test(await w.page.locator('[data-vsection="menu"]').innerText()), "viewer told who can see it");
    assert(!w.errors.length, `viewer console ${w.errors.join(" | ")}`);
    await w.ctx.close();
  });

  await test("V2 the list shows each vendor's staff, tills, menu items, sales and commission, and the KPIs add up", async () => {
    assert(V1, "needs V1");
    const s1 = sale(V1, 12000, OWNER);
    sale(V1, 4550, OWNER);
    let { vendors } = await org.call("GET", `${oBase(E)}/vendors`);
    let v = vendors.find((x) => x.id === V1);
    assert(v.members.length === 2 && v.terminals.length === 1 && v.products_count === 2 && v.products_hidden === 2 && v.gross_cents === 16550 && v.sales === 2, `counts ${js({ m: v.members.length, t: v.terminals.length, p: v.products_count, h: v.products_hidden, g: v.gross_cents })}`);
    assert(s1.commission === 0 && v.commission_bps === 0, "default commission is 0 here");
    // The admin sets a rate on the admin event page's API (the existing route).
    await admin.call("PATCH", `/api/admin/cashless/vendors/${V1}/commission`, { commissionBps: 500 });
    sale(V1, 10000, OWNER); // 5% = R5.00
    ({ vendors } = await org.call("GET", `${oBase(E)}/vendors`));
    v = vendors.find((x) => x.id === V1);
    for (const size of [PHONE, DESKTOP]) {
      const tag = size[0] < 500 ? "phone" : "desktop";
      const o = await open(org, `/organisers#/events/${E}/vendors`, size);
      await o.page.waitForSelector("[data-vendor-list]", { timeout: 15000 });
      const row = async (id) => o.page.evaluate((id) => Object.fromEntries([...document.querySelectorAll(`[data-vendor="${id}"] [data-stat]`)].map((e) => [e.dataset.stat, e.textContent.trim()])), id);
      const r1 = await row(V1);
      assert(js(r1) === js({ staff: "2", tills: "1", menu: "2", sales: rands(26550), commission: "5%" }), `row ${js(r1)}`);
      const kasi = vendors.find((x) => x.name === "Kasi Kitchen");
      const r2 = await row(kasi.id);
      assert(js(r2) === js({ staff: "0", tills: "0", menu: "0", sales: "R0.00", commission: "No commission" }), `row 2 ${js(r2)}`);
      const kasiText = await o.page.locator(`[data-vendor="${kasi.id}"]`).innerText();
      assert(/No menu yet/.test(kasiText) && /No till yet/.test(kasiText) && /Manage/.test(kasiText), `kasi ${kasiText}`);
      const k = await o.page.locator("[data-vendor-kpis]").innerText();
      assert(/Vendors\s*2/i.test(k) && /Tills active\s*1/i.test(k) && k.includes(rands(26550)) && k.includes("R5.00") && /3 sales/.test(k), `kpis ${k}`);
      const owed = 26550 - 500;
      assert(k.includes(rands(owed)), `owed ${k}`);
      // Old clutter is gone: no forms in the list, no lowercase action links.
      assert(await o.page.locator("#tab form").count() === 0, "no always-open forms");
      assert(await o.page.locator("#tab .btn-link").count() === 0, "no link-style actions");
      assert(await o.page.locator("[data-add-vendor]").count() === 1, "one Add vendor button");
      await check(o.page, `list ${tag}`);
      await shot(o.page, `4-list-${tag}`);
      assert(!o.errors.length, `console ${o.errors.join(" | ")}`);
      await o.ctx.close();
    }
  });

  await test("V4 Request settlement shows only when money is owed and the event is over, with the amount", async () => {
    assert(V1, "needs V1");
    // E has not ended: money owed, but no button, and a note.
    const o = await open(org, `/organisers#/events/${E}/vendors/${V1}/settlement`, DESKTOP);
    await o.page.waitForSelector('[data-vsection="settlement"] .card', { timeout: 15000 }).catch((e) => { throw new Error(`${e.message} ${o.errors.join(" | ")}`); });
    assert(await o.page.locator("[data-vpay]").count() === 0, "no button before the event ends");
    assert(/once the event ends/.test(await o.page.locator(".vendor-head").innerText()), "note before the end");
    await o.ctx.close();
    // An event that is over: a vendor with nothing owed has no button; one with sales has it, with the amount.
    const quiet = (await org.call("POST", `${oBase(ENDED)}/vendors`, { name: "Quiet Stall", category: "food", firstTill: "Till 1" }, 201)).vendor;
    const busy = (await org.call("POST", `${oBase(ENDED)}/vendors`, { name: "Busy Stall", category: "drinks", firstTill: "Till 1" }, 201)).vendor;
    sale(busy.id, 7525, OWNER);
    const p = await open(org, `/organisers#/events/${ENDED}/vendors/${quiet.id}`, DESKTOP);
    await p.page.waitForSelector(".vendor-head", { timeout: 15000 });
    assert(await p.page.locator("[data-vpay]").count() === 0, "no button when nothing is owed");
    await goto(p.page, `#/events/${ENDED}/vendors/${busy.id}/settlement`, `[data-vendor-page="${busy.id}"] [data-vsection="settlement"] .card`);
    const btn = p.page.locator("[data-vpay]");
    assert(await btn.count() === 1 && (await btn.innerText()).trim() === "Request settlement of R75.25", `button ${await btn.innerText().catch(() => "")}`);
    const st = await check(p.page, "settlement");
    assert(/Owed now\s*R75\.25/i.test(st) && /No settlements yet/.test(st), `settlement ${st}`);
    // Finance can request it too; marketing, viewer and managers do not see it.
    for (const [who, c, shown] of [["finance", finance, 1], ["viewer", viewer, 0]]) {
      const q = await open(c, `/organisers#/events/${ENDED}/vendors/${busy.id}`, DESKTOP);
      await q.page.waitForSelector(".vendor-head", { timeout: 15000 });
      assert(await q.page.locator("[data-vpay]").count() === shown, `${who} button`);
      await q.ctx.close();
    }
    // Once a settlement is in flight for the whole amount, the button goes.
    php(`$v = row('SELECT * FROM vendors WHERE id = ?', [$argv[2]]); insert('payouts', ['id' => uuid(), 'reference' => reference('PO'), 'organiser_id' => $v['organiser_id'], 'vendor_id' => $v['id'], 'amount_cents' => 7525, 'status' => 'requested', 'note' => 'test', 'created_at' => now_iso(), 'updated_at' => now_iso()]);`, busy.id);
    await p.page.reload();
    await p.page.waitForSelector('[data-vsection="settlement"] .card', { timeout: 15000 });
    assert(await p.page.locator("[data-vpay]").count() === 0, "no button once requested");
    const h = await p.page.locator('[data-vsection="settlement"]').innerText();
    assert(/Being paid\s*R75\.25/i.test(h) && /Requested/.test(h), `history ${h}`);
    assert(!p.errors.length, `console ${p.errors.join(" | ")}`);
    await p.ctx.close();
  });

  await test("V5 wristbands and the top-up desk are in their own Wristbands & desk tab", async () => {
    for (const size of [PHONE, DESKTOP]) {
      const tag = size[0] < 500 ? "phone" : "desktop";
      const o = await open(org, `/organisers#/events/${E}/vendors`, size);
      await o.page.waitForSelector("[data-vendor-list]", { timeout: 15000 });
      const tabs = await o.page.$$eval('.tabs [role="tab"]', (els) => els.map((e) => e.textContent.trim()));
      assert(tabs.includes("Vendors & POS") && tabs.includes("Wristbands & desk"), `tabs ${tabs}`);
      const vt = await o.page.locator("#tab").innerText();
      assert(!/Wristbands|Top-up desk|Register wristbands/.test(vt), "vendors tab has no wristbands or desk");
      await goto(o.page, `#/events/${E}/wristbands`, "#bf");
      await o.page.waitForSelector("[data-desk]", { timeout: 15000 });
      const wt = await check(o.page, `wristbands ${tag}`);
      assert(/Wristbands/.test(wt) && /Register wristbands/.test(wt) && /Top-up desk and cash-out/.test(wt) && /Open the top-up desk/.test(wt), `tab ${wt.slice(0, 300)}`);
      assert(await o.page.locator('.tabs [aria-selected="true"]').innerText() === "Wristbands & desk", "tab selected");
      await shot(o.page, `9-wristbands-desk-${tag}`);
      assert(!o.errors.length, `console ${o.errors.join(" | ")}`);
      await o.ctx.close();
    }
  });

  await test("V6 cashless off: a draft switches it on; a live event sends a change request to TicketRoom", async () => {
    const o = await open(org, `/organisers#/events/${OFF}/vendors`, PHONE);
    await o.page.waitForSelector("[data-cashless-off]", { timeout: 15000 });
    const t = await check(o.page, "off live");
    assert(/Cashless is off/.test(t) && /reviews this change first/.test(t) && !/under Details to use/.test(t), `callout ${t.slice(0, 300)}`);
    await o.page.click("[data-cashless-on]");
    await o.page.waitForSelector("dialog[open] [data-cashless-form]");
    const dt = await check(o.page, "off dialog");
    assert(/change request/.test(dt) && /email/.test(dt), `dialog ${dt}`);
    await shot(o.page, "8-cashless-request-phone");
    await o.page.click("dialog[open] button.btn-primary");
    await o.page.waitForFunction(() => /You asked TicketRoom to switch it on/.test(document.querySelector("[data-cashless-off]")?.innerText || ""), null, { timeout: 15000 });
    const cr = one("SELECT status, changes_json AS changes FROM event_change_requests WHERE event_id = ?", [OFF]);
    assert(cr && cr.status === "pending" && JSON.parse(cr.changes).event.cashlessEnabled === true, `request ${js(cr)}`);
    assert(one("SELECT cashless_enabled FROM events WHERE id = ?", [OFF]).cashless_enabled === 0, "live event unchanged until approved");
    assert(await o.page.locator("[data-cashless-on]").count() === 0, "no second request");
    // The Wristbands & desk tab says the same.
    await goto(o.page, `#/events/${OFF}/wristbands`, "[data-cashless-off]");
    assert(/You asked TicketRoom/.test(await o.page.locator("[data-cashless-off]").innerText()), "wristbands tab notice");
    await o.ctx.close();
    // A draft switches straight on.
    const q = await open(org, `/organisers#/events/${DRAFT}/vendors`, DESKTOP);
    await q.page.waitForSelector("[data-cashless-on]", { timeout: 15000 });
    assert((await q.page.locator("[data-cashless-on]").innerText()).trim() === "Switch on cashless", "draft button");
    await q.page.click("[data-cashless-on]");
    await q.page.waitForSelector("[data-vendor-guide]", { timeout: 15000 });
    await q.page.waitForFunction(() => !document.querySelector("[data-cashless-off]"), null, { timeout: 15000 });
    assert(one("SELECT cashless_enabled FROM events WHERE id = ?", [DRAFT]).cashless_enabled === 1, "draft switched on");
    assert(!q.errors.length && !o.errors.length, `console ${[...o.errors, ...q.errors].join(" | ")}`);
    await q.ctx.close();
    // Viewers are told to ask an owner or manager.
    const w = await open(viewer, `/organisers#/events/${OFF}/vendors`, DESKTOP);
    await w.page.waitForSelector("[data-cashless-off]", { timeout: 15000 });
    assert(await w.page.locator("[data-cashless-on]").count() === 0, "viewer has no button");
    await w.ctx.close();
  });

  await test("V7 the vendor page's sections, staff and till dialogs work on phone and desktop without sideways scroll", async () => {
    assert(V1, "needs V1");
    for (const size of [PHONE, DESKTOP]) {
      const tag = size[0] < 500 ? "phone" : "desktop";
      const o = await open(org, `/organisers#/events/${E}/vendors/${V1}`, size);
      await o.page.waitForSelector('[data-vsection="staff"] .card', { timeout: 15000 });
      const head = await o.page.locator(".vendor-head").innerText();
      assert(/Harbour Bar/.test(head) && /Bar \(alcohol\)/.test(head) && /Zodwa Khumalo/.test(head) && /Commission: 5%/.test(head) && /Suspend vendor/.test(head), `head ${head}`);
      for (const [sec, want] of [["staff", /Zodwa Khumalo[\s\S]*Manager[\s\S]*Thabo Cashier[\s\S]*Cashier/], ["tills", /Main bar till[\s\S]*(Last seen|Not used yet)[\s\S]*Active/], ["menu", /Lager[\s\S]*R50\.00/], ["sales", /Today[\s\S]*Overall[\s\S]*R265\.50[\s\S]*3 sales[\s\S]*Recent sales/i], ["settlement", /Owed now[\s\S]*History/i]]) {
        await goto(o.page, `#/events/${E}/vendors/${V1}/${sec}`, `[data-vsection="${sec}"] .card`);
        const t = await check(o.page, `${sec} ${tag}`);
        assert(want.test(t), `${sec} ${tag}: ${t.slice(0, 500)}`);
        assert(await o.page.locator(`.chips [aria-current="page"]`).getAttribute("data-vsec") === sec, `${sec} chip current`);
        await shot(o.page, `5-detail-${sec}-${tag}`);
      }
      // Tap targets for the actions.
      const small = await o.page.$$eval(".vendor-head button, .chips a", (els) => els.filter((e) => e.getBoundingClientRect().height < 36).map((e) => e.textContent.trim()));
      assert(!small.length, `small targets ${small}`);
      if (size === PHONE) {
        // Add staff and register a till through the dialogs.
        await goto(o.page, `#/events/${E}/vendors/${V1}/staff`, "[data-add-staff]");
        await o.page.click("[data-add-staff]");
        await o.page.fill("dialog[open] [name=email]", `runner+${stamp}@example.test`);
        await o.page.click("dialog[open] button.btn-primary");
        await o.page.waitForFunction((e) => document.querySelector('[data-vsection="staff"]')?.innerText.includes(e), `runner+${stamp}@example.test`, { timeout: 15000 });
        const runner = one("SELECT u.id FROM users u JOIN vendor_members vm ON vm.user_id = u.id WHERE u.email = ? AND vm.role = 'cashier'", [`runner+${stamp}@example.test`]);
        assert(runner, "staff added as cashier");
        await o.page.click(`[data-remove="${runner.id}"]`);
        await o.page.click("dialog[open] button.btn-danger");
        await o.page.waitForFunction((e) => !document.querySelector('[data-vsection="staff"]')?.innerText.includes(e), `runner+${stamp}@example.test`, { timeout: 15000 });
        await goto(o.page, `#/events/${E}/vendors/${V1}/tills`, "[data-add-till]");
        await o.page.click("[data-add-till]");
        assert(await o.page.inputValue("dialog[open] [name=label]") === "Till 2", "suggested name");
        await shot(o.page, "6b-register-till-dialog-phone");
        await o.page.click("dialog[open] button.btn-primary");
        await o.page.waitForSelector("dialog[open] [data-till-key]", { timeout: 15000 });
        await check(o.page, "till key phone");
        await shot(o.page, "6c-till-key-phone");
        await o.page.click("dialog[open] [data-close]");
        await o.page.waitForFunction(() => /Till 2/.test(document.querySelector('[data-vsection="tills"]')?.innerText || ""), null, { timeout: 15000 });
        const t2 = one("SELECT id FROM terminals WHERE vendor_id = ? AND label = 'Till 2'", [V1]).id;
        await o.page.click(`[data-tstatus="${t2}"]`);
        await o.page.waitForFunction((id) => /Suspended/.test(document.querySelector(`[data-till="${id}"]`)?.innerText || ""), t2, { timeout: 15000 });
        assert(one("SELECT status FROM terminals WHERE id = ?", [t2]).status === "suspended", "till suspended");
        assert((await o.page.locator(`[data-tstatus="${t2}"]`).innerText()).trim() === "Reactivate", "Reactivate label");
        // Suspend the vendor (confirmed), then reactivate.
        await o.page.click("[data-vstatus]");
        await o.page.click("dialog[open] button.btn-danger");
        await o.page.waitForFunction(() => /Reactivate vendor/.test(document.querySelector("[data-vendor-actions]")?.innerText || ""), null, { timeout: 15000 });
        assert(one("SELECT status FROM vendors WHERE id = ?", [V1]).status === "suspended", "vendor suspended");
        await o.page.click("[data-vstatus]");
        await o.page.waitForFunction(() => /Suspend vendor/.test(document.querySelector("[data-vendor-actions]")?.innerText || ""), null, { timeout: 15000 });
        // Back to the list.
        await o.page.click("[data-back]");
        await o.page.waitForSelector("[data-vendor-list]", { timeout: 15000 });
      }
      assert(!o.errors.length, `console ${o.errors.join(" | ")}`);
      await o.ctx.close();
    }
  });

  await test("V8 the admin event page lists the vendors read-only and sets the commission rate; the wallets page still does", async () => {
    assert(V1, "needs V1");
    const { vendors } = await admin.call("GET", `/api/admin/events/${E}/vendors`);
    assert(vendors.length === 2 && vendors.find((v) => v.id === V1).products_count === 2, `admin api ${vendors.length}`);
    await refuses(org.call("GET", `/api/admin/events/${E}/vendors`), "40[134]", "organiser on admin route");
    for (const size of [PHONE, DESKTOP]) {
      const a = await open(admin, `/admin#/events/${E}`, size);
      await a.page.waitForSelector(`[data-vendors] [data-vendor="${V1}"]`, { timeout: 15000 });
      const t = await a.page.locator("[data-vendors]").innerText();
      assert(/Harbour Bar/.test(t) && /Kasi Kitchen/.test(t) && /5%/.test(t) && /No commission/.test(t), `admin vendors ${t}`);
      assert(await a.page.locator("[data-vendors] [data-add-vendor], [data-vendors] form").count() === 0, "read-only");
      await check(a.page, `admin ${size[0]}`);
      if (size === DESKTOP) {
        await a.page.click(`[data-vendors] [data-vfee="${V1}"]`);
        await a.page.fill("dialog[open] #cd-in", "7.5");
        await a.page.click("dialog[open] button.btn-dark");
        await a.page.waitForFunction((id) => /7\.5%/.test(document.querySelector(`[data-vendors] [data-vendor="${id}"]`)?.innerText || ""), V1, { timeout: 15000 });
        assert(one("SELECT commission_bps FROM vendors WHERE id = ?", [V1]).commission_bps === 750, "rate saved");
        await shot(a.page, "10-admin-event-vendors-desktop");
        await goto(a.page, "#/wallets", "[data-vfee]");
        assert(await a.page.locator(`[data-vfee="${V1}"]`).count() === 1, "wallets page rate tool");
      }
      assert(!a.errors.length, `console ${a.errors.join(" | ")}`);
      await a.ctx.close();
    }
  });

  await test("V9 upgrade 55 adds the vendor columns and is safe to run again", () => {
    const cols = sql(DATA, "SELECT name FROM pragma_table_info('vendors')").map((r) => r.name);
    for (const c of ["category", "contact_name", "contact_email", "contact_phone"]) assert(cols.includes(c), `column ${c}`);
    assert(Number(one("SELECT value FROM meta WHERE key = 'schema_version'").value) >= 55, "schema version");
    const r = php(`foreach (UPGRADES[55] as $s) { try { db()->exec($s); } catch (PDOException $e) { if (!str_contains($e->getMessage(), 'duplicate column name')) throw $e; } } out(in_array('55', explode(',', (string) val("SELECT value FROM meta WHERE key = 'upgrades_done'")), true) || (int) val("SELECT value FROM meta WHERE key = 'schema_version'") >= 55);`);
    assert(r === true, `rerun ${js(r)}`);
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
