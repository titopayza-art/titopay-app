const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { payoutAvailability, assertPayoutAvailable } = require("./peach-payout-service");
const { writeAuditLog } = require("./audit-service");
const { queueEmail } = require("./email-centre-service");
const { shouldSendCustomerEmail } = require("./customer-notification-preference-service");
const { recordBeneficiaryPayment } = require("./beneficiary-service");
const { calculateFee, roundMoney, normalizeServiceCode } = require("./pricing-service");
const { recipientLookupValues, recipientPhoneLookupValues, verifyRecipient } = require("./security-service");
const { getPrimaryWalletForUser, getRevenueWallet, applyWalletMovement } = require("./wallet-service");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");

const REGISTERED_RECIPIENT_SERVICES = new Set([
  "wallet_transfer",
  "send_money",
  "send_gift",
  "tip",
  "payment_request",
  "business_payment_request",
  "bill_split",
  "stockvel"
]);

const LIVE_SINGLE_RECIPIENT_WALLET_SERVICES = new Set([
  "wallet_transfer",
  "send_money",
  "send_gift",
  "tip"
]);

const LIVE_QR_WALLET_SERVICES = new Set([
  "qr_payment",
  "qr_pay",
  "customer_qr_payment"
]);

const REQUEST_ONLY_SERVICES = new Set([
  "payment_request",
  "request_money",
  "business_payment_request"
]);

const MULTI_PARTY_SERVICES_PENDING_SETTLEMENT = new Set([
  "bill_split",
  "stockvel",
  "stockvel_contribution"
]);

// Card top-ups are a wallet CREDIT funded by Peach Checkout, not a wallet
// debit, so they can never run through createTransaction. They have their own
// lifecycle at /v1/payments/topup.
const CARD_TOPUP_SERVICES = new Set([
  "wallet_top_up",
  "top_up",
  "card_topups",
  "card_payments"
]);

// Withdrawals and payouts are money OUT and belong to the Peach PAYOUT
// capability, never to Collection/Checkout. They stay unavailable until that
// capability is configured, enabled and its own connection test has succeeded.
// The service catalogue publishes the code "payouts"; without it here the block
// only happened via the catch-all, and a fee preview first wrote a zero-fee
// "payouts" pricing rule to the database.
// Withdrawal processing was previously held behind PEACH_PAYOUT_PROCESSING_ENABLED
// because a connected payout provider is not the same thing as a withdrawal
// lifecycle: without the debit + submission + provider-confirmation chain, a
// Confirm could have debited a wallet with nothing on the other side to move
// the money. That chain now exists in peach-withdrawal-service, which debits
// once inside the same database transaction that records the withdrawal,
// submits to the Peach Payouts API, and reverses exactly once if Peach reports
// the payout failed. The flag is therefore gone rather than bypassed — the
// safety it was standing in for is implemented.
// Bank payouts only. Peach Payouts pays a bank account by realtime-EFT, so a
// CASH withdrawal is a different product with a different partner and is not
// routed here — sending it to the payout flow would tell the customer to use an
// endpoint that then refuses them. Cash stays with the unlaunched services
// below until it has a provider of its own.
const PEACH_PAYOUT_SERVICES = new Set([
  "withdraw",
  "withdraw_money_to_bank",
  "bank_withdrawal",
  "bank_transfer",
  "payouts",
  "business_payout",
  "merchant_payout",
  "merchant_payouts",
  "seller_payout",
  "bulk_distribution_bank_payout"
]);

const PROVIDER_DEPENDENT_SERVICES = new Set([
  // Cash out at a till or ATM. Peach Payouts cannot do this — it pays bank
  // accounts — so it stays unavailable until it has its own provider.
  "withdraw_cash",
  "cash_withdrawal",
  "airtime",
  "data",
  "electricity",
  "voucher",
  "vouchers",
  "pay_bills",
  "bill_payments",
  "cash_services",
  "gift_cards",
  "marketplace",
  "marketplace_seller_commission",
  "marketplace_commission",
  "marketplace_buyer_service_fee",
  "marketplace_refund_processing"
]);

function splitRecipientList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function recipientsForVerification(payload = {}, normalizedServiceCode = "") {
  if (normalizedServiceCode === "bill_split") return splitRecipientList(payload.participants || payload.metadata?.participants);
  if (normalizedServiceCode === "stockvel") return splitRecipientList(payload.members || payload.metadata?.members);
  return payload.recipient ? [payload.recipient] : [];
}

function txReference(prefix = "TX") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function providerPendingMessage(serviceCode) {
  const label = String(serviceCode || "service").replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} is not enabled for live processing yet. No wallet debit was made.`;
}

// Checks that depend only on the service code. Run from the fee preview too, so
// a customer is told a service is unavailable before they see a fee and press
// Confirm — the previous behaviour previewed cleanly and only failed on Confirm,
// which reads as a payment glitch rather than an unlaunched service.
async function assertServiceLaunched(normalizedServiceCode) {
  // Money out: ask the Peach payout capability directly, so the customer is
  // told the real reason and a withdrawal can never be attempted through the
  // Checkout (Collection) endpoint.
  if (PEACH_PAYOUT_SERVICES.has(normalizedServiceCode)) {
    // The provider link, so the customer sees the real reason when the payout
    // capability is unconfigured, disabled or unverified — checked here, at the
    // fee preview, so nobody is walked through a fee to a Confirm that cannot
    // settle. The withdrawal itself runs at POST /v1/payouts/withdrawals.
    assertPayoutAvailable(await payoutAvailability());
    return;
  }
  // Card top-ups are deliberately NOT rejected here. The fee preview is a
  // read-only price calculation, and the customer has to be shown the top-up fee
  // before they are sent to the card page — the amount charged at Peach is
  // amount + fee. Blocking the preview stopped the top-up before it began. The
  // wallet-debit path is refused in assertLiveTransactionSupported instead, so
  // createTransaction still cannot be used to fake a top-up.
  if (REQUEST_ONLY_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(409, "Payment requests create a request only. No wallet debit was made.");
  }
  if (MULTI_PARTY_SERVICES_PENDING_SETTLEMENT.has(normalizedServiceCode)) {
    throw new AppError(503, `${providerPendingMessage(normalizedServiceCode)} This service needs its dedicated settlement workflow before launch.`);
  }
  if (PROVIDER_DEPENDENT_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(503, providerPendingMessage(normalizedServiceCode));
  }
}

async function assertLiveTransactionSupported(normalizedServiceCode, payload = {}) {
  await assertServiceLaunched(normalizedServiceCode);
  // A card top-up is a wallet CREDIT funded by Peach Checkout, so it can never
  // be created through the wallet-debit endpoint. Only createTransaction reaches
  // this, which keeps the fee preview above working.
  if (CARD_TOPUP_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(
      409,
      "Card top-ups are completed through the secure card payment flow. No wallet debit was made.",
      { code: "USE_CARD_TOPUP_FLOW", endpoint: "/v1/payments/topup" }
    );
  }
  // A withdrawal debits the wallet AND submits a payout to Peach, and the two
  // have to happen in one controlled lifecycle so a failed payout can be
  // reversed exactly once. createTransaction only does the debit, so it would
  // take the money with nothing on the other side to move it.
  if (PEACH_PAYOUT_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(
      409,
      "Withdrawals are completed through the payout flow. No wallet debit was made.",
      { code: "USE_WITHDRAWAL_FLOW", endpoint: "/v1/payouts/withdrawals" }
    );
  }
  if (LIVE_QR_WALLET_SERVICES.has(normalizedServiceCode)) {
    if (!payload.metadata?.qrId) {
      throw new AppError(400, "QR payments must be started from a valid TitoPay QR code.");
    }
    if (!payload.recipient) {
      throw new AppError(400, "QR payment recipient is required.");
    }
    return;
  }
  if (LIVE_SINGLE_RECIPIENT_WALLET_SERVICES.has(normalizedServiceCode)) {
    if (!payload.recipient) throw new AppError(400, "Recipient is required.");
    return;
  }
  throw new AppError(503, providerPendingMessage(normalizedServiceCode));
}

function transactionResponseFromRow(row = {}) {
  const metadata = row.metadata || {};
  const netAmount = metadata.netAmount ?? row.net_amount ?? row.amount;
  return {
    transactionId: row.id,
    reference: row.reference,
    amount: Number(row.amount || 0),
    fee: Number(row.fee || 0),
    total: Number(row.total || 0),
    netAmount: Number(netAmount || row.amount || 0),
    status: row.status,
    recipient: row.recipient_reference || null,
    idempotentReplay: true
  };
}

async function feePreview(payload) {
  const serviceCode = payload.service || payload.serviceCode;
  if (!serviceCode) throw new AppError(400, "service is required");
  const normalizedServiceCode = normalizeServiceCode(serviceCode);
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "amount must be greater than zero");
  await assertServiceLaunched(normalizedServiceCode);
  const fee = await calculateFee(normalizedServiceCode, amount);
  let recipientStatus = null;
  const recipientChecks = recipientsForVerification(payload, normalizedServiceCode);
  if (REGISTERED_RECIPIENT_SERVICES.has(normalizedServiceCode) && recipientChecks.length) {
    const verifiedRecipients = [];
    for (const recipient of recipientChecks) {
      const status = await verifyRecipient(payload.actor || { userType: "system", userId: null }, { recipient });
      if (!status.registered) {
        throw new AppError(404, status.message, { invite: status.invite, recipient });
      }
      if (status.recipient && status.recipient.verified === false) {
        throw new AppError(403, "Recipient must be a verified TitoPay user before payment can continue");
      }
      verifiedRecipients.push({ identifier: recipient, ...status });
    }
    recipientStatus = verifiedRecipients.length === 1 ? verifiedRecipients[0] : { registered: true, recipients: verifiedRecipients };
  }
  return {
    amount: fee.amount,
    fee: fee.fee,
    total: fee.total,
    recipient: payload.recipient || null,
    transactionType: normalizedServiceCode,
    serviceCode: normalizedServiceCode,
    serviceName: fee.serviceName,
    recipientStatus
  };
}

async function resolveRecipientWallet(recipient) {
  if (!recipient) return null;
  const lookupValues = recipientLookupValues({ recipient }).map((value) => String(value).toLowerCase());
  const phoneLookupValues = recipientPhoneLookupValues({ recipient });
  const { rows } = await pool.query(
    `SELECT w.*, u.username, u.email, u.phone
     FROM users u
     JOIN wallets w ON w.user_id = u.id
     WHERE LOWER(u.username) = ANY($1::TEXT[])
        OR LOWER(u.email) = ANY($1::TEXT[])
        OR LOWER(u.phone) = ANY($1::TEXT[])
        OR LOWER(COALESCE(w.wallet_number, '')) = ANY($1::TEXT[])
        OR REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = ANY($2::TEXT[])
     ORDER BY w.created_at ASC
     LIMIT 1`,
    [lookupValues, phoneLookupValues]
  );
  return rows[0] || null;
}

async function createTransaction(actor, payload) {
  if (actor.profileLocked) throw new AppError(423, "Profile is locked. Financial transactions are disabled.");
  const serviceCode = payload.service || payload.serviceCode;
  const normalizedServiceCode = normalizeServiceCode(serviceCode);
  const amount = roundMoney(payload.amount);
  if (!serviceCode) throw new AppError(400, "service is required");
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "amount must be greater than zero");
  await assertLiveTransactionSupported(normalizedServiceCode, payload);
  const idempotencyKey = String(payload.idempotencyKey || payload.metadata?.clientIdempotencyKey || "").trim().slice(0, 120);

  // Fast path only. This unlocked read answers the ordinary case — a customer
  // pressing Confirm again a second later — without paying for a fee preview
  // and a pooled connection. It is NOT the guard: two copies of one request
  // arriving together both find nothing here and both carry on. The guard that
  // actually holds is the advisory lock inside the transaction below.
  if (idempotencyKey) {
    const { rows } = await pool.query(
      `SELECT *
       FROM transactions
       WHERE user_id = $1
         AND metadata->>'clientIdempotencyKey' = $2
         AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [actor.userId, idempotencyKey]
    );
    if (rows[0]) return transactionResponseFromRow(rows[0]);
  }

  const preview = await feePreview({
    serviceCode: normalizedServiceCode,
    amount,
    recipient: payload.recipient,
    participants: payload.participants,
    members: payload.members,
    metadata: payload.metadata,
    actor
  });
  const wallet = await getPrimaryWalletForUser(actor.userId);
  const recipientWallet = await resolveRecipientWallet(payload.recipient);
  const revenueWallet = preview.fee > 0 ? await getRevenueWallet() : null;
  const txId = uuidv4();
  const reference = txReference();
  const netAmount = roundMoney(payload.merchantReceivesFee ? amount - preview.fee : amount);
  const debitTotal = payload.merchantReceivesFee ? amount : preview.total;

  if (Number(wallet.available_balance) < debitTotal) throw new AppError(400, "Insufficient balance");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // THE idempotency guard. The check above runs unlocked on the pool, so two
    // deliveries of one request — a double tap, two tabs, a mobile network
    // retrying a POST it already delivered — both miss it and both proceed to
    // here. This advisory lock is transaction-scoped, so the first arrival holds
    // it until COMMIT and the second waits, then re-reads and finds the row the
    // first one wrote. Whichever loses the race returns the original record
    // instead of charging the customer a second time.
    //
    // Same shape as pos/service.js:110 and event-tag-service.js:480, which have
    // always done this correctly; these two older money paths predate it.
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tx:${actor.userId}:${idempotencyKey}`]);
      const { rows: replayed } = await client.query(
        `SELECT *
         FROM transactions
         WHERE user_id = $1
           AND metadata->>'clientIdempotencyKey' = $2
           AND created_at > NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC
         LIMIT 1`,
        [actor.userId, idempotencyKey]
      );
      if (replayed[0]) {
        // ROLLBACK, not COMMIT: nothing was written, only a lock taken, and a
        // transaction-scoped advisory lock is released either way.
        await client.query("ROLLBACK");
        return transactionResponseFromRow(replayed[0]);
      }
    }

    // The transaction row is written FIRST because every wallet_ledger entry
    // below carries its id, and wallet_ledger.transaction_id is a plain
    // non-deferrable foreign key. Writing the ledger first violated it on the
    // very first statement, so createTransaction raised
    // "wallet_ledger_transaction_id_fkey" and returned a 500 for every service
    // that debits a wallet — Send Money, airtime, data, electricity, vouchers,
    // Pay Bills, Bill Split, Tip, Send Gift, QR Pay and stokvel contributions.
    // Top-ups, withdrawals and payouts were unaffected because they have their
    // own lifecycles that insert the transaction before touching the ledger.
    //
    // Nothing else moves. The insert uses only values resolved before BEGIN,
    // it is inside the same BEGIN/COMMIT as the ledger writes, and any later
    // failure still rolls the whole thing back — so a transaction row can no
    // more exist without its ledger entries than it could before.
    await client.query(
      `INSERT INTO transactions
        (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed','debit',$8,$9,$10)`,
      [
        txId,
        actor.userId,
        wallet.id,
        normalizedServiceCode,
        amount,
        preview.fee,
        debitTotal,
        reference,
        payload.recipient || null,
        JSON.stringify({ ...payload.metadata, clientIdempotencyKey: idempotencyKey || payload.metadata?.clientIdempotencyKey || null, netAmount, recipientWalletId: recipientWallet?.id || null })
      ]
    );

    await applyWalletMovement(client, {
      walletId: wallet.id,
      transactionId: txId,
      entryType: "debit",
      amount: debitTotal,
      reference,
      metadata: { serviceCode: normalizedServiceCode }
    });
    if (recipientWallet) {
      await applyWalletMovement(client, {
        walletId: recipientWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: netAmount,
        reference,
        metadata: { serviceCode: normalizedServiceCode, fromUserId: actor.userId }
      });
    }
    if (revenueWallet) {
      await applyWalletMovement(client, {
        walletId: revenueWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: preview.fee,
        reference,
        metadata: { serviceCode: normalizedServiceCode, source: "fee" }
      });
      await client.query(
        `INSERT INTO revenue_ledger
          (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), txId, normalizedServiceCode, preview.fee, revenueWallet.id]
      );
    }
    if (recipientWallet?.user_id) {
      await recordBeneficiaryPayment(actor.userId, recipientWallet.user_id, amount, client);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "transaction_completed",
    entityType: "transaction",
    entityId: txId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { serviceCode: normalizedServiceCode, amount, fee: preview.fee, recipient: payload.recipient || null }
  });
  try {
    const { rows: accountRows } = await pool.query("SELECT email,full_name FROM users WHERE id=$1", [actor.userId]);
    const account = accountRows[0];
    if (account?.email && await shouldSendCustomerEmail(actor.userId, "transaction")) {
      const templateKey = /qr/.test(normalizedServiceCode) ? "qr_payment_receipt"
        : /top.?up/.test(normalizedServiceCode) ? "wallet_top_up_receipt"
          : /transfer|send/.test(normalizedServiceCode) ? "money_transfer_receipt" : "payment_receipt";
      await queueEmail({ recipient:account.email, templateKey, userId:actor.userId,
        variables:{fullName:account.full_name,email:account.email,amount:amount.toFixed(2),currency:"ZAR",transactionReference:reference},
        idempotencyKey:`transaction-receipt:${txId}`, metadata:{transactionId:txId,serviceCode:normalizedServiceCode} });
    }
  } catch (error) {
    console.error("[transaction] receipt queue failed", { transactionId:txId, message:error.message });
  }
  return {
    transactionId: txId,
    reference,
    amount,
    fee: preview.fee,
    total: debitTotal,
    netAmount,
    status: "completed",
    recipient: payload.recipient || null,
    recipientUserId: recipientWallet?.user_id || null
  };
}

// A transaction row records an ATTEMPT. It exists from the moment a payment is
// initiated, for audit and idempotency, and it says nothing about whether money
// moved. Only a wallet_ledger entry does that.
//
// So every transaction carries the ledger's own answer with it: whether an entry
// was posted against this wallet for this transaction, and the exact signed
// amount by which the available balance moved. Statements and any other
// financial total must use these two fields and never `amount`, `total` or
// `status`, so a pending or failed attempt can never be presented as money
// received. Every ledger entry type is an available_balance delta, so summing
// them signed gives the true movement.
const POSTED_LEDGER_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INT AS entry_count,
           COALESCE(SUM(
             CASE WHEN wl.entry_type IN ('credit', 'release') THEN ABS(wl.amount)
                  WHEN wl.entry_type IN ('debit', 'reserve') THEN -ABS(wl.amount)
                  ELSE 0 END
           ), 0) AS net_posted
    FROM wallet_ledger wl
    WHERE wl.transaction_id = t.id AND wl.wallet_id = t.wallet_id
  ) posted ON TRUE`;

async function listTransactionsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT t.*, pr.service_name, (t.metadata->>'netAmount')::NUMERIC AS net_amount,
            (posted.entry_count > 0) AS wallet_posted,
            posted.entry_count AS ledger_entry_count,
            posted.net_posted AS posted_amount
     FROM transactions t
     LEFT JOIN pricing_rules pr ON pr.service_code = t.service_code
     ${POSTED_LEDGER_LATERAL}
     WHERE t.user_id = $1
     ORDER BY t.created_at DESC
     LIMIT 100`,
    [userId]
  );
  return rows;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function listAllTransactions(filters = {}) {
  try {
    const values = [];
    const where = [];
    const limit = boundedInteger(filters.limit, 1000, 50, 5000);
    const addValue = (value) => {
      values.push(value);
      return `$${values.length}`;
    };
    const search = String(filters.search || "").trim();
    const status = String(filters.status || "").trim().toLowerCase();
    const service = String(filters.service || "").trim().toLowerCase();
    const from = String(filters.from || "").trim();
    const to = String(filters.to || "").trim();
    if (search) {
      const placeholder = addValue(`%${search.toLowerCase()}%`);
      where.push(`(
        LOWER(t.reference) LIKE ${placeholder}
        OR LOWER(COALESCE(t.recipient_reference, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(t.service_code, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(pr.service_name, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(u.full_name, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(u.username, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(u.email, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(u.phone, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(m.business_name, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(m.merchant_id, '')) LIKE ${placeholder}
        OR LOWER(COALESCE(w.wallet_number, '')) LIKE ${placeholder}
        OR LOWER(t.metadata::TEXT) LIKE ${placeholder}
      )`);
    }
    if (status) where.push(`LOWER(t.status) = ${addValue(status)}`);
    if (service) where.push(`LOWER(t.service_code) = ${addValue(service)}`);
    if (from) where.push(`t.created_at >= ${addValue(from)}::TIMESTAMPTZ`);
    if (to) where.push(`t.created_at < (${addValue(to)}::DATE + INTERVAL '1 day')`);
    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.user_id,
         t.wallet_id,
         t.merchant_id,
         t.qr_code_id,
         t.service_code,
         t.amount,
         t.fee,
         t.total,
         t.status,
         t.direction,
         t.reference,
         t.recipient_reference,
         t.metadata,
         t.created_at,
         t.updated_at,
         pr.service_name,
         COALESCE((t.metadata->>'netAmount')::NUMERIC, t.amount) AS net_amount,
         u.full_name,
         u.username,
         u.email,
         u.phone,
         u.account_type,
         w.wallet_number,
         w.kind AS wallet_kind,
         w.currency,
         m.business_name,
         m.merchant_id AS merchant_number,
         q.reference AS qr_reference,
         COALESCE(rl.fee_collected, 0)::NUMERIC AS revenue_recorded,
         rl.created_at AS revenue_recorded_at,
         t.metadata->>'orderId' AS ticket_order_id,
         t.metadata->>'eventId' AS ticket_event_id,
         t.metadata->>'batchId' AS bulk_batch_id,
         t.metadata->>'organisationId' AS bulk_organisation_id,
         -- Payment diagnostics for authorised admins. The customer is shown a
         -- mapped sentence with none of this in it; the detail has to remain
         -- somewhere an operator can reach, and this is that somewhere.
         t.metadata->>'provider' AS provider,
         t.metadata->>'providerState' AS provider_state,
         t.metadata->>'failureReason' AS failure_reason,
         t.metadata->>'resultCode' AS provider_result_code,
         t.metadata->>'payoutStatus' AS payout_status,
         (t.metadata->>'requiresReview')::BOOLEAN AS requires_review,
         (posted.entry_count > 0) AS wallet_posted,
         posted.net_posted AS posted_amount
       FROM transactions t
       ${POSTED_LEDGER_LATERAL}
       LEFT JOIN pricing_rules pr ON pr.service_code = t.service_code
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN wallets w ON w.id = t.wallet_id
       LEFT JOIN merchants m ON m.id = t.merchant_id
       LEFT JOIN qr_codes q ON q.id = t.qr_code_id
       LEFT JOIN (
         SELECT transaction_id, SUM(fee_collected)::NUMERIC AS fee_collected, MAX(created_at) AS created_at
         FROM revenue_ledger
         GROUP BY transaction_id
       ) rl ON rl.transaction_id = t.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.created_at DESC
       LIMIT ${addValue(limit)}`,
      values
    );
    return rows.map((row) => ({
      ...row,
      owner_name: row.business_name || row.full_name || "System / Platform",
      owner_identifier: row.username || row.email || row.phone || row.merchant_number || row.wallet_number || null,
      service_name: row.service_name || row.service_code,
      financial_route: row.wallet_posted
        ? (row.revenue_recorded > 0 ? "Customer/Merchant + TitoPay Revenue" : "Customer/Merchant Funds")
        : "No money moved",
      // A transaction the wallet ledger never posted has nothing to reconcile:
      // its fee was quoted, not charged, so comparing it against zero collected
      // revenue would flag every failed attempt for review and bury the real
      // breaks — a settled transaction whose fee never reached the revenue
      // ledger — under the noise.
      reconciliation_status: !row.wallet_posted
        ? "not_settled"
        : Number(row.revenue_recorded || 0) === Number(row.fee || 0) ? "matched"
        : Number(row.fee || 0) === 0 ? "no_fee"
        : "review",
      // What the customer was actually charged, as opposed to what an attempt
      // quoted. Zero until the wallet ledger says the movement happened.
      fee_charged: row.wallet_posted ? Number(row.fee || 0) : 0
    }));
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("transactions.listAllTransactions", error);
    return [];
  }
}

async function reverseTransaction(id, actor) {
  const client = await pool.connect();
  let reversedTransaction;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM transactions WHERE id = $1 FOR UPDATE",
      [id]
    );
    const transaction = rows[0];
    if (!transaction) throw new AppError(404, "Transaction not found");
    if (transaction.status === "reversed") throw new AppError(409, "Transaction is already reversed");
    if (transaction.status !== "completed") {
      throw new AppError(409, "Only completed transactions can be reversed automatically");
    }
    const { rows: ledgerRows } = await client.query(
      `SELECT *
       FROM wallet_ledger
       WHERE transaction_id = $1
         AND entry_type IN ('debit','credit','reserve','release')
       ORDER BY created_at DESC, id DESC`,
      [id]
    );
    if (!ledgerRows.length) throw new AppError(409, "Transaction has no wallet ledger entries to reverse");
    const reversalReference = txReference("REV");
    for (const entry of ledgerRows) {
      const reverseType = {
        debit: "credit",
        credit: "debit",
        reserve: "release",
        release: "reserve"
      }[entry.entry_type];
      await applyWalletMovement(client, {
        walletId: entry.wallet_id,
        transactionId: id,
        entryType: reverseType,
        amount: entry.amount,
        reference: reversalReference,
        metadata: {
          reversalOfLedgerId: entry.id,
          originalReference: transaction.reference,
          reversedBy: actor.userId
        }
      });
    }
    if (Number(transaction.fee || 0) > 0) {
      const { rows: revenueRows } = await client.query(
        "SELECT revenue_wallet_id FROM revenue_ledger WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1",
        [id]
      );
      if (revenueRows[0]?.revenue_wallet_id) {
        await client.query(
          `INSERT INTO revenue_ledger
            (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), id, transaction.service_code, -Math.abs(Number(transaction.fee)), revenueRows[0].revenue_wallet_id]
        );
      }
    }
    const { rows: updatedRows } = await client.query(
      `UPDATE transactions
       SET status = 'reversed',
           metadata = COALESCE(metadata, '{}'::JSONB) || $2::JSONB,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify({ reversedAt: new Date().toISOString(), reversedBy: actor.userId })]
    );
    reversedTransaction = updatedRows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "transaction_reversed",
    entityType: "transaction",
    entityId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { automaticLedgerReversal: true }
  });
  return reversedTransaction;
}

async function revenueSummary() {
  try {
    const [walletResult, byService, daily] = await Promise.all([
      pool.query("SELECT * FROM wallets WHERE kind = 'revenue' AND user_id IS NULL LIMIT 1"),
      pool.query(
        `SELECT service_code AS service_type, SUM(fee_collected)::NUMERIC AS total
         FROM revenue_ledger
         GROUP BY service_code
         ORDER BY total DESC`
      ),
      pool.query(
        `SELECT TO_CHAR(created_at::DATE, 'YYYY-MM-DD') AS day, SUM(fee_collected)::NUMERIC AS total
         FROM revenue_ledger
         GROUP BY created_at::DATE
         ORDER BY created_at::DATE DESC
         LIMIT 30`
      )
    ]);
    return {
      wallet: walletResult.rows[0] || null,
      byService: byService.rows,
      daily: daily.rows
    };
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning("transactions.revenueSummary", error);
    return { wallet: null, byService: [], daily: [] };
  }
}

module.exports = {
  feePreview,
  createTransaction,
  listTransactionsForUser,
  listAllTransactions,
  reverseTransaction,
  revenueSummary
};
