"use strict";

// THE MONEY PATHS CUSTOMERS ACTUALLY USE.
//
// /v1/transactions carries transfers, gifts, tips, QR payments and every VAS
// purchase, and had no test file of its own. What that cost is on the record:
// a Business Document PDF was priced at exactly double for as long as it
// existed, and nothing noticed.
//
// These cover the parts where getting it wrong costs somebody money:
//
//   - a double tap must not charge twice
//   - the debit must equal amount + fee, and the ledger must balance
//   - the fee goes to the revenue wallet, never to the recipient
//   - a wallet that cannot cover the total is refused before anything moves
//   - a service without a live provider is refused, and says so plainly
//
// The database is stubbed. The advisory lock that actually holds two
// simultaneous requests apart is a real Postgres feature and a stub cannot
// prove it works — verification/money-paths-live.js does that against a real
// database. What is proved here is everything around it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/pool");
const transactions = require("../src/services/transaction-service");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "transaction-service.js"), "utf8");

const ACTOR = { userId: "11111111-1111-4111-8111-111111111111", userType: "customer", email: "payer@titopay.test" };

// A stand-in for the whole data layer. Records every wallet movement so a test
// can total the ledger, and lets a test say what is already in the database.
function sandbox({ balance = 1000, flatFee = 0, percentageFee = 0, replayRow = null, recipient = true } = {}) {
  const movements = [];
  const inserted = [];
  const state = { advisoryLocks: 0, began: 0, committed: 0, rolledBack: 0, released: 0 };

  const answer = async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (/^(CREATE|ALTER|DO)\b/i.test(q)) return { rows: [] };
    if (/FROM pricing_rules/i.test(q)) {
      return { rows: [{
        service_code: "send_money", service_name: "Send Money",
        fee_type: percentageFee > 0 ? "PERCENTAGE" : "FIXED",
        fee_value: percentageFee > 0 ? percentageFee : flatFee,
        flat_fee: flatFee, percentage_fee: percentageFee,
        minimum_fee: 0, maximum_fee: 0, vat_percentage: 0
      }] };
    }
    if (/pg_advisory_xact_lock/i.test(q)) { state.advisoryLocks += 1; return { rows: [] }; }
    if (/^BEGIN/i.test(q)) { state.began += 1; return { rows: [] }; }
    if (/^COMMIT/i.test(q)) { state.committed += 1; return { rows: [] }; }
    if (/^ROLLBACK/i.test(q)) { state.rolledBack += 1; return { rows: [] }; }
    // The idempotency lookup, both the unlocked fast path and the locked replay.
    if (/FROM transactions WHERE user_id = \$1 AND metadata->>'clientIdempotencyKey'/i.test(q)) {
      return { rows: replayRow ? [replayRow] : [] };
    }
    if (/FROM wallets WHERE user_id/i.test(q)) {
      return { rows: [{ id: "wallet-payer", user_id: ACTOR.userId, available_balance: balance, wallet_number: "TP-PAYER" }] };
    }
    // resolveRecipientWallet
    if (/FROM users u JOIN wallets w/i.test(q)) {
      return { rows: recipient ? [{ id: "wallet-recipient", user_id: "22222222-2222-4222-8222-222222222222" }] : [] };
    }
    if (/revenue/i.test(q)) {
      return { rows: [{ id: "wallet-revenue", user_id: null, available_balance: 0 }] };
    }
    if (/^INSERT INTO transactions/i.test(q)) { inserted.push(params); return { rows: [] }; }
    // applyWalletMovement updates the wallet, then writes the ledger row. The
    // ledger insert is the record of money actually moving, so that is what is
    // captured — reading the code's intent would prove nothing.
    if (/^INSERT INTO wallet_ledger/i.test(q)) {
      movements.push({
        walletId: params[1], transactionId: params[2], entryType: params[3],
        amount: Number(params[4]), reference: params[6],
        metadata: JSON.parse(params[7] || "{}")
      });
      return { rows: [] };
    }
    if (/^UPDATE wallets SET available_balance/i.test(q)) {
      return { rows: [{ available_balance: balance }] };
    }
    if (/^SELECT \* FROM transactions|FROM transactions WHERE id/i.test(q)) return { rows: [] };
    return { rows: [] };
  };

  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = answer;
  pool.connect = async () => ({
    query: answer,
    release() { state.released += 1; }
  });

  return {
    movements, inserted, state,
    restore() {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    }
  };
}

/* ------------------------------------------------------- the money itself */

test("a transfer debits amount plus fee, and the ledger balances", async () => {
  const box = sandbox({ balance: 1000, flatFee: 1.5 });
  try {
    const result = await transactions.createTransaction(ACTOR, {
      serviceCode: "send_money", amount: 100, recipient: "payee@titopay.test", idempotencyKey: "k1"
    });
    assert.equal(result.amount, 100);
    assert.equal(result.fee, 1.5);
    assert.equal(result.total, 101.5, "the customer pays the amount plus the fee");

    const debits = box.movements.filter((m) => m.entryType === "debit");
    const credits = box.movements.filter((m) => m.entryType === "credit");
    assert.equal(debits.length, 1, "exactly one wallet is debited");
    assert.equal(debits[0].amount, 101.5);
    const totalDebited = debits.reduce((s, m) => s + m.amount, 0);
    const totalCredited = credits.reduce((s, m) => s + m.amount, 0);
    assert.equal(totalDebited, totalCredited, "every cent debited is credited somewhere");
  } finally {
    box.restore();
  }
});

test("the fee goes to the revenue wallet and the recipient gets the amount", async () => {
  const box = sandbox({ balance: 1000, flatFee: 1.5 });
  try {
    await transactions.createTransaction(ACTOR, {
      serviceCode: "send_money", amount: 100, recipient: "payee@titopay.test", idempotencyKey: "k2"
    });
    const toRecipient = box.movements.find((m) => m.walletId === "wallet-recipient");
    const toRevenue = box.movements.find((m) => m.walletId === "wallet-revenue");
    assert.ok(toRecipient, "the recipient must be credited");
    assert.equal(toRecipient.amount, 100, "the recipient gets the amount, never the amount minus the fee");
    assert.ok(toRevenue, "the fee must reach the revenue wallet");
    assert.equal(toRevenue.amount, 1.5);
    assert.equal(toRevenue.metadata.source, "fee");
  } finally {
    box.restore();
  }
});

test("a percentage fee reaches the ledger as the priced figure, not a recomputed one", async () => {
  const box = sandbox({ balance: 10000, percentageFee: 1.7 });
  try {
    const result = await transactions.createTransaction(ACTOR, {
      serviceCode: "send_money", amount: 33.33, recipient: "payee@titopay.test", idempotencyKey: "k3"
    });
    assert.equal(result.fee, 0.57, "1.7% of 33.33, rounded to the cent");
    assert.equal(result.total, 33.9);
    const debit = box.movements.find((m) => m.entryType === "debit");
    assert.equal(debit.amount, 33.9, "the ledger and the receipt agree to the cent");
  } finally {
    box.restore();
  }
});

/* ------------------------------------------------------------ double taps */

test("pressing Confirm twice returns the first transaction, and charges once", async () => {
  const existing = {
    id: "tx-original", user_id: ACTOR.userId, service_code: "send_money",
    amount: 100, fee: 1.5, total: 101.5, status: "completed", direction: "debit",
    reference: "TX-ORIGINAL", metadata: JSON.stringify({ clientIdempotencyKey: "same-key" })
  };
  const box = sandbox({ balance: 1000, flatFee: 1.5, replayRow: existing });
  try {
    const result = await transactions.createTransaction(ACTOR, {
      serviceCode: "send_money", amount: 100, recipient: "payee@titopay.test", idempotencyKey: "same-key"
    });
    assert.equal(result.reference, "TX-ORIGINAL", "the original transaction comes back");
    assert.equal(box.movements.length, 0, "a replay must not move any money at all");
    assert.equal(box.inserted.length, 0, "and must not write a second transaction row");
  } finally {
    box.restore();
  }
});

test("the idempotency guard is a lock, not just a lookup", () => {
  // Two copies of one request arriving together both miss an unlocked read.
  // Only the advisory lock holds them apart, and it has to be taken inside the
  // transaction, before the re-read that decides whether to charge.
  const body = SOURCE.slice(SOURCE.indexOf("async function createTransaction"));
  const begin = body.indexOf('client.query("BEGIN")');
  const lock = body.indexOf("pg_advisory_xact_lock");
  const reread = body.indexOf("FROM transactions", lock);
  const insert = body.indexOf("INSERT INTO transactions");
  assert.ok(begin >= 0 && lock > begin, "the lock must be taken inside the transaction");
  assert.ok(reread > lock, "the replay check must happen after the lock is held");
  assert.ok(insert > reread, "nothing may be written before the replay check");
  assert.match(body.slice(lock - 200, lock + 200), /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
});

/* ------------------------------------------------------------- refusals */

test("a wallet that cannot cover the total moves nothing", async () => {
  const box = sandbox({ balance: 100, flatFee: 1.5 });
  try {
    await assert.rejects(
      transactions.createTransaction(ACTOR, {
        serviceCode: "send_money", amount: 100, recipient: "payee@titopay.test", idempotencyKey: "k4"
      }),
      (error) => error.statusCode === 400 && /Insufficient balance/.test(error.message)
    );
    assert.equal(box.movements.length, 0, "a refused transaction must not touch the ledger");
    // R100 is affordable; R100 + R1.50 is not. The fee has to be part of the check.
  } finally {
    box.restore();
  }
});

test("a locked profile cannot move money", async () => {
  const box = sandbox({ balance: 1000 });
  try {
    await assert.rejects(
      transactions.createTransaction({ ...ACTOR, profileLocked: true }, {
        serviceCode: "send_money", amount: 10, recipient: "payee@titopay.test"
      }),
      (error) => error.statusCode === 423
    );
    assert.equal(box.movements.length, 0);
  } finally {
    box.restore();
  }
});

/* --------------------------------------------- services without a provider */

test("VAS, cash-out and marketplace are refused, and say no money moved", async () => {
  // Airtime, data and electricity have no provider wired up. The refusal has to
  // be unambiguous about the wallet, because the customer's next move after an
  // error is to try again.
  const box = sandbox({ balance: 1000 });
  try {
    for (const serviceCode of ["airtime", "data", "electricity", "voucher", "pay_bills", "withdraw_cash"]) {
      await assert.rejects(
        transactions.createTransaction(ACTOR, { serviceCode, amount: 50, idempotencyKey: `k-${serviceCode}` }),
        (error) => error.statusCode === 503 && /No wallet debit was made/.test(error.message),
        `${serviceCode} must be refused with a clear statement that nothing moved`
      );
    }
    assert.equal(box.movements.length, 0, "no unlaunched service may touch the ledger");
  } finally {
    box.restore();
  }
});

test("a card top-up is sent to the card flow, not debited here", async () => {
  // A top-up is a wallet CREDIT funded by Peach Checkout. Debiting it through
  // the generic endpoint would take money to add money.
  const box = sandbox({ balance: 1000 });
  try {
    await assert.rejects(
      transactions.createTransaction(ACTOR, { serviceCode: "wallet_top_up", amount: 50 }),
      (error) => error.details?.code === "USE_CARD_TOPUP_FLOW"
        && /No wallet debit was made/.test(error.message)
    );
    assert.equal(box.movements.length, 0);
  } finally {
    box.restore();
  }
});

test("a withdrawal is never debited through the generic endpoint", async () => {
  // Two different refusals guard this, and which one fires depends on the
  // environment: where the Peach payout capability is unconfigured the
  // capability check answers first (PAYOUT_NOT_CONFIGURED, as here); where it
  // is configured, assertLiveTransactionSupported redirects to the withdrawal
  // flow (USE_WITHDRAWAL_FLOW). What must hold either way is that the wallet is
  // untouched — createTransaction only does the debit, and a withdrawal needs
  // the debit and the payout submission in one reversible lifecycle.
  const box = sandbox({ balance: 1000 });
  try {
    for (const serviceCode of ["withdraw", "bank_withdrawal", "payouts", "merchant_payout"]) {
      await assert.rejects(
        transactions.createTransaction(ACTOR, { serviceCode, amount: 50 }),
        (error) => error.statusCode >= 400
          && ["PAYOUT_NOT_CONFIGURED", "PAYOUT_DISABLED", "PAYOUT_NOT_VERIFIED", "USE_WITHDRAWAL_FLOW"]
            .includes(error.details?.code),
        `${serviceCode} must be refused before any debit`
      );
    }
    assert.equal(box.movements.length, 0, "no withdrawal may move money through this endpoint");
  } finally {
    box.restore();
  }
});

test("a QR payment needs a real QR code behind it", async () => {
  // Without this, "qr_payment" is just a cheaper fee anyone can name.
  const box = sandbox({ balance: 1000 });
  try {
    await assert.rejects(
      transactions.createTransaction(ACTOR, { serviceCode: "qr_payment", amount: 50, recipient: "payee@titopay.test" }),
      (error) => error.statusCode === 400 && /valid TitoPay QR code/i.test(error.message)
    );
    await assert.rejects(
      transactions.createTransaction(ACTOR, { serviceCode: "qr_payment", amount: 50, metadata: { qrId: "qr-1" } }),
      (error) => error.statusCode === 400 && /recipient is required/i.test(error.message)
    );
    assert.equal(box.movements.length, 0);
  } finally {
    box.restore();
  }
});

test("a transfer with no recipient is refused before pricing", async () => {
  const box = sandbox({ balance: 1000 });
  try {
    await assert.rejects(
      transactions.createTransaction(ACTOR, { serviceCode: "send_money", amount: 50 }),
      (error) => error.statusCode === 400 && /Recipient is required/i.test(error.message)
    );
    assert.equal(box.movements.length, 0);
  } finally {
    box.restore();
  }
});
