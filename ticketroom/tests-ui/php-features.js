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
    const ics = (await download(fan, () => fan.locator(".pill-btn", { hasText: "Add to calendar" }).click())).toString();
    assert.match(ics, /BEGIN:VCALENDAR[\s\S]*SUMMARY:Free Jazz in the Park[\s\S]*BEGIN:VALARM/);
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
    step("like, share link, calendar file, saved events, ticket image; signed-out likes ask to sign in");

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

    // Event and organiser IDs, target age groups and the age filter.
    const opost = (url, data) => o.request.post(`${BASE}${url}`, { data, headers: { "x-csrf-token": ocsrf } });
    const ev2 = (await (await opost(`/api/organiser/${orgId}/events`, { ...ev1, title: "Teen Talent Show", ageGroups: ["teens", "families"] })).json()).event;
    assert.match(ev2.ref, /^EV-[2-9A-HJ-NP-TV-Z]{6}$/);
    assert.equal(ev2.age_groups, "teens,families");
    const bad18 = await opost(`/api/organiser/${orgId}/events`, { ...ev1, title: "Late Club Night", ageRestriction: "18+", ageGroups: ["kids"] });
    assert.equal(bad18.status(), 400);
    const orgView = (await (await o.request.get(`${BASE}/api/organiser/${orgId}`)).json()).organiser;
    assert.match(orgView.ref, /^ORG-[2-9A-HJ-NP-TV-Z]{6}$/);
    const opatch = (url, data) => o.request.patch(`${BASE}${url}`, { data, headers: { "x-csrf-token": ocsrf } });
    assert.equal((await (await opatch(`/api/organiser/${orgId}/events/${evId}`, { ageGroups: ["all"] })).json()).event.age_groups, "all");
    const jazzRef = (await (await o.request.get(`${BASE}/api/organiser/${orgId}/events/${evId}`)).json()).event.ref;
    const byAge = (await (await fetch(`${BASE}/api/public/events?age=25_34`)).json()).events.map((e) => e.title);
    assert.ok(byAge.includes("Free Jazz in the Park"), "an all-ages event shows for every age group");
    const pub = (await (await fetch(`${BASE}/api/public/events/${(await (await fetch(`${BASE}/api/public/events`)).json()).events.find((e) => e.title === "Free Jazz in the Park").slug}`)).json()).event;
    assert.equal(pub.ref, jazzRef);
    assert.equal(pub.organiser_ref, orgView.ref);
    const ap = await page(browser, ADMIN);
    assert.equal((await (await ap.request.get(`${BASE}/api/admin/events?q=${jazzRef.toLowerCase()}`)).json()).events[0].title, "Free Jazz in the Park");
    assert.equal((await (await ap.request.get(`${BASE}/api/admin/organisers?q=${orgView.ref}`)).json()).organisers[0].name, orgView.name);
    step("event and organiser IDs, admin search by ID, target age groups and filter; 18+ events can't target children");

    // Ticket kinds: a couple ticket lets two people in on one QR code.
    const tt = await opost(`/api/organiser/${orgId}/events/${evId}/ticket-types`, { name: "Couple", kind: "couple", priceCents: 0, quantityTotal: 20, perOrderLimit: 2 });
    assert.equal(tt.status(), 201);
    const couple = (await tt.json()).ticketType;
    assert.equal(couple.admits, 2);
    assert.equal((await opost(`/api/organiser/${orgId}/events/${evId}/ticket-types`, { name: "Odd", kind: "nonsense", priceCents: 0, quantityTotal: 5 })).status(), 422);
    const fcsrf = (await (await fan.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const jazzSlug = pub.slug;
    const bought = await fan.request.post(`${BASE}/api/public/orders`, { data: { eventSlug: jazzSlug, items: [{ ticketTypeId: couple.id, quantity: 1 }], idempotencyKey: `couple-${Date.now()}` }, headers: { "x-csrf-token": fcsrf } });
    assert.equal(bought.status(), 201);
    const coupleCode = execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); echo val("SELECT code FROM tickets WHERE ticket_type_id = ?", [$argv[1]]);`, couple.id]).toString();
    const c1 = await (await o.request.post(`${BASE}/api/staff/scan`, { data: { eventId: evId, payload: sign(coupleCode) }, headers: { "x-csrf-token": csrf } })).json();
    assert.equal(c1.outcome, "admitted");
    assert.equal(c1.admits, 2);
    assert.match(c1.ticketType, /Couple · Admit 2/);
    assert.equal(await (async () => { try { return (await opatch(`/api/organiser/${orgId}/events/${evId}/ticket-types/${couple.id}`, { admits: 3 })).status(); } catch { return 0; } })(), 409);
    step("couple ticket: one QR code, scanner shows ADMIT 2; head count locked once sold; unknown kinds refused");

    // Gate passes: crew re-entry, single-entry guest list, forged, cancelled and replaced passes.
    const crew = await (await opost(`/api/organiser/${orgId}/events/${evId}/passes`, { holderName: "Lerato Crew", role: "crew", accessNote: "Backstage" })).json();
    assert.match(crew.url, /\/pass\?t=[A-Za-z0-9_-]{30,}$/);
    const tok = new URL(crew.url).searchParams.get("t");
    const view = await (await fetch(`${BASE}/api/public/pass?t=${tok}`)).json();
    assert.equal(view.pass.holderName, "Lerato Crew");
    assert.match(view.svg, /^<svg/);
    assert.equal((await fetch(`${BASE}/api/public/pass?t=${"x".repeat(32)}`)).status, 404);
    const passPayload = execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); echo pass_payload(row('SELECT code, qr_version FROM gate_passes WHERE id = ?', [$argv[1]]));`, crew.pass.id]).toString();
    for (let i = 0; i < 3; i++) assert.equal(await scan(passPayload), "admitted", "re-entry pass lets crew in and out");
    assert.equal(await scan(passPayload.slice(0, -1) + (passPayload.endsWith("A") ? "B" : "A")), "invalid", "forged pass refused");
    assert.equal(await scan(passPayload.replace(/^TP1/, "TR1")), "invalid", "a pass can't pose as a ticket");
    assert.equal(await scan(crew.pass.code), "admitted", "typed pass code works");
    const guests = await (await opost(`/api/organiser/${orgId}/events/${evId}/passes/bulk`, { role: "guest", reentry: false, people: [{ holderName: "Guest One" }, { holderName: "Guest Two" }] })).json();
    assert.equal(guests.passes.length, 2);
    const gp = execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); echo pass_payload(row('SELECT code, qr_version FROM gate_passes WHERE id = ?', [$argv[1]]));`, guests.passes[0].pass.id]).toString();
    const gOutcomes = await Promise.all(Array.from({ length: 5 }, () => scan(gp)));
    assert.equal(gOutcomes.filter((x) => x === "admitted").length, 1, `one-entry pass admits once: ${gOutcomes}`);
    const re = await (await opost(`/api/organiser/${orgId}/events/${evId}/passes/${crew.pass.id}/reissue`, {})).json();
    assert.equal(await scan(passPayload), "invalid", "old QR stops working after a new link");
    assert.equal((await fetch(`${BASE}/api/public/pass?t=${tok}`)).status, 404, "old link stops working");
    assert.equal((await fetch(`${BASE}/api/public/pass?t=${new URL(re.url).searchParams.get("t")}`)).status, 200);
    await opost(`/api/organiser/${orgId}/events/${evId}/passes/${guests.passes[1].pass.id}/revoke`, {});
    const gp2 = execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); echo pass_payload(row('SELECT code, qr_version FROM gate_passes WHERE id = ?', [$argv[1]]));`, guests.passes[1].pass.id]).toString();
    assert.equal(await scan(gp2), "revoked");
    const stranger = await page(browser, { email: "sipho@example.co.za", password: "fan-password-123" });
    assert.equal((await stranger.request.get(`${BASE}/api/organiser/${orgId}/events/${evId}/passes`)).status(), 404, "passes are private to the organiser");
    const pack = await (await o.request.get(`${BASE}/api/staff/events/${evId}/offline-pack`)).json();
    assert.ok(pack.tickets.some((t) => t[3] === "Lerato Crew" && t[5] === 1), "re-entry passes are in the offline list");
    step("gate passes: re-entry crew, one-entry guest list (5 phones, 1 admit), forged, replaced and cancelled passes refused; offline list");

    // The organiser screens and the pass page in a browser.
    await o.goto(`${BASE}/organisers#/events/${evId}/passes`);
    await o.getByRole("heading", { name: "Issue gate passes" }).waitFor();
    await o.getByLabel("Name", { exact: true }).fill("Media Person");
    await o.getByLabel("Pass type").selectOption("media");
    await o.getByRole("button", { name: "Issue pass" }).click();
    const link = await o.locator("dialog input[readonly]").first().inputValue();
    const pimg = await download(o, () => o.locator("dialog").getByRole("button", { name: "Pass image" }).click());
    assert.deepEqual([...pimg.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const pp = await page(browser, null, { width: 390, height: 844 });
    await pp.goto(link);
    await pp.getByText("Media Person").waitFor();
    await pp.locator(".t-qr svg").waitFor();
    await o.goto(`${BASE}/organisers#/events/${evId}/details`);
    await o.getByText("Who is this event for?").waitFor();
    assert.equal(await o.getByLabel("All ages").isChecked(), true);
    await o.goto(`${BASE}/organisers#/events/${evId}/tickets`);
    await o.getByRole("cell", { name: /Admits 2/ }).waitFor();
    step("organiser issues a pass in the portal and downloads it; the pass opens on a phone; age groups and ticket kinds show");

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
