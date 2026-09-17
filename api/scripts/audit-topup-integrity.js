"use strict";

// READ-ONLY top-up / wallet-ledger integrity audit.
//
// It writes nothing. There is no UPDATE, INSERT or DELETE anywhere in this
// file, and it opens no transaction. Run it as often as you like.
//
//   node scripts/audit-topup-integrity.js
//   node scripts/audit-topup-integrity.js --wallet 9152641376
//   node scripts/audit-topup-integrity.js --reference TP-TOPUP-MSK11VSP-01B92AFC
//   node scripts/audit-topup-integrity.js --since 2026-08-01 --json
//
// For every top-up it reports: transaction ID, status, amount, fee, total,
// provider reference, the Peach evidence held against it, the ledger entry ID,
// whether the wallet was actually credited, and whether it belongs on a
// financial statement. It then reconciles each affected wallet's recorded
// balance against the sum of its own ledger, which is the check that says
// whether any money was really created out of nothing.

const { pool } = require("../src/db/pool");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] || null;
}
const asJson = process.argv.includes("--json");
const walletFilter = arg("wallet");
const referenceFilter = arg("reference");
const since = arg("since");
const money = (value) => Number(value || 0).toFixed(2);

async function main() {
  const values = [];
  const where = ["t.service_code IN ('wallet_top_up', 'topup', 'wallet_topup')"];
  if (walletFilter) { values.push(walletFilter); where.push(`(w.wallet_number = $${values.length} OR w.id::text = $${values.length})`); }
  if (referenceFilter) { values.push(referenceFilter); where.push(`t.reference = $${values.length}`); }
  if (since) { values.push(since); where.push(`t.created_at >= $${values.length}::date`); }

  const { rows } = await pool.query(
    `SELECT t.id, t.reference, t.status, t.amount, t.fee, t.total, t.created_at, t.updated_at,
            t.wallet_id, w.wallet_number, u.email, u.full_name,
            t.metadata->>'provider'         AS provider,
            t.metadata->>'providerState'    AS provider_state,
            t.metadata->>'checkoutId'       AS checkout_id,
            t.metadata->>'peachPaymentId'   AS peach_payment_id,
            t.metadata->>'resultCode'       AS result_code,
            t.metadata->>'failureReason'    AS failure_reason,
            t.metadata->>'settledAt'        AS settled_at,
            (t.metadata->>'requiresReview')::BOOLEAN AS requires_review,
            led.entry_ids, led.entry_count, led.credited, led.net_posted
       FROM transactions t
       JOIN wallets w ON w.id = t.wallet_id
       JOIN users u   ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(wl.id::text)                                   AS entry_ids,
                COUNT(*)::INT                                            AS entry_count,
                COALESCE(SUM(CASE WHEN wl.entry_type = 'credit' THEN wl.amount ELSE 0 END), 0) AS credited,
                COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN ABS(wl.amount)
                                  WHEN wl.entry_type IN ('debit','reserve')  THEN -ABS(wl.amount)
                                  ELSE 0 END), 0)                        AS net_posted
           FROM wallet_ledger wl
          WHERE wl.transaction_id = t.id AND wl.wallet_id = t.wallet_id
       ) led ON TRUE
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at DESC
      LIMIT 500`,
    values
  );

  const report = rows.map((row) => {
    const credited = Number(row.credited || 0);
    const walletCredited = credited > 0;
    const confirmed = String(row.provider_state || "") === "successful" && row.status === "completed";
    // Belongs on a statement only when the ledger actually posted an entry.
    const belongsOnStatement = walletCredited;
    const flags = [];
    if (walletCredited && !confirmed) flags.push("CREDITED_WITHOUT_PEACH_CONFIRMATION");
    if (confirmed && !walletCredited) flags.push("CONFIRMED_BUT_NOT_CREDITED");
    if (walletCredited && Math.abs(credited - Number(row.amount)) > 0.005) flags.push("CREDIT_AMOUNT_MISMATCH");
    if (Number(row.entry_count || 0) > 1) flags.push("MULTIPLE_LEDGER_ENTRIES");
    if (row.requires_review) flags.push("FLAGGED_FOR_REVIEW");
    return {
      transactionId: row.id,
      reference: row.reference,
      status: row.status,
      amount: money(row.amount),
      fee: money(row.fee),
      total: money(row.total),
      wallet: row.wallet_number,
      account: row.email || row.full_name,
      createdAt: row.created_at,
      provider: row.provider || "-",
      providerReference: row.checkout_id || row.peach_payment_id || "-",
      peachEvidence: row.provider_state
        ? `providerState=${row.provider_state}${row.result_code ? ` resultCode=${row.result_code}` : ""}${row.settled_at ? ` settledAt=${row.settled_at}` : ""}`
        : (row.failure_reason ? `failure=${row.failure_reason}` : "none recorded"),
      ledgerEntryIds: row.entry_ids || [],
      walletCredited,
      creditedAmount: money(credited),
      belongsOnStatement,
      flags
    };
  });

  if (asJson) {
    console.log(JSON.stringify({ topups: report }, null, 2));
  } else {
    console.log(`\nTOP-UP INTEGRITY AUDIT — ${report.length} record(s)\n${"=".repeat(78)}`);
    for (const item of report) {
      console.log(`
 Transaction ID   ${item.transactionId}
 Reference        ${item.reference}
 Wallet           ${item.wallet}   ${item.account || ""}
 Created          ${new Date(item.createdAt).toISOString()}
 Status           ${item.status}
 Amount / Fee     R ${item.amount} + R ${item.fee} fee  =  R ${item.total} charged
 Provider ref     ${item.providerReference}
 Peach evidence   ${item.peachEvidence}
 Ledger entry     ${item.ledgerEntryIds.length ? item.ledgerEntryIds.join(", ") : "NONE"}
 Wallet credited  ${item.walletCredited ? `YES  R ${item.creditedAmount}` : "NO   R 0.00"}
 On statement?    ${item.belongsOnStatement ? "yes — a real credit" : "NO — attempt only, must not count as money in"}${item.flags.length ? `\n ** FLAGS **      ${item.flags.join(", ")}` : ""}`);
    }
    const wrong = report.filter((item) => item.flags.length);
    console.log(`\n${"=".repeat(78)}`);
    console.log(` Credited to the wallet : ${report.filter((r) => r.walletCredited).length}`);
    console.log(` Attempts, no money     : ${report.filter((r) => !r.walletCredited).length}`);
    console.log(` Records needing action : ${wrong.length}${wrong.length ? "  <-- investigate these" : ""}`);
  }

  // The decisive check: does each wallet's recorded balance equal the sum of
  // its own ledger? If it does, no phantom money exists, whatever a statement
  // may have printed.
  const walletValues = [];
  let walletWhere = "";
  if (walletFilter) { walletValues.push(walletFilter); walletWhere = `WHERE w.wallet_number = $1 OR w.id::text = $1`; }
  const { rows: balances } = await pool.query(
    `SELECT w.wallet_number, w.available_balance, w.reserved_balance,
            COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN ABS(wl.amount)
                              WHEN wl.entry_type IN ('debit','reserve')  THEN -ABS(wl.amount)
                              ELSE 0 END), 0) AS ledger_balance
       FROM wallets w
       LEFT JOIN wallet_ledger wl ON wl.wallet_id = w.id
       ${walletWhere}
      GROUP BY w.id, w.wallet_number, w.available_balance, w.reserved_balance
      HAVING ABS(w.available_balance - COALESCE(SUM(CASE WHEN wl.entry_type IN ('credit','release') THEN ABS(wl.amount)
                                                        WHEN wl.entry_type IN ('debit','reserve')  THEN -ABS(wl.amount)
                                                        ELSE 0 END), 0)) > 0.005
      ORDER BY w.wallet_number
      LIMIT 200`,
    walletValues
  );

  if (!asJson) {
    console.log(`\nWALLET BALANCE vs LEDGER\n${"=".repeat(78)}`);
    if (!balances.length) {
      console.log(" Every wallet balance equals the sum of its own ledger. No phantom money.");
    } else {
      console.log(` ${balances.length} wallet(s) DO NOT reconcile — escalate before any other action:`);
      for (const row of balances) {
        console.log(`  ${row.wallet_number}  recorded R ${money(row.available_balance)}  ledger R ${money(row.ledger_balance)}  difference R ${money(Number(row.available_balance) - Number(row.ledger_balance))}`);
      }
    }
  } else {
    console.log(JSON.stringify({ unreconciledWallets: balances }, null, 2));
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error("audit failed:", error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
