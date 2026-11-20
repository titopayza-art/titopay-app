// Sign in with Google: switched on by an admin under Integrations; customers
// and organisers continue with Google on their own portals; staff never can.
// Google is played by tests-ui/mocks/providers.php. Run after php-walkthrough.js:
//   node tests-ui/php-google.js http://127.0.0.1:8600 /srv/trtest/public_html
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const MOCK = "http://127.0.0.1:8703";
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);

(async () => {
  sql("DELETE FROM rate_limits");
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  const state = fs.mkdtempSync("/tmp/tr-google-");
  const mock = spawn("php", ["-S", "127.0.0.1:8703", path.join(__dirname, "mocks", "providers.php")], { env: { ...process.env, TARGET: BASE, STATE: state }, stdio: "ignore" });
  fs.writeFileSync(cfgFile, original.replace("return [", `return [\n    'google' => ['authUrl' => '${MOCK}/google/auth', 'tokenUrl' => '${MOCK}/google/token'],`));
  await new Promise((r) => setTimeout(r, 3000)); // PHP rereads config every ~2 s
  const as = (who) => fs.writeFileSync(path.join(state, "google.json"), JSON.stringify(who));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const ctx = async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, functional: true, analytics: true })); } catch { /* no storage */ } });
    const p = await c.newPage();
    p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
    return p;
  };
  try {
    // 1. Off until an admin sets it up; the button only appears once it works.
    assert.equal((await (await fetch(`${BASE}/api/config`)).json()).googleSignIn, false);
    const off = await fetch(`${BASE}/api/auth/google/start?portal=customer`, { redirect: "manual" });
    assert.match(off.headers.get("location"), /\/account\?google=off$/, "switched off: straight back with a note");
    const a = await ctx();
    assert.equal((await a.request.post(`${BASE}/api/auth/login`, { data: ADMIN })).status(), 200);
    await a.goto(`${BASE}/admin#/integrations`);
    const card = a.locator('[data-integ="google"]');
    await card.getByText(/Authorised redirect URIs/).waitFor();
    await card.getByLabel("Sign in with Google").selectOption("on");
    await card.getByLabel("OAuth client ID").fill("tr-test.apps.googleusercontent.com");
    await card.getByLabel(/OAuth client secret/).click(); await card.getByLabel(/OAuth client secret/).fill("google-test-secret");
    await card.getByRole("button", { name: /^Save / }).click();
    await a.locator("dialog[open]").getByLabel("Your password").fill(ADMIN.password);
    await a.locator("dialog[open]").getByRole("button", { name: "Save" }).click();
    await card.locator(".badge", { hasText: "live" }).waitFor();
    const ig = JSON.stringify(await (await a.request.get(`${BASE}/api/admin/integrations`)).json());
    assert.ok(!ig.includes("google-test-secret"), "client secret never shown back");
    assert.equal((await (await fetch(`${BASE}/api/config`)).json()).googleSignIn, true);
    step("off by default; admin switches it on in Integrations with the client ID and secret (secret never shown back)");

    // 2. A new customer signs up with Google from the customer portal.
    as({ email: "lindiwe.google@gmail.com", name: "Lindiwe Dube" });
    const c = await ctx();
    await c.goto(`${BASE}/account`);
    await c.getByRole("button", { name: "Sign in" }).first().click();
    await c.locator("dialog[open]").getByRole("link", { name: "Continue with Google" }).click();
    await c.waitForURL(/\/account/);
    await c.locator(".portal-bar:visible, .side-portal:visible").first().waitFor();
    const u1 = sql("SELECT account_type, email_verified_at, full_name FROM users WHERE email = 'lindiwe.google@gmail.com'")[0];
    assert.equal(u1.account_type, "customer"); assert.ok(u1.email_verified_at); assert.equal(u1.full_name, "Lindiwe Dube");
    assert.equal((await (await c.request.get(`${BASE}/api/auth/me`)).json()).user.email, "lindiwe.google@gmail.com");
    step("new customer: Continue with Google creates a confirmed customer account and signs them in");

    // 3. A guest buyer (tickets bought without an account) becomes a full account, tickets kept.
    const guest = sql("SELECT email FROM users WHERE guest = 1 LIMIT 1")[0];
    if (guest) {
      as({ email: guest.email, name: "Guest Buyer" });
      const g = await ctx();
      await g.goto(`${BASE}/api/auth/google/start?portal=customer&next=${encodeURIComponent("/account#/tickets")}`);
      await g.waitForURL(/\/account#\/tickets/);
      assert.equal(Number(sql("SELECT guest FROM users WHERE email = ?", guest.email)[0].guest), 0);
      step("guest buyer: Google confirms the email, the account opens with their tickets");
    }

    // 4. A new organiser from the organiser portal; the wrong portal is refused.
    as({ email: "sizwe.events@gmail.com", name: "Sizwe Events" });
    const o = await ctx();
    await o.goto(`${BASE}/api/auth/google/start?portal=organiser`);
    await o.waitForURL(/\/organisers/);
    assert.equal(sql("SELECT account_type FROM users WHERE email = 'sizwe.events@gmail.com'")[0].account_type, "organiser");
    as({ email: "lindiwe.google@gmail.com", name: "Lindiwe Dube" });
    const w = await ctx();
    await w.goto(`${BASE}/api/auth/google/start?portal=organiser`);
    await w.waitForURL(/\/organisers\?google=customer_account|\/organisers$/);
    await w.getByText(/belongs to a customer account/).waitFor();
    assert.equal((await (await w.request.get(`${BASE}/api/auth/me`)).json()).user, null, "not signed in");
    step("organiser portal creates organiser accounts; a customer email is sent back with a clear note");

    // 5. Staff never sign in with Google; unverified emails and cancelled consent are refused.
    for (const [who, code] of [[{ email: ADMIN.email, name: "Boss" }, "not_allowed"], [{ email: "unverified@example.co.za", verified: false }, "unverified"], [{ deny: true }, "cancelled"]]) {
      as(who);
      const s = await ctx();
      await s.goto(`${BASE}/api/auth/google/start?portal=customer`);
      await s.waitForURL(/\/account/);
      await s.locator(".toast").first().waitFor();
      assert.equal((await (await s.request.get(`${BASE}/api/auth/me`)).json()).user, null, `${code}: not signed in`);
      await s.context().close();
    }
    assert.equal(sql("SELECT count(*) AS n FROM users WHERE email = 'unverified@example.co.za'")[0].n, 0);
    // A forged callback (no state from this browser) does nothing.
    const forged = await fetch(`${BASE}/api/auth/google/callback?code=x&state=y`, { redirect: "manual" });
    assert.match(forged.headers.get("location"), /google=expired/);
    // The admin sign-in box never offers Google.
    const st = await ctx();
    await st.goto(`${BASE}/admin`);
    await st.getByRole("button", { name: "Sign in" }).first().click();
    await st.locator("dialog[open]").getByText("TicketRoom staff only").waitFor();
    assert.equal(await st.locator("dialog[open]").getByRole("link", { name: "Continue with Google" }).count(), 0);
    step("staff never sign in with Google; unverified emails, cancelled consent and forged callbacks are refused");

    if (problems.length) throw new Error(problems.join("\n"));
    console.log("PHP Google sign-in checks passed.");
  } finally {
    fs.writeFileSync(cfgFile, original);
    mock.kill();
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
