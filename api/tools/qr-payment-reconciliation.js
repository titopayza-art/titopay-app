"use strict";

// ARE ALL QR PAYMENTS TRUE?
//
// A QR payment has three sides and they have to agree to the cent:
//
//     payer debited      amount + payerFee
//     recipient credited amount - recipientFee
//     revenue credited   payerFee + recipientFee
//
// This checks every QR payment in a database against its own ledger entries
// and reports any that do not. It is READ ONLY - nothing but SELECT - so it is
// safe to point at production:
//
//   POSTGRES_URL='...' node api/tools/qr-payment-reconciliation.js
//
// It lives under api/ rather than verification/ ON PURPOSE: this is the one
// check that has to run where the DATABASE is, which on a cPanel deployment is
// the API folder on the server. verification/ is not in any release archive,
// so a reconciliation kept there could never be pointed at production - which
// is the only place the answer matters.
//
// It exits non-zero if a single payment fails to reconcile, so it can sit in a
// cron and shout rather than be remembered.
//
// WHY THIS IS NOT THE SAME AS THE UNIT TESTS. The tests prove the arithmetic
// the code intends. This proves the arithmetic that actually landed in the
// ledger, on real rows, including ones written by builds that came before any
// of today's rules existed. The two answer different questions and a passing
// test suite is not evidence for this one.

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL
  || "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "reconcile-access-secret-long-enough";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "reconcile-refresh-secret-long-enough";

const { pool } = require("../src/db/pool");

const QR_CODES = ["qr_payment", "qr_pay", "customer_qr_payment"];
const cents = (value) => Math.round((Number(value) || 0) * 100);
const rand = (value) => `R${((Number(value) || 0)).toFixed(2)}`;

// A payment reconciles when every one of these holds. Each returns a sentence
// when it fails, so the report says what is wrong rather than just which row.
function auditPayment(tx, entries) {
  const problems = [];
  const meta = tx.metadata || {};

  const debits = entries.filter((e) => e.entry_type === "debit");
  const credits = entries.filter((e) => e.entry_type === "credit");
  const holds = entries.filter((e) => e.entry_type === "reserve" || e.entry_type === "release");

  const debited = debits.reduce((sum, e) => sum + cents(e.amount), 0);
  const credited = credits.reduce((sum, e) => sum + cents(e.amount), 0);

  // 1. THE ONE THAT MATTERS MOST. Whatever the fees were meant to be, money
  //    cannot appear or vanish: every cent debited is a cent credited.
  if (!holds.length && debited !== credited) {
    problems.push(`ledger does not balance: ${rand(debited / 100)} debited, ${rand(credited / 100)} credited`);
  }

  // A payment held for the recipient's verification posts no credit yet; it is
  // a liability, not a loss, and it is reported separately rather than counted
  // as a break.
  if (!credits.length && !holds.length) {
    problems.push("nothing was credited to anybody");
  }

  const amount = cents(tx.amount);
  const payerFee = cents(tx.fee);
  const recipientFee = cents(meta.recipientFee || 0);

  // 2. The payer was debited the amount plus their own fee, and no more.
  const payerDebit = debits.reduce((sum, e) => sum + cents(e.amount), 0);
  if (debits.length && payerDebit !== amount + payerFee) {
    problems.push(`payer debited ${rand(payerDebit / 100)}, expected ${rand((amount + payerFee) / 100)}`);
  }

  // 3. The recipient was credited the amount less the fee charged to THEM.
  const recipientWalletId = meta.recipientWalletId || null;
  const recipientCredit = credits
    .filter((e) => recipientWalletId && String(e.wallet_id) === String(recipientWalletId))
    .reduce((sum, e) => sum + cents(e.amount), 0);
  if (recipientWalletId && credits.length) {
    const expected = amount - recipientFee;
    if (recipientCredit !== expected) {
      problems.push(`recipient credited ${rand(recipientCredit / 100)}, expected ${rand(expected / 100)}`);
    }
    // netAmount is what the app shows. It has to be the same number.
    if (meta.netAmount !== undefined && cents(meta.netAmount) !== recipientCredit) {
      problems.push(`netAmount says ${rand(meta.netAmount)} but ${rand(recipientCredit / 100)} was credited`);
    }
  }

  // 4. Revenue took both fees and nothing else.
  const revenueCredit = credited - recipientCredit;
  if (credits.length && revenueCredit !== payerFee + recipientFee) {
    problems.push(`revenue credited ${rand(revenueCredit / 100)}, expected ${rand((payerFee + recipientFee) / 100)}`);
  }

  // 5. Nobody is credited a negative, and no fee exceeds its own sale.
  if (recipientFee >= amount && amount > 0) {
    problems.push(`merchant fee ${rand(recipientFee / 100)} is not less than the sale ${rand(amount / 100)}`);
  }

  return { problems, held: holds.length > 0 && !credits.length };
}

(async () => {
  console.log("\n=============================================================");
  console.log("  QR PAYMENTS -> does every one reconcile against its ledger?");
  console.log("=============================================================\n");

  const { rows: payments } = await pool.query(
    `SELECT id, reference, service_code, amount, fee, total, status, metadata, created_at
       FROM transactions
      WHERE service_code = ANY($1::TEXT[])
      ORDER BY created_at ASC`,
    [QR_CODES]);

  if (!payments.length) {
    console.log("  No QR payments in this database. Nothing to reconcile.\n");
    await pool.end();
    process.exit(0);
  }

  const { rows: ledger } = await pool.query(
    `SELECT wl.transaction_id, wl.wallet_id, wl.entry_type, wl.amount
       FROM wallet_ledger wl
       JOIN transactions t ON t.id = wl.transaction_id
      WHERE t.service_code = ANY($1::TEXT[])`,
    [QR_CODES]);

  const byTransaction = new Map();
  for (const entry of ledger) {
    const list = byTransaction.get(String(entry.transaction_id)) || [];
    list.push(entry);
    byTransaction.set(String(entry.transaction_id), list);
  }

  let clean = 0;
  let held = 0;
  let unposted = 0;
  const broken = [];
  let grossCents = 0;
  let feeCents = 0;

  for (const tx of payments) {
    const entries = byTransaction.get(String(tx.id)) || [];
    if (!entries.length) {
      // A transaction with no ledger entries at all moved no money. That is
      // correct for a failed or pending one and a break for a completed one.
      if (tx.status === "completed") broken.push({ tx, problems: ["completed but nothing was posted to any wallet"] });
      else unposted += 1;
      continue;
    }
    const { problems, held: isHeld } = auditPayment(tx, entries);
    grossCents += cents(tx.amount);
    feeCents += cents(tx.fee) + cents((tx.metadata || {}).recipientFee || 0);
    if (isHeld) held += 1;
    if (problems.length) broken.push({ tx, problems });
    else clean += 1;
  }

  console.log(`  ${payments.length} QR payment(s) examined`);
  console.log(`    reconciled        ${clean}`);
  if (held) console.log(`    held for verification ${held}  (credit not posted yet, by design)`);
  if (unposted) console.log(`    moved no money    ${unposted}  (not completed)`);
  console.log(`    DID NOT RECONCILE ${broken.length}`);
  console.log(`\n  Gross through QR: ${rand(grossCents / 100)}   fees taken: ${rand(feeCents / 100)}\n`);

  if (broken.length) {
    console.log("  PAYMENTS THAT DO NOT RECONCILE:\n");
    for (const { tx, problems } of broken.slice(0, 40)) {
      console.log(`   ${tx.reference}  ${rand(tx.amount)}  ${tx.status}  ${new Date(tx.created_at).toISOString().slice(0, 10)}`);
      for (const problem of problems) console.log(`       - ${problem}`);
    }
    if (broken.length > 40) console.log(`   ... and ${broken.length - 40} more`);
    console.log("");
  }

  await pool.end();
  process.exit(broken.length ? 1 : 0);
})().catch(async (error) => {
  console.error("RECONCILIATION COULD NOT RUN:", error.message);
  await pool.end().catch(() => {});
  process.exit(2);
});
