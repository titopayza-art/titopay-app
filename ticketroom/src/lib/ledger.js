// Double-entry ledger. Debits are positive, credits negative, every journal
// sums to zero (enforced by a deferred database trigger) and rows are
// immutable (enforced by triggers). Corrections are reversal journals.
const { conflict } = require("./errors");

const ACCOUNT_KINDS = {
  provider_clearing: "asset",       // money the provider holds for us
  platform_bank: "asset",           // TitoPay's settlement bank account
  organiser_payable: "liability",   // owed to an organiser, per event
  vendor_payable: "liability",      // owed to a vendor
  attendee_wallet: "liability",     // prepaid event balance owed to attendee
  platform_fee_revenue: "revenue",  // consumer booking fees (R10 per paid ticket)
  organiser_commission_revenue: "revenue", // organiser commission (5% of ticket sales)
  platform_commission_revenue: "revenue", // vendor commissions
  provider_fee_expense: "expense",
};

// Account codes are deterministic so the same account is always reused.
const codes = {
  providerClearing: (provider) => ({ code: `provider_clearing:${provider}`, type: "provider_clearing", owner_type: "provider", owner_id: provider, name: `Provider clearing (${provider})` }),
  platformBank: () => ({ code: "platform_bank", type: "platform_bank", owner_type: "platform", name: "Settlement bank" }),
  organiserPayable: (orgId, eventId) => ({ code: `organiser_payable:${orgId}:${eventId}`, type: "organiser_payable", owner_type: "organiser", owner_id: orgId, event_id: eventId, name: "Organiser payable" }),
  vendorPayable: (vendorId, eventId) => ({ code: `vendor_payable:${vendorId}`, type: "vendor_payable", owner_type: "vendor", owner_id: vendorId, event_id: eventId, name: "Vendor payable" }),
  attendeeWallet: (userId, eventId) => ({ code: `attendee_wallet:${userId}:${eventId}`, type: "attendee_wallet", owner_type: "attendee", owner_id: userId, event_id: eventId, name: "Attendee event balance" }),
  feeRevenue: () => ({ code: "platform_fee_revenue", type: "platform_fee_revenue", owner_type: "platform", name: "Consumer booking fees" }),
  organiserCommission: () => ({ code: "organiser_commission_revenue", type: "organiser_commission_revenue", owner_type: "platform", name: "Organiser commission" }),
  commissionRevenue: () => ({ code: "platform_commission_revenue", type: "platform_commission_revenue", owner_type: "platform", name: "Vendor commission" }),
  providerFees: (provider) => ({ code: `provider_fee_expense:${provider}`, type: "provider_fee_expense", owner_type: "provider", owner_id: provider, name: `Provider fees (${provider})` }),
};

async function account(client, spec) {
  const kind = ACCOUNT_KINDS[spec.type];
  const { rows } = await client.query(
    `INSERT INTO ledger_accounts (code, kind, owner_type, owner_id, event_id, name)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id, code, kind`,
    [spec.code, kind, spec.owner_type, spec.owner_id || null, spec.event_id || null, spec.name]
  );
  return rows[0];
}

// Locks the account row so concurrent spenders queue behind each other, then
// returns the balance in the account's natural sign (liabilities positive).
async function lockedBalance(client, spec) {
  const acct = await account(client, spec);
  await client.query("SELECT id FROM ledger_accounts WHERE id = $1 FOR UPDATE", [acct.id]);
  return { account: acct, balance: await balanceOf(client, acct) };
}

async function balanceOf(client, acct) {
  const { rows } = await client.query("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM ledger_entries WHERE account_id = $1", [acct.id]);
  const raw = rows[0].s;
  return acct.kind === "asset" || acct.kind === "expense" ? raw : -raw;
}

async function balanceByCode(client, code) {
  const { rows } = await client.query(
    `SELECT a.kind, COALESCE(SUM(e.amount_cents),0)::bigint AS s FROM ledger_accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.code = $1 GROUP BY a.kind`, [code]);
  if (!rows[0]) return 0;
  return rows[0].kind === "asset" || rows[0].kind === "expense" ? rows[0].s : -rows[0].s;
}

// lines: [{ account: spec, debit } | { account: spec, credit }]
// Returns the journal id. Re-posting the same idempotency key returns the
// original journal instead of posting twice.
async function post(client, { kind, reference, idempotencyKey, memo, createdBy, reverses, lines }) {
  const existing = await client.query("SELECT id FROM journals WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rows[0]) return existing.rows[0].id;

  const resolved = [];
  let sum = 0;
  for (const line of lines) {
    const amount = line.debit ? line.debit : -(line.credit || 0);
    if (!Number.isSafeInteger(amount)) throw new Error("ledger amounts must be integer cents");
    if (amount === 0) continue;
    sum += amount;
    resolved.push({ acct: await account(client, line.account), amount });
  }
  if (sum !== 0 || resolved.length < 2) throw conflict("Ledger journal does not balance.", "ledger_unbalanced");

  const { rows } = await client.query(
    `INSERT INTO journals (kind, reference, idempotency_key, memo, created_by, reverses_journal_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [kind, reference, idempotencyKey, memo || null, createdBy || null, reverses || null]
  );
  const journalId = rows[0].id;
  for (const { acct, amount } of resolved) {
    await client.query("INSERT INTO ledger_entries (journal_id, account_id, amount_cents) VALUES ($1,$2,$3)", [journalId, acct.id, amount]);
  }
  return journalId;
}

// Posts the exact mirror of an existing journal.
async function reverse(client, journalId, { kind, reference, idempotencyKey, memo, createdBy }) {
  const existing = await client.query("SELECT id FROM journals WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows: entries } = await client.query("SELECT account_id, amount_cents FROM ledger_entries WHERE journal_id = $1", [journalId]);
  if (!entries.length) throw new Error("nothing to reverse");
  const { rows } = await client.query(
    `INSERT INTO journals (kind, reference, idempotency_key, memo, created_by, reverses_journal_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [kind, reference, idempotencyKey, memo || null, createdBy || null, journalId]);
  for (const e of entries) {
    await client.query("INSERT INTO ledger_entries (journal_id, account_id, amount_cents) VALUES ($1,$2,$3)", [rows[0].id, e.account_id, -e.amount_cents]);
  }
  return rows[0].id;
}

module.exports = { codes, account, lockedBalance, balanceOf, balanceByCode, post, reverse };
