"use strict";

const { randomInt } = require("crypto");

function generateWalletNumberCandidate() {
  return String(randomInt(1000000000, 10000000000));
}

async function generateUniqueWalletNumber(queryable, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const walletNumber = generateWalletNumberCandidate();
    if (!/^[0-9]{1,10}$/.test(walletNumber)) continue;
    const { rows } = await queryable.query("SELECT 1 FROM wallets WHERE wallet_number = $1 LIMIT 1", [walletNumber]);
    if (!rows[0]) return walletNumber;
  }
  throw new Error("Unable to allocate wallet number");
}

async function ensureWalletNumbersForAllWallets(queryable) {
  const { rows } = await queryable.query(
    `SELECT id
     FROM wallets
     WHERE wallet_number IS NULL
        OR wallet_number !~ '^[0-9]{1,10}$'
     ORDER BY created_at ASC
     LIMIT 1000`
  );
  for (const row of rows) {
    const walletNumber = await generateUniqueWalletNumber(queryable);
    await queryable.query(
      "UPDATE wallets SET wallet_number = $2, updated_at = NOW() WHERE id = $1",
      [row.id, walletNumber]
    );
  }
  return rows.length;
}

module.exports = {
  ensureWalletNumbersForAllWallets,
  generateUniqueWalletNumber
};
