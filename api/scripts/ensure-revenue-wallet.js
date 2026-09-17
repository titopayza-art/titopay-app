"use strict";

// Provision the single TitoPay revenue wallet, if it does not already exist.
//
//   node scripts/ensure-revenue-wallet.js            report only, changes nothing
//   node scripts/ensure-revenue-wallet.js --create   create it if it is missing
//
// Four services already read this wallet — top-up fees, Email Statement fees,
// ticketing and enterprise distribution — and nothing in the codebase creates
// it. Without it, a fee is either silently unrecorded or the request fails,
// depending on which service is asking.
//
// It is deliberately not created on demand from inside a payment path. A wallet
// that appears in the middle of settling someone's money is not something that
// should happen quietly, so it is an explicit, auditable operation with a
// dry run by default.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const { generateUniqueWalletNumber } = require("../src/lib/wallet-id");

const CREATE = process.argv.includes("--create");

async function main() {
  const { rows: existing } = await pool.query(
    `SELECT id, wallet_number, currency, available_balance, status, created_at
       FROM wallets WHERE kind = 'revenue' AND user_id IS NULL ORDER BY created_at LIMIT 5`
  );

  if (existing.length > 1) {
    console.error(`\n  ${existing.length} revenue wallets exist. There must be exactly one — fee postings pick the first.`);
    existing.forEach((w) => console.error(`    ${w.wallet_number}  R ${w.available_balance}  ${w.status}  created ${w.created_at.toISOString()}`));
    console.error("  Resolve this before recording any further revenue.\n");
    await pool.end();
    process.exit(1);
  }

  if (existing.length === 1) {
    const w = existing[0];
    console.log(`\n  Revenue wallet present.`);
    console.log(`    number   ${w.wallet_number}`);
    console.log(`    balance  ${w.currency} ${w.available_balance}`);
    console.log(`    status   ${w.status}`);
    const { rows: booked } = await pool.query(
      `SELECT COUNT(*)::int AS entries, COALESCE(SUM(fee_collected), 0) AS total FROM revenue_ledger WHERE revenue_wallet_id = $1`,
      [w.id]
    );
    console.log(`    recorded ${booked[0].entries} fee(s) totalling ${w.currency} ${Number(booked[0].total).toFixed(2)}`);
    if (w.status !== "active") console.log(`\n  WARNING: status is "${w.status}". Fee postings expect an active wallet.`);
    console.log("");
    await pool.end();
    return;
  }

  console.log("\n  No revenue wallet exists.");
  console.log("  Fees collected on card top-ups reach TitoPay but cannot be recorded as revenue,");
  console.log("  and every settled transaction will read as needing reconciliation.\n");

  if (!CREATE) {
    console.log("  Re-run with --create to provision it. Nothing has been changed.\n");
    await pool.end();
    return;
  }

  // Same allocator every other wallet uses, so the number satisfies the
  // wallet_number format constraint and is unique.
  const id = uuidv4();
  const number = await generateUniqueWalletNumber(pool);
  const { rows } = await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1, $2, NULL, 'revenue', 'ZAR', 0, 0, 'active')
     RETURNING wallet_number, currency, available_balance, status`,
    [id, number]
  );
  console.log(`  Created revenue wallet ${rows[0].wallet_number} (${rows[0].currency} ${rows[0].available_balance}, ${rows[0].status}).`);
  console.log("  Fees on transactions settled from now on will be recorded against it.");
  console.log("  Fees already collected before this point are NOT backfilled — that is a");
  console.log("  finance decision, not something a provisioning script should assume.\n");
  await pool.end();
}

main().catch(async (error) => {
  console.error("failed:", error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
