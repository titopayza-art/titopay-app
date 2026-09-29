"use strict";

// ACTIVATION AND RETENTION: THE METRICS THAT DECIDE WHETHER THIS IS A PRODUCT.
//
// TitoPay has been able to answer "how many people registered?" since the first
// build. It has never been able to answer the two questions that actually say
// whether there is a business here:
//
//   1. Of the people who registered, how many ever transacted?
//   2. Of the people who transacted, how many came back?
//
// Registrations without those two numbers are a vanity count. A wallet that
// 10 000 people opened and 400 use is a worse business than one 800 people
// opened and 600 use, and today the platform reports the first number and not
// the second.
//
// WHY THIS IS NOT marketing-analytics-service.
//
// That file has a funnel, and it is a good funnel, but it counts
// `marketing_campaign_events` — so it only ever sees users who arrived through
// a tracked campaign. Someone who heard about TitoPay from a spaza owner and
// registered organically is invisible to it. That is the correct design for
// measuring a campaign and the wrong one for measuring a product. This file
// counts every user, attributed or not, straight off `users` and
// `transactions`.
//
// PERFORMANCE IS A CONSTRAINT, NOT AN AFTERTHOUGHT.
//
// The rule this module inherits from marketing-analytics-service is explicit:
// opening a dashboard must never be able to slow down a payment. So:
//
//   - every query is bounded by a registration window, never an open scan
//   - the cohort join rides `idx_transactions_user (user_id, created_at DESC)`
//   - the observation window is capped, because a 400-day cohort grid over a
//     large transactions table is exactly the query that takes a database down
//   - nothing here writes, and nothing here is on a payment path
//
// WHAT "ACTIVATED" MEANS, AND WHY IT IS DELIBERATELY STRICT.
//
// A user is activated when they have completed at least one real transaction.
// Not registered. Not verified. Not funded. Transacted. It is tempting to count
// a wallet top-up as activation because it makes the number larger, but a user
// who loads money and never spends it has not adopted anything — they have
// lent TitoPay their money. The funnel below reports funding as its own step so
// the gap between "funded" and "activated" stays visible, because in a wallet
// business that gap is the whole diagnosis.

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

// A completed transaction is the only kind that counts. A pending or failed
// transaction is an intent, and an intent is not a habit.
const COMPLETED = "completed";

// How far past a cohort's registration we are willing to look. Twelve weeks is
// long enough to see whether a habit formed and short enough that the grid
// stays small.
const MAX_OBSERVATION_WEEKS = 12;

// Registration windows this module will accept. Longer than a quarter and the
// cohort grid stops being readable before it stops being fast.
const MAX_COHORT_DAYS = 120;

function resolveWindow({ from, to, days } = {}) {
  const end = to ? new Date(to) : new Date();
  const span = Number(days) > 0 ? Number(days) : 30;
  const start = from ? new Date(from) : new Date(end.getTime() - span * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new AppError(400, "Enter valid from and to dates.");
  }
  if (end < start) throw new AppError(400, "The end date is before the start date.");
  if ((end - start) / 86400000 > MAX_COHORT_DAYS) {
    throw new AppError(400, `Choose a registration window of ${MAX_COHORT_DAYS} days or less.`);
  }
  return { start, end };
}

const rate = (part, whole) => (whole > 0 ? +((part / whole) * 100).toFixed(1) : 0);

// THE ACTIVATION FUNNEL, FOR EVERY USER — not only campaign-attributed ones.
//
// THESE ARE STAGES, NOT A STRICTLY NESTING FUNNEL, and that distinction was
// learned the hard way — twice — while writing this.
//
// The canonical wallet funnel is registered > verified > funded > spent, each a
// subset of the last. Neither of those middle nestings holds here:
//
//   verified  is not a gate. Tier 0 carries a R25 000 monthly allowance, so a
//             user transacts without ever verifying. It is reported separately.
//   funded    is not a prerequisite either. Several services are FREE --
//             wallet-to-wallet among them -- so a user can complete a real
//             transaction without a credit ever posting to their ledger.
//
// Imposing the canonical shape produced a funnel that widened, which is
// nonsense, and would have reported a working product as a broken one. So the
// stages below are counted independently against the same cohort and each is
// honest on its own terms. The number that matters most is the gap between
// "funded" and "transacted once": money that arrived and never moved.
async function activationFunnel(windowInput) {
  const { start, end } = resolveWindow(windowInput);

  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT id, created_at, fica_status
         FROM users
        WHERE created_at >= $1 AND created_at < $2
     ),
     money AS (
       SELECT t.user_id,
              MIN(t.created_at)  AS first_transaction,
              COUNT(*)::int      AS completed_count
         FROM transactions t
         JOIN cohort c ON c.id = t.user_id
        WHERE t.status = $3
          AND t.created_at >= $1
          AND t.created_at < $4
        GROUP BY t.user_id
     ),
     -- FUNDING IS READ FROM THE LEDGER, NOT FROM transactions.direction.
     --
     -- The first version of this asked transactions for a row with
     -- direction = 'credit'. The test caught it: more users had transacted
     -- than had ever been funded, which is impossible. The reason is that
     -- the direction column describes the INITIATING side of a transfer: a
     -- P2P send writes one row from the sender's point of view, so the
     -- recipient's funding never appears as a credit row of their own.
     --
     -- wallet_ledger is where both legs live, which is exactly why this
     -- platform derives balances from postings rather than storing them.
     -- Reading anything else and calling it "funded" is guessing.
     funded AS (
       SELECT DISTINCT w.user_id
         FROM wallet_ledger l
         JOIN wallets w ON w.id = l.wallet_id
         JOIN cohort  c ON c.id = w.user_id
        WHERE l.entry_type = 'credit'
          AND l.created_at >= $1
          AND l.created_at < $4
     )
     SELECT
       COUNT(*)::int                                                            AS registered,
       COUNT(*) FILTER (WHERE c.fica_status IN ('approved','verified'))::int    AS verified,
       COUNT(f.user_id)::int                                                    AS funded,
       COUNT(f.user_id) FILTER (WHERE m.user_id IS NULL)::int                   AS funded_never_spent,
       COUNT(m.user_id)::int                                                    AS activated,
       COUNT(m.user_id) FILTER (WHERE m.completed_count >= 2)::int              AS repeated,
       COUNT(m.user_id) FILTER (
         WHERE m.first_transaction < c.created_at + INTERVAL '1 day')::int      AS activated_day_one,
       COUNT(m.user_id) FILTER (
         WHERE m.first_transaction < c.created_at + INTERVAL '7 days')::int     AS activated_week_one
       FROM cohort c
       LEFT JOIN money  m ON m.user_id = c.id
       LEFT JOIN funded f ON f.user_id = c.id`,
    // The observation end is pushed out past the registration window so a user
    // who registered on the last day still gets a fair chance to transact.
    // Measuring their first week inside a window that ended yesterday would
    // report a failure that is really just a clock.
    [start, end, COMPLETED, new Date(end.getTime() + MAX_OBSERVATION_WEEKS * 7 * 86400000)]
  );

  const r = rows[0] || {};
  const registered = Number(r.registered || 0);
  const activated = Number(r.activated || 0);

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    // IDENTITY VERIFICATION IS NOT A FUNNEL STEP ON THIS PLATFORM.
    //
    // The first version of this function had it between "registered" and
    // "funded", which is the shape every other wallet's funnel has — and the
    // test caught it immediately, because the funnel widened: more users had
    // funded than had verified.
    //
    // That is not a bug in the data. Tier 0 is "Limited Access", not "blocked":
    // it carries a R25 000 monthly allowance, so a user can fund and transact
    // without ever verifying. Verification raises a ceiling; it does not open a
    // door. Drawing it as a stage would model a gate that does not exist, and
    // would report a healthy product as a broken one every time an unverified
    // user transacted.
    //
    // So the funnel below is only the steps that genuinely nest, and
    // verification is reported beside it as what it actually is: an attribute
    // of the cohort, and a leading indicator of how much headroom the cohort
    // has before limits start refusing them.
    steps: [
      { step: "Registered", value: registered, rate: 100 },
      { step: "Funded a wallet", value: Number(r.funded || 0), rate: rate(r.funded, registered) },
      { step: "Transacted once", value: activated, rate: rate(activated, registered) },
      { step: "Transacted twice", value: Number(r.repeated || 0), rate: rate(r.repeated, registered) }
    ],
    verification: {
      verified: Number(r.verified || 0),
      rate: rate(r.verified, registered),
      note: "Verification raises the monthly limit. It is not required to transact."
    },
    // The headline the audit asked to be managed against. D1 is the honest
    // measure of whether onboarding delivers value; everything downstream is
    // recoverable, a dead first day usually is not.
    firstTransaction: {
      dayOneRate: rate(r.activated_day_one, registered),
      weekOneRate: rate(r.activated_week_one, registered)
    },
    // Funded but never spent. In a wallet this is the number that says the
    // product has nothing worth buying.
    //
    // Counted as a set difference in SQL, not as funded MINUS activated. The
    // subtraction looked equivalent and was not: the two sets do not nest here
    // (a free wallet-to-wallet transfer activates a user who was never funded),
    // so the arithmetic quietly clamped to zero and hid the very users this
    // figure exists to surface.
    fundedNeverSpent: Number(r.funded_never_spent || 0)
  };
}

// WEEKLY RETENTION COHORTS.
//
// Users grouped by the week they registered, then counted in each following
// week they completed a transaction. Week 0 is the registration week itself, so
// week 0 is activation and weeks 1+ are retention.
async function retentionCohorts(windowInput) {
  const { start, end } = resolveWindow(windowInput);
  const horizon = new Date(end.getTime() + MAX_OBSERVATION_WEEKS * 7 * 86400000);

  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT id, date_trunc('week', created_at) AS cohort_week
         FROM users
        WHERE created_at >= $1 AND created_at < $2
     ),
     sizes AS (
       SELECT cohort_week, COUNT(*)::int AS size FROM cohort GROUP BY cohort_week
     ),
     active AS (
       SELECT DISTINCT
              c.cohort_week,
              c.id,
              (EXTRACT(EPOCH FROM (date_trunc('week', t.created_at) - c.cohort_week))
                 / 604800)::int AS week_offset
         FROM cohort c
         JOIN transactions t ON t.user_id = c.id
        WHERE t.status = $3
          AND t.created_at >= $1
          AND t.created_at < $4
     )
     SELECT s.cohort_week,
            s.size,
            a.week_offset,
            COUNT(a.id)::int AS retained
       FROM sizes s
       LEFT JOIN active a
              ON a.cohort_week = s.cohort_week
             AND a.week_offset BETWEEN 0 AND $5
      GROUP BY s.cohort_week, s.size, a.week_offset
      ORDER BY s.cohort_week, a.week_offset`,
    [start, end, COMPLETED, horizon, MAX_OBSERVATION_WEEKS]
  );

  const byWeek = new Map();
  for (const row of rows) {
    const key = new Date(row.cohort_week).toISOString();
    if (!byWeek.has(key)) {
      byWeek.set(key, { cohortWeek: key, size: Number(row.size || 0), weeks: {} });
    }
    if (row.week_offset === null) continue;
    byWeek.get(key).weeks[Number(row.week_offset)] = Number(row.retained || 0);
  }

  const cohorts = [...byWeek.values()].map((c) => ({
    cohortWeek: c.cohortWeek,
    size: c.size,
    // Reported as both counts and rates. A rate on a cohort of four people is
    // noise dressed as a percentage, so the size travels with it and the
    // consumer can decide what is worth reading.
    retention: Array.from({ length: MAX_OBSERVATION_WEEKS + 1 }, (_, week) => {
      const retained = Number(c.weeks[week] || 0);
      return { week, retained, rate: rate(retained, c.size) };
    })
  }));

  return { window: { from: start.toISOString(), to: end.toISOString() }, cohorts };
}

// FREQUENCY: how often an active user actually transacts.
//
// The habit metric. A wallet whose actives transact 0.8 times a week is a
// utility people remember when a bill is due; one whose actives transact four
// times a week is where money lives. The difference between those two is the
// difference between this business working and not.
async function frequency(windowInput) {
  const { start, end } = resolveWindow(windowInput);

  const { rows } = await pool.query(
    `WITH weekly AS (
       SELECT date_trunc('week', created_at) AS week,
              user_id,
              COUNT(*)::int AS n
         FROM transactions
        WHERE status = $3
          AND created_at >= $1
          AND created_at < $2
        GROUP BY 1, 2
     )
     SELECT week,
            COUNT(DISTINCT user_id)::int AS actives,
            SUM(n)::int                  AS transactions
       FROM weekly
      GROUP BY week
      ORDER BY week`,
    [start, end, COMPLETED]
  );

  const series = rows.map((row) => ({
    week: new Date(row.week).toISOString(),
    actives: Number(row.actives || 0),
    transactions: Number(row.transactions || 0),
    perActive: row.actives > 0 ? +(Number(row.transactions) / Number(row.actives)).toFixed(2) : 0
  }));

  const totalTx = series.reduce((sum, w) => sum + w.transactions, 0);
  const totalActive = series.reduce((sum, w) => sum + w.actives, 0);

  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    series,
    averagePerActivePerWeek: totalActive > 0 ? +(totalTx / totalActive).toFixed(2) : 0
  };
}

// The whole picture in one call, because these three numbers are only
// meaningful together: activation without retention is a leaky bucket,
// retention without frequency is a dormant balance.
async function growthSnapshot(windowInput) {
  const [funnel, cohorts, freq] = await Promise.all([
    activationFunnel(windowInput),
    retentionCohorts(windowInput),
    frequency(windowInput)
  ]);
  return { funnel, cohorts, frequency: freq };
}

module.exports = {
  activationFunnel,
  retentionCohorts,
  frequency,
  growthSnapshot,
  resolveWindow,
  MAX_OBSERVATION_WEEKS,
  MAX_COHORT_DAYS
};
