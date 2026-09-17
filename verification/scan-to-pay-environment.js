// SCAN TO PAY — the environment, not a new payment engine.
//
// What has to be true:
//   1. The feature is OFF until two separate levers both say on.
//   2. Turning it off removes it from customers, and does NOT touch the wallet,
//      the existing POS payment path, or anything else.
//   3. An unsupported QR is refused politely, not paid.
//   4. Monitoring reads the POS engine and leaks nothing sensitive.
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const API = `http://127.0.0.1:${Number(process.argv[2] || 8110)}/v1`;
const stamp = Date.now();
const POSTGRES_URL = process.env.POSTGRES_URL
  || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(t) { console.log(`\n--- ${t} ---`); }
async function call(path, { method = "GET", body, token } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n${"=".repeat(76)}\n  SCAN TO PAY — feature environment\n${"=".repeat(76)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters");

  const admin = (await call("/admin/login", { method: "POST",
    body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" } })).payload;
  check("admin signed in", Boolean(admin.accessToken));

  const customer = {
    fullName: "Scan Tester", email: `scan${stamp}@titopay.local`,
    phone: `+2766${String(stamp).slice(-7)}`, password: "ScanTest!2026#xy", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: customer });
  const login = await call("/auth/login", { method: "POST",
    body: { identifier: customer.email, password: customer.password } });
  const token = login.payload.accessToken;
  check("customer signed in", Boolean(token));

  const walletBefore = await db.query(
    "SELECT COUNT(*)::int n, COALESCE(SUM(available_balance),0) t FROM wallets");

  /* ================================================= 1. OFF by default */
  section("1. The feature is off until two levers agree");
  const config = (await call("/scan-to-pay/admin/config", { token: admin.accessToken })).payload.config;
  check("SCAN_TO_PAY_ENABLED is not set in this environment", config.environmentAllows === false,
    `environmentAllows=${config.environmentAllows}`);
  check("so the feature is off", config.enabled === false);
  check("and the operator is told which lever to pull",
    /SCAN_TO_PAY_ENABLED/.test(String(config.reason)), String(config.reason).slice(0, 60));
  check("the environment defaults to sandbox, never production",
    config.environment === "sandbox", config.environment);

  const capability = await call("/scan-to-pay/capability", { token });
  check("the customer app is told the feature is unavailable",
    capability.status === 200 && capability.payload.enabled === false);
  check("and is offered no schemes", (capability.payload.schemes || []).length === 0);

  const parseOff = await call("/scan-to-pay/parse", { method: "POST", token,
    body: { payload: "titopay://pay/" + "a".repeat(48) } });
  check("scanning is refused while the feature is off", parseOff.status === 404, `HTTP ${parseOff.status}`);

  const cannotForce = await call("/scan-to-pay/admin/config", { method: "POST", token: admin.accessToken,
    body: { enabled: true } });
  check("IT CANNOT BE SWITCHED ON FROM THE CONSOLE ALONE", cannotForce.status === 409,
    `HTTP ${cannotForce.status} ${String(cannotForce.payload.error || "").slice(0, 60)}`);
  const stillOff = (await call("/scan-to-pay/admin/config", { token: admin.accessToken })).payload.config;
  check("and the refusal stored nothing", stillOff.runtimeEnabled === false);

  /* ============================== 2. with the environment lever raised */
  section("2. With SCAN_TO_PAY_ENABLED=true on a second API");
  // A second API process with the environment lever raised, so both states can
  // be observed without restarting the one the other suites use.
  const ALT = `http://127.0.0.1:8175/v1`;
  const altCall = async (path, opts = {}) => {
    const r = await fetch(`${ALT}${path}`, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    return { status: r.status, payload: await r.json().catch(() => ({})) };
  };
  let altUp = false;
  for (let i = 0; i < 40; i += 1) {
    const r = await fetch(`${ALT}/health`).catch(() => null);
    if (r && r.status === 200) { altUp = true; break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  check("second API with the lever raised is up", altUp);

  const altAdmin = (await altCall("/admin/login", { method: "POST",
    body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" } })).payload;
  const altConfig = (await altCall("/scan-to-pay/admin/config", { token: altAdmin.accessToken })).payload.config;
  check("the environment now allows it", altConfig.environmentAllows === true);
  check("but it is STILL off, because the runtime switch is untouched",
    altConfig.enabled === false && altConfig.runtimeEnabled === false);

  const enabled = await altCall("/scan-to-pay/admin/config", { method: "POST",
    token: altAdmin.accessToken, body: { enabled: true, reason: "sandbox pilot" } });
  check("an operator can now switch it on", enabled.status === 200 && enabled.payload.config.enabled === true);

  const altLogin = await altCall("/auth/login", { method: "POST",
    body: { identifier: customer.email, password: customer.password } });
  const altToken = altLogin.payload.accessToken;
  const capOn = await altCall("/scan-to-pay/capability", { token: altToken });
  check("the customer app now sees the feature", capOn.payload.enabled === true);
  check("and is offered only schemes TitoPay actually supports",
    capOn.payload.schemes.length === 1 && capOn.payload.schemes[0].key === "titopay_closed_loop",
    capOn.payload.schemes.map((s) => s.key).join(", "));

  /* ================================================= 3. QR handling */
  section("3. A QR payload is an identifier, never a source of money");
  const unsupported = await altCall("/scan-to-pay/parse", { method: "POST", token: altToken,
    body: { payload: "https://www.snapscan.co.za/qr/abcdef" } });
  check("another scheme's QR is refused, politely",
    unsupported.payload.supported === false && /isn't currently supported/i.test(unsupported.payload.reason),
    unsupported.payload.reason);

  const junk = await altCall("/scan-to-pay/parse", { method: "POST", token: altToken,
    body: { payload: "hello world" } });
  check("a non-payment QR is refused", junk.payload.supported === false);

  const oversized = await altCall("/scan-to-pay/parse", { method: "POST", token: altToken,
    body: { payload: "a".repeat(5000) } });
  check("an oversized payload is refused rather than parsed", oversized.payload.supported === false);

  const ours = await altCall("/scan-to-pay/parse", { method: "POST", token: altToken,
    body: { payload: `titopay://pay/${"T".repeat(48)}` } });
  check("a TitoPay QR is recognised", ours.payload.supported === true && ours.payload.scheme === "titopay_closed_loop");
  const keys = Object.keys(ours.payload);
  check("PARSING RETURNS NO AMOUNT, MERCHANT OR REFERENCE",
    !keys.some((k) => /amount|merchant|reference|currency/i.test(k)), keys.join(", "));

  // A well-formed token that is not a real intent must not resolve to anything.
  const bogus = await altCall(`/pos/payment-intents/resolve/${"T".repeat(48)}`, { token: altToken });
  check("a made-up token resolves to nothing", bogus.status === 404, `HTTP ${bogus.status}`);

  /* ================================================= 4. monitoring */
  section("4. Admin monitoring reads the POS engine and leaks nothing");
  const overview = await altCall("/scan-to-pay/admin/overview", { token: altAdmin.accessToken });
  check("the overview responds", overview.status === 200 && overview.payload.cards);
  check("a rate is null rather than a fake 0% when there is no traffic",
    overview.payload.cards.total > 0 || overview.payload.cards.successRate === null,
    `total=${overview.payload.cards.total} successRate=${overview.payload.cards.successRate}`);

  const payments = await altCall("/scan-to-pay/admin/payments", { token: altAdmin.accessToken });
  check("the payments list responds", payments.status === 200);
  const dump = JSON.stringify(payments.payload);
  check("NO QR TOKEN HASH IS EXPOSED", !/qr_token_hash|qrTokenHash/.test(dump));
  check("no terminal credential is exposed", !/credential/i.test(dump));
  check("no customer email or phone is exposed", !/@[a-z0-9.-]+\.(com|za|local)|\+27\d{7}/i.test(dump));

  const asCustomer = await altCall("/scan-to-pay/admin/overview", { token: altToken });
  check("a customer token cannot read the admin monitoring",
    asCustomer.status === 403 || asCustomer.status === 401, `HTTP ${asCustomer.status}`);

  /* ================================= 5. nothing existing was disturbed */
  section("5. The protected infrastructure is untouched");
  const walletAfter = await db.query(
    "SELECT COUNT(*)::int n, COALESCE(SUM(available_balance),0) t FROM wallets");
  check("NO WALLET BALANCE CHANGED", Number(walletAfter.rows[0].t) === Number(walletBefore.rows[0].t),
    `R${walletBefore.rows[0].t} -> R${walletAfter.rows[0].t}`);
  check("no wallet was created or removed", walletAfter.rows[0].n === walletBefore.rows[0].n);

  const drift = await db.query(
    `SELECT COUNT(*)::int n FROM (
       SELECT w.id, w.available_balance,
              COALESCE(SUM(CASE WHEN l.entry_type='credit' THEN l.amount
                                WHEN l.entry_type='debit' THEN -l.amount ELSE 0 END),0) led
         FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id
        GROUP BY w.id, w.available_balance) x WHERE ABS(x.available_balance-x.led) > 0.005`);
  check("every wallet still agrees with its ledger", drift.rows[0].n === 0);

  // The existing POS endpoints must answer exactly as before, on the API where
  // the feature is OFF — the flag must not have gated the terminal path.
  const posStillThere = await call(`/pos/payment-intents/resolve/${"T".repeat(48)}`, { token });
  check("the existing POS resolve endpoint is unaffected by the flag",
    posStillThere.status === 404, `HTTP ${posStillThere.status} (404 = reached it, no such intent)`);

  for (const [path, label] of [["/wallets", "wallets"], ["/transactions", "transactions"]]) {
    const r = await call(path, { token });
    check(`${label} still work`, r.status === 200, `HTTP ${r.status}`);
  }

  const noTables = await db.query(
    `SELECT COUNT(*)::int n FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'scan_to_pay%'`);
  check("NO NEW TABLE WAS CREATED — the POS tables are reused",
    noTables.rows[0].n === 0, `${noTables.rows[0].n} scan_to_pay_* tables`);

  const audits = await db.query(
    `SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'scan_to_pay%'
       AND created_at > NOW() - INTERVAL '5 minutes'`);
  check("switching the feature on is in the audit log",
    audits.rows.some((r) => r.action === "scan_to_pay_enabled"),
    audits.rows.map((r) => r.action).join(", "));

  // Leave it as we found it.
  await altCall("/scan-to-pay/admin/config", { method: "POST", token: altAdmin.accessToken,
    body: { enabled: false, reason: "end of test" } }).catch(() => {});
  await db.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(76)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`    - ${f.name}`);
  console.log(`${"=".repeat(76)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
