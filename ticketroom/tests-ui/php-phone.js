// Phone confirmation by SMS code, and the risk recheck when a live event grows.
// Run after php-portals.js (it sets up "your own SMS provider"):
//   node tests-ui/php-phone.js http://127.0.0.1:8600 /srv/trtest/public_html
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const MOCK_PORT = process.env.TR_MOCK_PORT5 || "8705";
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);

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

(async () => {
  sql("DELETE FROM rate_limits");
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  const state = fs.mkdtempSync("/tmp/tr-phone-");
  const mock = spawn("php", ["-S", `127.0.0.1:${MOCK_PORT}`, path.join(__dirname, "mocks", "providers.php")], { env: { ...process.env, TARGET: BASE, STATE: state }, stdio: "ignore" });
  fs.writeFileSync(cfgFile, original.replace("return [", "return [\n    'sms' => ['allowPrivateHosts' => true],"));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const page = async (creds, viewport = { width: 1280, height: 900 }) => {
    const c = await browser.newContext({ viewport });
    await c.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, functional: true, analytics: true })); } catch { /* no storage */ } });
    const p = await c.newPage();
    p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
    if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
    return p;
  };
  const lastCode = () => {
    const lines = fs.readFileSync(path.join(state, "sms.log"), "utf8").trim().split("\n");
    return JSON.parse(JSON.parse(lines.pop()).body).text.match(/\b(\d{6})\b/)[1];
  };
  try {
    // Point "your own SMS provider" at this test's stand-in.
    const adm = await page(ADMIN);
    const a = api(adm);
    assert.equal((await a.put("/api/admin/integrations/sms", { currentPassword: ADMIN.password, values: { provider: "http", httpUrl: `${MOCK}/sms/send`, httpAuth: "Bearer sms-test-key", httpFormat: "json", httpToField: "recipient", httpMessageField: "text", httpNumberFormat: "intl" } })).status, 200);
    await new Promise((r) => setTimeout(r, 3000)); // config is reread every ~2 s
    assert.equal((await (await fetch(`${BASE}/api/config`)).json()).features.sms, true, "SMS ready");

    // 1. The organiser's checklist asks for a confirmed phone now that SMS works.
    const org = await page(ORG);
    const o = api(org);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;
    const ph = () => o.get(`/api/organiser/${orgId}/verification`).then((r) => r.body.verification.requirements.find((x) => x.key === "phone"));
    assert.equal((await ph()).status, "missing");
    await org.goto(`${BASE}/organisers#/verification`);
    await org.getByRole("button", { name: "Confirm by SMS" }).click();
    const d = org.locator("dialog[open]");
    await d.getByLabel("Mobile number").fill("082 555 0101");
    await d.getByRole("button", { name: "Send the code" }).click();
    await d.getByText(/We sent a code to/).waitFor();
    assert.equal(JSON.parse(JSON.parse(fs.readFileSync(path.join(state, "sms.log"), "utf8").trim().split("\n").pop()).body).recipient, "27825550101");
    await d.getByLabel("Code").fill("000000");
    await d.getByRole("button", { name: "Confirm" }).click();
    await d.getByText(/not right/).waitFor();
    await d.getByLabel("Code").fill(lastCode());
    await d.getByRole("button", { name: "Confirm" }).click();
    await org.getByText("Your mobile number is confirmed.").waitFor();
    assert.equal((await ph()).status, "approved");
    const u = sql("SELECT phone, phone_verified_at FROM users WHERE email = ?", ORG.email)[0];
    assert.equal(u.phone, "+27825550101"); assert.ok(u.phone_verified_at);
    step("phone confirmation: SMS code to the number, wrong code refused, right code confirms it; the checklist item turns green");

    // 2. Guard rails: a new number needs confirming again; codes expire after 5 wrong tries; one number, one account.
    assert.equal((await o.patch("/api/auth/me", { fullName: "Naledi Dlamini", phone: "082 555 0102" })).status, 200);
    assert.equal(sql("SELECT phone_verified_at FROM users WHERE email = ?", ORG.email)[0].phone_verified_at, null, "changed number is not confirmed");
    assert.equal((await o.post("/api/auth/phone/send", { phone: "082 555 0102" })).status, 200);
    for (let i = 0; i < 5; i++) await o.post("/api/auth/phone/verify", { code: "111111" });
    assert.match((await o.post("/api/auth/phone/verify", { code: lastCode() })).body.error.message, /Too many wrong codes/);
    assert.equal((await o.post("/api/auth/phone/send", { phone: "082 555 0102" })).status, 200);
    assert.equal((await o.post("/api/auth/phone/verify", { code: lastCode() })).status, 200);
    const fan = await page({ email: "sipho@example.co.za", password: "fan-password-123", portal: "customer" });
    assert.equal((await api(fan).post("/api/auth/phone/send", { phone: "082 555 0102" })).body.error.code, "phone_taken");
    // Customers confirm theirs from Settings.
    await fan.goto(`${BASE}/account#/settings`);
    await fan.getByRole("button", { name: "Confirm by SMS" }).waitFor();
    step("a changed number must be confirmed again; 5 wrong codes and the code is dead; a confirmed number belongs to one account; customers confirm in Settings");

    // 3. A live event grows past 5 000 people: documents are asked for again, sales stay open.
    const ev = sql("SELECT id, title FROM events WHERE organiser_id = ? AND status = 'published' ORDER BY created_at LIMIT 1", orgId)[0];
    assert.ok(ev, "a published event to grow");
    const before = sql("SELECT count(*) AS n FROM message_outbox WHERE subject LIKE ?", `Documents needed for ${ev.title}%`)[0].n;
    assert.equal((await o.patch(`/api/organiser/${orgId}/events/${ev.id}`, { capacity: 6000 })).status, 200);
    assert.equal(sql("SELECT count(*) AS n FROM message_outbox WHERE subject = ?", `Documents needed for ${ev.title}`)[0].n, Number(before) + 1, "organiser told");
    assert.equal(sql("SELECT count(*) AS n FROM message_outbox WHERE subject = ?", `[TicketRoom] Live event needs documents: ${ev.title}`)[0].n, 1, "team told");
    assert.equal(sql("SELECT status FROM events WHERE id = ?", ev.id)[0].status, "published", "still on sale");
    await o.patch(`/api/organiser/${orgId}/events/${ev.id}`, { capacity: 6001 });
    assert.equal(sql("SELECT count(*) AS n FROM message_outbox WHERE subject = ?", `Documents needed for ${ev.title}`)[0].n, Number(before) + 1, "not told twice for the same list");
    await o.patch(`/api/organiser/${orgId}/events/${ev.id}`, { capacity: 200 });
    step("a live event that grows into a high-risk one asks for its documents once (organiser and team emailed); it stays on sale");

    if (problems.length) throw new Error(problems.join("\n"));
    console.log("PHP phone and risk checks passed.");
  } finally {
    fs.writeFileSync(cfgFile, original);
    mock.kill();
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
