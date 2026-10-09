// Browser + HTTP checks for the PHP edition's newer features. Run after
// php-walkthrough.js on the same instance (it reuses the accounts it made).
//   node tests-ui/php-features.js http://127.0.0.1:8600 /path/to/public_html
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3];
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1" };
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);

// Read the newest email to an address straight from the site's database.
function lastMail(to) {
  const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
  const php = `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare('SELECT subject, body FROM message_outbox WHERE to_address = ? ORDER BY created_at DESC LIMIT 1'); $s->execute([$argv[1]]); echo json_encode($s->fetch(PDO::FETCH_ASSOC));`;
  return JSON.parse(execFileSync("php", ["-r", php, to]).toString() || "null");
}
async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|403|404|409|422|429|501)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
  return p;
}
const download = async (p, click) => { const [d] = await Promise.all([p.waitForEvent("download"), click()]); return fs.readFileSync(await d.path()); };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  try {
    // Subscribe from the footer, confirm from the email, see it in the admin portal.
    const v = await page(browser, null, { width: 390, height: 844 });
    await v.goto(`${BASE}/help`);
    const band = v.locator(".sub-band");
    await band.getByRole("heading", { name: "Subscribe to receive updates" }).waitFor();
    await band.getByLabel("Email address").fill("lerato@example.co.za");
    await band.getByRole("button", { name: "Subscribe" }).click();
    await band.getByText(/we've sent it an email/).waitFor();
    const mail = lastMail("lerato@example.co.za");
    assert.match(mail.subject, /Confirm your TicketRoom updates/);
    await v.goto(mail.body.match(/https?:\/\/\S+\/subscribe\?t=\S+/)[0].replace(/^https?:\/\/[^/]+/, BASE));
    await v.getByRole("heading", { name: "You're subscribed" }).waitFor();
    step("subscribe from the footer, confirm from the email");

    const a = await page(browser, ADMIN);
    await a.goto(`${BASE}/admin#/subscribers`);
    await a.getByRole("heading", { name: "Subscribers", exact: true }).waitFor();
    assert.equal((await a.locator(".kpi .v").first().innerText()).trim(), "1");
    await a.getByLabel("Subject").fill("New this month");
    await a.getByLabel("Message").fill("Hi there,\n\nThree new free events this weekend.\n\nSee what's on: https://ticketroom.co.za/");
    await a.getByRole("button", { name: "Send me a test" }).click();
    await a.getByText("Test sent to your email address.").waitFor();
    assert.match(lastMail(ADMIN.email).subject, /\[Test\] New this month/);
    const csv = await download(a, () => a.getByRole("link", { name: "Export CSV" }).click());
    assert.match(csv.toString(), /lerato@example\.co\.za/);
    step("admin sees the subscriber, sends a test update, exports CSV");

    // Admin QR maker: WhatsApp code, PNG and SVG downloads.
    await a.goto(`${BASE}/admin#/qr`);
    await a.getByLabel("What should it open?").selectOption("whatsapp");
    await a.getByLabel("WhatsApp number").fill("076 884 7372");
    await a.getByLabel(/Caption/).fill("Chat to TicketRoom");
    await a.getByRole("button", { name: "Make QR code" }).click();
    await a.getByText("https://wa.me/27768847372").waitFor();
    const png = await download(a, () => a.getByRole("button", { name: "Download PNG" }).click());
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const svg = await download(a, () => a.getByRole("button", { name: "Download SVG" }).click());
    assert.match(svg.toString(), /^<svg[\s\S]*<\/svg>$/);
    // Light squares on white cannot be scanned: refused with a clear reason.
    await a.getByLabel("Squares").evaluate((el) => { el.value = "#eeeeee"; });
    await a.getByRole("button", { name: "Make QR code" }).click();
    await a.getByText(/Phones cannot read low-contrast codes/).first().waitFor();
    step("admin QR maker: WhatsApp code, PNG and SVG downloads, contrast check");

    // Staff & roles.
    await a.goto(`${BASE}/admin#/staff`);
    await a.getByRole("heading", { name: "Staff & roles" }).waitFor();
    await a.getByLabel("Full name").fill("Ayanda Khumalo");
    await a.getByLabel("Email").fill("ayanda@example.co.za");
    await a.getByLabel(/Finance/).check();
    await a.getByRole("button", { name: "Add to the team" }).click();
    await a.locator("tr", { hasText: "Ayanda Khumalo" }).waitFor();
    assert.match(lastMail("ayanda@example.co.za").body, /as Finance and Support|as Support and Finance/);
    await a.locator("tr", { hasText: "Ayanda Khumalo" }).getByRole("button", { name: "Change roles" }).click();
    await a.locator("dialog").getByLabel(/Support/).uncheck();
    await a.locator("dialog").getByRole("button", { name: "Save roles" }).click();
    await a.getByText("Roles saved.").waitFor();
    assert.equal(await a.locator("tr", { hasText: "Ayanda Khumalo" }).locator(".badge").count(), 1);
    step("admin adds a staff member with chosen roles and changes them");

    // Organiser: Share your event card with QR downloads.
    const o = await page(browser, ORG);
    await o.goto(`${BASE}/organisers#/events`);
    await o.locator("#main a[href*='#/events/']:not([href$='/new'])").first().click();
    await o.getByRole("heading", { name: "Share your event" }).waitFor();
    const opng = await download(o, () => o.getByRole("button", { name: "Download PNG" }).click());
    assert.deepEqual([...opng.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    step("organiser downloads the event QR code");

    // A customer likes and shares an event, and saves their ticket.
    const fan = await page(browser, { email: "sipho@example.co.za", password: "fan-password-123" }, { width: 390, height: 844 });
    await fan.goto(`${BASE}/`);
    await fan.locator(".event-card", { hasText: "Free Jazz in the Park" }).first().click();
    const like = fan.locator(".like-btn");
    await like.click();
    await fan.locator(".like-btn.on").waitFor();
    assert.match(await like.innerText(), /1/);
    const wa = await fan.locator('.share-bar a[data-share="WhatsApp"]').getAttribute("href");
    assert.match(decodeURIComponent(wa), /^https:\/\/wa\.me\/\?text=.*\/events\/free-jazz-in-the-park/);
    await fan.goto(`${BASE}/account#/saved`);
    await fan.getByRole("link", { name: "Free Jazz in the Park" }).waitFor();
    await fan.goto(`${BASE}/account#/tickets`);
    const tpng = await download(fan, () => fan.getByRole("button", { name: "Save ticket image" }).first().click());
    assert.deepEqual([...tpng.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(await fan.locator(".wallet-btn").count(), 0, "wallet buttons hidden until the wallet accounts are set up");
    const visitor = await page(browser);
    await visitor.goto(fan.url().replace(/account.*/, "events/" + (await (await visitor.request.get(`${BASE}/api/public/events`)).json()).events.find((e) => e.title === "Free Jazz in the Park").slug));
    await visitor.locator(".like-btn").click();
    await visitor.locator("dialog").getByText(/Sign in to like events/).waitFor();
    step("like, share link, saved events, ticket image; signed-out likes ask to sign in");

    // Fake and duplicate tickets at the gate: the organiser scans as gate staff.
    const sign = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); echo qr_payload(row('SELECT code, qr_version FROM tickets WHERE code = ?', [$argv[1]]));`, code]).toString();
    const csrf = (await (await o.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const evs = (await (await o.request.get(`${BASE}/api/staff/events`)).json()).events;
    const evId = evs.find((e) => e.title === "Free Jazz in the Park").id;
    const scan = async (payload) => (await (await o.request.post(`${BASE}/api/staff/scan`, { data: { eventId: evId, payload }, headers: { "x-csrf-token": csrf } })).json()).outcome;
    const fanTickets = execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); echo json_encode(array_column(rows("SELECT t.code FROM tickets t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'sipho@example.co.za' AND t.status = 'valid'"), 'code'));`]).toString();
    const code = JSON.parse(fanTickets)[0];
    const real = sign(code);
    const forged = real.slice(0, -1) + (real.endsWith("A") ? "B" : "A");
    assert.equal(await scan(forged), "invalid", "altered QR refused");
    assert.equal(await scan("TR1.ABCDEFGHJK.1.aaaaaaaaaaaaaaaaaaaaaa"), "invalid", "made-up QR refused");
    assert.equal(await scan("ZZZZZZZZZZ"), "invalid", "made-up typed code refused");
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => scan(real)));
    assert.equal(outcomes.filter((x) => x === "admitted").length, 1, `exactly one admit from 10 phones at once: ${outcomes}`);
    assert.equal(outcomes.filter((x) => x === "already_used").length, 9);
    assert.equal(await scan(real), "already_used", "second scan refused");
    step("fake and altered QR codes refused; 10 phones at once let one person in once");

    // The same event twice is refused.
    const ocsrf = csrf;
    const orgId = (await (await o.request.get(`${BASE}/api/auth/me`)).json()).user.organisers[0].id;
    const ev1 = { title: "Twice Test", category: "music", venueName: "Hall", city: "Soweto", startsAt: "2027-03-01T17:00:00.000Z", endsAt: "2027-03-01T21:00:00.000Z", capacity: 100 };
    assert.equal((await o.request.post(`${BASE}/api/organiser/${orgId}/events`, { data: ev1, headers: { "x-csrf-token": ocsrf } })).status(), 201);
    const again = await o.request.post(`${BASE}/api/organiser/${orgId}/events`, { data: ev1, headers: { "x-csrf-token": ocsrf } });
    assert.equal(again.status(), 409);
    assert.equal((await again.json()).error.code, "duplicate_event");
    step("the same event cannot be created twice");

    // Locked password page: secret word, one wrong word locks it, staff accounts only.
    const unlock = path.join(ROOT, "data", "unlock-reset");
    assert.equal((await fetch(`${BASE}/set-password.php`)).status, 404);
    fs.writeFileSync(unlock, "blue-giraffe-77\n");
    execFileSync("chown", ["www-data:www-data", unlock]);
    const form = (o) => new URLSearchParams(o).toString();
    const post = (o) => fetch(`${BASE}/set-password.php`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(o) }).then((r) => r.text());
    assert.match(await post({ unlock: "blue-giraffe-77", email: ORG.email, password: "x-new-password-1", confirm: "x-new-password-1" }), /not a TicketRoom staff account/);
    assert.match(await post({ unlock: "wrong-word", email: ADMIN.email, password: "x-new-password-1", confirm: "x-new-password-1" }), /locked itself/);
    assert.equal(fs.existsSync(unlock), false);
    fs.writeFileSync(unlock, "blue-giraffe-77\n");
    execFileSync("chown", ["www-data:www-data", unlock]);
    assert.match(await post({ unlock: "blue-giraffe-77", email: "ayanda@example.co.za", password: "ayanda-pass-2026", confirm: "ayanda-pass-2026" }), /Password set/);
    assert.equal((await fetch(`${BASE}/set-password.php`)).status, 404);
    step("password page needs the secret word, locks on a wrong one, staff only");

    // Sign-in throttling and the generic answer.
    const login = (email, password) => fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const unknown = await (await login("nobody@example.co.za", "whatever-123")).json();
    const wrong = await (await login(ORG.email, "wrong-password-9")).json();
    assert.equal(unknown.error.message, wrong.error.message);
    for (let i = 0; i < 4; i++) await login(ORG.email, "wrong-password-9");
    assert.equal((await login(ORG.email, ORG.password)).status, 429);
    step("sign-in: same answer for unknown and wrong; throttled after 5 tries");

    // Front door and private files.
    // Redirects must stay on this site, whatever odd address comes in.
    const http = require("http");
    for (const u of ["/%5Cevil.com/", "//evil.com/", "//evil.com.html", "/%5Cevil.com.html", "/\\evil.com/"]) {
      const loc = await new Promise((ok) => http.get(BASE + u, (res) => { res.resume(); ok(res.headers.location || ""); }).on("error", () => ok("")));
      if (loc) assert.equal(new URL(loc, BASE).origin, new URL(BASE).origin, `${u} redirects off-site to ${loc}`);
    }
    for (const u of ["/data/ticketroom.sqlite", "/data/keys.php", "/api/config.php", "/api/schema.sql", "/START-HERE.txt", "/DEPLOY-AFRIHOST.md"]) {
      const r = await fetch(BASE + u);
      const t = await r.text();
      assert.ok(r.status >= 400 && !/passwordHash|CREATE TABLE|SQLite format/.test(t), `${u} is private`);
    }
    const page1 = await fetch(`${BASE}/help`);
    assert.match(page1.headers.get("content-security-policy") || "", /script-src 'self'/);
    step("private files stay private; pages carry a Content-Security-Policy");
  } catch (err) {
    problems.push(err.stack || String(err));
  } finally {
    await browser.close();
  }
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("PHP feature checks passed.");
})();
