"use strict";

// TITOPAY BOOK: THE ONCE-OFF ACTIVATION.
//
// A business pays R250 once and Book is unlocked for it. This is the only file
// in Book that moves money, and it moves it the way every other rand in TitoPay
// moves: a transactions row first, then applyWalletMovement for each leg, then a
// revenue_ledger row. Book owns no balance and writes no ledger of its own.
//
// THE SPECIFIC FAILURE THIS FILE IS SHAPED TO PREVENT is charging a business
// twice. Two taps on a slow connection, a retried request, a double-delivered
// webhook - each of these is an ordinary event, and each of them must result in
// exactly one R250. Three independent things stop it:
//
//   1. a UNIQUE index on book_activations.business_user_id, so a second row
//      cannot be written even if everything else fails;
//   2. pg_advisory_xact_lock, so two concurrent attempts serialise instead of
//      both reading "not activated yet";
//   3. a re-read of the activation INSIDE the lock, so the second one returns
//      the first one's result rather than trying to pay again.
//
// THE UNIQUE INDEX IS THE ONLY ONE THAT GUARANTEES IT, and this is measured
// rather than asserted: removing the advisory lock and re-running
// test/book-activation.test.js still charges exactly once, because the losing
// transaction's INSERT violates the index and rolls back its own debit with it.
// The lock and the re-read are there to make the second attempt a calm "you
// already have this" rather than an error the caller has to recover from, and
// to keep two taps from doing pointless wallet work. Useful, not load-bearing.
// If the index is ever dropped, this file stops being safe.

const { randomUUID } = require("node:crypto");

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { applyWalletMovement, getRevenueWallet } = require("./wallet-service");
const { calculateFee, ensureDefaultPricingRule } = require("./pricing-service");
const { writeAuditLog } = require("./audit-service");
const { ensureBookSchema } = require("./book-schema");
const reference = require("../config/book-reference");

const SERVICE_CODE = reference.SERVICE_CODES.ACTIVATION;

// Money is NUMERIC(18,2) everywhere in this schema. Round the same way the rest
// of the codebase does, so a half-cent never reaches the ledger.
function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * What the activation costs right now.
 *
 * READ, NEVER HARDCODED. The operative figure lives in pricing_rules so an
 * operator can change it in the Pricing Engine; book-reference's constant is the
 * seed and the fallback only. If these disagreed, the screen would quote one
 * number and the wallet would be debited another.
 */
async function activationPrice() {
  // Make sure the rule exists before reading it. getPricingRule invents a
  // ZERO-FEE rule for a code it does not recognise, which would silently make
  // Book free rather than throwing, so the seed has to happen first.
  await ensureDefaultPricingRule(SERVICE_CODE).catch(() => {});
  const quote = await calculateFee(SERVICE_CODE, 0);
  const price = roundMoney(quote.fee ?? quote.totalFee ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    // A zero price here means the pricing rule is missing or was set to free.
    // Refuse rather than silently giving Book away, and say so in a way an
    // operator can act on.
    throw new AppError(503, "TitoPay Book is not available right now. Please try again later.", {
      code: "BOOK_ACTIVATION_PRICE_UNAVAILABLE"
    });
  }
  return price;
}

/** Has this business already paid? Returns the activation row or null. */
async function getActivation(businessUserId, client = pool) {
  await ensureBookSchema();
  const { rows } = await client.query(
    "SELECT * FROM book_activations WHERE business_user_id = $1 LIMIT 1",
    [businessUserId]
  );
  return rows[0] || null;
}

function shapeActivation(row, price) {
  if (!row) {
    return { active: false, amount: price ?? null, currency: "ZAR", activatedAt: null };
  }
  return {
    active: true,
    amount: Number(row.amount),
    currency: "ZAR",
    activatedAt: row.activated_at,
    transactionId: row.transaction_id || null
  };
}

/**
 * What the business sees before paying: the price, and whether they already have it.
 */
async function activationStatus(businessUserId) {
  const [existing, price] = await Promise.all([
    getActivation(businessUserId),
    activationPrice().catch(() => null)
  ]);
  return shapeActivation(existing, price);
}

/**
 * Pay the once-off activation.
 *
 * Idempotent by design: calling it again after it has succeeded returns the
 * existing activation and charges nothing.
 */
async function activate(actor, meta = {}) {
  await ensureBookSchema();

  const businessUserId = actor?.userId;
  if (!businessUserId) throw new AppError(401, "Authentication required");
  if (actor.accountType !== "business") {
    throw new AppError(403, "Only a business account can activate TitoPay Book.");
  }
  // A locked profile may not spend. Every other state-changing money path in
  // TitoPay checks this and returns 423; Book is not an exception.
  if (actor.profileLocked) {
    throw new AppError(423, "Your profile is locked. Please contact support.");
  }

  // Cheap pre-check outside the transaction so the common "already have it"
  // case never takes a lock at all.
  const already = await getActivation(businessUserId);
  if (already) return { alreadyActive: true, activation: shapeActivation(already) };

  // Read the price BEFORE opening the transaction. It touches pricing_rules and
  // there is no reason to hold a wallet lock across it.
  const price = await activationPrice();

  // AND THE REVENUE WALLET BEFORE THE TRANSACTION TOO. getRevenueWallet() takes
  // no client and queries the POOL, so calling it while holding a client from
  // that same pool can deadlock once the pool is saturated: every connection is
  // held by a transaction that is waiting for a connection. The row is stable,
  // so reading it up front costs nothing and removes the hazard entirely.
  const revenueWallet = await getRevenueWallet().catch(() => null);
  if (!revenueWallet) {
    // Without it the debit and credit legs cannot balance, and a lone debit
    // looks exactly like money vanishing. Refuse before anything moves.
    throw new AppError(503, "TitoPay Book is not available right now. Please try again later.", {
      code: "BOOK_REVENUE_WALLET_MISSING"
    });
  }

  const client = await pool.connect();
  let activationRow = null;
  let transactionId = null;
  try {
    await client.query("BEGIN");

    // Serialise every attempt for THIS business. Two taps now queue instead of
    // both reading "not activated" and both paying.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`book-activation:${businessUserId}`]);

    // Re-read inside the lock. The other tap may have completed while we waited.
    const { rows: settled } = await client.query(
      "SELECT * FROM book_activations WHERE business_user_id = $1 LIMIT 1", [businessUserId]);
    if (settled[0]) {
      await client.query("COMMIT");
      return { alreadyActive: true, activation: shapeActivation(settled[0]) };
    }

    // The business's own wallet, locked for the duration.
    const { rows: wallets } = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 AND kind <> 'system' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [businessUserId]
    );
    const wallet = wallets[0];
    if (!wallet) throw new AppError(404, "We could not find your TitoPay wallet.");

    const availableBalance = Number(wallet.available_balance || 0);
    if (availableBalance < price) {
      // A shortfall is the customer's situation, not an error in the system, so
      // it says what is needed in the words a person uses.
      throw new AppError(400,
        `TitoPay Book costs R${price.toFixed(2)} and your wallet has R${availableBalance.toFixed(2)}. Top up and try again.`,
        { code: "BOOK_ACTIVATION_INSUFFICIENT_FUNDS" });
    }

    transactionId = randomUUID();
    const paymentReference = `BOOK-${transactionId.slice(0, 8).toUpperCase()}`;
    const metadata = {
      serviceCode: SERVICE_CODE,
      product: "titopay_book",
      purpose: "business_activation"
    };

    // THE TRANSACTION ROW FIRST. wallet_ledger.transaction_id is a
    // non-deferrable foreign key, so a ledger row written before this one fails
    // outright - a mistake that once broke every wallet-debiting service.
    //
    // status 'completed', NOT 'success'. The lifecycle in money-integrity-service
    // is pending/processing/completed/..., and the orphan reconciliation only
    // inspects status='completed'. A row written as 'success' is invisible to it.
    //
    // The whole price is booked as FEE rather than as an amount moving between
    // two people, because that is what it is: a platform charge with no
    // counterparty. revenue_ledger.fee_collected must equal transactions.fee or
    // the integrity checker flags every single activation.
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total,
                                 status, direction, reference, metadata)
       VALUES ($1,$2,$3,$4,0,$5,$5,'completed','debit',$6,$7::JSONB)`,
      [transactionId, businessUserId, wallet.id, SERVICE_CODE, price, paymentReference, JSON.stringify(metadata)]
    );

    // Leg one: the money leaves the business.
    await applyWalletMovement(client, {
      walletId: wallet.id,
      transactionId,
      entryType: "debit",
      amount: price,
      reference: paymentReference,
      metadata
    });

    // Leg two: it arrives in the single TitoPay revenue wallet. These two legs
    // MUST net to zero for this transaction id, or money-integrity raises a
    // CRITICAL unbalanced_entries alert on every activation. The wallet was read
    // before BEGIN, above.
    await applyWalletMovement(client, {
      walletId: revenueWallet.id,
      transactionId,
      entryType: "credit",
      amount: price,
      reference: paymentReference,
      metadata: { ...metadata, source: "titopay_book" }
    });
    await client.query(
      `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), transactionId, SERVICE_CODE, price, revenueWallet.id]
    );

    // The thing that was bought. The unique index on business_user_id is what
    // actually makes this once-only; if a racing writer beat us here despite the
    // lock, this INSERT fails and the whole payment rolls back rather than
    // charging twice.
    const activationId = randomUUID();
    const { rows: created } = await client.query(
      `INSERT INTO book_activations (id, business_user_id, transaction_id, amount, service_code, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::JSONB)
       RETURNING *`,
      [activationId, businessUserId, transactionId, price, SERVICE_CODE, JSON.stringify(metadata)]
    );
    activationRow = created[0];

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // A unique violation here means the other attempt won. That is a success
    // from the business's point of view, not a failure, so read their row and
    // return it rather than showing an error for something that worked.
    if (error && error.code === "23505") {
      const settled = await getActivation(businessUserId);
      if (settled) return { alreadyActive: true, activation: shapeActivation(settled) };
    }
    throw error;
  } finally {
    client.release();
  }

  // AFTER COMMIT, NEVER INSIDE IT. A failed audit write or a failed notification
  // must not roll back a payment that has already happened.
  await writeAuditLog({
    actorType: "customer",
    actorId: businessUserId,
    action: "book_business_activated",
    entityType: "book_activation",
    entityId: activationRow.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { amount: Number(activationRow.amount), transactionId, serviceCode: SERVICE_CODE }
  }).catch((error) => console.error("[book] activation audit failed", { message: error.message }));

  return { alreadyActive: false, activation: shapeActivation(activationRow) };
}

/**
 * The gate every Book write goes through. Throws unless this business has paid.
 *
 * ONE FUNCTION, called everywhere, rather than an inline check per handler -
 * the same discipline canManageEventTicketing follows, and for the same reason:
 * a second answer to "is this allowed" is a second thing to get wrong.
 */
async function assertActivated(businessUserId) {
  const activation = await getActivation(businessUserId);
  if (!activation) {
    throw new AppError(402, "TitoPay Book is not active on this business yet.", {
      code: "BOOK_NOT_ACTIVATED"
    });
  }
  return activation;
}

module.exports = {
  SERVICE_CODE,
  activationPrice,
  activationStatus,
  getActivation,
  activate,
  assertActivated
};
