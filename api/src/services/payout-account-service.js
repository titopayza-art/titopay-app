"use strict";

// Bank accounts a customer can withdraw or pay out to.
//
// TitoPay's `beneficiaries` table links two TitoPay users, so it cannot hold a
// bank account. These records hold exactly what the Peach Payouts API requires
// and nothing more, and they are validated against Peach's published
// constraints at save time so a payout can never fail on a detail TitoPay could
// have caught first.
//
// Account numbers are never returned in full. Callers see the bank, the holder
// and a masked tail — enough to recognise the account, useless to anyone else.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const {
  SUPPORTED_BANKS,
  normalizeBankName,
  toAccountHolder
} = require("./peach-payout-service");

const ACCOUNT_TYPES = ["cheque", "savings", "transmission", "business"];

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function maskAccountNumber(value) {
  const text = trimmed(value);
  if (!text) return "";
  return text.length <= 4 ? `••••${text}` : `••••${text.slice(-4)}`;
}

// The public shape. There is deliberately no option to return the full number.
function publicAccount(row = {}) {
  return {
    id: row.id,
    nickname: row.nickname || "",
    accountHolder: row.account_holder,
    bankName: row.bank_name,
    accountNumber: maskAccountNumber(row.account_number),
    accountNumberLast4: trimmed(row.account_number).slice(-4),
    branchCode: row.branch_code,
    accountType: row.account_type,
    isDefault: Boolean(row.is_default),
    verified: Boolean(row.verified_at),
    lastPaidAt: row.last_paid_at || null,
    createdAt: row.created_at
  };
}

function listSupportedBanks() {
  return SUPPORTED_BANKS.map((name) => ({ value: name, label: name }));
}

function validateAccountPayload(payload = {}) {
  const problems = [];

  const accountHolder = toAccountHolder(payload.accountHolder);
  if (!accountHolder || accountHolder.length < 2) {
    problems.push("Account holder must be 2-50 letters, digits, spaces, dots or hyphens");
  }

  const bankName = normalizeBankName(payload.bankName);
  if (!bankName) problems.push("Choose a bank TitoPay can pay out to");

  const accountNumber = trimmed(payload.accountNumber).replace(/\s+/g, "");
  if (!/^[0-9]{4,50}$/.test(accountNumber)) problems.push("Account number must be 4-50 digits");

  const branchCode = trimmed(payload.branchCode).replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(branchCode)) problems.push("Branch code must be exactly 6 digits");

  const accountType = trimmed(payload.accountType).toLowerCase() || "cheque";
  if (!ACCOUNT_TYPES.includes(accountType)) problems.push(`Account type must be one of ${ACCOUNT_TYPES.join(", ")}`);

  if (problems.length) {
    // The values themselves are never echoed back, only what is wrong.
    throw new AppError(400, problems[0], { code: "BANK_ACCOUNT_INVALID", problems });
  }

  return {
    accountHolder,
    bankName,
    accountNumber,
    branchCode,
    accountType,
    nickname: trimmed(payload.nickname).slice(0, 60)
  };
}

async function listBankAccounts(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM payout_bank_accounts
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY is_default DESC, created_at DESC`,
    [userId]
  );
  return rows.map(publicAccount);
}

// Server-side only: the full record, including the account number. Used by the
// withdrawal service when building the Peach request. Never serialise this.
async function listBankAccountRecord(userId, accountId) {
  const id = trimmed(accountId);
  if (!id) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { rows } = await pool.query(
    "SELECT * FROM payout_bank_accounts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1",
    [id, userId]
  );
  return rows[0] || null;
}

async function createBankAccount(userId, payload = {}) {
  const clean = validateAccountPayload(payload);

  const existing = await pool.query(
    `SELECT * FROM payout_bank_accounts
      WHERE user_id=$1 AND bank_name=$2 AND account_number=$3 AND branch_code=$4 AND deleted_at IS NULL
      LIMIT 1`,
    [userId, clean.bankName, clean.accountNumber, clean.branchCode]
  );
  if (existing.rows[0]) return publicAccount(existing.rows[0]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const count = await client.query(
      "SELECT COUNT(*)::int AS n FROM payout_bank_accounts WHERE user_id=$1 AND deleted_at IS NULL",
      [userId]
    );
    if (count.rows[0].n >= 20) throw new AppError(409, "You already have the maximum number of saved bank accounts");
    const makeDefault = payload.isDefault === true || count.rows[0].n === 0;
    if (makeDefault) {
      await client.query("UPDATE payout_bank_accounts SET is_default=FALSE, updated_at=NOW() WHERE user_id=$1", [userId]);
    }
    const { rows } = await client.query(
      `INSERT INTO payout_bank_accounts
        (id, user_id, nickname, account_holder, bank_name, account_number, branch_code, account_type, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uuidv4(), userId, clean.nickname || null, clean.accountHolder, clean.bankName,
       clean.accountNumber, clean.branchCode, clean.accountType, makeDefault]
    );
    await client.query("COMMIT");
    return publicAccount(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Soft delete, so a completed withdrawal keeps the account it was sent to.
async function deleteBankAccount(userId, accountId) {
  const record = await listBankAccountRecord(userId, accountId);
  if (!record) throw new AppError(404, "Bank account not found");
  await pool.query(
    "UPDATE payout_bank_accounts SET deleted_at=NOW(), is_default=FALSE, updated_at=NOW() WHERE id=$1 AND user_id=$2",
    [record.id, userId]
  );
  return { ok: true };
}

module.exports = {
  ACCOUNT_TYPES,
  createBankAccount,
  deleteBankAccount,
  listBankAccountRecord,
  listBankAccounts,
  listSupportedBanks,
  maskAccountNumber,
  publicAccount,
  validateAccountPayload
};
