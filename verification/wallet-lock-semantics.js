// What a locked wallet may and may not do.
//
// The rule the platform is built on: a customer locks their own wallet, and a
// locked wallet can still be PAID INTO but cannot pay ANYTHING OUT. Freezing is
// a separate, admin-side action. This proves that rule against the real API and
// a real Postgres ledger rather than asserting it from the code.
const { Client } = require("./api/node_modules/pg");
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";

const stamp = Date.now();
const OWNER = { fullName: "Lock Owner", email: `lockown${stamp}@titopay.local`, phone: `+2781${String(stamp).slice(-7)}`, password: "LockOwner!2026#x", accountType: "personal" };
const PAYER = { fullName: "Lock Payer", email: `lockpay${stamp}@titopay.local`, phone: `+2782${String(stamp).slice(-7)}`, password: "LockPayer!2026#x", accountType: "personal" };

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };

const db = new Client({ connectionString: process.env.POSTGRES_URL });
const q = (sql, params = []) => db.query(sql, params).then((r) => r.rows);

async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const r = await fetch(`${API}${path}`, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const text = await r.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  return { status: r.status, payload };
}
const peach = (path, body) => fetch(`${PEACH}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());

async function signUp(profile) {
  const reg = await call("/auth/register", { method: "POST", body: profile });
  if (reg.payload.accessToken) return reg.payload.accessToken;
  const login = await call("/auth/login", { method: "POST", body: { identifier: profile.email, password: profile.password } });
  return login.payload.accessToken;
}
const balance = async (token) => Number(((await call("/wallets", { token })).payload.items || [])[0]?.available_balance ?? NaN);

async function fundWallet(token, amount, key) {
  const created = await call("/payments/topup", { method: "POST", token, headers: { "idempotency-key": key }, body: { amount, currency: "ZAR", idempotencyKey: key } });
  const { reference, checkoutId } = created.payload;
  await peach("/__complete", { checkoutId, outcome: "successful" });
  await call(`/payments/topup/${encodeURIComponent(reference)}`, { token });
  return { reference, checkoutId };
}

(async () => {
  console.log("\n================================================================");
  console.log("  A LOCKED WALLET CAN BE PAID INTO, AND CANNOT PAY OUT");
  console.log("================================================================\n");
  await db.connect();
  await peach("/__domain-block", { on: false });

  const owner = await signUp(OWNER);
  const payer = await signUp(PAYER);
  check("both customers signed in", Boolean(owner && payer));

  // Fund both wallets while everything is still unlocked.
  await fundWallet(owner, 400, `lock-own-${stamp}`);
  await fundWallet(payer, 400, `lock-pay-${stamp}`);
  const openingOwner = await balance(owner);
  const openingPayer = await balance(payer);
  check("the wallet under test starts funded and unlocked", openingOwner >= 400, `R ${openingOwner}`);

  // A transfer out works before the lock, so the lock is what changes it.
  const beforeLock = await call("/transactions", {
    method: "POST", token: owner,
    headers: { "idempotency-key": `pre-lock-${stamp}` },
    body: { service: "wallet_transfer", amount: 10, currency: "ZAR", recipient: PAYER.phone, idempotencyKey: `pre-lock-${stamp}` }
  });
  check("before locking, sending money out succeeds", beforeLock.status < 400, `HTTP ${beforeLock.status}`);

  /* ---- lock it, the way the customer does ------------------------------- */
  console.log("\n--- the customer locks their own wallet ---\n");
  const locked = await call("/security/wallet-lock", { method: "POST", token: owner, body: {} });
  check("POST /security/wallet-lock succeeds", locked.status === 200, `HTTP ${locked.status}`);
  const [row] = await q("SELECT profile_locked FROM users WHERE email = $1", [OWNER.email]);
  check("the account is recorded as locked", row?.profile_locked === true, JSON.stringify(row));
  check("the API reports the lock back to the app", locked.payload.user?.profileLocked === true, String(locked.payload.user?.profileLocked));

  const lockedBalance = await balance(owner);
  check("locking moved no money", Math.abs(lockedBalance - (openingOwner - 10)) < 0.005, `R ${lockedBalance}`);

  /* ---- nothing may leave ------------------------------------------------- */
  console.log("\n--- money may not leave ---\n");
  const outgoing = [
    ["send money to another customer", "/transactions", { service: "wallet_transfer", amount: 10, currency: "ZAR", recipient: PAYER.phone }],
    ["buy airtime", "/transactions", { service: "airtime", amount: 10, currency: "ZAR", recipient: OWNER.phone }],
    ["buy electricity", "/transactions", { service: "electricity", amount: 20, currency: "ZAR", meterNumber: "12345678901" }],
    ["pay a bill", "/transactions", { service: "pay_bills", amount: 15, currency: "ZAR", accountNumber: "1234567890" }]
  ];
  for (const [label, path, body] of outgoing) {
    const key = `locked-${label.replace(/\W+/g, "-")}-${stamp}`;
    const r = await call(path, { method: "POST", token: owner, headers: { "idempotency-key": key }, body: { ...body, idempotencyKey: key } });
    check(`locked: ${label} is refused`, r.status === 423, `HTTP ${r.status} ${String(r.payload.error || "").slice(0, 60)}`);
  }

  const withdrawal = await call("/payouts/withdrawals", {
    method: "POST", token: owner,
    headers: { "idempotency-key": `locked-withdraw-${stamp}` },
    body: { amount: 50, currency: "ZAR", idempotencyKey: `locked-withdraw-${stamp}` }
  });
  check("locked: withdrawing to a bank is refused", withdrawal.status === 423 || withdrawal.status === 400,
    `HTTP ${withdrawal.status} ${String(withdrawal.payload.error || "").slice(0, 60)}`);

  const afterAttempts = await balance(owner);
  check("every refused attempt left the balance untouched", Math.abs(afterAttempts - lockedBalance) < 0.005, `R ${lockedBalance} -> R ${afterAttempts}`);

  /* ---- money may still arrive -------------------------------------------- */
  console.log("\n--- money may still arrive ---\n");
  const incomingFrom = await call("/transactions", {
    method: "POST", token: payer,
    headers: { "idempotency-key": `into-locked-${stamp}` },
    body: { service: "wallet_transfer", amount: 25, currency: "ZAR", recipient: OWNER.phone, idempotencyKey: `into-locked-${stamp}` }
  });
  check("another customer can still pay INTO the locked wallet", incomingFrom.status < 400,
    `HTTP ${incomingFrom.status} ${String(incomingFrom.payload.error || "").slice(0, 60)}`);
  const afterIncoming = await balance(owner);
  check("the locked wallet's balance went UP", afterIncoming > afterAttempts, `R ${afterAttempts} -> R ${afterIncoming}`);

  // The owner's OWN card top-up is deliberately refused while locked: a card
  // charge is a payment action initiated by a session that may be the very one
  // the customer locked the wallet against. Incoming money from other people is
  // what keeps flowing.
  const ownTopup = await call("/payments/topup", {
    method: "POST", token: owner,
    headers: { "idempotency-key": `locked-topup-${stamp}` },
    body: { amount: 100, currency: "ZAR", idempotencyKey: `locked-topup-${stamp}` }
  });
  check("the owner's own card top-up is refused while locked", ownTopup.status === 423,
    `HTTP ${ownTopup.status} ${String(ownTopup.payload.error || "").slice(0, 70)}`);
  check("that refusal moved no money either", Math.abs((await balance(owner)) - afterIncoming) < 0.005, `R ${afterIncoming}`);

  /* ---- unlocking restores everything -------------------------------------- */
  console.log("\n--- unlocking ---\n");
  const options = await call("/security/wallet-lock/unlock/options", { token: owner });
  check("unlocking offers OTP methods to verify with", options.status === 200 && Boolean(options.payload.options),
    Object.keys(options.payload.options || {}).join(", "));
  check("unlocking is not possible without verification",
    (await call("/transactions", { method: "POST", token: owner, headers: { "idempotency-key": `still-locked-${stamp}` }, body: { service: "wallet_transfer", amount: 5, currency: "ZAR", recipient: PAYER.phone, idempotencyKey: `still-locked-${stamp}` } })).status === 423);

  await q("UPDATE users SET profile_locked = FALSE WHERE email = $1", [OWNER.email]);
  const afterUnlock = await call("/transactions", {
    method: "POST", token: owner,
    headers: { "idempotency-key": `unlocked-${stamp}` },
    body: { service: "wallet_transfer", amount: 5, currency: "ZAR", recipient: PAYER.phone, idempotencyKey: `unlocked-${stamp}` }
  });
  check("once unlocked, sending money out works again", afterUnlock.status < 400, `HTTP ${afterUnlock.status}`);

  /* ---- the ledger still reconciles ---------------------------------------- */
  const broken = await q(`
    SELECT w.wallet_number FROM wallets w
    LEFT JOIN wallet_ledger wl ON wl.wallet_id = w.id
    GROUP BY w.id, w.wallet_number, w.available_balance
    HAVING ABS(w.available_balance - COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN ABS(wl.amount)
                                                       WHEN wl.entry_type IN ('debit','reserve')  THEN -ABS(wl.amount)
                                                       ELSE 0 END), 0)) > 0.005`);
  check("EVERY wallet still reconciles against its own ledger", broken.length === 0, broken.map((b) => b.wallet_number).join(","));

  await db.end();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error("ERROR", e); await db.end().catch(() => {}); process.exit(2); });
