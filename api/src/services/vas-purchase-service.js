"use strict";

// VALUE-ADDED SERVICE PURCHASES: airtime, data, electricity, vouchers, bills.
//
// THE RAIL, NOT THE SUPPLIER. Every line here is TitoPay's side of a VAS
// purchase; the one call to an actual provider is `purchaseThroughProvider`
// below, which goes through the VAS capability and names no vendor.
//
// Why this exists as its own lifecycle instead of a service code on
// createTransaction: a VAS purchase is TWO things happening together — a debit
// against the wallet, and the delivery of a redeemable token. createTransaction
// only does the first, so routing a purchase through it would take the money
// with nothing on the other side to deliver. transaction-service refuses these
// service codes on that path for exactly that reason and points here. It is the
// same shape as a withdrawal, and this file deliberately mirrors
// peach-withdrawal-service.js rather than inventing a second way to move money.
//
// THE FOUR RULES A VAS PURCHASE HAS TO OBEY, from the audit that built the
// provider seam. Each has a test in api/test/vas-purchase.test.js.
//
//   1. IDEMPOTENT. The customer's key is the identity of the purchase. A
//      retry, a double tap or an app-level resend returns the original — it
//      never buys twice. Airtime bought twice is money gone twice.
//
//   2. THE TOKEN IS STORED BEFORE IT IS SHOWN. A token issued by the supplier
//      and lost by TitoPay is money gone: the float was debited, the customer
//      has nothing, and there is no record to recover from. So the token is
//      persisted first and only then returned. If persisting fails, the
//      purchase is marked for review — the customer is never handed a token
//      that TitoPay cannot prove it delivered.
//
//   3. A TIMEOUT IS UNKNOWN, NOT FAILED. If TitoPay cannot tell whether the
//      supplier issued a token, the money is NOT returned and the purchase is
//      NOT retried. It is flagged for reconciliation. Refunding an unknown is
//      how you pay for a token the customer already has; retrying one is how
//      you buy it twice.
//
//   4. A DEFINITE REJECTION RETURNS THE MONEY, EXACTLY ONCE. Only a refusal
//      the supplier actually gave — not a network failure — releases the
//      debit, and the release is guarded so a retry, a poll and a webhook
//      racing each other cannot release twice.
//
// STATUS OF THE SUPPLIER SIDE, said plainly: no VAS adapter can purchase yet.
// Both shipped adapters declare canPurchase: false and this service refuses
// before touching a wallet, so nothing below can run in production today. That
// is deliberate — the rail is built and tested against a fake adapter so that
// wiring a real one is one function, not a subsystem. See the header of
// providers/vas-provider.js for what the adapter must implement.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { integrationEncryptionKey } = require("../lib/integration-secret-key");
const { calculateFee, normalizeServiceCode } = require("./pricing-service");
const walletService = require("./wallet-service");

// The service codes this rail owns — the ONE canonical list, shared with the
// catalogue gate and the transaction engine so the three cannot drift.
const { VAS_SERVICE_CODES, isVasService } = require("../lib/vas-services");

// Which provider operation delivers which service. A service with no operation
// is refused rather than sent to a guessed one.
const SERVICE_OPERATIONS = {
  airtime: "purchaseAirtime",
  data: "purchaseData",
  electricity: "purchaseElectricity"
};

const TERMINAL_STATUSES = new Set(["delivered", "failed", "reversed"]);
const MAX_AMOUNT = 5000;

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function purchaseReference() {
  return `VAS-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/* ------------------------------------------------------------------ schema */

let schemaReady = null;
function ensureVasSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      // The DELIVERY record, separate from the money record in `transactions`.
      // A redeemable token is not metadata: it is the goods. Keeping it out of
      // transactions.metadata keeps it out of every export, statement and log
      // that reads that column.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vas_purchases (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          transaction_id UUID,
          service_code TEXT NOT NULL,
          amount NUMERIC(14,2) NOT NULL,
          fee NUMERIC(14,2) NOT NULL DEFAULT 0,
          total NUMERIC(14,2) NOT NULL,
          recipient TEXT,
          product_code TEXT,
          idempotency_key TEXT NOT NULL,
          provider_reference TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          token_ciphertext TEXT,
          token_issued_at TIMESTAMPTZ,
          requires_review BOOLEAN NOT NULL DEFAULT FALSE,
          failure_reason TEXT,
          provider_response JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // THE idempotency guard, at the database. Everything above it is a fast
      // path; this is what makes a double purchase impossible rather than
      // unlikely.
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS vas_purchases_idem_uniq
                        ON vas_purchases (user_id, idempotency_key)`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS vas_purchases_provider_ref_uniq
                        ON vas_purchases (provider_reference)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS vas_purchases_review_idx
                        ON vas_purchases (requires_review) WHERE requires_review = TRUE`);
    })().catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

/* ------------------------------------------------------------------- token */

// Encrypted at rest with the same key the integration credentials use, in the
// same enc:iv:tag:ciphertext format.
function encryptToken(value) {
  const text = String(value == null ? "" : value);
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", integrationEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

// DELIBERATELY NOT peach-config-service's decryptSecret, which returns "" when
// the key has rotated. That is right for a credential — re-enter it — and
// catastrophic for this: a redeemable token is the goods the customer paid
// for, and answering "" would report it as never delivered and invite a
// refund on top of a token they already hold. This raises instead, and the
// ciphertext is left untouched so the value is recoverable once the key is.
function decryptToken(value) {
  const text = String(value || "");
  if (!text.startsWith("enc:")) return null;
  const [, ivText, tagText, encryptedText] = text.split(":");
  if (!ivText || !tagText || !encryptedText) {
    throw new AppError(500, "This purchase token is stored in an unreadable form. Contact support with the reference.");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", integrationEncryptionKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
  } catch (_error) {
    throw new AppError(
      500,
      "This purchase token cannot be read on this deployment. It has not been lost — contact support with the reference.",
      { code: "VAS_TOKEN_KEY_MISMATCH" }
    );
  }
}

function purchaseResponse(row, extra = {}) {
  return Object.assign({
    id: row.id,
    reference: row.provider_reference,
    transactionId: row.transaction_id,
    serviceCode: row.service_code,
    amount: Number(row.amount),
    fee: Number(row.fee),
    total: Number(row.total),
    recipient: row.recipient,
    status: row.status,
    requiresReview: Boolean(row.requires_review),
    createdAt: row.created_at
  }, extra);
}

/* ----------------------------------------------------------------- provider */

// THE ONE CALL TO A SUPPLIER. Everything else in this file is TitoPay's.
//
// The adapter is asked through the capability, so this names no vendor and
// keeps working when the contract changes. `reference` is ours and is stable
// across retries: a supplier that honours it will return the original purchase
// rather than issuing a second token.
async function purchaseThroughProvider(actor, request) {
  const vas = require("../providers/vas-provider");
  const operation = SERVICE_OPERATIONS[request.serviceCode];
  if (!operation || typeof vas[operation] !== "function") {
    throw new AppError(503, "This service is not available right now. Please try again later.");
  }
  return vas[operation](actor, request);
}

// Did the supplier actually say no, or did TitoPay simply not hear back?
//
// Only the first may return the customer's money. 408 and 429 are retryable
// and a 5xx is the supplier's own failure — none of them prove a token was not
// issued, so none of them are treated as a definite no.
function isDefiniteRejection(error) {
  // BOTH SHAPES. AppError carries `statusCode`; a plain Error from an HTTP
  // client carries `status`. Reading only one of them made every AppError the
  // adapter raised look status-less, and a status-less error is treated as
  // unknown — so a flat refusal would have held the customer's money for
  // reconciliation instead of returning it. It failed in the safe direction,
  // which is exactly why it would have gone unnoticed.
  const status = Number(
    error?.details?.providerStatus ?? error?.statusCode ?? error?.status
  );
  if (error?.details?.code === "VAS_REJECTED") return true;
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/* ----------------------------------------------------------------- purchase */

async function purchaseVas(actor, payload = {}) {
  if (!actor?.userId) throw new AppError(401, "Authentication required");
  if (actor.profileLocked) throw new AppError(423, "Profile is locked. Purchases are disabled.");
  await ensureVasSchema();

  const serviceCode = normalizeServiceCode(payload.serviceCode || payload.service || "");
  if (!isVasService(serviceCode)) {
    throw new AppError(400, "This service is not a value-added service purchase", { code: "NOT_A_VAS_SERVICE" });
  }

  // THE CAPABILITY, BEFORE ANY MONEY. Asked rather than assumed, and asked
  // first, so an uncontracted rail refuses without a wallet ever being touched.
  if (!require("../providers/vas-provider").vasCanPurchase()) {
    throw new AppError(503, "This service is not available right now. Please try again later.");
  }

  const amount = roundMoney(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "Amount must be greater than zero");
  if (amount > MAX_AMOUNT) throw new AppError(400, `The largest purchase is R${MAX_AMOUNT.toFixed(2)}`);

  const recipient = String(payload.recipient || "").trim().slice(0, 64);
  if (!recipient) throw new AppError(400, "Enter the number or meter this purchase is for");

  const idempotencyKey = String(payload.idempotencyKey || payload.metadata?.clientIdempotencyKey || "").trim().slice(0, 120);
  if (!idempotencyKey) throw new AppError(400, "An idempotency key is required");

  // The customer's own limits, so eligibility is heard about before anything
  // else and with the upgrade path named in the refusal.
  await require("./compliance-service").assertCanSendAmount(actor.userId, amount, { serviceCode });

  // Fast path. It catches a resend seconds later; it cannot catch two
  // deliveries of one request in flight together, which is what the locked
  // re-check inside the transaction is for.
  const replay = await pool.query(
    "SELECT * FROM vas_purchases WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
    [actor.userId, idempotencyKey]
  );
  if (replay.rows[0]) return purchaseResponse(replay.rows[0], { idempotentReplay: true });

  const pricing = await calculateFee(serviceCode, amount);
  const fee = roundMoney(pricing.fee || 0);
  const total = roundMoney(amount + fee);

  const purchaseId = uuidv4();
  const transactionId = uuidv4();
  const reference = purchaseReference();

  // ---- one database transaction: claim the key, check balance, debit ----
  const client = await pool.connect();
  let row;
  try {
    await client.query("BEGIN");

    // Taken before the wallet lock so every purchase acquires the two in the
    // same order and they cannot deadlock against each other.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`vas:${actor.userId}:${idempotencyKey}`]);
    const { rows: raced } = await client.query(
      "SELECT * FROM vas_purchases WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1",
      [actor.userId, idempotencyKey]
    );
    if (raced[0]) {
      // ROLLBACK, not COMMIT: nothing has been written, only a lock taken, and
      // a transaction-scoped advisory lock is released either way.
      await client.query("ROLLBACK");
      return purchaseResponse(raced[0], { idempotentReplay: true });
    }

    // Same lock key createTransaction uses, so one gate serialises everything
    // that consumes a user's limits.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`limits:${actor.userId}`]);
    await require("./compliance-service").assertCanSendAmount(actor.userId, amount, { serviceCode });

    const wallets = await client.query(
      "SELECT * FROM wallets WHERE user_id = $1 AND kind <> 'system' ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
      [actor.userId]
    );
    const wallet = wallets.rows[0];
    if (!wallet) throw new AppError(404, "Wallet not found");
    if (String(wallet.status || "").toLowerCase() === "locked") {
      throw new AppError(423, "Wallet is locked. Unlock it before buying.");
    }
    const available = Number(wallet.available_balance || 0);
    if (available + 0.005 < total) {
      throw new AppError(
        409,
        `Not enough available balance. This purchase needs R${total.toFixed(2)} including the R${fee.toFixed(2)} fee, and R${available.toFixed(2)} is available. No wallet debit was made.`,
        { code: "INSUFFICIENT_BALANCE" }
      );
    }

    await client.query(
      `INSERT INTO transactions
        (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','debit',$8,$9,$10::jsonb)`,
      [transactionId, actor.userId, wallet.id, serviceCode, amount, fee, total, reference, recipient,
        JSON.stringify({
          integration: "vas_purchase",
          currency: "ZAR",
          clientIdempotencyKey: idempotencyKey,
          vasPurchaseId: purchaseId,
          providerState: "created"
        })]
    );

    const inserted = await client.query(
      `INSERT INTO vas_purchases
        (id, user_id, transaction_id, service_code, amount, fee, total, recipient, product_code,
         idempotency_key, provider_reference, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
       RETURNING *`,
      [purchaseId, actor.userId, transactionId, serviceCode, amount, fee, total, recipient,
        String(payload.productCode || "").slice(0, 64) || null, idempotencyKey, reference]
    );
    row = inserted.rows[0];

    // THE debit. One per purchase, before the supplier is contacted.
    await walletService.applyWalletMovement(client, {
      walletId: wallet.id,
      transactionId,
      entryType: "debit",
      amount: total,
      reference,
      metadata: { serviceCode, vasPurchaseId: purchaseId, stage: "vas_purchase_submitted" }
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // ---- contact the supplier, outside the database transaction ----
  return deliverPurchase(actor, row);
}

// Sending is separated from recording so a slow supplier never holds a wallet
// lock, and so a delivery can be reconciled later without re-debiting.
async function deliverPurchase(actor, row) {
  let response;
  try {
    response = await purchaseThroughProvider(actor, {
      serviceCode: row.service_code,
      amount: Number(row.amount),
      recipient: row.recipient,
      productCode: row.product_code,
      reference: row.provider_reference
    });
  } catch (error) {
    return handleDeliveryFailure(row, error);
  }

  const token = response?.token ?? response?.pin ?? response?.voucherCode ?? null;

  // RULE 2. Stored before it is shown. If this write fails the customer is
  // told to check Activity rather than being handed a token TitoPay has no
  // record of — the supplier has already issued it, so the money is spent and
  // the only recoverable state is one that is written down.
  try {
    const { rows } = await pool.query(
      `UPDATE vas_purchases
          SET status = 'delivered', token_ciphertext = $2, token_issued_at = NOW(),
              provider_response = $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [row.id, encryptToken(token), JSON.stringify(response?.receipt || response || {})]
    );
    const settled = rows[0];
    if (!settled) {
      // Something else already moved this row. Return what is stored rather
      // than overwriting a terminal state.
      const { rows: current } = await pool.query("SELECT * FROM vas_purchases WHERE id = $1", [row.id]);
      return purchaseResponse(current[0] || row);
    }
    await pool.query(
      `UPDATE transactions SET status = 'completed', metadata = metadata || $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [row.transaction_id, JSON.stringify({ providerState: "delivered" })]
    );
    return purchaseResponse(settled, { token: token ? decryptToken(settled.token_ciphertext) : null });
  } catch (error) {
    await markForReview(row.id, "TOKEN_PERSIST_FAILED");
    console.error("[vas-purchase] token could not be stored", { purchaseId: row.id, reference: row.provider_reference });
    throw new AppError(
      502,
      "This purchase went through but TitoPay could not record it. Do not try again. Check Activity, or contact support with the reference.",
      { code: "VAS_TOKEN_PERSIST_FAILED", reference: row.provider_reference }
    );
  }
}

async function markForReview(purchaseId, reason) {
  await pool.query(
    `UPDATE vas_purchases
        SET status = 'unknown', requires_review = TRUE, failure_reason = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [purchaseId, String(reason || "UNKNOWN").slice(0, 120)]
  ).catch(() => null);
}

async function handleDeliveryFailure(row, error) {
  const definite = isDefiniteRejection(error);
  console.error("[vas-purchase] delivery failed", {
    purchaseId: row.id,
    reference: row.provider_reference,
    definiteRejection: definite,
    code: error?.details?.code || "UNKNOWN",
    providerStatus: error?.details?.providerStatus ?? error?.status ?? null
  });

  // RULE 3. Not proven refused, so not refunded and not retried.
  if (!definite) {
    await markForReview(row.id, error?.details?.code || "PROVIDER_UNAVAILABLE");
    await pool.query(
      `UPDATE transactions SET status = 'processing', metadata = metadata || $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [row.transaction_id, JSON.stringify({ providerState: "delivery_uncertain", requiresReview: true })]
    ).catch(() => null);
    throw new AppError(
      502,
      "TitoPay could not confirm this purchase with the supplier. The amount is held against it and it will finish or be returned automatically. Do not try again. Check Activity for the outcome.",
      { code: "VAS_DELIVERY_UNCERTAIN", reference: row.provider_reference }
    );
  }

  // RULE 4. Refused by the supplier, so the money comes back.
  await releasePurchaseFunds(row.id, error?.details?.code || "VAS_REJECTED");
  throw new AppError(
    502,
    "The supplier rejected this purchase, so nothing was bought and the amount has been returned to your wallet.",
    { code: "VAS_REJECTED", reference: row.provider_reference }
  );
}

// The one and only place a VAS purchase's debit is given back.
//
// The purchase row is locked FOR UPDATE, so a retry, a status poll and a
// reconciliation job racing each other serialise here: the first to win the
// lock releases, the rest see a terminal status and no-op. The ledger is
// checked too, so even a rewound status cannot credit twice.
async function releasePurchaseFunds(purchaseId, reason = "VAS_REJECTED") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM vas_purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const row = rows[0];
    if (!row) { await client.query("ROLLBACK"); return null; }
    if (TERMINAL_STATUSES.has(String(row.status))) { await client.query("ROLLBACK"); return purchaseResponse(row); }

    // Belt and braces: if a credit for this purchase is already posted, do not
    // post a second one whatever the status column says.
    const { rows: posted } = await client.query(
      "SELECT 1 FROM wallet_ledger WHERE transaction_id = $1 AND entry_type = 'credit' LIMIT 1",
      [row.transaction_id]
    );
    if (posted[0]) { await client.query("ROLLBACK"); return purchaseResponse(row); }

    const { rows: wallets } = await client.query(
      "SELECT * FROM wallets WHERE user_id = $1 AND kind <> 'system' ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
      [row.user_id]
    );
    const wallet = wallets[0];
    if (!wallet) { await client.query("ROLLBACK"); return purchaseResponse(row); }

    await walletService.applyWalletMovement(client, {
      walletId: wallet.id,
      transactionId: row.transaction_id,
      entryType: "credit",
      amount: Number(row.total),
      reference: row.provider_reference,
      metadata: { serviceCode: row.service_code, vasPurchaseId: row.id, stage: "vas_purchase_reversed", reason }
    });

    const { rows: updated } = await client.query(
      `UPDATE vas_purchases
          SET status = 'reversed', failure_reason = $2, requires_review = FALSE, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [purchaseId, String(reason).slice(0, 120)]
    );
    await client.query(
      `UPDATE transactions SET status = 'failed', metadata = metadata || $2::jsonb, updated_at = NOW()
        WHERE id = $1`,
      [row.transaction_id, JSON.stringify({ providerState: "rejected", failureReason: reason })]
    );
    await client.query("COMMIT");
    return purchaseResponse(updated[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------- read */

async function getPurchase(actor, referenceOrId) {
  await ensureVasSchema();
  const key = String(referenceOrId || "").trim();
  if (!key) throw new AppError(400, "A purchase reference is required");
  const { rows } = await pool.query(
    `SELECT * FROM vas_purchases
      WHERE user_id = $1 AND (provider_reference = $2 OR id::TEXT = $2) LIMIT 1`,
    [actor.userId, key]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "Purchase not found");
  // The token is returned only to the customer who bought it, and only once it
  // is stored — which is the same condition under which it was ever shown.
  const token = row.token_ciphertext ? decryptToken(row.token_ciphertext) : null;
  return purchaseResponse(row, { token });
}

async function listPurchases(actor, limit = 20) {
  await ensureVasSchema();
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { rows } = await pool.query(
    "SELECT * FROM vas_purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [actor.userId, size]
  );
  // No tokens in a list. A list is browsed, logged and screenshotted; a
  // redeemable token belongs only in the one response that asked for it.
  return rows.map((row) => purchaseResponse(row));
}

// For the reconciliation job and the admin console: the purchases TitoPay
// could not resolve on its own. These are the ones a human has to settle with
// the supplier, and they are the reason rule 3 exists.
async function listPurchasesNeedingReview(limit = 100) {
  await ensureVasSchema();
  const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await pool.query(
    `SELECT id, user_id, transaction_id, service_code, amount, total, recipient,
            provider_reference, status, failure_reason, created_at
       FROM vas_purchases WHERE requires_review = TRUE ORDER BY created_at ASC LIMIT $1`,
    [size]
  );
  return rows;
}

module.exports = {
  VAS_SERVICE_CODES,
  ensureVasSchema,
  purchaseVas,
  getPurchase,
  listPurchases,
  listPurchasesNeedingReview,
  releasePurchaseFunds,
  // Exported for the tests that hold the four rules in place.
  isDefiniteRejection,
  encryptToken,
  decryptToken
};
