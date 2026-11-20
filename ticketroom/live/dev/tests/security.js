// Staff two-step sign-in, the admin Security card, Cloudflare Turnstile and
// the hidden form traps, SC1-SC7:
//   SC1 a staff member sets up an authenticator app (QR key, first code)
//   SC2 sign-in then asks for the app's code, not an emailed one; a wrong
//       code and the same code twice are refused
//   SC3 the switch "staff must use two-step" needs the admin's password and
//       their own two-step first; the card lists who has not set it up
//   SC4 with the switch on, a staff member without two-step can only set it
//       up; once set up, the admin portal opens
//   SC5 an admin resets a colleague's two-step: they are signed out
//   SC6 hidden traps: a public form with the trap field filled is refused
//   SC7 Turnstile: keys saved write-only; forms need a token Cloudflare
//       accepts; the site key is public, the secret never leaves the server
//
//   node tests/security.js <dir from serve.sh> [port]
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Client, sql, outbox, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: security.js <dir from serve.sh> [port]"); process.exit(2); }
const BASE = `http://localhost:${process.argv[3] || 8787}`;
const DATA = path.join(DIR, "ticketroom-data");
const PW = process.env.TR_TEST_ADMIN_PASSWORD;
const MOCK_PORT = Number(process.env.TR_SECURITY_MOCK_PORT || 8796);
let passes = 0, failures = 0;
async function test(name, fn) { try { await fn(); passes++; console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}  ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };
const js = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async (p) => { try { await p; return 200; } catch (e) { const m = e.message.match(/-> (\d{3})/); return m ? Number(m[1]) : 0; } };
const one = (q, p = []) => sql(DATA, q, p)[0];

// An authenticator app, as on a phone (RFC 6238, SHA-1, 30 s, 6 digits).
function b32(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/[^A-Z2-7]/gi, "").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, offset = 0) {
  const step = Math.floor(Date.now() / 30000) + offset;
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(step / 2 ** 32), 0); msg.writeUInt32BE(step % 2 ** 32, 4);
  const h = crypto.createHmac("sha1", b32(secret)).update(msg).digest();
  const o = h[19] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
// The next code that has not been used yet (codes change every 30 seconds).
async function freshCode(secret, used) { for (;;) { const c = totp(secret); if (!used.has(c)) { used.add(c); return c; } await sleep(1000); } }

function writeConfig(entry) {
  const f = path.join(DATA, "config.php");
  let s = fs.readFileSync(f, "utf8").replace(/\n    'turnstile' => \[[^\n]*\],/, "");
  if (entry) s = s.replace(/\n\];\s*$/, `\n    'turnstile' => ${entry},\n];\n`);
  fs.writeFileSync(f, s);
}

(async () => {
  const admin = new Client(BASE, DATA); await admin.staffLogin(ADMIN_EMAIL, PW);
  const adminId = one("SELECT id FROM users WHERE lower(email) = lower(?)", [ADMIN_EMAIL]).id;
  let secret; const used = new Set();

  await test("SC1 a staff member sets up an authenticator app: QR, key, and a first code", async () => {
    const s0 = await admin.call("GET", "/api/admin/me/two-step");
    assert(s0.enabled === false, js(s0));
    const r = await admin.call("POST", "/api/admin/me/two-step/start");
    assert(r.qrSvg.startsWith("<svg") && r.uri.startsWith("otpauth://totp/TicketRoom") && /^[A-Z2-7 ]{32,}$/.test(r.secret), js({ uri: r.uri, secret: r.secret }));
    secret = r.secret;
    assert(await status(admin.call("POST", "/api/admin/me/two-step/confirm", { code: totp(secret) === "000000" ? "111111" : "000000" })) === 422, "a wrong first code was accepted");
    await admin.call("POST", "/api/admin/me/two-step/confirm", { code: await freshCode(secret, used) });
    const row = one("SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?", [adminId]);
    assert(row.totp_enabled_at && row.totp_secret.startsWith("v1.") && !row.totp_secret.includes(secret.replace(/ /g, "")), "the secret is not stored encrypted");
    assert((await admin.call("GET", "/api/admin/staff")).staff.find((x) => x.id === adminId).two_step === true, "not shown on the staff list");
  });

  await test("SC2 sign-in asks for the app's code, not an emailed one; wrong and repeated codes are refused", async () => {
    const c = new Client(BASE, DATA);
    await sleep(300); const since = new Date().toISOString();
    const r = await c.call("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: PW, portal: "admin" });
    assert(r.mfaRequired && r.mfaType === "totp", js(r));
    const mails = sql(DATA, "SELECT subject, created_at FROM message_outbox WHERE lower(to_address) = lower(?) AND created_at >= ?", [ADMIN_EMAIL, since]);
    assert(!mails.length, `an email was sent as well: ${js(mails)} since ${since}`);
    assert(await status(c.call("POST", "/api/auth/staff-code/verify", { challenge: r.challenge, code: "123456" === totp(secret) ? "654321" : "123456" })) === 400, "a wrong code signed in");
    const code = await freshCode(secret, used);
    await c.call("POST", "/api/auth/staff-code/verify", { challenge: r.challenge, code });
    await c.refreshCsrf();
    assert((await c.call("GET", "/api/admin/me/two-step")).enabled === true, "not signed in");
    const again = await new Client(BASE, DATA).call("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: PW, portal: "admin" });
    assert(await status(new Client(BASE, DATA).call("POST", "/api/auth/staff-code/verify", { challenge: again.challenge, code })) === 400, "the same code worked twice");
  });

  let dev, devId;
  await test("SC3 the switch needs the admin's password and their own two-step; the card lists who has not set it up", async () => {
    const email = `dev.two+${Date.now()}@ticketroom.co.za`;
    await admin.call("POST", "/api/admin/staff", { fullName: "Dev Two", email, roles: ["support"] });
    devId = one("SELECT id FROM users WHERE lower(email) = lower(?)", [email]).id;
    const devPw = "Dev-Two-pass-" + crypto.randomBytes(6).toString("hex");
    sql(DATA, "UPDATE users SET password_hash = ?, email_verified_at = ? WHERE id = ?", [require("child_process").execFileSync("php", ["-r", `echo password_hash(${js(devPw)}, PASSWORD_DEFAULT);`], { encoding: "utf8" }), new Date().toISOString(), devId]);
    dev = { email, pw: devPw };
    const card = await admin.call("GET", "/api/admin/security");
    assert(card.staffTwoStep === false && card.notSetUp.includes("Dev Two") && !card.notSetUp.some((n) => /hello|Owner/i.test(n) && n === undefined), js(card));
    assert(await status(admin.call("PUT", "/api/admin/security", { currentPassword: "wrong-password-123", staffTwoStep: true })) === 401, "saved with a wrong password");
    const support = new Client(BASE, DATA); await support.staffLogin(email, devPw);
    assert(await status(support.call("PUT", "/api/admin/security", { currentPassword: devPw, staffTwoStep: true })) === 403, "a support role changed security");
    const on = await admin.call("PUT", "/api/admin/security", { currentPassword: PW, staffTwoStep: true });
    assert(on.staffTwoStep === true && on.notSetUp.includes("Dev Two"), js(on));
  });

  await test("SC4 with the switch on, staff without two-step can only set it up; then the portal opens", async () => {
    const d = new Client(BASE, DATA); await d.staffLogin(dev.email, dev.pw);
    const me = await d.call("GET", "/api/auth/me");
    assert(me.user.twoStepRequired === true && me.user.twoStepEnabled === false, js(me.user));
    assert(await status(d.call("GET", "/api/admin/support")) === 403, "the portal opened without two-step");
    const r = await d.call("POST", "/api/admin/me/two-step/start");
    const devUsed = new Set();
    await d.call("POST", "/api/admin/me/two-step/confirm", { code: await freshCode(r.secret, devUsed) });
    await d.refreshCsrf();
    assert(await status(d.call("GET", "/api/admin/support")) === 200, "still locked after setting up");
    assert(await status(d.call("POST", "/api/admin/me/two-step/off", { currentPassword: dev.pw, code: await freshCode(r.secret, devUsed) })) === 409, "turned off while compulsory");
    dev.client = d;
  });

  await test("SC5 an admin resets a colleague's two-step: they are signed out", async () => {
    assert(await status(admin.call("POST", `/api/admin/staff/${adminId}/two-step/reset`)) === 409, "reset their own from the staff list");
    await admin.call("POST", `/api/admin/staff/${devId}/two-step/reset`);
    assert(await status(dev.client.call("GET", "/api/admin/support")) === 401, "still signed in after the reset");
    assert(!one("SELECT totp_enabled_at FROM users WHERE id = ?", [devId]).totp_enabled_at, "not cleared");
    const card = await admin.call("GET", "/api/admin/security");
    assert(card.notSetUp.includes("Dev Two"), js(card));
    await admin.call("PUT", "/api/admin/security", { currentPassword: PW, staffTwoStep: false });
  });

  await test("SC6 hidden traps: a public form with the trap field filled in is refused", async () => {
    const stamp = Date.now();
    const base = { fullName: "Trap Test", password: "Trap-test-pass-2026", acceptTerms: true, marketingOptIn: false };
    assert(await status(new Client(BASE, DATA).call("POST", "/api/auth/register", { ...base, email: `trap1+${stamp}@example.test`, fax_number: "555 1234" })) === 400, "a bot sign-up got through");
    assert(!one("SELECT count(*) AS n FROM users WHERE email = ?", [`trap1+${stamp}@example.test`]).n || Number(one("SELECT count(*) AS n FROM users WHERE email = ?", [`trap1+${stamp}@example.test`]).n) === 0, "the bot account was made");
    assert(await status(new Client(BASE, DATA).call("POST", "/api/auth/register", { ...base, email: `trap2+${stamp}@example.test`, fax_number: "" })) === 200, "a person with an empty trap was refused");
    assert(await status(new Client(BASE, DATA).call("POST", "/api/site/subscribe", { email: `trap3+${stamp}@example.test`, fax_number: "x" })) === 400, "a bot subscription got through");
  });

  await test("SC7 Turnstile: keys saved write-only, forms need a token Cloudflare accepts, only the site key is public", async () => {
    const seen = [];
    const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => {
      const p = new URLSearchParams(b); seen.push(Object.fromEntries(p));
      res.writeHead(200, { "content-type": "application/json" }); res.end(js({ success: p.get("response") === "good-token" && p.get("secret") === "0x4AAAAAAAtestsecretKEY" }));
    }); });
    await new Promise((r) => srv.listen(MOCK_PORT, "127.0.0.1", r));
    try {
      writeConfig(`['verifyUrl' => 'http://127.0.0.1:${MOCK_PORT}/siteverify']`);
      await sleep(2500);
      let bad = await status(admin.call("PUT", "/api/admin/security", { currentPassword: PW, staffTwoStep: false, turnstileSiteKey: "not a key!", turnstileSecretKey: "" }));
      assert(bad === 422, `a broken site key was saved (${bad})`);
      const saved = await admin.call("PUT", "/api/admin/security", { currentPassword: PW, staffTwoStep: false, turnstileSiteKey: "0x4AAAAAAAtestSITEkey", turnstileSecretKey: "0x4AAAAAAAtestsecretKEY" });
      assert(saved.turnstile.on && saved.turnstile.siteKey === "0x4AAAAAAAtestSITEkey" && saved.turnstile.secretSet && !js(saved).includes("testsecret"), js(saved));
      const cfg = await new Client(BASE, DATA).call("GET", "/api/config");
      assert(cfg.turnstileSiteKey === "0x4AAAAAAAtestSITEkey" && !js(cfg).includes("testsecret"), "config: " + js(cfg).slice(0, 200));
      const stored = one("SELECT value FROM integration_settings WHERE key = 'turnstile'").value;
      assert(!stored.includes("testsecret"), "the secret is stored in plain text");
      const stamp = Date.now();
      const body = (n, extra) => ({ email: `ts${n}+${stamp}@example.test`, ...extra });
      assert(await status(new Client(BASE, DATA).call("POST", "/api/site/subscribe", body(1, {}))) === 400, "no token got through");
      assert(await status(new Client(BASE, DATA).call("POST", "/api/site/subscribe", body(2, { turnstileToken: "bad-token" }))) === 400, "a bad token got through");
      assert(await status(new Client(BASE, DATA).call("POST", "/api/site/subscribe", body(3, { "cf-turnstile-response": "good-token" }))) === 200, "a good token was refused");
      assert(seen.length >= 2 && seen.every((x) => x.secret === "0x4AAAAAAAtestsecretKEY"), js(seen));
      const off = await admin.call("PUT", "/api/admin/security", { currentPassword: PW, staffTwoStep: false, clearTurnstile: true });
      assert(!off.turnstile.on && !off.turnstile.secretSet, js(off));
      assert(await status(new Client(BASE, DATA).call("POST", "/api/site/subscribe", body(4, {}))) === 200, "still asking for a token after removing the keys");
    } finally { srv.close(); writeConfig(null); }
  });

  // Back to how the other suites expect it: staff sign in with emailed codes.
  sql(DATA, "UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE account_type = 'staff'");
  sql(DATA, "UPDATE users SET status = 'suspended' WHERE id = ?", [devId || ""]);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
