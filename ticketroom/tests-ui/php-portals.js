// One account, one portal; staff made and reset only by the owner; provider
// settings never shown back; test messages to any address; your own SMS
// provider; maintenance mode that really closes the site.
// Run after php-walkthrough.js on the same instance:
//   node tests-ui/php-portals.js http://127.0.0.1:8600 /srv/trtest/public_html
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const ORG = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const FAN = { email: "sipho@example.co.za", password: "fan-password-123", portal: "customer" };
const MOCK = "http://127.0.0.1:8702";
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const lastMail = (to) => sql("SELECT subject, body, status, last_error FROM message_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", to)[0];
const clearLimits = () => sql("DELETE FROM rate_limits");

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
  return p;
}
function api(p) {
  let token;
  const call = async (method, url, data) => {
    token ??= (await (await p.request.get(`${BASE}/api/auth/me`)).json()).csrfToken;
    const r = await p.request.fetch(`${BASE}${url}`, { method, data, headers: token ? { "x-csrf-token": token } : {} });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), body };
  };
  return { get: (u) => call("GET", u), post: (u, d) => call("POST", u, d ?? {}), put: (u, d) => call("PUT", u, d) };
}
const anon = (url, data, method = "POST") => fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const login = (creds) => anon("/api/auth/login", creds);

(async () => {
  clearLimits();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  const state = fs.mkdtempSync("/tmp/tr-sms-");
  const mock = spawn("php", ["-S", "127.0.0.1:8702", path.join(__dirname, "mocks", "providers.php")], { env: { ...process.env, TARGET: BASE, STATE: state }, stdio: "ignore" });
  // Lets "your own SMS provider" point at the local stand-in (PHP rereads config every ~2 s).
  if (!original.includes("allowPrivateHosts")) fs.writeFileSync(cfgFile, original.replace("return [", "return [\n    'sms' => ['allowPrivateHosts' => true],"));
  try {
    // 1. One account, one portal.
    assert.equal((await login({ ...FAN, portal: "organiser" })).body.error.code, "wrong_portal", "customer refused on the organiser portal");
    assert.equal((await login({ ...ORG, portal: "customer" })).body.error.code, "wrong_portal", "organiser refused on the customer portal");
    const orgOnAdmin = await login({ ...ORG, portal: "admin" });
    assert.equal(orgOnAdmin.status, 401, "organiser refused on the admin portal");
    assert.equal(orgOnAdmin.body.error.code, "bad_credentials", "and the admin sign-in says nothing about the account");
    assert.equal((await login({ ...FAN, portal: "admin" })).body.error.code, "bad_credentials");
    assert.equal((await login({ ...ADMIN, portal: "site" })).body.error.code, "bad_credentials", "staff sign in on the admin portal only");
    const fanP = await page(browser, FAN);
    await fanP.goto(`${BASE}/organisers`);
    await fanP.getByRole("heading", { name: "This portal isn't for this account" }).waitFor();
    assert.equal((await api(fanP).post("/api/organiser/apply", { name: "Sneaky Events", contactEmail: FAN.email })).status, 403, "a customer can't become an organiser");
    await fanP.goto(`${BASE}/admin`);
    await fanP.getByRole("heading", { name: "Page not found" }).waitFor();
    assert.equal((await api(fanP).get("/api/admin/users")).status, 403);
    const orgP = await page(browser, ORG);
    await orgP.goto(`${BASE}/account`);
    await orgP.getByRole("heading", { name: "This portal isn't for this account" }).waitFor();
    assert.equal((await api(orgP).get("/api/me/tickets")).status, 403, "the customer API is for customers");
    await orgP.goto(`${BASE}/admin`);
    await orgP.getByRole("heading", { name: "Page not found" }).waitFor();
    // Same email, another kind of account: refused.
    assert.equal((await anon("/api/organiser/signup", { organisation: "Fan Events", fullName: "Sipho Fan", email: FAN.email, password: "organiser-pass-9", acceptTerms: true })).body.error.code, "email_taken");
    assert.equal((await anon("/api/auth/register", { fullName: "Naledi", email: ORG.email, password: "customer-pass-9", acceptTerms: true, marketingOptIn: false })).body.error.code, "email_taken");
    assert.equal((await anon("/api/auth/register", { fullName: "Boss", email: ADMIN.email, password: "customer-pass-9", acceptTerms: true, marketingOptIn: false })).body.error.code, "email_taken");
    // An organiser's team: organiser accounts only.
    const o = api(orgP);
    const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;
    assert.equal((await o.post(`/api/organiser/${orgId}/members`, { email: FAN.email, role: "viewer" })).body.error.code, "not_organiser_account");
    const added = await o.post(`/api/organiser/${orgId}/members`, { email: "thabo.team@example.co.za", role: "manager" });
    assert.equal(added.status, 201); assert.equal(added.body.invited, true);
    assert.match(lastMail("thabo.team@example.co.za").body, /\/organisers#\/reset\//);
    assert.equal(sql("SELECT account_type FROM users WHERE email = 'thabo.team@example.co.za'")[0].account_type, "organiser");
    step("customers, organisers and staff each sign in on their own portal only; the wrong portal shows a note, never the inside");

    // 2. Admin portal: staff only, made and reset by the owner.
    const a = await page(browser);
    await a.goto(`${BASE}/admin`);
    const box = a.locator("dialog");
    await box.getByText("TicketRoom staff only").waitFor();
    assert.equal(await box.getByRole("button", { name: /Create account|Forgot password/ }).count(), 0, "no sign-up or reset on the admin sign-in");
    assert.equal(await a.locator("#header").getByRole("button", { name: /Create account|Start selling/ }).count(), 0, "no sign-up in the admin header");
    await box.getByLabel("Email").fill(ADMIN.email);
    await box.getByLabel("Password").fill(ADMIN.password);
    await box.getByRole("button", { name: "Sign in" }).click();
    await a.locator(".portal-bar.pb-admin").waitFor();
    // Forgot password never mails a staff member.
    const before = sql("SELECT count(*) AS n FROM message_outbox WHERE to_address = ?", ADMIN.email)[0].n;
    assert.equal((await anon("/api/auth/password/forgot", { email: ADMIN.email })).status, 200, "same answer as for anyone");
    assert.equal(sql("SELECT count(*) AS n FROM message_outbox WHERE to_address = ?", ADMIN.email)[0].n, before, "no reset email for staff");
    // Customers & organisers: no staff roles anywhere.
    const ad = api(a);
    await a.goto(`${BASE}/admin#/users`);
    await a.getByRole("heading", { name: "Customers & organisers" }).waitFor();
    await a.locator("tr", { hasText: FAN.email }).getByRole("button", { name: "Open" }).click();
    await a.locator("dialog[open]").getByText("Customer account").waitFor();
    assert.equal(await a.locator("dialog[open]").getByRole("button", { name: /Make admin|Make finance|Make support/ }).count(), 0, "no staff roles on customers");
    await a.keyboard.press("Escape");
    const fanId = sql("SELECT id FROM users WHERE email = ?", FAN.email)[0].id;
    assert.equal((await ad.post(`/api/admin/users/${fanId}/roles`, { role: "admin", grant: true })).status, 404, "the old role switch is gone");
    assert.equal((await ad.post("/api/admin/staff", { email: FAN.email, fullName: "Sipho", roles: ["support"] })).body.error.code, "not_staff_account", "a customer's email can't be made staff");
    assert.equal((await ad.post("/api/admin/staff", { email: ORG.email, fullName: "Naledi", roles: ["finance"] })).body.error.code, "not_staff_account");
    assert.equal(sql("SELECT count(*) AS n FROM platform_roles r JOIN users u ON u.id = r.user_id WHERE u.account_type <> 'staff'")[0].n, 0, "no staff roles on any non-staff account");
    // A new staff member: their own account, a link to the admin portal, and the owner resets them.
    assert.equal((await ad.post("/api/admin/staff", { email: "ayanda@ticketroom.co.za", fullName: "Ayanda Khumalo", roles: ["support"] })).status, 201);
    const inv = lastMail("ayanda@ticketroom.co.za");
    const link = inv.body.match(/\/admin#\/reset\/(\S+)/);
    assert.ok(link, "staff invite opens in the admin portal");
    const st = await page(browser);
    await st.goto(`${BASE}/admin#/reset/${link[1]}`);
    await st.getByLabel("New password", { exact: true }).fill("support-pass-123");
    await st.getByLabel("Confirm new password").fill("support-pass-123");
    await st.getByRole("button", { name: "Save password" }).click();
    await st.locator(".portal-bar.pb-admin").waitFor();
    const stId = sql("SELECT id FROM users WHERE email = 'ayanda@ticketroom.co.za'")[0].id;
    const ownerId = sql("SELECT value FROM meta WHERE key = 'owner_user_id'")[0].value;
    assert.equal((await ad.post(`/api/admin/staff/${stId}/reset`)).status, 200);
    assert.match(lastMail("ayanda@ticketroom.co.za").subject, /Choose a new TicketRoom password/);
    // Ayanda (support) can't touch the owner or the integrations.
    const sa = api(st);
    assert.equal((await sa.get("/api/admin/integrations")).status, 403, "provider settings are for admins only");
    assert.equal((await sa.post(`/api/admin/staff/${ownerId}/reset`)).status, 403);
    // A second admin still can't act on the owner.
    await ad.put(`/api/admin/staff/${stId}`, { roles: ["admin", "support"] });
    assert.equal((await sa.put(`/api/admin/staff/${ownerId}`, { roles: ["support"] })).status, 403, "the owner's roles are the owner's");
    assert.equal((await sa.post(`/api/admin/users/${ownerId}/status`, { status: "suspended", reason: "testing" })).status, 403);
    await ad.put(`/api/admin/staff/${stId}`, { roles: [] });
    assert.equal((await login({ email: "ayanda@ticketroom.co.za", password: "support-pass-123", portal: "admin" })).body.error.code, "suspended", "off the team means off");
    // Staff never act as an organiser (no bank details, payouts or campaigns in their name).
    assert.equal((await ad.get(`/api/organiser/${orgId}`)).status, 404);
    assert.equal((await ad.put(`/api/organiser/${orgId}/bank`, { bankName: "X", accountHolder: "X", accountNumber: "123456789", branchCode: "250655", accountType: "cheque" })).status, 404);
    step("admin sign-in has no sign-up or reset; staff are made only in Staff & roles, never from customers or organisers; the owner is protected; staff never act as organisers");

    // 3. Integrations: nothing shown back, password asked on save, tests to any address.
    await a.goto(`${BASE}/admin#/integrations`);
    await a.getByRole("heading", { name: "Card payments" }).waitFor();
    assert.equal(await a.locator("#main input[autocomplete='current-password']").count(), 0, "no password box on the page");
    const save = async (key, fill) => {
      const card = a.locator(`[data-integ="${key}"]`);
      await fill(card);
      await card.getByRole("button", { name: /^Save / }).click();
      const d = a.locator("dialog[open]");
      await d.getByLabel("Your password").fill(ADMIN.password);
      const done = a.waitForResponse((r) => r.url().endsWith(`/api/admin/integrations/${key}`) && r.request().method() === "PUT");
      await d.getByRole("button", { name: "Save" }).click();
      assert.equal((await done).status(), 200, `${key} saved`);
    };
    await save("email", async (c) => {
      await c.getByLabel("Send email with").selectOption("log");
      await c.getByLabel("SMTP server").fill("mail.ticketroom.co.za");
      await c.getByLabel(/^Username/).click(); await c.getByLabel(/^Username/).fill("no-reply@ticketroom.co.za");
      await c.getByLabel(/^Password/).click(); await c.getByLabel(/^Password/).fill("mailbox-secret-77");
    });
    const ig = JSON.stringify((await ad.get("/api/admin/integrations")).body);
    for (const secret of ["no-reply@ticketroom.co.za", "mailbox-secret-77"]) assert.ok(!ig.includes(secret), `${secret} never sent back`);
    await a.goto(`${BASE}/admin#/integrations`);
    await a.locator('[data-integ="email"]').getByLabel(/^Username/).waitFor();
    assert.equal(await a.locator('[data-integ="email"]').getByLabel(/^Username/).inputValue(), "", "username box is empty: write-only");
    // Test email to an address of the admin's choosing.
    await a.locator('[data-integ="email"]').getByRole("button", { name: "Send a test email" }).click();
    const td = a.locator("dialog[open]");
    await td.getByLabel("Email address").fill("owner.personal@example.co.za");
    await td.getByRole("button", { name: "Send" }).click();
    await a.getByText(/Recorded, not sent|Sent to owner\.personal@example\.co\.za/).first().waitFor();
    assert.equal(lastMail("owner.personal@example.co.za").subject, "TicketRoom test email");
    // Every email template is listed, and each can be sent as a test to any address.
    const { emails } = (await ad.get("/api/admin/emails")).body;
    const keys = emails.map((e) => e.key);
    for (const k of ["orderConfirmedFree", "orderConfirmedPaid", "finishAccount", "supportReply", "queryPassedOn", "queryForOrganiser", "refundDone", "payoutRequested", "payoutPaid", "payoutRejected", "gatePass", "teamInvite", "staffPasswordReset", "orgMemberInvite", "staffInvite"]) assert.ok(keys.includes(k), `template ${k} listed`);
    assert.deepEqual([...new Set(emails.map((e) => e.audience))].filter((g) => !["Attendee", "Everyone", "Organiser", "Subscriber", "Staff"].includes(g)), [], "every template is in a shown group");
    await a.goto(`${BASE}/admin#/emails`);
    await a.getByRole("heading", { name: "Organiser emails" }).waitFor();
    assert.equal(await a.locator("article").count(), emails.length, "every template is on the page");
    for (const e of emails) assert.equal((await ad.post(`/api/admin/emails/${e.key}/test`, { to: "templates@example.co.za" })).body.ok, true, `test of ${e.key}`);
    assert.equal(sql("SELECT count(*) AS n FROM message_outbox WHERE to_address = 'templates@example.co.za' AND subject LIKE '[TEST]%'")[0].n, emails.length);
    step("integrations: usernames, IDs, keys and passwords never shown back; password asked on save; test emails and every template to any address");

    // 4. Your own SMS provider, and PayFast's test account in one click.
    await a.goto(`${BASE}/admin#/integrations`);
    await a.locator('[data-integ="sms"]').getByLabel("SMS provider").waitFor();
    await save("sms", async (c) => {
      await c.getByLabel("SMS provider").selectOption("http");
      await c.getByLabel(/Send-SMS web address/).click(); await c.getByLabel(/Send-SMS web address/).fill(`${MOCK}/sms/send`);
      await c.getByLabel(/Authorization header/).click(); await c.getByLabel(/Authorization header/).fill("Bearer sms-test-key");
      await c.getByLabel("Field name for the number").fill("recipient");
      await c.getByLabel("Field name for the message").fill("text");
      await c.getByLabel("Number format").selectOption("intl");
    });
    const sms = await ad.post("/api/admin/integrations/sms/test", { phone: "082 123 4567" });
    assert.equal(sms.body.ok, true, JSON.stringify(sms.body));
    const got = JSON.parse(fs.readFileSync(path.join(state, "sms.log"), "utf8").trim().split("\n").pop());
    assert.equal(got.auth, "Bearer sms-test-key");
    assert.deepEqual(Object.keys(JSON.parse(got.body)), ["recipient", "text"]);
    assert.equal(JSON.parse(got.body).recipient, "27821234567");
    assert.ok(!JSON.stringify((await ad.get("/api/admin/integrations")).body).includes("sms-test-key"), "SMS key never shown back");
    fs.writeFileSync(cfgFile, original);
    await new Promise((r) => setTimeout(r, 5000));
    // Without the test switch, only public https addresses are accepted.
    assert.equal((await ad.post("/api/admin/integrations/sms/health")).body.ok, false, "http and private addresses refused");
    await a.goto(`${BASE}/admin#/integrations`);
    await a.getByRole("button", { name: "Use the test account" }).click();
    await a.locator("dialog[open]").getByLabel("Your password").fill(ADMIN.password);
    await a.locator("dialog[open]").getByRole("button", { name: "Save" }).click();
    await a.getByText(/Test payments are ready/).waitFor();
    const pay = (await ad.get("/api/admin/integrations")).body.integrations.find((i) => i.key === "payments");
    assert.equal(pay.provider, "payfast"); assert.equal(pay.environment, "test"); assert.equal(pay.status, "active");
    assert.equal((await anon("/api/config", null, "GET")).body.cardPaymentsEnabled, true, "card checkout ready in test mode");
    step("your own SMS provider through its web API (number, message and key sent as set up); PayFast's test account in one click");

    // 5. Maintenance mode closes the site for visitors, on the server.
    clearLimits();
    assert.equal((await ad.put("/api/admin/settings/maintenance", { enabled: true, message: "Back at 3pm with something new." })).status, 200);
    for (const u of ["/", "/sell", "/account", "/organisers", "/events/anything", "/signin", "/legal/privacy"]) {
      const r = await fetch(BASE + u, { redirect: "manual" });
      assert.equal(r.status, 503, `${u} closed for visitors`);
      assert.match(await r.text(), /Back at 3pm with something new\./);
    }
    assert.equal((await fetch(`${BASE}/admin`)).status, 200, "the admin portal stays open");
    assert.equal((await fetch(`${BASE}/assets/tr.css`)).status, 200);
    for (const [m, u, d] of [["GET", "/api/public/events"], ["POST", "/api/auth/register", { fullName: "New Person", email: "new@example.co.za", password: "new-person-123", acceptTerms: true }], ["POST", "/api/auth/password/forgot", { email: FAN.email }], ["POST", "/api/site/chat", { message: "hi" }], ["POST", "/api/site/subscribe", { email: "x@example.co.za" }]]) {
      assert.equal((await anon(u, d, m)).status, 503, `${m} ${u} closed`);
    }
    assert.equal((await login(FAN)).status, 503, "customers can't sign in");
    assert.equal((await login(ORG)).status, 503, "organisers can't sign in");
    assert.equal((await login(ADMIN)).status, 200, "staff can");
    const fanBlocked = await fanP.request.get(`${BASE}/api/me/tickets`);
    assert.equal(fanBlocked.status(), 503, "a customer already signed in is stopped too");
    assert.equal((await fetch(`${BASE}/api/webhooks/yoco`, { method: "POST", body: "{}" })).status === 503, false, "payment notifications still arrive");
    // Staff see the site, with a reminder.
    await a.goto(`${BASE}/`);
    await a.locator(".maint-staff").getByText("Maintenance mode is on.").waitFor();
    await ad.put("/api/admin/settings/maintenance", { enabled: false, message: "Back at 3pm with something new." });
    assert.equal((await fetch(`${BASE}/`)).status, 200, "open again");
    assert.equal((await login(FAN)).status, 200);
    step("maintenance mode: every page and API closed to visitors by the server (sign-in, sign-up, chat too); staff and payment notifications carry on; off means open");

    if (problems.length) throw new Error(problems.join("\n"));
    console.log("PHP portal checks passed.");
  } finally {
    fs.writeFileSync(cfgFile, original);
    mock.kill();
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
