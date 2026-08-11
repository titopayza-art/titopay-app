// THE DOUBLE TAP, AGAINST A REAL DATABASE.
//
// api/test/transaction-money-paths.test.js stubs the data layer, so it can
// prove the shape of a transaction but not the one thing that actually keeps a
// customer from being charged twice: a transaction-scoped Postgres advisory
// lock. Stubbing pg_advisory_xact_lock proves nothing — it is the real lock,
// held across a real COMMIT, that makes the second arrival wait and then find
// the row the first one wrote.
//
// So this fires genuinely concurrent requests at a running API and counts what
// landed in the ledger.
//
//   M-01  two simultaneous identical POSTs charge once
//   M-02  ten simultaneous identical POSTs charge once
//   M-03  two POSTs with DIFFERENT keys charge twice — the guard must not be
//         so eager that it swallows a real second payment
//   M-04  every cent debited is credited somewhere
//   M-05  a wallet that cannot cover amount + fee is refused, and stays whole
//
// Run against the sandbox only. It creates throwaway accounts and funds them
// by SQL, which is a test-environment action and touches nothing else.
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const API = process.env.API_BASE || "http://127.0.0.1:8110/v1";
const POSTGRES_URL = process.env.POSTGRES_URL
  || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

async function makeAccount(db, prefix, { fund = 0 } = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const account = {
    fullName: `${prefix} Tester`,
    email: `${prefix}${stamp}@titopay.local`,
    phone: `+2786${stamp.slice(-7)}`,
    password: "MoneyPaths!2026#x",
    accountType: "personal"
  };
  await fetch(`${API}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account)
  }).then((r) => r.json());
  const auth = await fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: account.email, password: account.password })
  }).then((r) => r.json());
  const { rows } = await db.query(
    "SELECT w.id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email = $1", [account.email]);
  const walletId = rows[0] && rows[0].id;
  if (fund && walletId) await db.query("UPDATE wallets SET available_balance = $2 WHERE id = $1", [walletId, fund]);
  return { ...account, auth, walletId };
}

// The route answers { ok, transaction: {...} }; reading r.body.reference
// instead of r.body.transaction.reference made an assertion compare
// undefined with undefined and call it a pass.
const post = (token, body) => fetch(`${API}/transactions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(body)
}).then(async (r) => {
  const payload = await r.json();
  return { status: r.status, body: payload, tx: payload.transaction || payload };
});

const balanceOf = async (db, walletId) => Number(
  (await db.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0].available_balance);

(async () => {
  console.log(`\n${"=".repeat(72)}\n  MONEY PATHS — concurrency against a real database\n${"=".repeat(72)}\n`);
  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters");

  const payer = await makeAccount(db, "payer", { fund: 5000 });
  const payee = await makeAccount(db, "payee");
  if (!payer.auth.accessToken || !payee.auth.accessToken) {
    check("both accounts signed in", false, JSON.stringify(payer.auth).slice(0, 150));
    process.exit(1);
  }
  check("both accounts signed in", true);

  // Confirm a single transfer works at all before drawing conclusions from a
  // race — a flow that is simply refused would "pass" every duplicate test.
  const probe = await post(payer.auth.accessToken, {
    serviceCode: "send_money", amount: 10, recipient: payee.email, idempotencyKey: `probe-${Date.now()}`
  });
  check("a single transfer completes", probe.status < 400,
    probe.status < 400 ? `total ${probe.tx.total}` : `${probe.status} ${JSON.stringify(probe.body).slice(0, 120)}`);
  if (probe.status >= 400) {
    console.log("\n  Transfers are refused in this environment, so the concurrency checks");
    console.log("  below would prove nothing. Stopping rather than reporting a false pass.\n");
    await db.end();
    process.exit(1);
  }

  /* ------------------------------------------------------ M-01 double tap */
  {
    const key = `dup-${Date.now()}`;
    const before = await balanceOf(db, payer.walletId);
    const [a, b] = await Promise.all([
      post(payer.auth.accessToken, { serviceCode: "send_money", amount: 100, recipient: payee.email, idempotencyKey: key }),
      post(payer.auth.accessToken, { serviceCode: "send_money", amount: 100, recipient: payee.email, idempotencyKey: key })
    ]);
    const after = await balanceOf(db, payer.walletId);
    const { rows } = await db.query(
      "SELECT id, total FROM transactions WHERE metadata->>'clientIdempotencyKey' = $1", [key]);
    check("M-01 two simultaneous identical POSTs write one transaction",
      rows.length === 1, `${rows.length} transaction row(s), HTTP ${a.status}/${b.status}`);
    check("M-01 and the customer is debited once",
      before - after === Number(rows[0] ? rows[0].total : -1),
      `debited ${(before - after).toFixed(2)}, transaction total ${rows[0] && rows[0].total}`);
    check("M-01 both callers get the same reference back",
      Boolean(a.tx.reference) && a.tx.reference === b.tx.reference, `${a.tx.reference} / ${b.tx.reference}`);
  }

  /* ----------------------------------------------------- M-02 ten at once */
  {
    const key = `dup10-${Date.now()}`;
    const before = await balanceOf(db, payer.walletId);
    const replies = await Promise.all(Array.from({ length: 10 }, () =>
      post(payer.auth.accessToken, { serviceCode: "send_money", amount: 50, recipient: payee.email, idempotencyKey: key })));
    const after = await balanceOf(db, payer.walletId);
    const { rows } = await db.query(
      "SELECT id, total FROM transactions WHERE metadata->>'clientIdempotencyKey' = $1", [key]);
    check("M-02 ten simultaneous identical POSTs write one transaction",
      rows.length === 1, `${rows.length} row(s)`);
    check("M-02 and debit the customer once",
      Math.abs((before - after) - Number(rows[0] ? rows[0].total : 0)) < 0.001,
      `debited ${(before - after).toFixed(2)}`);
    check("M-02 every caller was answered",
      replies.every((r) => r.status < 400), `${replies.filter((r) => r.status >= 400).length} failed`);
  }

  /* ------------------------------------------- M-03 the guard is not eager */
  {
    const before = await balanceOf(db, payer.walletId);
    const [a, b] = await Promise.all([
      post(payer.auth.accessToken, { serviceCode: "send_money", amount: 25, recipient: payee.email, idempotencyKey: `one-${Date.now()}` }),
      post(payer.auth.accessToken, { serviceCode: "send_money", amount: 25, recipient: payee.email, idempotencyKey: `two-${Date.now()}` })
    ]);
    const after = await balanceOf(db, payer.walletId);
    const spent = before - after;
    check("M-03 two DIFFERENT payments both go through",
      Boolean(a.tx.reference) && Boolean(b.tx.reference) && a.tx.reference !== b.tx.reference
      && a.status < 400 && b.status < 400,
      `${a.tx.reference} / ${b.tx.reference}`);
    check("M-03 and the customer is debited for both",
      Math.abs(spent - (Number(a.tx.total) + Number(b.tx.total))) < 0.001,
      `debited ${spent.toFixed(2)} for ${a.tx.total} + ${b.tx.total}`);
  }

  /* ------------------------------------------------- M-04 ledger balances */
  {
    const { rows } = await db.query(
      `SELECT wl.entry_type, SUM(wl.amount)::numeric AS total
         FROM wallet_ledger wl
         JOIN transactions t ON t.id = wl.transaction_id
        WHERE t.user_id = (SELECT user_id FROM wallets WHERE id = $1)
        GROUP BY wl.entry_type`, [payer.walletId]);
    const debited = Number((rows.find((r) => r.entry_type === "debit") || {}).total || 0);
    const credited = Number((rows.find((r) => r.entry_type === "credit") || {}).total || 0);
    check("M-04 every cent debited is credited somewhere",
      Math.abs(debited - credited) < 0.001,
      `debited ${debited.toFixed(2)}, credited ${credited.toFixed(2)}, unaccounted ${(debited - credited).toFixed(2)}`);
  }

  /* ------------------------------------------ M-05 insufficient balance */
  {
    const broke = await makeAccount(db, "broke", { fund: 10 });
    const before = await balanceOf(db, broke.walletId);
    const reply = await post(broke.auth.accessToken, {
      serviceCode: "send_money", amount: 10, recipient: payee.email, idempotencyKey: `broke-${Date.now()}`
    });
    const after = await balanceOf(db, broke.walletId);
    // R10 is exactly the balance; any fee at all makes it unaffordable. Whether
    // it is refused depends on the schedule, so the invariant asserted is the
    // one that always holds: it never goes negative and never partly completes.
    check("M-05 a wallet is never left negative", after >= 0, `${after.toFixed(2)} remaining`);
    check("M-05 a refused transfer leaves the balance untouched",
      reply.status < 400 || before === after,
      `HTTP ${reply.status}, ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  }

  await db.end();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`  FAILED: ${failed.map((f) => f.name).join(" | ")}`);
    process.exit(1);
  }
})().catch((error) => { console.error(error); process.exit(1); });
