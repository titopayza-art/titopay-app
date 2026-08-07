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
// Withdrawal processing is a separate build step from the provider connection.
// Flipping this on must go hand in hand with the debit + payout-submission +
// provider-confirmation lifecycle; it is deliberately not implied by a
// successful payout connection test.
const PAYOUT_PROCESSING_ENABLED = String(process.env.PEACH_PAYOUT_PROCESSING_ENABLED || "").toLowerCase() === "true";

const PEACH_PAYOUT_SERVICES = new Set([
  "withdraw",
  "withdraw_money_to_bank",
  "withdraw_cash",
  "bank_withdrawal",
  "cash_withdrawal",
  "bank_transfer",
  "payouts",
  "business_payout",
  "merchant_payout",
  "merchant_payouts",
  "seller_payout",
  "bulk_distribution_bank_payout"
]);

const PROVIDER_DEPENDENT_SERVICES = new Set([
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
    // First the provider link, so the customer sees the real reason when the
    // payout capability is unconfigured, disabled or unverified.
    const availability = await payoutAvailability();
    assertPayoutAvailable(availability);
    // A connected payout provider proves the link works — it does not mean
    // TitoPay has a withdrawal lifecycle yet. Until PAYOUT_PROCESSING_ENABLED
    // is switched on, withdrawals stay blocked HERE, at the fee preview, so a
    // customer is never walked through a fee to a Confirm that cannot settle,
    // and createTransaction can never debit a wallet with nothing on the other
    // side to move the money.
    if (!PAYOUT_PROCESSING_ENABLED) {
      throw new AppError(
        503,
        "Withdrawals are not open yet. The payout provider is connected, but TitoPay withdrawal processing is still being enabled. No wallet debit was made.",
        { code: "PAYOUT_PROCESSING_NOT_ENABLED" }
      );
    }
    return;
  }
  if (CARD_TOPUP_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(
      409,
      "Card top-ups are completed through the secure card payment flow. No wallet debit was made.",
      { code: "USE_CARD_TOPUP_FLOW", endpoint: "/v1/payments/topup" }
    );
  }
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

async function listTransactionsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT t.*, pr.service_name, (t.metadata->>'netAmount')::NUMERIC AS net_amount
     FROM transactions t
     LEFT JOIN pricing_rules pr ON pr.service_code = t.service_code
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
         t.metadata->>'organisationId' AS bulk_organisation_id
       FROM transactions t
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
      financial_route: row.revenue_recorded > 0 ? "Customer/Merchant + TitoPay Revenue" : "Customer/Merchant Funds",
      reconciliation_status: Number(row.revenue_recorded || 0) === Number(row.fee || 0) ? "matched" : Number(row.fee || 0) === 0 ? "no_fee" : "review"
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
