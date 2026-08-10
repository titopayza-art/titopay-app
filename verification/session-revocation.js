// PRE-LAUNCH AUDIT — round two.
//
//   A. Does "Sign out this device" in the Security Centre actually sign anything out?
//   B. With the victim's wallet FUNDED and carrying real ledger rows, does the
//      statement endpoint still refuse another customer? (round one saw an empty
//      wallet, which proves nothing)
//   C. Does the account-wide logout path work, so we can say what IS wired up?

const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";
const { execSync } = require("child_process");
const PG = (require("fs").readFileSync(__dirname + "/local.env", "utf8").match(/^POSTGRES_URL=(.*)$/m) || [])[1].replace(/^"|"$/g, "").trim();
const sql = (q) => execSync(`psql "${PG}" -At -F'|' -c "${q.replace(/\n/g, " ").replace(/"/g, '\\"')}"`).toString().trim();

const stamp = Date.now();
let seq = 0;

async function raw(path, o = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, o.headers || {});
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const r = await fetch(`${API}${path}`, { method: o.method || "GET", headers, body: o.body ? JSON.stringify(o.body) : undefined, redirect: "manual" });
  const t = await r.text();
  try { return { status: r.status, payload: JSON.parse(t || "{}") }; } catch { return { status: r.status, payload: { raw: t.slice(0, 200) } }; }
}
async function call(path, o = {}) {
  for (let i = 0; i < 6; i += 1) {
    const res = await raw(path, o);
    if (res.status !== 429) return res;
    const w = Math.min((res.payload.retryAfterSeconds || 15) * 1000, 65000);
    process.stdout.write(`      (429, waiting ${Math.round(w / 1000)}s)\n`);
    await new Promise((r) => setTimeout(r, w));
  }
  return raw(path, o);
}
const peach = (p, b) => fetch(`${PEACH}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const results = [];
const record = (n, pass, d = "") => { results.push({ n, pass, d }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${n}${d ? `\n        ${d}` : ""}`); };

(async () => {
  console.log(`\n${"=".repeat(78)}\nTITOPAY PRE-LAUNCH AUDIT — session revocation and statement scoping\n${"=".repeat(78)}`);

  const user = {
    fullName: "Session Probe", email: `sess${stamp}@titopay.local`,
    phone: `+2779${String(stamp).slice(-7)}`, password: "SessProbe!2026#x", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: user });
  const login = (t) => call("/auth/login", { method: "POST", body: { identifier: user.email, password: user.password } }).then((r) => r.payload.accessToken);

  console.log(`\n── A. "Sign out this device"`);
  const T1 = await login();          // the phone the customer is holding
  const T2 = await login();          // the session they want to kill
  if (!T1 || !T2) throw new Error("could not obtain two sessions");
  const userId = sql(`SELECT id FROM users WHERE email='${user.email}'`);
  const sessionRows = sql(`SELECT id, revoked_at IS NULL AS live FROM sessions WHERE user_id='${userId}' ORDER BY created_at`);
  console.log(`     sessions table:        ${sessionRows.split("\n").length} row(s) for this customer`);
  const activeCount = sql(`SELECT count(*) FROM active_sessions WHERE user_id='${userId}'`);
  console.log(`     active_sessions table: ${activeCount} row(s) — this is the table the Security Centre reads`);

  const devices = await call("/security/devices", { token: T1 });
  console.log(`     GET /security/devices returns ${(devices.payload.items || []).length} item(s): ${JSON.stringify(devices.payload.items || []).slice(0, 120)}`);
  record("Security Centre lists the customer's real sessions",
    (devices.payload.items || []).length >= 2,
    `${(devices.payload.items || []).length} listed, but the customer genuinely has ${sessionRows.split("\n").length} live sessions`);

  const secondSessionId = sessionRows.split("\n")[1]?.split("|")[0];
  const before = await call("/wallets", { token: T2 });
  const logout = await call(`/security/sessions/${secondSessionId}/logout`, { method: "POST", token: T1, body: {} });
  console.log(`     POST /security/sessions/${(secondSessionId || "").slice(0, 8)}…/logout -> HTTP ${logout.status} ${JSON.stringify(logout.payload)}`);
  await new Promise((r) => setTimeout(r, 800));
  const after = await call("/wallets", { token: T2 });
  const stillLive = sql(`SELECT revoked_at IS NULL FROM sessions WHERE id='${secondSessionId}'`);
  console.log(`     the "signed out" token before: HTTP ${before.status}   after: HTTP ${after.status}`);
  console.log(`     sessions.revoked_at still NULL for that session: ${stillLive}`);
  record("signing a device out actually revokes its token",
    after.status === 401,
    after.status === 200
      ? `the API answered ok:true and the revoked session's bearer token still returns HTTP 200 — nothing was signed out`
      : "");

  console.log(`\n── C. Does the account-wide logout work?`);
  const logoutAll = await call("/auth/logout-all", { method: "POST", token: T1, body: {} });
  const t2AfterAll = await call("/wallets", { token: T2 });
  const t1AfterAll = await call("/wallets", { token: T1 });
  console.log(`     POST /auth/logout-all -> HTTP ${logoutAll.status}`);
  console.log(`     other session afterwards: HTTP ${t2AfterAll.status}   own session: HTTP ${t1AfterAll.status}`);
  record("logout-all revokes other sessions", logoutAll.status < 400 && t2AfterAll.status === 401,
    logoutAll.status >= 400 ? `logout-all returned ${logoutAll.status} ${JSON.stringify(logoutAll.payload).slice(0, 120)}` : "");

  console.log(`\n── B. Statement scoping with a FUNDED victim wallet`);
  const vic = {
    fullName: "Funded Victim", email: `vic${stamp}@titopay.local`,
    phone: `+2779${String(stamp).slice(-6)}1`, password: "VicProbe!2026#x", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: vic });
  const vt = (await call("/auth/login", { method: "POST", body: { identifier: vic.email, password: vic.password } })).payload.accessToken;
  const vwallet = ((await call("/wallets", { token: vt })).payload.items || [])[0];

  const key = `sess-fund-${stamp}`;
  const topup = await call("/payments/topup", { method: "POST", token: vt, headers: { "idempotency-key": key }, body: { amount: 750, currency: "ZAR", idempotencyKey: key } });
  if (topup.payload.checkoutId) {
    await peach("/__complete", { checkoutId: topup.payload.checkoutId, outcome: "successful" });
    await peach("/__webhook", { checkoutId: topup.payload.checkoutId });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 400));
      const b = Number(((await call("/wallets", { token: vt })).payload.items || [])[0]?.available_balance || 0);
      if (b >= 749) break;
    }
  }
  const ledgerRows = sql(`SELECT count(*) FROM wallet_ledger WHERE wallet_id='${vwallet.id}'`);
  const ownStatement = await call(`/wallets/${vwallet.id}/statement`, { token: vt });
  console.log(`     victim wallet ${vwallet.id.slice(0, 8)}… has ${ledgerRows} ledger row(s); owner sees ${(ownStatement.payload.items || []).length}`);

  const att = {
    fullName: "Statement Attacker", email: `att${stamp}@titopay.local`,
    phone: `+2779${String(stamp).slice(-6)}2`, password: "AttProbe!2026#x", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: att });
  const at = (await call("/auth/login", { method: "POST", body: { identifier: att.email, password: att.password } })).payload.accessToken;
  const stolen = await call(`/wallets/${vwallet.id}/statement`, { token: at });
  console.log(`     attacker requesting the same wallet: HTTP ${stolen.status}, ${(stolen.payload.items || []).length} row(s)`);
  record("a funded wallet's statement is not readable by another customer",
    Number(ledgerRows) > 0 && (stolen.payload.items || []).length === 0,
    Number(ledgerRows) === 0 ? "INCONCLUSIVE — the victim wallet ended up with no ledger rows" : "");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(78)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log(`    FAILED: ${f.n}\n            ${f.d}`));
  console.log(`${"=".repeat(78)}\n`);
})().catch((e) => { console.error("\n  HARNESS ERROR:", e.message, "\n"); process.exit(1); });
