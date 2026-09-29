"use strict";

// SETTLEMENT, RECONCILIATION AND MERCHANT PAYOUT.
//
// POS payments credit the merchant's operating wallet gross, in real time,
// inside the same database transaction as the customer debit - that is the
// ledger-first design this engine inherits, not something it changes. What
// was missing is the STATEMENT OF RECORD: a per-merchant, per-window batch
// that says exactly which payments, refunds and reversals a trading period
// contained, proves the ledger agrees with the payment stream before a rand
// is described as settled, and then executes the payout leg.
//
// Three principles, all borrowed from the code around this file:
//
//   LEDGER-FIRST   batch items are derived from `transactions` rows and
//                  verified against `wallet_ledger` double-entry legs and the
//                  pos_payment_intents stream. Totals are SUM() over items,
//                  never a running counter (the stokvel display-cap bug is
//                  the standing warning here).
//
//   IDEMPOTENT     a settlement window is UNIQUE (merchant, start, end) and
//                  windows tile: each starts where the last ended. Closing
//                  is serialized per merchant by an advisory xact lock, the
//                  payout leg is guarded by the batch state machine under
//                  FOR UPDATE, and every wallet movement lives inside one
//                  database transaction, protected by the ledger's unique
//                  posting index like every other rand.
//
//   EVENTED        every transition writes settlement_events in the same
//                  transaction (mirroring pos_payment_events), and a paid
//                  batch fans out `settlement.completed` through the existing
//                  webhook_deliveries machinery - same envelope shape, same
//                  signing, same retries; the event type has been reserved in
//                  EVENT_TYPES since the webhook engine shipped.
//
// The payout leg reflects the real-time credit truthfully. If the merchant
// has configured a distinct settlement wallet, the window's net is swept
// into it. If not, the money is ALREADY in the operating wallet and the
// batch records payout_mode 'realtime_wallet' with no movement - a payout
// that pretended to move money it already moved would be theatre. An
// optional settlement fee (pricing rule `pos_settlement`, default FREE so
// nothing changes until an operator prices it) is debited from the merchant
// and credited to the revenue wallet with a revenue_ledger row, exactly like
// every other fee on the platform.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { applyWalletMovement, getRevenueWallet } = require("./wallet-service");
const { calculateFee, ensureDefaultPricingRule } = require("./pricing-service");
const { API_BUILD } = require("../build-info");

const POS_PAYMENT_CODE = "pos_qr";
const POS_REFUND_CODE = "pos_qr_refund";
const POS_REVERSAL_CODE = "pos_qr_reversal";
const FEE_SERVICE_CODE = "pos_settlement";
const SETTLEMENT_EVENT_TYPE = "settlement.completed";
const SWEEP_LOCK = "titopay_settlement_sweep";
const HEARTBEAT_KEY = "settlement_worker_heartbeat";
const SCHEDULES = ["manual", "daily", "weekly", "monthly"];

let workerTimer = null;
let workerStopping = false;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

function rands(centsValue) {
  return centsValue / 100;
}

/* ----------------------------------------------------------------- schema */

// Idempotent and NEVER fatal at the call sites: schema.sql is canonical, this
// covers deployments that have not re-applied it (the account-closure /
// webhook pattern).
async function ensureSettlementSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settlement_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      settlement_reference TEXT NOT NULL UNIQUE,
      merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'ZAR' CHECK (currency = 'ZAR'),
      gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      reversal_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      fee_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      net_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      payment_count INTEGER NOT NULL DEFAULT 0,
      refund_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'reconciling' CHECK (
        status IN ('reconciling', 'reconciled', 'discrepancy', 'paid', 'failed')
      ),
      payout_mode TEXT CHECK (payout_mode IN ('realtime_wallet', 'settlement_wallet')),
      payout_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
      discrepancy JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      reconciled_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (period_end > period_start),
      UNIQUE (merchant_id, period_start, period_end)
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_batches_merchant ON settlement_batches (merchant_id, period_end DESC);
    CREATE INDEX IF NOT EXISTS idx_settlement_batches_status ON settlement_batches (status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS settlement_batch_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL REFERENCES settlement_batches(id) ON DELETE CASCADE,
      transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
      payment_intent_id UUID REFERENCES pos_payment_intents(id) ON DELETE SET NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('payment', 'refund', 'reversal')),
      amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
      occurred_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (batch_id, transaction_id, item_type)
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_items_batch ON settlement_batch_items (batch_id, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_items_transaction ON settlement_batch_items (transaction_id);
    CREATE TABLE IF NOT EXISTS settlement_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id UUID NOT NULL REFERENCES settlement_batches(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id UUID,
      request_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_events_batch ON settlement_events (batch_id, created_at);
  `);
}

/* ---------------------------------------------------------------- helpers */

async function addBatchEvent(client, batchId, eventType, previousStatus, newStatus, { actorType = "system", actorId = null, requestId = null, metadata = {} } = {}) {
  // clock_timestamp(), not NOW(): NOW() is frozen for the whole transaction,
  // and two events written in one transaction would tie on created_at and
  // read back in arbitrary order.
  await client.query(
    `INSERT INTO settlement_events (batch_id, event_type, previous_status, new_status, actor_type, actor_id, request_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::JSONB, clock_timestamp())`,
    [batchId, eventType, previousStatus, newStatus, actorType, actorId, requestId, JSON.stringify(metadata)]
  );
}

// The operating wallet exactly as the POS engine resolves it at payment
// time - one source of truth, quoted, not paraphrased.
async function resolveOperatingWallet(client, merchantUuid) {
  const { rows } = await client.query(
    `SELECT w.*
       FROM merchants m
       LEFT JOIN merchant_wallets mw ON mw.merchant_id = m.id AND mw.status = 'active'
       JOIN wallets w ON w.id = COALESCE(mw.wallet_id, (
         SELECT id FROM wallets WHERE user_id = m.user_id AND kind IN ('merchant','business') ORDER BY created_at ASC LIMIT 1
       ))
      WHERE m.id = $1
      LIMIT 1`,
    [merchantUuid]
  );
  return rows[0] || null;
}

async function resolveSettlementWallet(client, merchantUuid) {
  const { rows } = await client.query(
    `SELECT w.* FROM merchant_wallets mw
       JOIN wallets w ON w.id = mw.settlement_wallet_id
      WHERE mw.merchant_id = $1 AND mw.status = 'active' AND w.status = 'active'
      LIMIT 1`,
    [merchantUuid]
  );
  return rows[0] || null;
}

function settlementReference() {
  return `SET-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function publicBatch(row, items) {
  const batch = {
    id: row.id,
    settlementReference: row.settlement_reference,
    merchantId: row.merchant_code || undefined,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: row.currency,
    grossAmount: Number(row.gross_amount),
    refundAmount: Number(row.refund_amount),
    reversalAmount: Number(row.reversal_amount),
    feeAmount: Number(row.fee_amount),
    netAmount: Number(row.net_amount),
    paymentCount: row.payment_count,
    refundCount: row.refund_count,
    status: row.status,
    payoutMode: row.payout_mode,
    discrepancy: row.discrepancy || null,
    reconciledAt: row.reconciled_at,
    paidAt: row.paid_at,
    createdAt: row.created_at
  };
  if (items) {
    batch.items = items.map((item) => ({
      transactionId: item.transaction_id,
      paymentId: item.payment_public_id || null,
      type: item.item_type,
      amount: Number(item.amount),
      occurredAt: item.occurred_at
    }));
  }
  return batch;
}

/* ---------------------------------------------------------- reconciliation */

// Three independent checks, all answered by the database:
//  1. DOUBLE ENTRY - every item's transaction posted equal-and-opposite
//     ledger legs of exactly the item amount, with the merchant-side leg on
//     a wallet the merchant's owner actually holds.
//  2. STREAM vs LEDGER - every pos_payment_intent COMPLETED in the window
//     produced a transaction the batch contains, and every batch item traces
//     back to the POS channel. A payment the stream knows and the ledger
//     does not (or the reverse) is exactly what reconciliation exists to
//     catch.
//  3. ARITHMETIC - the batch header equals SUM() over its own items,
//     recomputed in SQL.
async function reconcileChecks(client, batch, merchant) {
  const discrepancies = [];

  const { rows: items } = await client.query(
    "SELECT * FROM settlement_batch_items WHERE batch_id = $1",
    [batch.id]
  );
  const transactionIds = items.map((item) => item.transaction_id);

  if (transactionIds.length) {
    // 1. Double-entry legs per transaction, with owner attribution.
    const { rows: legs } = await client.query(
      `SELECT wl.transaction_id,
              wl.entry_type,
              SUM(wl.amount)::NUMERIC AS total,
              BOOL_OR(w.user_id = $2) AS touches_merchant_owner
         FROM wallet_ledger wl
         JOIN wallets w ON w.id = wl.wallet_id
        WHERE wl.transaction_id = ANY($1)
        GROUP BY wl.transaction_id, wl.entry_type`,
      [transactionIds, merchant.user_id]
    );
    const byTransaction = new Map();
    for (const leg of legs) {
      if (!byTransaction.has(leg.transaction_id)) byTransaction.set(leg.transaction_id, {});
      byTransaction.get(leg.transaction_id)[leg.entry_type] = leg;
    }
    for (const item of items) {
      const pair = byTransaction.get(item.transaction_id) || {};
      const credit = pair.credit ? cents(pair.credit.total) : 0;
      const debit = pair.debit ? cents(pair.debit.total) : 0;
      const expected = cents(item.amount);
      if (credit !== expected || debit !== expected) {
        discrepancies.push({
          check: "double_entry",
          transactionId: item.transaction_id,
          expected: rands(expected),
          creditLegs: rands(credit),
          debitLegs: rands(debit)
        });
        continue;
      }
      const merchantLeg = item.item_type === "payment" ? pair.credit : pair.debit;
      if (!merchantLeg?.touches_merchant_owner) {
        discrepancies.push({
          check: "merchant_leg",
          transactionId: item.transaction_id,
          detail: `the ${item.item_type === "payment" ? "credit" : "debit"} leg does not touch a wallet owned by this merchant`
        });
      }
    }
  }

  // 2a. Stream → ledger: intents completed in the window must be items.
  const { rows: missing } = await client.query(
    `SELECT p.payment_id, p.transaction_id
       FROM pos_payment_intents p
      WHERE p.merchant_id = $1
        AND p.completed_at >= $2 AND p.completed_at < $3
        AND p.transaction_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM settlement_batch_items i
           WHERE i.batch_id = $4 AND i.transaction_id = p.transaction_id AND i.item_type = 'payment'
        )`,
    [batch.merchant_id, batch.period_start, batch.period_end, batch.id]
  );
  for (const row of missing) {
    discrepancies.push({ check: "stream_vs_ledger", paymentId: row.payment_id, detail: "completed POS payment missing from the batch" });
  }

  // 2b. Ledger → stream: every payment item must trace to a POS intent.
  const { rows: orphans } = await client.query(
    `SELECT i.transaction_id
       FROM settlement_batch_items i
      WHERE i.batch_id = $1 AND i.item_type = 'payment'
        AND NOT EXISTS (SELECT 1 FROM pos_payment_intents p WHERE p.transaction_id = i.transaction_id)`,
    [batch.id]
  );
  for (const row of orphans) {
    discrepancies.push({ check: "ledger_vs_stream", transactionId: row.transaction_id, detail: "batch payment has no POS payment intent behind it" });
  }

  // 3. Header arithmetic, recomputed from the items in SQL.
  const { rows: sums } = await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE item_type = 'payment'), 0)::NUMERIC AS gross,
       COALESCE(SUM(amount) FILTER (WHERE item_type = 'refund'), 0)::NUMERIC AS refunds,
       COALESCE(SUM(amount) FILTER (WHERE item_type = 'reversal'), 0)::NUMERIC AS reversals
     FROM settlement_batch_items WHERE batch_id = $1`,
    [batch.id]
  );
  const sum = sums[0];
  if (cents(sum.gross) !== cents(batch.gross_amount)
    || cents(sum.refunds) !== cents(batch.refund_amount)
    || cents(sum.reversals) !== cents(batch.reversal_amount)) {
    discrepancies.push({
      check: "arithmetic",
      header: { gross: Number(batch.gross_amount), refunds: Number(batch.refund_amount), reversals: Number(batch.reversal_amount) },
      items: { gross: Number(sum.gross), refunds: Number(sum.refunds), reversals: Number(sum.reversals) }
    });
  }

  return discrepancies;
}

/* ------------------------------------------------------------- close window */

// Close the merchant's next settlement window: derive the items from the
// transactions the POS engine wrote, reconcile, and leave the batch
// 'reconciled' or 'discrepancy'. Windows tile - each starts exactly where
// the previous ended - and an empty window creates nothing, so a quiet
// weekend simply folds into the next active batch.
async function closeSettlement(merchantUuid, { upTo = null, actorType = "system", actorId = null, requestId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One closeout per merchant at a time; the xact lock releases itself on
    // COMMIT/ROLLBACK, so it cannot leak the way a session lock can.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`settlement:${merchantUuid}`]);

    const { rows: merchantRows } = await client.query("SELECT * FROM merchants WHERE id = $1 LIMIT 1", [merchantUuid]);
    const merchant = merchantRows[0];
    if (!merchant) throw new AppError(404, "Merchant not found");

    const { rows: bounds } = await client.query(
      `SELECT
         (SELECT MAX(period_end) FROM settlement_batches WHERE merchant_id = $1) AS last_end,
         (SELECT MIN(created_at) FROM transactions
           WHERE merchant_id = $1 AND service_code = ANY($2) AND status = 'completed') AS first_activity`,
      [merchantUuid, [POS_PAYMENT_CODE, POS_REFUND_CODE, POS_REVERSAL_CODE]]
    );
    const periodStart = bounds[0].last_end || bounds[0].first_activity;
    if (!periodStart) {
      await client.query("ROLLBACK");
      return { settled: false, reason: "This merchant has no POS activity to settle" };
    }
    const periodEnd = upTo ? new Date(upTo) : new Date();
    if (Number.isNaN(periodEnd.getTime())) throw new AppError(400, "upTo must be a valid timestamp");
    if (periodEnd.getTime() > Date.now() + 1000) throw new AppError(400, "A settlement window cannot end in the future");
    if (periodEnd <= new Date(periodStart)) {
      await client.query("ROLLBACK");
      return { settled: false, reason: "The window is already settled up to this point" };
    }

    const { rows: sourceRows } = await client.query(
      `SELECT t.id, t.service_code, t.amount, t.created_at, p.id AS payment_intent_id
         FROM transactions t
         LEFT JOIN pos_payment_intents p ON p.transaction_id = t.id
        WHERE t.merchant_id = $1
          AND t.service_code = ANY($2)
          AND t.status = 'completed'
          AND t.created_at >= $3 AND t.created_at < $4
        ORDER BY t.created_at`,
      [merchantUuid, [POS_PAYMENT_CODE, POS_REFUND_CODE, POS_REVERSAL_CODE], periodStart, periodEnd]
    );
    if (!sourceRows.length) {
      await client.query("ROLLBACK");
      return { settled: false, reason: "No POS activity in this window" };
    }

    let grossCents = 0, refundCents = 0, reversalCents = 0, paymentCount = 0, refundCount = 0;
    const items = sourceRows.map((row) => {
      const amountCents = cents(row.amount);
      let itemType = "payment";
      if (row.service_code === POS_REFUND_CODE) itemType = "refund";
      if (row.service_code === POS_REVERSAL_CODE) itemType = "reversal";
      if (itemType === "payment") { grossCents += amountCents; paymentCount += 1; }
      else if (itemType === "refund") { refundCents += amountCents; refundCount += 1; }
      else { reversalCents += amountCents; refundCount += 1; }
      return { transactionId: row.id, paymentIntentId: row.payment_intent_id, itemType, amount: rands(amountCents), occurredAt: row.created_at };
    });

    const batchId = uuidv4();
    const netCents = grossCents - refundCents - reversalCents;
    const { rows: batchRows } = await client.query(
      `INSERT INTO settlement_batches
         (id, settlement_reference, merchant_id, period_start, period_end,
          gross_amount, refund_amount, reversal_amount, fee_amount, net_amount,
          payment_count, refund_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,'reconciling')
       RETURNING *`,
      [batchId, settlementReference(), merchantUuid, new Date(periodStart), periodEnd,
        rands(grossCents), rands(refundCents), rands(reversalCents), rands(netCents),
        paymentCount, refundCount]
    );
    const batch = batchRows[0];
    for (const item of items) {
      await client.query(
        `INSERT INTO settlement_batch_items (batch_id, transaction_id, payment_intent_id, item_type, amount, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [batchId, item.transactionId, item.paymentIntentId, item.itemType, item.amount, item.occurredAt]
      );
    }
    await addBatchEvent(client, batchId, "batch_created", null, "reconciling", { actorType, actorId, requestId, metadata: { paymentCount, refundCount } });

    const discrepancies = await reconcileChecks(client, batch, merchant);
    if (discrepancies.length) {
      await client.query(
        `UPDATE settlement_batches SET status = 'discrepancy', discrepancy = $2::JSONB, updated_at = NOW() WHERE id = $1`,
        [batchId, JSON.stringify({ found: discrepancies.length, checks: discrepancies.slice(0, 50) })]
      );
      await addBatchEvent(client, batchId, "reconciliation_failed", "reconciling", "discrepancy", { actorType: "system", requestId, metadata: { found: discrepancies.length } });
    } else {
      await client.query(
        "UPDATE settlement_batches SET status = 'reconciled', reconciled_at = NOW(), updated_at = NOW() WHERE id = $1",
        [batchId]
      );
      await addBatchEvent(client, batchId, "reconciled", "reconciling", "reconciled", { actorType: "system", requestId });
    }
    await client.query("COMMIT");

    if (discrepancies.length) {
      // The alert is diagnostics, never the transaction's problem.
      try {
        await require("./money-integrity-service").raiseAlert({
          alertType: "settlement_discrepancy", severity: "high",
          fingerprint: `settlement_${batchId}`,
          details: { batchId, merchantId: merchantUuid, found: discrepancies.length, sample: discrepancies.slice(0, 5) }
        });
      } catch {}
      return { settled: true, batchId, status: "discrepancy", discrepancies: discrepancies.length };
    }

    const payout = await executePayout(batchId, { actorType, actorId, requestId });
    return { settled: true, batchId, status: payout.status, payoutMode: payout.payoutMode };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ----------------------------------------------------------------- payout */

// The payout leg for a reconciled batch. Everything - the fee to revenue,
// the sweep to the settlement wallet, the batch transition and the webhook
// delivery rows - commits or rolls back as one. Re-running against a paid
// batch replays; a payout that cannot move the money (the merchant spent
// operating funds before a sweep) marks the batch 'failed' with the reason
// and is retried from the admin console once funds are back.
async function executePayout(batchId, { actorType = "system", actorId = null, requestId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: batchRows } = await client.query(
      `SELECT b.*, m.merchant_id AS merchant_code, m.user_id AS merchant_user_id, m.business_name
         FROM settlement_batches b JOIN merchants m ON m.id = b.merchant_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [batchId]
    );
    const batch = batchRows[0];
    if (!batch) throw new AppError(404, "Settlement batch not found");
    if (batch.status === "paid") {
      await client.query("COMMIT");
      return { status: "paid", payoutMode: batch.payout_mode, alreadyPaid: true };
    }
    if (!["reconciled", "failed"].includes(batch.status)) {
      throw new AppError(409, `A ${batch.status} settlement cannot be paid out`);
    }

    const operatingWallet = await resolveOperatingWallet(client, batch.merchant_id);
    if (!operatingWallet || operatingWallet.status !== "active") {
      throw new AppError(503, "Merchant operating wallet is unavailable");
    }
    const settlementWallet = await resolveSettlementWallet(client, batch.merchant_id);
    const distinctSettlementWallet = settlementWallet && settlementWallet.id !== operatingWallet.id ? settlementWallet : null;

    const netCents = cents(batch.gross_amount) - cents(batch.refund_amount) - cents(batch.reversal_amount);
    // The fee prices the window's net POS volume. FREE by default: until an
    // operator prices `pos_settlement` in the console this is R0.00 and no
    // movement or revenue row exists.
    const feePreview = netCents > 0 ? await calculateFee(FEE_SERVICE_CODE, rands(netCents)) : { fee: 0 };
    const feeCents = cents(feePreview.fee || 0);
    const sweepCents = distinctSettlementWallet && netCents > 0 ? netCents - feeCents : 0;
    const payoutMode = distinctSettlementWallet && netCents > 0 ? "settlement_wallet" : "realtime_wallet";

    await addBatchEvent(client, batchId, "payout_started", batch.status, batch.status, { actorType, actorId, requestId, metadata: { payoutMode } });

    let payoutTransactionId = null;
    if (sweepCents > 0 || feeCents > 0) {
      await ensureDefaultPricingRule(FEE_SERVICE_CODE);
      payoutTransactionId = uuidv4();
      const reference = `SETP-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const movedCents = sweepCents > 0 ? sweepCents : 0;
      await client.query(
        `INSERT INTO transactions
           (id, user_id, wallet_id, merchant_id, service_code, amount, fee, total, status, direction, reference, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing','debit',$9,$10::JSONB)`,
        [payoutTransactionId, batch.merchant_user_id, operatingWallet.id, batch.merchant_id, FEE_SERVICE_CODE,
          rands(movedCents), rands(feeCents), rands(movedCents + feeCents), reference,
          JSON.stringify({ channel: "SETTLEMENT", settlementReference: batch.settlement_reference, batchId, payoutMode })]
      );
      if (movedCents + feeCents > 0) {
        await applyWalletMovement(client, {
          walletId: operatingWallet.id, transactionId: payoutTransactionId, entryType: "debit",
          amount: rands(movedCents + feeCents), reference,
          metadata: { channel: "SETTLEMENT", batchId, settlementReference: batch.settlement_reference }
        });
      }
      if (movedCents > 0) {
        await applyWalletMovement(client, {
          walletId: distinctSettlementWallet.id, transactionId: payoutTransactionId, entryType: "credit",
          amount: rands(movedCents), reference,
          metadata: { channel: "SETTLEMENT", batchId, settlementReference: batch.settlement_reference }
        });
      }
      if (feeCents > 0) {
        const revenueWallet = await getRevenueWallet();
        await applyWalletMovement(client, {
          walletId: revenueWallet.id, transactionId: payoutTransactionId, entryType: "credit",
          amount: rands(feeCents), reference: `${reference}-FEE`,
          metadata: { channel: "SETTLEMENT", batchId, source: "fee" }
        });
        await client.query(
          `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), payoutTransactionId, FEE_SERVICE_CODE, rands(feeCents), revenueWallet.id]
        );
      }
      await client.query("UPDATE transactions SET status = 'completed', updated_at = NOW() WHERE id = $1", [payoutTransactionId]);
    }

    await client.query(
      `UPDATE settlement_batches
          SET status = 'paid', payout_mode = $2, payout_transaction_id = $3,
              fee_amount = $4, net_amount = $5, paid_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [batchId, payoutMode, payoutTransactionId, rands(feeCents), rands(netCents - feeCents)]
    );
    await addBatchEvent(client, batchId, "paid", batch.status, "paid", { actorType, actorId, requestId, metadata: { payoutMode, feeAmount: rands(feeCents) } });

    // settlement.completed rides the existing webhook rails: one delivery row
    // per subscription that wants it, deterministic envelope id, and the
    // delivery worker signs and retries exactly as it does for payments. The
    // unique key makes a payout retry incapable of double-notifying.
    const envelope = {
      id: `evt_${sha256(`${batchId}:${SETTLEMENT_EVENT_TYPE}`).slice(0, 32)}`,
      type: SETTLEMENT_EVENT_TYPE,
      apiVersion: "v1",
      createdAt: new Date().toISOString(),
      data: {
        settlementReference: batch.settlement_reference,
        merchantId: batch.merchant_code,
        periodStart: batch.period_start,
        periodEnd: batch.period_end,
        currency: batch.currency,
        grossAmount: Number(batch.gross_amount),
        refundAmount: Number(batch.refund_amount),
        reversalAmount: Number(batch.reversal_amount),
        feeAmount: rands(feeCents),
        netAmount: rands(netCents - feeCents),
        paymentCount: batch.payment_count,
        refundCount: batch.refund_count,
        payoutMode,
        occurredAt: new Date().toISOString()
      }
    };
    const { rows: subscriptions } = await client.query(
      "SELECT id, events FROM webhook_subscriptions WHERE merchant_id = $1 AND status = 'active'",
      [batch.merchant_id]
    );
    for (const subscription of subscriptions) {
      if (subscription.events?.length && !subscription.events.includes(SETTLEMENT_EVENT_TYPE)) continue;
      await client.query(
        `INSERT INTO webhook_deliveries (subscription_id, event_id, event_type, request_payload)
         VALUES ($1,$2,$3,$4::JSONB)
         ON CONFLICT (subscription_id, event_id, event_type) DO NOTHING`,
        [subscription.id, batchId, SETTLEMENT_EVENT_TYPE, JSON.stringify(envelope)]
      );
    }
    await client.query("COMMIT");

    // Nudge delivery so a vendor watching the sandbox sees the event now;
    // the worker's next tick covers it regardless.
    require("./webhook-service").deliverDueOnce().catch(() => {});
    return { status: "paid", payoutMode, payoutTransactionId, feeAmount: rands(feeCents), netAmount: rands(netCents - feeCents) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Record the failure OUTSIDE the rolled-back transaction so the batch
    // says why it is not paid; the money itself is untouched.
    if (error instanceof AppError && [409, 503].includes(error.statusCode)) {
      try {
        const { rows } = await pool.query("SELECT status FROM settlement_batches WHERE id = $1", [batchId]);
        if (rows[0] && ["reconciled", "failed"].includes(rows[0].status)) {
          await pool.query(
            `UPDATE settlement_batches SET status = 'failed', metadata = metadata || $2::JSONB, updated_at = NOW() WHERE id = $1`,
            [batchId, JSON.stringify({ lastPayoutError: String(error.message).slice(0, 300), failedAt: new Date().toISOString() })]
          );
          await pool.query(
            `INSERT INTO settlement_events (batch_id, event_type, previous_status, new_status, actor_type, actor_id, request_id, metadata)
             VALUES ($1,'payout_failed',$2,'failed',$3,$4,$5,$6::JSONB)`,
            [batchId, rows[0].status, actorType, actorId, requestId, JSON.stringify({ error: String(error.message).slice(0, 300) })]
          );
        }
      } catch {}
    }
    throw error;
  } finally {
    client.release();
  }
}

// A discrepancy batch is re-reconciled against the CURRENT ledger after the
// underlying fault is fixed; clean checks release it to payout.
async function rerunReconciliation(batchId, { actorType = "admin", actorId = null, requestId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT b.*, m.user_id AS merchant_user_id FROM settlement_batches b
         JOIN merchants m ON m.id = b.merchant_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [batchId]
    );
    const batch = rows[0];
    if (!batch) throw new AppError(404, "Settlement batch not found");
    if (batch.status !== "discrepancy") throw new AppError(409, `Only a discrepancy batch can be re-reconciled (this one is ${batch.status})`);
    const discrepancies = await reconcileChecks(client, batch, { user_id: batch.merchant_user_id });
    if (discrepancies.length) {
      await client.query(
        "UPDATE settlement_batches SET discrepancy = $2::JSONB, updated_at = NOW() WHERE id = $1",
        [batchId, JSON.stringify({ found: discrepancies.length, checks: discrepancies.slice(0, 50) })]
      );
      await addBatchEvent(client, batchId, "reconciliation_failed", "discrepancy", "discrepancy", { actorType, actorId, requestId, metadata: { found: discrepancies.length } });
      await client.query("COMMIT");
      return { status: "discrepancy", discrepancies: discrepancies.length };
    }
    await client.query(
      "UPDATE settlement_batches SET status = 'reconciled', discrepancy = NULL, reconciled_at = NOW(), updated_at = NOW() WHERE id = $1",
      [batchId]
    );
    await addBatchEvent(client, batchId, "reconciled", "discrepancy", "reconciled", { actorType, actorId, requestId });
    await client.query("COMMIT");
    return { status: "reconciled" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------ configuration */

async function getSettlementConfig(merchant) {
  const client = await pool.connect();
  try {
    const operating = await resolveOperatingWallet(client, merchant.id);
    const { rows } = await client.query(
      "SELECT settlement_schedule, settlement_wallet_id FROM merchant_wallets WHERE merchant_id = $1 LIMIT 1",
      [merchant.id]
    );
    return {
      schedule: rows[0]?.settlement_schedule || "manual",
      settlementWalletId: rows[0]?.settlement_wallet_id || null,
      operatingWalletId: operating?.id || null,
      payoutMode: rows[0]?.settlement_wallet_id && rows[0].settlement_wallet_id !== operating?.id
        ? "settlement_wallet" : "realtime_wallet"
    };
  } finally {
    client.release();
  }
}

async function updateSettlementConfig(merchant, payload = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const operating = await resolveOperatingWallet(client, merchant.id);
    if (!operating) throw new AppError(503, "Merchant operating wallet is unavailable");

    let schedule;
    if (payload.schedule !== undefined) {
      schedule = String(payload.schedule || "").trim().toLowerCase();
      if (!SCHEDULES.includes(schedule)) throw new AppError(400, `schedule must be one of: ${SCHEDULES.join(", ")}`);
    }

    let settlementWalletId;
    if (payload.settlementWalletId !== undefined) {
      settlementWalletId = payload.settlementWalletId === null ? null : String(payload.settlementWalletId).trim();
      if (settlementWalletId) {
        const { rows } = await client.query(
          `SELECT id FROM wallets
            WHERE id = $1 AND user_id = $2 AND status = 'active' AND kind <> 'system'`,
          [settlementWalletId, merchant.user_id]
        );
        if (!rows[0]) throw new AppError(400, "The settlement wallet must be one of this merchant's own active wallets");
        if (settlementWalletId === operating.id) {
          throw new AppError(400, "The settlement wallet is already the operating wallet - leave it unset for real-time settlement");
        }
      }
    }

    await client.query(
      `INSERT INTO merchant_wallets (id, merchant_id, wallet_id, settlement_wallet_id, settlement_schedule)
       VALUES ($1,$2,$3,$4,COALESCE($5,'manual'))
       ON CONFLICT (merchant_id) DO UPDATE SET
         settlement_wallet_id = CASE WHEN $6 THEN $4 ELSE merchant_wallets.settlement_wallet_id END,
         settlement_schedule = COALESCE($5, merchant_wallets.settlement_schedule),
         updated_at = NOW()`,
      [uuidv4(), merchant.id, operating.id,
        settlementWalletId === undefined ? null : settlementWalletId,
        schedule === undefined ? null : schedule,
        settlementWalletId !== undefined]
    );
    await client.query("COMMIT");
    return getSettlementConfig(merchant);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------- listings */

async function listSettlements(merchant, { status, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [merchant.id];
  let where = "b.merchant_id = $1";
  if (status) { params.push(String(status)); where += ` AND b.status = $${params.length}`; }
  params.push(cap);
  const { rows } = await pool.query(
    `SELECT b.*, m.merchant_id AS merchant_code FROM settlement_batches b
       JOIN merchants m ON m.id = b.merchant_id
      WHERE ${where} ORDER BY b.period_end DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => publicBatch(row));
}

async function getSettlement(merchant, batchId) {
  const { rows } = await pool.query(
    `SELECT b.*, m.merchant_id AS merchant_code FROM settlement_batches b
       JOIN merchants m ON m.id = b.merchant_id
      WHERE b.id = $1 AND b.merchant_id = $2 LIMIT 1`,
    [batchId, merchant.id]
  );
  if (!rows[0]) throw new AppError(404, "Settlement not found");
  const { rows: items } = await pool.query(
    `SELECT i.*, p.payment_id AS payment_public_id
       FROM settlement_batch_items i
       LEFT JOIN pos_payment_intents p ON p.id = i.payment_intent_id
      WHERE i.batch_id = $1 ORDER BY i.occurred_at`,
    [batchId]
  );
  return publicBatch(rows[0], items);
}

async function adminListSettlements({ status, merchantId, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [];
  const where = [];
  if (status) { params.push(String(status)); where.push(`b.status = $${params.length}`); }
  if (merchantId) { params.push(merchantId); where.push(`b.merchant_id = $${params.length}`); }
  params.push(cap);
  const { rows } = await pool.query(
    `SELECT b.*, m.merchant_id AS merchant_code, m.business_name
       FROM settlement_batches b JOIN merchants m ON m.id = b.merchant_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.updated_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({ ...publicBatch(row), businessName: row.business_name, merchantUuid: row.merchant_id }));
}

async function adminGetSettlement(batchId) {
  const { rows } = await pool.query(
    `SELECT b.*, m.merchant_id AS merchant_code, m.business_name FROM settlement_batches b
       JOIN merchants m ON m.id = b.merchant_id WHERE b.id = $1 LIMIT 1`,
    [batchId]
  );
  if (!rows[0]) throw new AppError(404, "Settlement not found");
  const [{ rows: items }, { rows: events }] = await Promise.all([
    pool.query(
      `SELECT i.*, p.payment_id AS payment_public_id FROM settlement_batch_items i
         LEFT JOIN pos_payment_intents p ON p.id = i.payment_intent_id
        WHERE i.batch_id = $1 ORDER BY i.occurred_at`,
      [batchId]
    ),
    pool.query("SELECT event_type, previous_status, new_status, actor_type, metadata, created_at FROM settlement_events WHERE batch_id = $1 ORDER BY created_at", [batchId])
  ]);
  return { ...publicBatch(rows[0], items), businessName: rows[0].business_name, merchantUuid: rows[0].merchant_id, events };
}

/* ------------------------------------------------------------------ sweep */

// Which merchants are due, judged in South African time - the same clock the
// limit engine rolls on. The boundary is the most recent schedule boundary;
// a merchant is due when no batch reaches it and there is POS activity
// before it that no batch covers.
async function dueMerchants(client) {
  const { rows } = await client.query(
    `WITH boundaries AS (
       SELECT
         (DATE_TRUNC('day',   NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg') AS daily,
         (DATE_TRUNC('week',  NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg') AS weekly,
         (DATE_TRUNC('month', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg') AS monthly
     )
     SELECT mw.merchant_id AS merchant_uuid, mw.settlement_schedule,
            CASE mw.settlement_schedule
              WHEN 'daily' THEN b.daily WHEN 'weekly' THEN b.weekly ELSE b.monthly
            END AS boundary
       FROM merchant_wallets mw
       CROSS JOIN boundaries b
       JOIN merchants m ON m.id = mw.merchant_id AND m.status = 'active'
      WHERE mw.settlement_schedule <> 'manual' AND mw.status = 'active'
        AND COALESCE((SELECT MAX(period_end) FROM settlement_batches sb WHERE sb.merchant_id = mw.merchant_id), '-infinity'::TIMESTAMPTZ)
            < CASE mw.settlement_schedule WHEN 'daily' THEN b.daily WHEN 'weekly' THEN b.weekly ELSE b.monthly END
        AND EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.merchant_id = mw.merchant_id AND t.status = 'completed'
             AND t.service_code = ANY($1)
             AND t.created_at < CASE mw.settlement_schedule WHEN 'daily' THEN b.daily WHEN 'weekly' THEN b.weekly ELSE b.monthly END
             AND t.created_at >= COALESCE((SELECT MAX(period_end) FROM settlement_batches sb WHERE sb.merchant_id = mw.merchant_id), '-infinity'::TIMESTAMPTZ)
        )`,
    [[POS_PAYMENT_CODE, POS_REFUND_CODE, POS_REVERSAL_CODE]]
  );
  return rows;
}

async function runSettlementSweep({ requestId = null } = {}) {
  // The lock and its unlock must ride ONE connection (the webhook fan-out
  // taught this the hard way).
  const client = await pool.connect();
  let due = [];
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) locked", [SWEEP_LOCK]);
    if (!lock.rows[0].locked) {
      return { swept: 0, skippedLock: true };
    }
    due = await dueMerchants(client);
  } finally {
    // Bulletproof unlock: the acquire and the early-return are now INSIDE the
    // try, and pg_advisory_unlock_all releases any session advisory lock this
    // connection holds before it returns to the pool - so a tick can never leave
    // a pooled connection poisoned (which stranded the pool and 500'd sign-in).
    await client.query("SELECT pg_advisory_unlock_all()").catch(() => {});
    client.release();
  }
  const results = [];
  for (const row of due) {
    try {
      results.push({ merchantId: row.merchant_uuid, ...(await closeSettlement(row.merchant_uuid, { upTo: row.boundary, actorType: "system", requestId })) });
    } catch (error) {
      console.error("[settlement] sweep closeout failed", { merchantId: row.merchant_uuid, message: error.message });
      results.push({ merchantId: row.merchant_uuid, settled: false, error: String(error.message).slice(0, 200) });
    }
  }
  return { swept: results.length, results };
}

/* ------------------------------------------------------------------ worker */

async function heartbeat(extra = {}) {
  await pool.query(
    `INSERT INTO platform_settings (key, value)
     VALUES ($1, $2::JSONB)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), build: API_BUILD, pid: process.pid, ...extra })]
  ).catch(() => {});
}

// Inline by default, like the webhook worker; a settlement is due at most
// once a day, so the poll is long. Never fatal.
function startSettlementWorker(intervalMs = Number(process.env.SETTLEMENT_WORKER_POLL_MS || 15 * 60 * 1000)) {
  if (workerTimer) return;
  workerStopping = false;
  const loop = async () => {
    if (workerStopping) return;
    try {
      const result = await runSettlementSweep();
      if (result.swept) console.info("[settlement-worker] sweep", { swept: result.swept });
      await heartbeat({ swept: result.swept || 0 });
    } catch (error) {
      console.error("[settlement-worker] sweep failed", { message: error.message, code: error.code });
    } finally {
      if (!workerStopping) workerTimer = setTimeout(loop, intervalMs);
    }
  };
  workerTimer = setTimeout(loop, intervalMs);
}

function stopSettlementWorker() {
  workerStopping = true;
  clearTimeout(workerTimer);
  workerTimer = null;
}

async function workerStatus() {
  const [beat, open, failed] = await Promise.all([
    pool.query("SELECT value FROM platform_settings WHERE key = $1", [HEARTBEAT_KEY]),
    pool.query("SELECT COUNT(*)::INT total FROM settlement_batches WHERE status IN ('reconciling','reconciled')"),
    pool.query("SELECT COUNT(*)::INT total FROM settlement_batches WHERE status IN ('discrepancy','failed')")
  ]);
  const lastBeat = beat.rows[0]?.value?.at ? new Date(beat.rows[0].value.at).getTime() : 0;
  const staleAfter = Number(process.env.SETTLEMENT_WORKER_POLL_MS || 15 * 60 * 1000) * 3;
  return {
    status: !lastBeat ? "never_ran" : Date.now() - lastBeat > staleAfter ? "stalled" : "ready",
    lastHeartbeat: beat.rows[0]?.value?.at || null,
    open: open.rows[0].total,
    attention: failed.rows[0].total
  };
}

module.exports = {
  ensureSettlementSchema,
  closeSettlement,
  executePayout,
  rerunReconciliation,
  getSettlementConfig,
  updateSettlementConfig,
  listSettlements,
  getSettlement,
  adminListSettlements,
  adminGetSettlement,
  runSettlementSweep,
  startSettlementWorker,
  stopSettlementWorker,
  workerStatus,
  // exported for tests
  reconcileChecks,
  resolveOperatingWallet
};
