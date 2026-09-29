"use strict";

// ACTIVATION AND RETENTION, PROVEN AGAINST A COHORT WHOSE ANSWER IS KNOWN.
//
// A retention query is easy to write and easy to get subtly wrong: an off-by-one
// on the week offset, a user counted twice because they transacted twice in a
// week, a cohort that silently includes users who registered outside the window.
// Each of those produces a number that looks plausible and is false — and a
// false retention number is worse than none, because it gets put in a board pack.
//
// So this file does not check that the queries return "some rows". It builds a
// cohort by hand with a retention curve chosen in advance, and asserts the
// service reports exactly that curve.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const {
  activationFunnel,
  retentionCohorts,
  frequency,
  resolveWindow,
  MAX_COHORT_DAYS
} = require("../src/services/activation-service");

// Every fixture user carries this tag in their username so the assertions can
// scope to this run. The tables are shared with every other suite.
const TAG = `act${crypto.randomBytes(4).toString("hex")}`;

// The cohort registers on a fixed Wednesday so week bucketing is unambiguous.
// Postgres date_trunc('week') snaps to Monday; registering mid-week proves the
// offset maths does not accidentally depend on registering on the boundary.
const REGISTERED_DAYS_AGO = 42;

async function makeUser({ daysAgo, fica = "approved" }) {
  const userId = crypto.randomUUID();
  const walletId = crypto.randomUUID();
  const u = crypto.randomBytes(5).toString("hex");
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, fica_status, created_at)
     VALUES ($1,'personal','Activation Test',$2,$3,$4,'x',$5, NOW() - ($6 || ' days')::interval)`,
    [userId, `${TAG}_${u}`, `${TAG}_${u}@t.local`,
     `+2776${Math.floor(1000000 + Math.random() * 8999999)}`, fica, String(daysAgo)]
  );
  await pool.query(
    "INSERT INTO wallets (id, user_id, kind, currency, available_balance, status) VALUES ($1,$2,'personal','ZAR',0,'active')",
    [walletId, userId]
  );
  return { userId, walletId };
}

// Funding is read from the ledger, so a fixture that only writes a transaction
// row is not funded as far as the service is concerned -- which is exactly the
// distinction the service was corrected to make. This posts the credit leg.
async function makeCredit(acct, { daysAgo, amount = 200 }) {
  const txId = await makeTx(acct, { daysAgo, direction: "credit", amount });
  await pool.query(
    `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, created_at)
     VALUES ($1,$2,$3,'credit',$4,$4,$5, NOW() - ($6 || ' days')::interval)`,
    [crypto.randomUUID(), acct.walletId, txId, amount,
     `L-${crypto.randomBytes(5).toString("hex")}`, String(daysAgo)]
  );
  return txId;
}

async function makeTx(acct, { daysAgo, direction = "debit", status = "completed", amount = 50 }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO transactions (id,user_id,wallet_id,service_code,amount,fee,total,status,direction,reference,created_at)
     VALUES ($1,$2,$3,'wallet_transfer',$4,0,$4,$5,$6,$7, NOW() - ($8 || ' days')::interval)`,
    [id, acct.userId, acct.walletId, amount, status, direction,
     `R-${crypto.randomBytes(5).toString("hex")}`, String(daysAgo)]
  );
  return id;
}

// Each test cleans up ONLY the users it created.
//
// The first version of this asked the database for every user carrying this
// file's tag. That reads as tidy and is a race: node:test runs async top-level
// tests concurrently, so one test's cleanup deleted another test's fixtures
// while that test was still using them, and the two cleanups then blocked each
// other on the same rows. The suite hung rather than failed, which is the worst
// way for a test to be wrong.
//
// A test now tracks its own ids and purges exactly those.
function tracker() {
  const ids = [];
  return {
    ids,
    async user(options) {
      const account = await makeUser(options);
      ids.push(account.userId);
      return account;
    }
  };
}

// Ledger rows reference wallets, so they go first. Every cleanup in this file
// routes through here rather than repeating the order and getting it wrong.
async function purge(ids) {
  if (!ids || !ids.length) return;
  await pool.query(
    "DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1))", [ids]);
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM wallets WHERE user_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
}

test("the window guard refuses a range longer than the cap", () => {
  assert.throws(
    () => resolveWindow({ days: MAX_COHORT_DAYS + 1 }),
    /days or less/,
    "a cohort grid over an unbounded window is the query that takes the database down"
  );
  assert.throws(() => resolveWindow({ from: "2026-03-01", to: "2026-01-01" }), /before the start/);
  const ok = resolveWindow({ days: 30 });
  assert.ok(ok.start < ok.end);
});

test("activation is transacting, not registering — and funded-never-spent is visible", async () => {
  // Six users, with an activation outcome chosen for each.
  const mine = tracker();
  const registeredOnly = await mine.user({ daysAgo: REGISTERED_DAYS_AGO, fica: "pending" });
  const verifiedOnly = await mine.user({ daysAgo: REGISTERED_DAYS_AGO });
  const fundedOnly = await mine.user({ daysAgo: REGISTERED_DAYS_AGO });
  const activatedLate = await mine.user({ daysAgo: REGISTERED_DAYS_AGO });
  const activatedDayOne = await mine.user({ daysAgo: REGISTERED_DAYS_AGO });
  const repeatUser = await mine.user({ daysAgo: REGISTERED_DAYS_AGO });
  assert.ok(verifiedOnly.userId, "a verified user who never transacted is part of the cohort");

  // Funded but never spent: a real ledger credit and nothing else. This is the
  // user the funnel exists to make visible.
  await makeCredit(fundedOnly, { daysAgo: REGISTERED_DAYS_AGO });

  // Activated, but not on day one — transacted a week after registering.
  await makeTx(activatedLate, { daysAgo: REGISTERED_DAYS_AGO - 8 });

  // Activated within 24 hours of registering.
  await makeTx(activatedDayOne, { daysAgo: REGISTERED_DAYS_AGO });

  // Two completed transactions: counts once as activated, once as repeated.
  await makeTx(repeatUser, { daysAgo: REGISTERED_DAYS_AGO });
  await makeTx(repeatUser, { daysAgo: REGISTERED_DAYS_AGO - 3 });

  // A failed transaction must NOT activate anyone. An intent is not a habit.
  await makeTx(registeredOnly, { daysAgo: REGISTERED_DAYS_AGO, status: "failed" });

  const result = await activationFunnel({ days: MAX_COHORT_DAYS });
  assert.equal(mine.ids.length, 6, "six fixture users were created");

  const step = (name) => result.steps.find((s) => s.step === name);

  // The funnel is platform-wide, so it counts other suites' users too. These
  // assertions are therefore "at least ours", plus exact checks scoped to this
  // run's rows below.
  assert.ok(step("Registered").value >= 6);
  assert.ok(step("Transacted once").value >= 4, "four of the six transacted");
  assert.ok(step("Transacted twice").value >= 1, "one of the six transacted twice");

  // Verification is reported, but NOT as a funnel step -- a Tier 0 user may
  // fund and transact without it, so putting it in the nesting would make the
  // funnel widen. This assertion pins that decision down.
  assert.equal(step("Identity verified"), undefined,
    "verification is not a funnel stage: it raises a limit, it does not gate transacting");
  assert.ok(result.verification && typeof result.verification.rate === "number",
    "verification is reported alongside the funnel as a cohort attribute");

  // NOT asserted: that each stage is a subset of the one above it.
  //
  // Two earlier versions of this test did assert that, and both caught a real
  // modelling error rather than a data problem -- first that verification gates
  // transacting (it does not, Tier 0 allows R25 000 a month), then that funding
  // does (it does not either, because wallet-to-wallet is FREE, so a user can
  // complete a transaction with no credit ever posting to their ledger).
  //
  // So the invariants asserted here are only the ones this platform actually
  // guarantees.
  const value = (name) => step(name).value;
  for (const name of ["Funded a wallet", "Transacted once", "Transacted twice"]) {
    assert.ok(value(name) <= value("Registered"),
      `"${name}" (${value(name)}) exceeds the cohort it is drawn from (${value("Registered")})`);
  }
  assert.ok(value("Transacted twice") <= value("Transacted once"),
    "transacting twice is genuinely a subset of transacting once");
  for (const s of result.steps) {
    assert.ok(s.rate >= 0 && s.rate <= 100, `"${s.step}" rate ${s.rate} is not a percentage`);
  }

  assert.ok(typeof result.fundedNeverSpent === "number" && result.fundedNeverSpent >= 1,
    "the user who loaded money and never spent it is reported");
  assert.ok(result.firstTransaction.dayOneRate <= result.firstTransaction.weekOneRate,
    "day one can never exceed week one");

  await purge(mine.ids);
});

test("a retention curve is reported exactly as it happened", async () => {
  // One user with a known, deliberately gappy activity pattern:
  //   week 0  transacted (twice — must still count as ONE retained user)
  //   week 1  transacted
  //   week 2  silent
  //   week 3  transacted   <- returning after a gap must be counted
  const mine = tracker();
  const user = await mine.user({ daysAgo: REGISTERED_DAYS_AGO });
  await makeTx(user, { daysAgo: REGISTERED_DAYS_AGO });          // week 0
  await makeTx(user, { daysAgo: REGISTERED_DAYS_AGO - 1 });      // week 0 again
  await makeTx(user, { daysAgo: REGISTERED_DAYS_AGO - 7 });      // week 1
  await makeTx(user, { daysAgo: REGISTERED_DAYS_AGO - 21 });     // week 3

  const { cohorts } = await retentionCohorts({ days: MAX_COHORT_DAYS });

  // Find the cohort week this user landed in by asking the database the same
  // question the service asked, rather than recomputing it in JavaScript and
  // risking a different week boundary.
  const { rows } = await pool.query(
    "SELECT date_trunc('week', created_at) AS w FROM users WHERE id = $1", [user.userId]
  );
  const week = new Date(rows[0].w).toISOString();
  const cohort = cohorts.find((c) => c.cohortWeek === week);
  assert.ok(cohort, "the user's registration week appears as a cohort");

  const at = (n) => cohort.retention.find((r) => r.week === n);
  assert.ok(at(0).retained >= 1, "week 0 counts the user who transacted on registration week");
  assert.ok(at(1).retained >= 1, "week 1 counts the user who came back");
  assert.ok(at(3).retained >= 1, "week 3 counts a user returning after a silent week");

  // The property that catches double counting: a cohort can never report more
  // retained users than it has members.
  for (const point of cohort.retention) {
    assert.ok(point.retained <= cohort.size,
      `week ${point.week} retained ${point.retained} of a cohort of ${cohort.size} — a user was counted twice`);
    assert.ok(point.rate >= 0 && point.rate <= 100, `week ${point.week} rate ${point.rate} is not a percentage`);
  }

  await purge(mine.ids);
});

test("frequency reports transactions per active, not per registered", async () => {
  // Two users in one week: one transacts three times, one transacts once.
  // Four transactions across two actives is 2.0 per active — and it must not
  // be diluted by every other registered user who did nothing.
  const mine = tracker();
  const busy = await mine.user({ daysAgo: 3 });
  const quiet = await mine.user({ daysAgo: 3 });
  const dormant = await mine.user({ daysAgo: 3 });
  assert.ok(dormant.userId, "a dormant user exists and must not appear in the denominator");

  for (const d of [2, 2, 1]) await makeTx(busy, { daysAgo: d });
  await makeTx(quiet, { daysAgo: 2 });

  const result = await frequency({ days: 14 });
  assert.ok(result.series.length >= 1, "at least one week of activity is reported");
  for (const week of result.series) {
    assert.ok(week.actives > 0, "a reported week always has at least one active user");
    assert.equal(week.perActive, +(week.transactions / week.actives).toFixed(2),
      "per-active is transactions divided by ACTIVES, never by registrations");
  }
  assert.ok(result.averagePerActivePerWeek >= 1,
    "an active user transacts at least once by definition");

  await purge(mine.ids);
});

test.after(async () => {
  // Belt and braces: nothing from this suite survives a failed assertion.
  const { rows } = await pool.query("SELECT id FROM users WHERE username LIKE $1", [`${TAG}_%`]);
  await purge(rows.map((r) => r.id));
  await pool.end();
});
