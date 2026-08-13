"use strict";

// TitoPay withdrawal / payout lifecycle on the Peach Payouts API.
//
//   PWA  -> POST /v1/payouts/withdrawals        validate, debit, submit to Peach
//   Peach-> POST /v1/webhooks/provider          status changed (a TRIGGER only)
//   PWA  -> GET  /v1/payouts/withdrawals/:ref   poll until a terminal state
//
// Money rules, in one place:
//
//   * The wallet is debited ONCE, inside the same database transaction that
//     creates the withdrawal row, before Peach is contacted. A double tap, a
//     retry and a refresh therefore cannot spend the same balance twice.
//   * The debit is reversed ONCE, and only when Peach itself reports the payout
//     failed, cancelled or reversed. A timeout, a 5xx or an unreadable answer
//     never reverses anything — the money stays out and the withdrawal stays in
//     flight until Peach gives a real answer.
//   * A withdrawal is COMPLETED only because Peach said `successful`. Peach
//     accepting the request is `processing`, never a completion.
//
// Nothing the browser sends can move money. The frontend supplies an amount and
// a bank account id; every other value is resolved server-side.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { calculateFee, normalizeServiceCode } = require("./pricing-service");
const walletService = require("./wallet-service");
const {
  createPayoutRequest,
  queryPayoutRequest,
  findPayoutInResponse,
  normalizePayoutStatus,
  payoutAvailability,
  assertPayoutAvailable,
  PAYOUT_TERMINAL_STATUSES,
  MIN_PAYOUT_CENTS,
  MAX_PAYOUT_CENTS
} = require("./peach-payout-service");
const { listBankAccountRecord } = require("./payout-account-service");

const PROVIDER = "peach_payouts";

// Personal withdrawals and business payouts share this lifecycle. They differ
// only in the service code, which decides the fee and how Activity labels it.
const PERSONAL_WITHDRAWAL_SERVICES = new Set([
  "withdraw", "withdraw_money_to_bank", "bank_transfer", "bank_withdrawal"
]);
const BUSINESS_PAYOUT_SERVICES = new Set([
  "payouts", "business_payout", "merchant_payout", "merchant_payouts", "seller_payout"
]);
const WITHDRAWAL_SERVICES = new Set([...PERSONAL_WITHDRAWAL_SERVICES, ...BUSINESS_PAYOUT_SERVICES]);

const DEFAULT_SERVICE_CODE = "withdraw";
const TERMINAL_TRANSACTION_STATUSES = new Set(["completed", "failed", "cancelled", "reversed"]);

function isWithdrawalService(serviceCode) {
  return WITHDRAWAL_SERVICES.has(normalizeServiceCode(serviceCode));
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function withdrawalReference() {
  return `TP-WD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function metadataOf(row = {}) {
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {});
  return metadata || {};
}

// Peach's vocabulary -> TitoPay's transaction status.
// `pending` and `processing` are explicitly NOT outcomes: a withdrawal that
// Peach has not decided yet must never be shown to a customer as failed.
function transactionStatusForPayout(payoutStatus) {
  switch (normalizePayoutStatus(payoutStatus)) {
    case "successful": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    // Peach reversed a payout it had already made. The money is coming back, so
    // it is a failed withdrawal from the customer's point of view and the debit
    // is released the same way.
    case "reversed": return "failed";
    case "pending":
    case "processing": return "processing";
    default: return "processing";
  }
}

// Nothing here is safe to widen: bank details never leave the server beyond the
// masked tail the customer needs to recognise their own account.
function maskAccountNumber(value) {
  const text = String(value || "").trim();
  if (text.length <= 4) return text ? `••••${text}` : "";
  return `••••${text.slice(-4)}`;
}

function withdrawalResponse(row, extra = {}) {
  const metadata = metadataOf(row);
  return {
    transactionId: row.id,
    reference: row.reference,
    amount: Number(row.amount),
    fee: Number(row.fee || 0),
    total: Number(row.total ?? row.amount),
    currency: metadata.currency || "ZAR",
    status: row.status,
    serviceCode: row.service_code,
    providerState: metadata.providerState || null,
    providerStatus: metadata.payoutStatus || null,
    resultCode: metadata.resultCode || null,
    failureReason: metadata.failureReason || null,
    bankAccount: metadata.bankAccount
      ? {
          bankName: metadata.bankAccount.bankName,
          accountNumber: metadata.bankAccount.accountNumberMasked,
          accountHolder: metadata.bankAccount.accountHolder
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra
  };
}

/* ------------------------------------------------------------------ create */

async function createWithdrawal(actor, payload = {}) {
  if (actor.profileLocked) throw new AppError(423, "Profile is locked. Withdrawals are disabled.");

  const serviceCode = normalizeServiceCode(payload.serviceCode || payload.service || DEFAULT_SERVICE_CODE);
  if (!WITHDRAWAL_SERVICES.has(serviceCode)) {
    throw new AppError(400, "This service is not a withdrawal or payout", { code: "NOT_A_WITHDRAWAL_SERVICE" });
  }

  const amount = roundMoney(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "Amount must be greater than zero");

  const idempotencyKey = String(payload.idempotencyKey || payload.metadata?.clientIdempotencyKey || "").trim().slice(0, 120);
  if (!idempotencyKey) throw new AppError(400, "An idempotency key is required");

  // The actor's own tier withdrawal limits come first: whatever the provider
  // state, the customer's eligibility is theirs to hear about, with the
  // upgrade path named in the refusal.
  await require("./compliance-service").assertCanWithdraw(actor.userId, amount);

  // Provider link next, so an unavailable payout capability is reported as
  // itself and no wallet is ever touched for a payout that cannot be sent.
  assertPayoutAvailable(await payoutAvailability());

  // Peach's own documented limits, checked before anything is written so the
  // customer is told the real reason rather than seeing a provider rejection.
  const amountCents = Math.round(amount * 100);
  if (amountCents < MIN_PAYOUT_CENTS) {
    throw new AppError(400, `The smallest withdrawal is R${(MIN_PAYOUT_CENTS / 100).toFixed(2)}`, { code: "AMOUNT_BELOW_MINIMUM" });
  }
  if (amountCents > MAX_PAYOUT_CENTS) {
    throw new AppError(400, `The largest withdrawal is R${(MAX_PAYOUT_CENTS / 100).toFixed(2)}`, { code: "AMOUNT_ABOVE_MAXIMUM" });
  }

  // Fast path only — see the locked re-check inside the transaction below. This
  // unlocked read catches a submit repeated seconds later; it cannot catch two
  // deliveries of the same request in flight together.
  const replay = await pool.query(
    `SELECT * FROM transactions
      WHERE user_id = $1 AND service_code = $2
        AND metadata->>'clientIdempotencyKey' = $3
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [actor.userId, serviceCode, idempotencyKey]
  );
  if (replay.rows[0]) return withdrawalResponse(replay.rows[0], { idempotentReplay: true });

  const account = await listBankAccountRecord(actor.userId, payload.bankAccountId);
  if (!account) throw new AppError(404, "Choose a saved bank account to withdraw to", { code: "BANK_ACCOUNT_NOT_FOUND" });

  const pricing = await calculateFee(serviceCode, amount);
  const fee = roundMoney(pricing.fee || 0);
  const total = roundMoney(amount + fee);

  const payoutId = uuidv4();
  const reference = withdrawalReference();
  const transactionId = uuidv4();

  // ---- one database transaction: check balance, record, debit ----
  const client = await pool.connect();
  let row;
  try {
    await client.query("BEGIN");

    // THE idempotency guard, taken before the wallet lock so every withdrawal
    // acquires the two in the same order and they cannot deadlock against each
    // other. The unlocked check above is a fast path: two deliveries of one
    // request in flight together both miss it. That matters more here than
    // anywhere else, because the PWA re-sends a withdrawal by itself after the
    // 45-second provider timeout (app.js:6455) — so the duplicate is not a
    // customer double-tapping, it is the app doing what it was designed to do.
    // The loser of the race now returns the original withdrawal rather than
    // submitting a second payout to Peach.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wd:${actor.userId}:${idempotencyKey}`]);
    const { rows: raced } = await client.query(
      `SELECT * FROM transactions
        WHERE user_id = $1 AND service_code = $2
          AND metadata->>'clientIdempotencyKey' = $3
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC LIMIT 1`,
      [actor.userId, serviceCode, idempotencyKey]
    );
    if (raced[0]) {
      // ROLLBACK, not COMMIT: this transaction has written nothing, only taken
      // a lock, and an advisory lock scoped to the transaction is released
      // either way. Ending it this way also leaves exactly one COMMIT in this
      // function — the real one, after the debit — so the structural guard in
      // peach-withdrawal.test.js keeps measuring what it was written to measure.
      await client.query("ROLLBACK");
      return withdrawalResponse(raced[0], { idempotentReplay: true });
    }

    // Lock the wallet so two concurrent withdrawals cannot both pass the
    // balance check. This is what makes a double tap safe.
    const wallets = await client.query(
      "SELECT * FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
      [actor.userId]
    );
    const wallet = wallets.rows[0];
    if (!wallet) throw new AppError(404, "Wallet not found");
    if (String(wallet.status || "").toLowerCase() === "locked") {
      throw new AppError(423, "Wallet is locked. Unlock it before withdrawing.");
    }

    const available = Number(wallet.available_balance || 0);
    if (available + 0.005 < total) {
      throw new AppError(
        409,
        `Not enough available balance. This withdrawal needs R${total.toFixed(2)} including the R${fee.toFixed(2)} fee, and R${available.toFixed(2)} is available. No wallet debit was made.`,
        { code: "INSUFFICIENT_BALANCE" }
      );
    }

    const inserted = await client.query(
      `INSERT INTO transactions
        (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','debit',$8,$9,$10::jsonb)
       RETURNING *`,
      [
        transactionId, actor.userId, wallet.id, serviceCode, amount, fee, total, reference,
        maskAccountNumber(account.account_number),
        JSON.stringify({
          provider: PROVIDER,
          integration: "payouts_api",
          currency: "ZAR",
          clientIdempotencyKey: idempotencyKey,
          payoutId,
          providerState: "created",
          note: String(payload.note || payload.reference || "").slice(0, 200) || undefined,
          // Enough to identify the account in Activity, never the full number.
          bankAccount: {
            id: account.id,
            bankName: account.bank_name,
            accountHolder: account.account_holder,
            accountNumberMasked: maskAccountNumber(account.account_number),
            branchCode: account.branch_code
          }
        })
      ]
    );
    row = inserted.rows[0];

    // THE debit. One per withdrawal, before Peach is contacted.
    await walletService.applyWalletMovement(client, {
      walletId: wallet.id,
      transactionId,
      entryType: "debit",
      amount: total,
      reference,
      metadata: { provider: PROVIDER, serviceCode, payoutId, stage: "withdrawal_submitted" }
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // ---- submit to Peach, outside the database transaction ----
  return submitWithdrawalToPeach(row, account, payoutId);
}

// Sending is separated from recording so a slow provider never holds a wallet
// lock, and so a submission can be retried later without re-debiting.
async function submitWithdrawalToPeach(row, account, payoutId) {
  const metadata = metadataOf(row);
  let response;
  try {
    response = await createPayoutRequest({
      payoutId,
      currency: "ZAR",
      // Rands in. peach-payout-service converts to the cents Peach documents.
      amount: Number(row.amount),
      accountNumber: account.account_number,
      branchCode: account.branch_code,
      bankName: account.bank_name,
      accountHolder: account.account_holder,
      reference: metadata.note || "TitoPay withdrawal",
      merchantReference: row.reference,
      payoutMethod: "realtime-eft"
    });
  } catch (error) {
    return handleSubmissionFailure(row, error);
  }

  const payoutRequestId = String(response?.payoutRequestId || "").trim();
  const entry = findPayoutInResponse(response, payoutId) || {};
  const payoutStatus = normalizePayoutStatus(entry.status) || "pending";

  const { rows } = await pool.query(
    `UPDATE transactions
        SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [
      row.id,
      transactionStatusForPayout(payoutStatus),
      JSON.stringify({
        providerState: "submitted",
        payoutRequestId: payoutRequestId || null,
        payoutStatus,
        resultCode: entry.resultCode || null,
        submittedAt: new Date().toISOString()
      })
    ]
  );

  console.info("[peach-payout] withdrawal submitted", {
    transactionId: row.id, reference: row.reference, payoutRequestId, payoutStatus
  });

  return withdrawalResponse(rows[0], { idempotentReplay: false });
}

// A submission that failed splits into two very different cases.
//
//   Definitely rejected  — Peach validated the request and said no. No payout
//                          exists, so the debit is released immediately.
//   Uncertain            — timeout, network error, 5xx. Peach may or may not
//                          have created the payout. Releasing here could pay
//                          the customer twice, so the money stays out and the
//                          withdrawal is flagged for an operator.
function submissionIsDefiniteRejection(error) {
  const status = Number(error?.details?.providerStatus);
  if (error?.details?.code === "PAYOUT_DETAILS_INCOMPLETE") return true;
  // 408/429 are retryable, so they are not a definite "no".
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function handleSubmissionFailure(row, error) {
  const definite = submissionIsDefiniteRejection(error);
  console.error("[peach-payout] withdrawal submission failed", {
    transactionId: row.id,
    reference: row.reference,
    definiteRejection: definite,
    code: error?.details?.code || "UNKNOWN",
    providerStatus: error?.details?.providerStatus ?? null
  });

  if (!definite) {
    const { rows } = await pool.query(
      `UPDATE transactions
          SET status = 'processing', metadata = metadata || $2::jsonb, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [row.id, JSON.stringify({
        providerState: "submission_uncertain",
        requiresReview: true,
        failureReason: error?.details?.code || "PROVIDER_UNAVAILABLE",
        submissionAttemptedAt: new Date().toISOString()
      })]
    );
    // Deliberately a 502 so the customer is told the truth: it is in flight.
    throw new AppError(
      502,
      "TitoPay could not confirm this withdrawal with the payout provider. The amount is held against this withdrawal and it will finish or be returned automatically. Do not try again. Check Activity for the outcome.",
      { code: "PAYOUT_SUBMISSION_UNCERTAIN", reference: rows[0]?.reference || row.reference }
    );
  }

  await releaseWithdrawalFunds(row.id, {
    providerState: "rejected",
    payoutStatus: "failed",
    failureReason: error?.details?.code || "PAYOUT_REJECTED"
  }, "failed");

  throw new AppError(
    502,
    "The payout provider rejected this withdrawal, so nothing was sent and the amount has been returned to your wallet.",
    { code: "PAYOUT_REJECTED" }
  );
}

/* ----------------------------------------------------------------- settle */

// The one and only place a withdrawal's debit is given back.
//
// Concurrency: the transaction row is locked FOR UPDATE, so a status poll, a
// webhook trigger and a retry racing each other serialise here. The first one
// to win the lock releases; the rest see a terminal status and no-op. The
// ledger is checked as well, so even a rewound status cannot pay twice.
async function releaseWithdrawalFunds(transactionId, patch = {}, nextStatus = "failed") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId]);
    const row = locked.rows[0];
    if (!row) throw new AppError(404, "Withdrawal not found");

    if (TERMINAL_TRANSACTION_STATUSES.has(row.status)) {
      await client.query("COMMIT");
      return { row, released: false, alreadySettled: true };
    }

    const existingRelease = await client.query(
      `SELECT id FROM wallet_ledger
        WHERE transaction_id = $1 AND entry_type = 'credit' AND metadata->>'stage' = 'withdrawal_reversed' LIMIT 1`,
      [transactionId]
    );

    let released = false;
    if (!existingRelease.rows[0]) {
      // Give back exactly what was taken — read from the ledger, not from the
      // caller, so a reversal can never create or destroy money.
      const debits = await client.query(
        `SELECT amount FROM wallet_ledger
          WHERE transaction_id = $1 AND entry_type = 'debit' AND metadata->>'stage' = 'withdrawal_submitted'`,
        [transactionId]
      );
      const debited = debits.rows.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
      if (debited > 0) {
        await walletService.applyWalletMovement(client, {
          walletId: row.wallet_id,
          transactionId,
          entryType: "credit",
          amount: debited,
          reference: row.reference,
          metadata: { provider: PROVIDER, serviceCode: row.service_code, stage: "withdrawal_reversed" }
        });
        released = true;
      }
    }

    const { rows } = await client.query(
      `UPDATE transactions SET status = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [transactionId, nextStatus, JSON.stringify({ ...patch, releasedAt: new Date().toISOString() })]
    );
    await client.query("COMMIT");
    return { row: rows[0], released, alreadySettled: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Apply what Peach reported. Success keeps the debit; failure returns it.
async function applyPayoutOutcome(transactionId, verified) {
  const nextStatus = transactionStatusForPayout(verified.payoutStatus);

  if (nextStatus === "completed") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT * FROM transactions WHERE id = $1 FOR UPDATE", [transactionId]);
      const row = locked.rows[0];
      if (!row) throw new AppError(404, "Withdrawal not found");
      if (TERMINAL_TRANSACTION_STATUSES.has(row.status)) {
        await client.query("COMMIT");
        return { row, alreadySettled: true };
      }
      // Nothing moves on success: the debit already happened at submission.
      const { rows } = await client.query(
        `UPDATE transactions SET status='completed', metadata = metadata || $2::jsonb, updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [transactionId, JSON.stringify({
          providerState: "successful",
          payoutStatus: verified.payoutStatus,
          resultCode: verified.resultCode || null,
          settledAt: new Date().toISOString()
        })]
      );
      await client.query("COMMIT");
      return { row: rows[0], alreadySettled: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  if (nextStatus === "failed" || nextStatus === "cancelled") {
    const result = await releaseWithdrawalFunds(transactionId, {
      providerState: verified.payoutStatus,
      payoutStatus: verified.payoutStatus,
      resultCode: verified.resultCode || null,
      failureReason: verified.failureReason || verified.resultCode || "PAYOUT_FAILED"
    }, nextStatus);
    return { row: result.row, alreadySettled: result.alreadySettled, released: result.released };
  }

  // Still in flight. Record what Peach said and leave the money where it is.
  const { rows } = await pool.query(
    `UPDATE transactions SET status='processing', metadata = metadata || $2::jsonb, updated_at=NOW()
      WHERE id=$1 AND status NOT IN ('completed','failed','cancelled','reversed') RETURNING *`,
    [transactionId, JSON.stringify({
      providerState: verified.payoutStatus,
      payoutStatus: verified.payoutStatus,
      resultCode: verified.resultCode || null,
      providerUpdatedAt: new Date().toISOString()
    })]
  );
  if (rows[0]) return { row: rows[0], alreadySettled: false };
  const current = await pool.query("SELECT * FROM transactions WHERE id=$1", [transactionId]);
  return { row: current.rows[0], alreadySettled: true };
}

/* ------------------------------------------------------------ verification */

// Ask Peach directly what happened. This is the only trusted source: a webhook
// body, a browser poll or anything the client claims is never sufficient.
async function verifyWithPeach(row) {
  const metadata = metadataOf(row);
  const payoutRequestId = String(metadata.payoutRequestId || "").trim();
  if (!payoutRequestId) {
    // The submission never returned an id, so there is nothing to query. The
    // withdrawal stays in flight for an operator rather than being guessed at.
    return null;
  }
  const payload = await queryPayoutRequest(payoutRequestId);
  const entry = findPayoutInResponse(payload, metadata.payoutId);
  if (!entry) return null;
  return {
    payoutStatus: normalizePayoutStatus(entry.status) || "processing",
    resultCode: entry.resultCode || null,
    // Peach's error object carries a title/message; keep the code only, so no
    // provider prose reaches the customer.
    failureReason: entry.error?.code || entry.error?.title || null
  };
}

async function findWithdrawalForActor(actor, referenceOrId) {
  const key = String(referenceOrId || "").trim();
  if (!key) throw new AppError(400, "A withdrawal reference is required");
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const { rows } = await pool.query(
    `SELECT * FROM transactions
      WHERE user_id = $1 AND service_code = ANY($2::text[])
        AND (reference = $3 ${isUuid ? "OR id = $3::uuid" : ""})
      ORDER BY created_at DESC LIMIT 1`,
    [actor.userId, [...WITHDRAWAL_SERVICES], key]
  );
  if (!rows[0]) throw new AppError(404, "Withdrawal not found");
  return rows[0];
}

async function getWithdrawalStatus(actor, referenceOrId) {
  const row = await findWithdrawalForActor(actor, referenceOrId);
  if (TERMINAL_TRANSACTION_STATUSES.has(row.status)) return withdrawalResponse(row, { verified: true });

  try {
    const verified = await verifyWithPeach(row);
    if (!verified) return withdrawalResponse(row, { verified: false, verificationError: "AWAITING_PROVIDER_REFERENCE" });
    const result = await applyPayoutOutcome(row.id, verified);
    return withdrawalResponse(result.row, { verified: true });
  } catch (error) {
    // A provider hiccup while polling must never present as a failed payout.
    console.error("[peach-payout] status verification failed", {
      transactionId: row.id, code: error?.details?.code || "UNKNOWN"
    });
    return withdrawalResponse(row, { verified: false, verificationError: error?.details?.code || "VERIFICATION_UNAVAILABLE" });
  }
}

async function listRecentWithdrawals(actor, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM transactions
      WHERE user_id=$1 AND service_code = ANY($2::text[])
      ORDER BY created_at DESC LIMIT $3`,
    [actor.userId, [...WITHDRAWAL_SERVICES], Math.min(Math.max(Number(limit) || 10, 1), 50)]
  );
  return rows.map((row) => withdrawalResponse(row));
}

/* --------------------------------------------------------------- webhook */

// Peach's payout webhook carries {status, payoutId, lastUpdated, resultCode}
// and the published reference documents no signature for it. It is therefore
// treated purely as a TRIGGER: it tells TitoPay which payout changed, and
// TitoPay then asks Peach directly what the status actually is. An attacker who
// forges one can at most cause a redundant status query.
async function settleWithdrawalFromWebhook(payload = {}) {
  const payoutId = String(payload.payoutId || "").trim().toLowerCase();
  if (!payoutId) return { handled: false, reason: "NO_PAYOUT_ID" };

  const { rows } = await pool.query(
    `SELECT * FROM transactions
      WHERE metadata->>'payoutId' = $1 AND service_code = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [payoutId, [...WITHDRAWAL_SERVICES]]
  );
  const row = rows[0];
  if (!row) return { handled: false, reason: "UNKNOWN_PAYOUT" };
  if (TERMINAL_TRANSACTION_STATUSES.has(row.status)) return { handled: true, alreadySettled: true };

  const verified = await verifyWithPeach(row);
  if (!verified) return { handled: true, verified: false };
  const result = await applyPayoutOutcome(row.id, verified);
  return {
    handled: true,
    verified: true,
    status: result.row?.status,
    released: Boolean(result.released),
    alreadySettled: Boolean(result.alreadySettled)
  };
}

module.exports = {
  BUSINESS_PAYOUT_SERVICES,
  PERSONAL_WITHDRAWAL_SERVICES,
  WITHDRAWAL_SERVICES,
  applyPayoutOutcome,
  createWithdrawal,
  getWithdrawalStatus,
  isWithdrawalService,
  listRecentWithdrawals,
  maskAccountNumber,
  releaseWithdrawalFunds,
  settleWithdrawalFromWebhook,
  submissionIsDefiniteRejection,
  transactionStatusForPayout,
  verifyWithPeach
};
