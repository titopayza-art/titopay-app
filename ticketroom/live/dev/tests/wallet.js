// Apple Wallet and Google Wallet passes, against a harness instance.
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/wallet.js <dir> [port]
//
// Makes a throwaway certificate chain with openssl (test root, test "WWDR"
// intermediate, pass certificate as a .p12) and a fake Google service account
// key, saves them in Admin > Integrations > Apple Wallet and Google Wallet,
// and checks: buttons hidden until set up (and per device after), secrets
// write-only and encrypted, the Test button in plain words, the .pkpass zip
// (files, pass.json fields and colours, manifest hashes, a detached PKCS#7
// signature that openssl verifies against the test root, with Apple's WWDR
// G4 intermediate included), the Google "Add to Google Wallet" JWT (verifies
// with the key, right fields), other people's tickets refused, the order
// page's private-link routes, the Apple pass web service (register, fetch,
// push) and voiding after a transfer and after a refund (Apple voided pass,
// Google object INACTIVE). Stand-ins for Google (token + Wallet API) and
// Apple push (HTTP/2) listen on 127.0.0.1:8820 and 8821 (TR_WALLET_MOCK_PORTS=a,b).
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const http2 = require("http2");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { Client, outbox, sql } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json")) || !ADMIN_PW) { console.error("usage: TR_TEST_ADMIN_PASSWORD=... wallet.js <dir from serve.sh> [port]"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const [GPORT, APORT] = (process.env.TR_WALLET_MOCK_PORTS || "8820,8821").split(",").map(Number);
const LIB = path.join(__dirname, "money-lib.php");
const ENV = { ...process.env, no_proxy: "localhost,127.0.0.1", NO_PROXY: "localhost,127.0.0.1" };
const PASS_TYPE = "pass.za.co.ticketroom.test";
const TEAM = "TEST123456";
const ISSUER = "3388000000099887766";

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).split("\n")[0].slice(0, 500)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const js = (v) => JSON.stringify(v);
function php(code) {
  let out;
  try { out = execFileSync("php", ["-r", `require ${js(LIB)}; tm_boot(${js(DIR)}); ${code}`], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`PHP failed: ${(e.stderr || "") + (e.stdout || "")}`.slice(0, 1500)); }
  const m = out.match(/@@TM@@(.*)\n?$/m);
  if (!m) throw new Error(`PHP gave no result: ${out.slice(0, 800)}`);
  return JSON.parse(m[1]);
}
// The 'wallet-updates' job, run here (asynchronously: it calls the stand-ins in this process).
const execFileP = require("util").promisify(require("child_process").execFile);
const sync = async () => { const r = await execFileP("php", ["-r", `require ${js(LIB)}; tm_boot(${js(DIR)}); echo "@@N" . wallet_sync();`], { encoding: "utf8", env: ENV }); if (r.stderr) console.log(r.stderr.trim()); return Number(r.stdout.split("@@N").pop()); };
async function status(p) { try { await p; return 200; } catch (e) { return Number(/-> (\d{3})/.exec(e.message)?.[1] || 0); } }

// ---------------------------------------------------------------- test credentials
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tr-wallet-"));
const P12_PW = "p12-" + crypto.randomBytes(6).toString("hex");
function ossl(...args) { return execFileSync("openssl", args, { cwd: TMP, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function makeCerts() {
  fs.writeFileSync(path.join(TMP, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  fs.writeFileSync(path.join(TMP, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
  ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-subj", "/CN=TicketRoom Test Root", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ossl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "inter.key", "-out", "inter.csr", "-subj", "/CN=TicketRoom Test WWDR");
  ossl("x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "inter.pem", "-days", "2", "-extfile", "ca.ext");
  ossl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/UID=${PASS_TYPE}/CN=Pass Type ID: ${PASS_TYPE}/OU=${TEAM}/O=TicketRoom Test/C=ZA`);
  ossl("x509", "-req", "-in", "leaf.csr", "-CA", "inter.pem", "-CAkey", "inter.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext");
  ossl("pkcs12", "-export", "-inkey", "leaf.key", "-in", "leaf.pem", "-certfile", "inter.pem", "-passout", `pass:${P12_PW}`, "-out", "pass.p12");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { type: "service_account", project_id: "tr-wallet-test", private_key_id: crypto.randomBytes(20).toString("hex"), client_email: "wallet@tr-wallet-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }), client_id: "1", token_uri: `http://127.0.0.1:${GPORT}/token` };
  return { p12: fs.readFileSync(path.join(TMP, "pass.p12")).toString("base64"), sa, publicKey };
}

// ---------------------------------------------------------------- stand-ins
const calls = { token: 0, patch: [], push: [] };
function mocks() {
  const g = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/token" && req.method === "POST") { calls.token++; res.writeHead(200, { "content-type": "application/json" }); return res.end(js({ access_token: "test-token", expires_in: 3600 })); }
      const m = req.url.match(/^\/walletobjects\/v1\/eventTicketObject\/(.+)$/);
      if (m && req.method === "PATCH") { calls.patch.push({ id: decodeURIComponent(m[1]), body: JSON.parse(body || "{}"), auth: req.headers.authorization }); res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
      console.log(`  (Google stand-in: no route for ${req.method} ${req.url})`); res.writeHead(404); res.end();
    });
  });
  const a = http2.createServer();
  a.on("stream", (stream, h) => { calls.push.push({ path: h[":path"], topic: h["apns-topic"] }); stream.respond({ ":status": 200 }); stream.end(); });
  return Promise.all([new Promise((r) => g.listen(GPORT, "127.0.0.1", r)), new Promise((r) => a.listen(APORT, "127.0.0.1", r))]).then(() => [g, a]);
}
// Points the instance's Google and Apple push calls at the stand-ins (config.php, test only).
const CONFIG = path.join(DATA, "config.php");
const configBefore = fs.readFileSync(CONFIG, "utf8");
function setConfig() {
  fs.writeFileSync(CONFIG, configBefore.replace(/\n\];\s*$/, `\n    'wallet' => ['googleApiBase' => 'http://127.0.0.1:${GPORT}', 'googleTokenUrl' => 'http://127.0.0.1:${GPORT}/token', 'apnsBase' => 'http://127.0.0.1:${APORT}'],\n];\n`));
}

// ---------------------------------------------------------------- pkpass helpers
function unzip(buf) {
  const files = {}; let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), size = buf.readUInt32LE(i + 18), nlen = buf.readUInt16LE(i + 26), xlen = buf.readUInt16LE(i + 28);
    if (method !== 0) throw new Error("compressed entry");
    const name = buf.slice(i + 30, i + 30 + nlen).toString();
    files[name] = buf.slice(i + 30 + nlen + xlen, i + 30 + nlen + xlen + size);
    i += 30 + nlen + xlen + size;
  }
  return files;
}
async function fetchBin(c, p, headers = {}) {
  const h = { ...headers }; const ck = c && c.cookieHeader(); if (ck) h.cookie = ck;
  const r = await fetch(BASE + p, { headers: h });
  return { status: r.status, type: r.headers.get("content-type"), buf: Buffer.from(await r.arrayBuffer()) };
}
function verifySignature(files) {
  fs.writeFileSync(path.join(TMP, "manifest.json"), files["manifest.json"]);
  fs.writeFileSync(path.join(TMP, "signature"), files.signature);
  ossl("smime", "-verify", "-binary", "-inform", "DER", "-in", "signature", "-content", "manifest.json", "-CAfile", "root.pem", "-purpose", "any", "-out", "verified.out");
  return ossl("pkcs7", "-inform", "DER", "-in", "signature", "-print_certs", "-noout");
}
function decodeJwt(url, publicKey) {
  const jwt = url.replace("https://pay.google.com/gp/v/save/", "");
  const [h, b, s] = jwt.split(".");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(b, "base64url")) };
}

// A published free event (copied from the seeded one) to book tickets for.
function freeEvent() {
  const r = php(`$src = row("SELECT * FROM events WHERE id = ?", [${js(SEED.events.free.id)}]); $id = uuid(); $tag = bin2hex(random_bytes(4));
    $src['id'] = $id; $src['slug'] = 'wallet-test-' . $tag; $src['ref'] = null; $src['title'] = 'Wallet test ' . $tag; $src['starts_at'] = iso_in(5 * 86400); $src['ends_at'] = iso_in(5 * 86400 + 4 * 3600);
    $src['created_at'] = $src['updated_at'] = now_iso(); insert('events', array_filter($src, fn($v) => $v !== null));
    $tt = row('SELECT * FROM ticket_types WHERE event_id = ? LIMIT 1', [${js(SEED.events.free.id)}]); $tt['id'] = uuid(); $tt['event_id'] = $id; $tt['quantity_sold'] = 0; $tt['quantity_held'] = 0; $tt['quantity_total'] = 100; $tt['release_after'] = null; $tt['sales_start_at'] = null; $tt['sales_end_at'] = null;
    insert('ticket_types', array_filter($tt, fn($v) => $v !== null)); tm_out(['slug' => $src['slug'], 'ttId' => $tt['id'], 'id' => $id]);`);
  return r;
}
const book = (c, ev) => c.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ev.ttId, quantity: 1 }], idempotencyKey: uuid() });
async function signUp(label) {
  const email = `wallet-${label}+${Date.now().toString(36)}@example.test`;
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/auth/register", { fullName: `Wallet ${label}`, email, password: "Wt-" + crypto.randomBytes(12).toString("base64url"), marketingOptIn: false, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  return Object.assign(c, { email });
}
// Wallet buttons on My tickets for a device, as {apple, google} counts.
async function badgesOn(browser, c, ua, url = "/account#/tickets") {
  const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 } });
  if (c) await ctx.addCookies(Object.entries(c.cookies).map(([name, value]) => ({ name, value, url: BASE })));
  const p = await ctx.newPage();
  await p.goto(BASE + url);
  await p.waitForSelector(".tk-actions", { timeout: 15000 });
  await sleep(600);
  const r = { apple: await p.locator("[data-wallet-apple]").count(), google: await p.locator(".wallet-badge[data-gw]").count(), text: await p.locator(".wallet-badges").first().getAttribute("class").catch(() => null) };
  await ctx.close();
  return r;
}
const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

(async () => {
  console.log("Wallet passes");
  const servers = await mocks();
  setConfig();
  await sleep(2500); // opcache may keep the old config.php for up to 2 seconds
  const browser = await chromium.launch({ executablePath: CHROME });
  const { p12, sa, publicKey } = makeCerts();
  const admin = new Client(BASE, DATA); await admin.staffLogin("hello@ticketroom.co.za", ADMIN_PW);
  const cust = new Client(BASE, DATA); await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  const ev = freeEvent();
  const order = await book(cust, ev);
  const tickets = (await cust.call("GET", "/api/me/tickets")).tickets.filter((t) => t.slug === ev.slug);
  const tk = tickets[0];
  const guestC = new Client(BASE, DATA); await guestC.refreshCsrf();
  const gOrder = await guestC.call("POST", "/api/public/orders", { eventSlug: ev.slug, items: [{ ticketTypeId: ev.ttId, quantity: 1 }], idempotencyKey: uuid(), guest: { fullName: "Wallet Guest", email: `wallet-guest+${Date.now()}@example.test` } }).catch((e) => ({ error: e.message }));

  await test("W1 not set up: features off, routes not available, no buttons on any device", async () => {
    const cfg = await (await fetch(BASE + "/api/config")).json();
    assert(cfg.features.walletApple === false && cfg.features.walletGoogle === false, "features on: " + js(cfg.features));
    for (const k of ["apple", "google"]) { const st = await status(cust.call("GET", `/api/me/tickets/${tk.id}/wallet/${k}`)); assert(st >= 400, `${k} route answered ${st}`); }
    for (const ua of Object.values(UA)) { const b = await badgesOn(browser, cust, ua); assert(b.apple === 0 && b.google === 0, "buttons shown: " + js(b)); }
  });

  await test("W2 Integrations: wallet card, wrong certificate password reported in plain words", async () => {
    const list = await admin.call("GET", "/api/admin/integrations");
    const card = list.integrations.find((i) => i.key === "wallet");
    assert(card && card.fields.some((f) => f.name === "appleCertificate" && f.secret && f.file), "no wallet card with a file field");
    const r = await admin.call("PUT", "/api/admin/integrations/wallet", { currentPassword: ADMIN_PW, values: { applePassTypeId: PASS_TYPE, appleTeamId: TEAM, appleCertificate: p12, appleCertificatePassword: "wrong-password" } });
    assert(r.warning && /password/i.test(r.warning) && !r.warning.includes(p12.slice(0, 20)), "warning: " + r.warning);
    const t = await admin.call("POST", "/api/admin/integrations/wallet/test", {});
    assert(t.ok === false && /Apple Wallet: .*password/i.test(t.detail), "test: " + js(t));
  });

  await test("W3 saved secrets are write-only and encrypted; Test builds a sample pass on both sides", async () => {
    const r = await admin.call("PUT", "/api/admin/integrations/wallet", { currentPassword: ADMIN_PW, values: { appleCertificatePassword: P12_PW, googleIssuerId: ISSUER, googleServiceAccount: js(sa) } });
    assert(!r.warning, "warning: " + r.warning);
    const card = (await admin.call("GET", "/api/admin/integrations")).integrations.find((i) => i.key === "wallet");
    const text = js(card);
    assert(!text.includes(p12.slice(0, 40)) && !text.includes("PRIVATE KEY") && !text.includes(P12_PW), "secret sent back to the browser");
    assert(card.fields.find((f) => f.name === "appleCertificate").set === true && card.apple && card.google, "card: " + text.slice(0, 300));
    const stored = sql(DATA, "SELECT value FROM integration_settings WHERE key = 'wallet'")[0].value;
    assert(!stored.includes("PRIVATE KEY") && !stored.includes(p12.slice(0, 40)) && !stored.includes(P12_PW), "secret stored in plain text");
    const t = await admin.call("POST", "/api/admin/integrations/wallet/test", {});
    assert(t.ok === true && /Apple Wallet: ready/.test(t.detail) && /Google Wallet: ready/.test(t.detail), "test: " + js(t));
    const cfg = await (await fetch(BASE + "/api/config")).json();
    assert(cfg.features.walletApple && cfg.features.walletGoogle, "features still off");
  });

  let applePass, serial;
  await test("W4 Apple .pkpass: zip, pass.json design fields and colours, manifest hashes", async () => {
    const r = await fetchBin(cust, `/api/me/tickets/${tk.id}/wallet/apple`);
    assert(r.status === 200 && r.type === "application/vnd.apple.pkpass", `status ${r.status} ${r.type}`);
    const files = unzip(r.buf);
    for (const f of ["pass.json", "manifest.json", "signature", "icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"]) assert(files[f], "missing " + f);
    const pass = JSON.parse(files["pass.json"]);
    const manifest = JSON.parse(files["manifest.json"]);
    for (const [n, h] of Object.entries(manifest)) assert(crypto.createHash("sha1").update(files[n]).digest("hex") === h, "hash of " + n);
    assert(Object.keys(manifest).length === Object.keys(files).length - 2, "manifest lists every file");
    const e = pass.eventTicket;
    assert(pass.passTypeIdentifier === PASS_TYPE && pass.teamIdentifier === TEAM && pass.formatVersion === 1, "ids");
    assert(pass.backgroundColor === "rgb(11,29,63)" && pass.labelColor === "rgb(242,169,59)" && pass.foregroundColor === "rgb(255,255,255)", "colours " + js([pass.backgroundColor, pass.labelColor]));
    assert(pass.logoText === "TICKETROOM", "logoText");
    assert(e.primaryFields[0].value === tk.title && e.primaryFields[0].label === "TICKETROOM TICKET", "primary");
    assert(e.secondaryFields.map((f) => f.key).join() === "when,where" && /\d{2}:\d{2}$/.test(e.secondaryFields[0].value) && e.secondaryFields[1].value.includes(tk.venue_name), "secondary " + js(e.secondaryFields));
    assert(e.auxiliaryFields[0].value === tk.ticket_type && e.auxiliaryFields[1].label === "HOLDER", "auxiliary");
    const back = Object.fromEntries(e.backFields.map((f) => [f.key, f.value]));
    assert(back.order === tk.order_reference && back.code === tk.code && /stops working/.test(back.terms) && /hello@ticketroom\.co\.za/.test(back.support), "back " + js(back));
    assert(pass.barcodes[0].format === "PKBarcodeFormatQR" && pass.barcodes[0].message === tk.qrPayload && pass.barcodes[0].altText === tk.code, "barcode");
    assert(/T\d{2}:\d{2}:\d{2}\+02:00$/.test(pass.relevantDate) && new Date(pass.relevantDate).getTime() === Math.floor(new Date(tk.starts_at).getTime() / 1000) * 1000, "relevantDate " + pass.relevantDate);
    assert(pass.webServiceURL === BASE + "/api/passkit" && pass.authenticationToken.length >= 16 && !pass.voided, "web service");
    const png = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];
    assert(js(png(files["icon@3x.png"])) === "[87,87]" && js(png(files["logo@2x.png"])) === "[134,100]" && png(files["logo@3x.png"])[1] === 150, "image sizes");
    applePass = pass; serial = pass.serialNumber;
    // Signature: detached PKCS#7 over manifest.json, verified against the test root, WWDR included.
    const certs = verifySignature(files);
    assert(/Apple Worldwide Developer Relations/.test(certs) && /TicketRoom Test WWDR/.test(certs) && new RegExp(`Pass Type ID: ${PASS_TYPE.replace(/\./g, "\\.")}`).test(certs), "certs in signature: " + certs);
  });

  await test("W5 Google: JWT verifies with the service account key and carries the ticket", async () => {
    const { url } = await cust.call("GET", `/api/me/tickets/${tk.id}/wallet/google`);
    assert(url.startsWith("https://pay.google.com/gp/v/save/"), url);
    const j = decodeJwt(url, publicKey);
    assert(j.ok && j.header.alg === "RS256", "signature does not verify");
    const c = j.claims, cls = c.payload.eventTicketClasses[0], obj = c.payload.eventTicketObjects[0];
    assert(c.iss === sa.client_email && c.aud === "google" && c.typ === "savetowallet" && c.origins[0] === BASE, "claims " + js({ iss: c.iss, origins: c.origins }));
    assert(cls.id.startsWith(ISSUER + ".") && cls.hexBackgroundColor === "#0B1D3F" && cls.eventName.defaultValue.value === tk.title && cls.venue.name.defaultValue.value === tk.venue_name, "class " + js(cls).slice(0, 300));
    assert(cls.logo.sourceUri.uri === BASE + "/api/wallet/logo.png" && new Date(cls.dateTime.start).getTime() === Math.floor(new Date(tk.starts_at).getTime() / 1000) * 1000, "logo/date");
    assert(obj.state === "ACTIVE" && obj.barcode.type === "QR_CODE" && obj.barcode.value === tk.qrPayload && obj.barcode.alternateText === tk.code && obj.ticketNumber === tk.code, "object barcode");
    assert(obj.ticketType.defaultValue.value === tk.ticket_type && obj.ticketHolderName === (tk.holder_name || "") && obj.hexBackgroundColor === "#0B1D3F" && obj.reservationInfo.confirmationCode === tk.order_reference, "object fields");
    const logo = await fetchBin(null, "/api/wallet/logo.png");
    assert(logo.status === 200 && logo.type === "image/png", "logo not served");
  });

  let other;
  await test("W6 routes refuse other people's tickets and wrong order links", async () => {
    other = await signUp("other");
    for (const k of ["apple", "google"]) assert(await status(other.call("GET", `/api/me/tickets/${tk.id}/wallet/${k}`)) === 404, k + " served to another customer");
    const anon = new Client(BASE, DATA);
    assert(await status(anon.call("GET", `/api/me/tickets/${tk.id}/wallet/google`)) === 401, "signed out");
    assert(await status(anon.call("GET", `/api/public/orders/${order.order.reference}/tickets/${tk.id}/wallet/google?k=nope`)) >= 401, "bad order link");
    // The guest's own link works, but not for someone else's ticket.
    assert(gOrder.accessKey, "guest order: " + js(gOrder));
    const gv = await guestC.call("GET", `/api/public/orders/${gOrder.order.reference}?k=${encodeURIComponent(gOrder.accessKey)}`);
    const gt = gv.tickets[0];
    const ok = await fetchBin(null, `/api/public/orders/${gOrder.order.reference}/tickets/${gt.id}/wallet/apple?k=${encodeURIComponent(gOrder.accessKey)}`);
    assert(ok.status === 200 && unzip(ok.buf)["pass.json"], "guest pass " + ok.status);
    const cross = await fetchBin(null, `/api/public/orders/${gOrder.order.reference}/tickets/${tk.id}/wallet/apple?k=${encodeURIComponent(gOrder.accessKey)}`);
    assert(cross.status === 404, "another order's ticket through a guest link: " + cross.status);
  });

  await test("W7 buttons: Apple on iPhone, Google on Android, both on a computer; order page too", async () => {
    const i = await badgesOn(browser, cust, UA.iphone), a = await badgesOn(browser, cust, UA.android), d = await badgesOn(browser, cust, UA.desktop);
    assert(i.apple >= 1 && i.google === 0, "iphone " + js(i));
    assert(a.apple === 0 && a.google >= 1, "android " + js(a));
    assert(d.apple >= 1 && d.google >= 1, "desktop " + js(d));
    const o = await badgesOn(browser, null, UA.desktop, `/orders/${gOrder.order.reference}?k=${encodeURIComponent(gOrder.accessKey)}`);
    assert(o.apple === 1 && o.google === 1, "order page " + js(o));
  });

  const token = () => `ApplePass ${applePass.authenticationToken}`;
  const dev = "device" + crypto.randomBytes(6).toString("hex");
  await test("W8 Apple pass web service: register, list, fetch, wrong token refused", async () => {
    const reg = (auth) => fetch(`${BASE}/api/passkit/v1/devices/${dev}/registrations/${PASS_TYPE}/${serial}`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: js({ pushToken: "pushtoken" + crypto.randomBytes(8).toString("hex") }) });
    assert((await reg("ApplePass wrong-token-000000000000")).status === 401, "wrong token accepted");
    assert((await reg(token())).status === 201, "register");
    assert((await reg(token())).status === 200, "register again");
    const l = await fetch(`${BASE}/api/passkit/v1/devices/${dev}/registrations/${PASS_TYPE}`);
    const lj = await l.json();
    assert(l.status === 200 && lj.serialNumbers.includes(serial), "list " + js(lj));
    const p = await fetchBin(null, `/api/passkit/v1/passes/${PASS_TYPE}/${serial}`, { authorization: token() });
    assert(p.status === 200 && !JSON.parse(unzip(p.buf)["pass.json"]).voided, "fetch " + p.status);
  });

  await test("W9 transfer voids the old pass: push sent, Apple pass voided, Google object INACTIVE", async () => {
    await sync(); // earlier runs on the same instance
    assert((await sync()) === 0, "nothing should change before the transfer");
    calls.push.length = 0; calls.patch.length = 0;
    await cust.call("POST", `/api/me/tickets/${tk.id}/transfer`, { toEmail: other.email });
    const link = outbox(DATA, other.email, /#\/claim\/([A-Za-z0-9._~%-]+)/);
    await other.call("POST", "/api/me/transfers/claim", { token: decodeURIComponent(link[1]) });
    assert((await sync()) >= 2, "sync found no changes");
    assert(calls.push.length === 1 && calls.push[0].topic === PASS_TYPE && calls.push[0].path.startsWith("/3/device/pushtoken"), "push " + js(calls.push));
    const g = calls.patch.find((x) => x.id.includes(tk.id));
    assert(g && g.body.state === "INACTIVE" && g.auth === "Bearer test-token", "google patch " + js(calls.patch));
    const since = (await (await fetch(`${BASE}/api/passkit/v1/devices/${dev}/registrations/${PASS_TYPE}?passesUpdatedSince=2000-01-01`)).json());
    assert(since.serialNumbers.includes(serial), "updated list");
    const p = await fetchBin(null, `/api/passkit/v1/passes/${PASS_TYPE}/${serial}`, { authorization: token() });
    const pass = JSON.parse(unzip(p.buf)["pass.json"]);
    assert(p.status === 200 && pass.voided === true && pass.barcodes[0].message === tk.qrPayload, "voided pass " + js({ s: p.status, v: pass.voided }));
    assert(!JSON.stringify(pass).includes("Wallet other"), "the new holder's name leaked into the old pass");
    assert(await status(cust.call("GET", `/api/me/tickets/${tk.id}/wallet/apple`)) === 404, "old owner can still download");
    const mine = (await other.call("GET", "/api/me/tickets")).tickets.find((t) => t.id === tk.id);
    const fresh = await fetchBin(other, `/api/me/tickets/${tk.id}/wallet/apple`);
    const fp = JSON.parse(unzip(fresh.buf)["pass.json"]);
    assert(fp.serialNumber !== serial && fp.barcodes[0].message === mine.qrPayload && mine.qrPayload !== tk.qrPayload && !fp.voided, "new owner's pass");
    assert((await sync()) === 0, "second run changes nothing");
  });

  await test("W10 refund voids the pass; test tickets carry TEST", async () => {
    const s = php(`$u = row('SELECT * FROM users WHERE lower(email) = lower(?)', [${js(SEED.customer.email)}]); $ev = tm_event(); $o = tm_buy($ev, 1, exchange_buyer($u)); $t = tm_tickets($o['id'])[0]; tm_out(['order' => $o['id'], 'ticket' => $t['id'], 'test' => (int) $t['test']]);`);
    const p = await fetchBin(cust, `/api/me/tickets/${s.ticket}/wallet/apple`);
    const pass = JSON.parse(unzip(p.buf)["pass.json"]);
    if (s.test) assert(pass.eventTicket.headerFields[0].value === "TEST" && pass.eventTicket.backFields[0].label === "TEST", "TEST label missing");
    const { url } = await cust.call("GET", `/api/me/tickets/${s.ticket}/wallet/google`);
    const obj = decodeJwt(url, publicKey).claims.payload.eventTicketObjects[0];
    if (s.test) assert(obj.textModulesData[0].header === "TEST", "Google TEST label missing");
    const sr = pass.serialNumber;
    const r = await fetch(`${BASE}/api/passkit/v1/devices/${dev}/registrations/${PASS_TYPE}/${sr}`, { method: "POST", headers: { authorization: `ApplePass ${pass.authenticationToken}`, "content-type": "application/json" }, body: js({ pushToken: "pushtokenrefund0001" }) });
    assert(r.status === 201, "register " + r.status);
    calls.push.length = 0; calls.patch.length = 0;
    const done = php(`$o = row('SELECT * FROM orders WHERE id = ?', [${js(s.order)}]); $rf = tx(fn() => refund_create($o, tm_admin(), [${js(s.ticket)}], true, 'customer', 'Wallet test')); refund_process($rf['id'], tm_admin()); tm_out(val('SELECT status FROM tickets WHERE id = ?', [${js(s.ticket)}]));`);
    assert(done === "refunded", "ticket " + done);
    assert((await sync()) >= 2, "no change found");
    assert(calls.push.some((x) => x.path.endsWith("pushtokenrefund0001")) && calls.patch.some((x) => x.id.includes(s.ticket) && x.body.state === "INACTIVE"), "push/patch " + js(calls));
    const v = await fetchBin(null, `/api/passkit/v1/passes/${PASS_TYPE}/${sr}`, { authorization: `ApplePass ${pass.authenticationToken}` });
    assert(JSON.parse(unzip(v.buf)["pass.json"]).voided === true, "refunded pass not voided");
  });

  await test("W11 clearing the certificate hides the Apple button again", async () => {
    await admin.call("PUT", "/api/admin/integrations/wallet", { currentPassword: ADMIN_PW, values: {}, clear: ["appleCertificate", "googleServiceAccount"] });
    const cfg = await (await fetch(BASE + "/api/config")).json();
    assert(!cfg.features.walletApple && !cfg.features.walletGoogle, "features " + js(cfg.features));
    const st = await status(other.call("GET", `/api/me/tickets/${tk.id}/wallet/apple`));
    assert(st >= 400, "route " + st);
  });

  // Leave the instance as it was.
  await admin.call("PUT", "/api/admin/integrations/wallet", { currentPassword: ADMIN_PW, values: { applePassTypeId: "", appleTeamId: "", googleIssuerId: "" }, clear: ["appleCertificatePassword"] }).catch(() => {});
  fs.writeFileSync(CONFIG, configBefore);
  await browser.close();
  servers.forEach((s) => s.close());
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `${failures} wallet test(s) FAILED` : "All wallet tests passed.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.writeFileSync(CONFIG, configBefore); } catch { /* */ } process.exit(1); });
