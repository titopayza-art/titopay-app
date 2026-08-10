// PAYMENT INTEGRITY — can the platform be made to create or lose money?
//
// The existing suites cover rejected top-ups, declined cards and statement
// arithmetic. This one goes after the ways a payment system leaks money that
// nothing here was testing: a settlement replayed, a settlement raced against
// the reconciliation poll, a provider reporting an amount nobody was charged,
// one customer settling another's checkout, and a late failure arriving after
// a success.
//
// Every assertion is made against the DATABASE, not against an API response.
// An endpoint that says "completed" proves nothing about what happened to the
// ledger, and the ledger is what the money actually is.
//
// Usage: node payment-integrity.js [port]
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const PORT = Number(process.argv[2] || 8110);
const API = `http://127.0.0.1:${PORT}/v1`;
const PEACH = "http://127.0.0.1:4400";
const stamp = Date.now();
const POSTGRES_URL = fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(title) { console.log(`\n--- ${title} ---`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => `R${Number(n).toFixed(2)}`;

async function call(path, { method = "GET", body, token, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}
async function peach(path, body) {
  const r = await fetch(`${PEACH}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

async function newCustomer(tag) {
  const user = {
    fullName: `Integrity ${tag}`,
    email: `pi${tag}${stamp}@titopay.local`,
    phone: `+2769${String(stamp).slice(-5)}${String(tag).padStart(2, "0")}`,
    password: "Integrity!2026#xy",
    accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: user });
  const login = await call("/auth/login", { method: "POST", body: { identifier: user.email, password: user.password } });
  const wallets = await call("/wallets", { token: login.payload.accessToken });
  return { ...user, token: login.payload.accessToken, walletId: (wallets.payload.items || [])[0]?.id };
}

async function startTopup(customer, amount) {
  const key = `pi-${stamp}-${Math.random().toString(16).slice(2, 10)}`;
  const created = await call("/payments/topup", {
    method: "POST", token: customer.token,
    headers: { "idempotency-key": key },
    body: { amount, currency: "ZAR", idempotencyKey: key }
  });
  return created.payload;
}

// The ledger is the truth. Balance is only trustworthy if it equals the ledger.
async function walletFacts(db, walletId) {
  const { rows } = await db.query(
    `SELECT w.available_balance,
            COALESCE(SUM(CASE WHEN l.entry_type='credit' THEN l.amount
                              WHEN l.entry_type='debit'  THEN -l.amount ELSE 0 END),0) AS ledger,
            COUNT(l.id)::int AS entries
       FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id = w.id
      WHERE w.id = $1 GROUP BY w.available_balance`, [walletId]);
  return {
    balance: Number(rows[0]?.available_balance ?? 0),
    ledger: Number(rows[0]?.ledger ?? 0),
    entries: Number(rows[0]?.entries ?? 0)
  };
}
async function creditsFor(db, reference) {
  const { rows } = await db.query(
    `SELECT l.entry_type, l.amount, l.wallet_id FROM wallet_ledger l
       JOIN transactions t ON t.id = l.transaction_id
      WHERE t.reference = $1 ORDER BY l.created_at`, [reference]);
  return rows;
}
async function txByReference(db, reference) {
  const { rows } = await db.query("SELECT * FROM transactions WHERE reference = $1", [reference]);
  return rows[0];
}

(async () => {
  console.log(`\n${"=".repeat(78)}`);
  console.log("  PAYMENT INTEGRITY — can the platform be made to create or lose money?");
  console.log(`${"=".repeat(78)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();

  const systemBefore = Number((await db.query(
    "SELECT COALESCE(SUM(available_balance),0) AS total FROM wallets")).rows[0].total);

  /* ================================================== 1. the honest path */
  section("1. A real top-up credits the amount, never the amount plus fee");
  const alice = await newCustomer(1);
  check("customer ready", Boolean(alice.token && alice.walletId));

  const topup = await startTopup(alice, 500);
  check("checkout created", Boolean(topup.checkoutId), `charge ${money(topup.total ?? 0)} for ${money(topup.amount ?? 0)}`);
  const chargedTotal = Number(topup.total);
  const fee = Number(topup.fee);

  await peach("/__complete", { checkoutId: topup.checkoutId, outcome: "successful" });
  for (let i = 0; i < 25; i += 1) {
    const st = await call(`/payments/topup/${encodeURIComponent(topup.reference)}`, { token: alice.token });
    if (st.payload.status === "completed") break;
    await sleep(300);
  }

  let facts = await walletFacts(db, alice.walletId);
  check("wallet credited the amount, not the charge",
    Math.abs(facts.balance - 500) < 0.005,
    `${money(facts.balance)} (card was charged ${money(chargedTotal)}, fee ${money(fee)})`);
  check("balance equals its own ledger", Math.abs(facts.balance - facts.ledger) < 0.005,
    `balance ${money(facts.balance)} vs ledger ${money(facts.ledger)}`);

  const aliceCredits = (await creditsFor(db, topup.reference)).filter((r) => r.wallet_id === alice.walletId);
  check("exactly one credit row for this payment", aliceCredits.length === 1, `${aliceCredits.length} row(s)`);

  /* =============================================== 2. settlement replayed */
  section("2. The same settlement delivered again must not pay twice");
  await peach("/__complete", { checkoutId: topup.checkoutId, outcome: "successful" });
  for (let i = 0; i < 6; i += 1) {
    await call(`/payments/topup/${encodeURIComponent(topup.reference)}`, { token: alice.token });
    await sleep(120);
  }
  facts = await walletFacts(db, alice.walletId);
  const replayCredits = (await creditsFor(db, topup.reference)).filter((r) => r.wallet_id === alice.walletId);
  check("REPLAY DID NOT CREDIT AGAIN", Math.abs(facts.balance - 500) < 0.005, money(facts.balance));
  check("still exactly one credit row", replayCredits.length === 1, `${replayCredits.length} row(s)`);

  /* ============================== 3. settlement raced against the poller */
  section("3. Twelve simultaneous settlements of one payment");
  const bob = await newCustomer(2);
  const race = await startTopup(bob, 750);
  await peach("/__complete", { checkoutId: race.checkoutId, outcome: "successful" });
  // Every one of these can settle the transaction. Only one may credit.
  await Promise.all(Array.from({ length: 12 }, () =>
    call(`/payments/topup/${encodeURIComponent(race.reference)}`, { token: bob.token })));
  await sleep(1200);

  const bobFacts = await walletFacts(db, bob.walletId);
  const bobCredits = (await creditsFor(db, race.reference)).filter((r) => r.wallet_id === bob.walletId);
  check("CREDITED EXACTLY ONCE UNDER A 12-WAY RACE",
    Math.abs(bobFacts.balance - 750) < 0.005 && bobCredits.length === 1,
    `${money(bobFacts.balance)}, ${bobCredits.length} credit row(s)`);
  check("balance equals ledger after the race", Math.abs(bobFacts.balance - bobFacts.ledger) < 0.005,
    `balance ${money(bobFacts.balance)} vs ledger ${money(bobFacts.ledger)}`);

  /* ================================= 4. the provider reports a fake amount */
  section("4. A provider reporting an amount nobody was charged");
  const mallory = await newCustomer(3);
  const tamper = await startTopup(mallory, 100);
  // The checkout was created for R100. The provider now claims R100,000.
  await peach("/__complete", { checkoutId: tamper.checkoutId, outcome: "successful", amount: 100000 });
  for (let i = 0; i < 12; i += 1) {
    await call(`/payments/topup/${encodeURIComponent(tamper.reference)}`, { token: mallory.token });
    await sleep(250);
  }
  const malloryFacts = await walletFacts(db, mallory.walletId);
  const tamperTx = await txByReference(db, tamper.reference);
  check("THE INFLATED AMOUNT WAS NOT CREDITED", malloryFacts.balance < 100000,
    `balance ${money(malloryFacts.balance)}`);
  check("no money was invented at all", Math.abs(malloryFacts.balance) < 0.005 || Math.abs(malloryFacts.balance - 100) < 0.005,
    `balance ${money(malloryFacts.balance)} (R0.00 if held, R100.00 if settled at the real amount)`);
  check("the mismatch is flagged rather than silently dropped",
    String(tamperTx?.metadata?.providerState || "").includes("mismatch") || tamperTx?.status !== "completed",
    `status ${tamperTx?.status}, providerState ${tamperTx?.metadata?.providerState || "none"}`);
  check("balance equals ledger", Math.abs(malloryFacts.balance - malloryFacts.ledger) < 0.005,
    `balance ${money(malloryFacts.balance)} vs ledger ${money(malloryFacts.ledger)}`);

  /* ======================================= 5. settling someone else's payment */
  section("5. One customer cannot settle or read another's payment");
  const eve = await newCustomer(4);
  const victimTopup = await startTopup(alice, 300);
  await peach("/__complete", { checkoutId: victimTopup.checkoutId, outcome: "successful" });

  const stolen = await call(`/payments/topup/${encodeURIComponent(victimTopup.reference)}`, { token: eve.token });
  check("another customer cannot read the payment", stolen.status === 404 || stolen.status === 403,
    `HTTP ${stolen.status}`);

  const eveFacts = await walletFacts(db, eve.walletId);
  check("and nothing landed in their wallet", Math.abs(eveFacts.balance) < 0.005, money(eveFacts.balance));

  // The rightful owner still gets their money — the refusal above must not have
  // consumed the settlement.
  for (let i = 0; i < 20; i += 1) {
    const st = await call(`/payments/topup/${encodeURIComponent(victimTopup.reference)}`, { token: alice.token });
    if (st.payload.status === "completed") break;
    await sleep(250);
  }
  const aliceAfter = await walletFacts(db, alice.walletId);
  check("the rightful owner is still paid", Math.abs(aliceAfter.balance - 800) < 0.005,
    `${money(aliceAfter.balance)} (R500 + R300)`);

  /* ============================== 6. a failure arriving after a success */
  section("6. A late failure must not reverse money already settled");
  await peach("/__complete", { checkoutId: victimTopup.checkoutId, outcome: "failed" });
  for (let i = 0; i < 8; i += 1) {
    await call(`/payments/topup/${encodeURIComponent(victimTopup.reference)}`, { token: alice.token });
    await sleep(200);
  }
  const aliceFinal = await walletFacts(db, alice.walletId);
  const settledTx = await txByReference(db, victimTopup.reference);
  check("A LATE FAILURE DID NOT TAKE THE MONEY BACK", Math.abs(aliceFinal.balance - 800) < 0.005,
    `${money(aliceFinal.balance)}`);
  check("the settled payment stays settled", settledTx?.status === "completed", `status ${settledTx?.status}`);

  /* ============================================= 7. an invented reference */
  section("7. A reference that never existed");
  const fake = await call(`/payments/topup/TP-TOPUP-DOES-NOT-EXIST-${stamp}`, { token: alice.token });
  check("an unknown reference is refused, not invented", fake.status >= 400, `HTTP ${fake.status}`);

  /* ================================================ 8. conservation of money */
  section("8. Conservation — every cent is accounted for");
  const drift = await db.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT w.id, w.available_balance,
              COALESCE(SUM(CASE WHEN l.entry_type='credit' THEN l.amount
                                WHEN l.entry_type='debit'  THEN -l.amount ELSE 0 END),0) AS ledger
         FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id
        GROUP BY w.id, w.available_balance) x
      WHERE ABS(x.available_balance - x.ledger) > 0.005`);
  check("NO WALLET IN THE DATABASE DISAGREES WITH ITS LEDGER", drift.rows[0].n === 0,
    `${drift.rows[0].n} wallet(s) drifting`);

  const orphans = await db.query(
    `SELECT COUNT(*)::int AS n FROM wallet_ledger l
      LEFT JOIN transactions t ON t.id = l.transaction_id WHERE t.id IS NULL`);
  check("no ledger entry exists without a transaction behind it", orphans.rows[0].n === 0,
    `${orphans.rows[0].n} orphan(s)`);

  const systemAfter = Number((await db.query(
    "SELECT COALESCE(SUM(available_balance),0) AS total FROM wallets")).rows[0].total);
  // R500 + R750 + R300 credited to customers, plus the fees posted to revenue.
  const expectedCustomerMoney = 500 + 750 + 300;
  const grew = systemAfter - systemBefore;
  check("system-wide money grew by exactly what was paid in, plus fees",
    grew >= expectedCustomerMoney - 0.005 && grew <= expectedCustomerMoney + (3 * 50) + 0.005,
    `${money(systemBefore)} -> ${money(systemAfter)}, grew ${money(grew)} against ${money(expectedCustomerMoney)} paid in`);

  await db.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(78)}`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\n  FAILED:");
    for (const f of failed) console.log(`    - ${f.name}${f.detail ? "  (" + f.detail + ")" : ""}`);
  }
  console.log(`${"=".repeat(78)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e.stack); process.exit(1); });
