const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
// The payout CAPABILITY, not a payout company. Which provider supplies it is
// configuration; this file must never know or care.
const { payoutAvailability, assertPayoutAvailable } = require("../providers/payout-provider");
const { writeAuditLog } = require("./audit-service");
const { queueEmail } = require("./email-centre-service");
const { shouldSendCustomerEmail } = require("./customer-notification-preference-service");
const { recordBeneficiaryPayment } = require("./beneficiary-service");
const { calculateFee, roundMoney, normalizeServiceCode } = require("./pricing-service");
const { recipientLookupValues, recipientPhoneLookupValues, verifyRecipient } = require("./security-service");
const { getPrimaryWalletForUser, getRevenueWallet, applyWalletMovement } = require("./wallet-service");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");
// VALUE-ADDED SERVICES: airtime, data, electricity, vouchers, bill payments.
//
// ONE canonical list, in lib/vas-services.js, read by the catalogue gate and
// the purchase rail as well. It used to be a second copy in this file and the
// two disagreed: the catalogue knew the alias codes the app actually uses
// ("airtime-and-data" is the real service_code behind the Airtime & Data tile)
// and this copy did not. So the tile was correctly held at "coming soon" while
// this engine would have accepted airtime_and_data straight through to a bare
// wallet debit — money out, nothing delivered, no supplier contracted to
// deliver it. An endpoint does not care what a tile says.
const { isVasService } = require("../lib/vas-services");

const REGISTERED_RECIPIENT_SERVICES = new Set([
  "wallet_transfer",
  "send_money",
  "send_gift",
  "tip",
  "payment_request",
  "business_payment_request",
  "bill_split",
  "stockvel",
  "stockvel_contribution"
]);

const LIVE_SINGLE_RECIPIENT_WALLET_SERVICES = new Set([
  "wallet_transfer",
  "send_money",
  "send_gift",
  "tip",
  // A stokvel contribution is a transfer to the group's treasurer (the chair),
  // made through POST /v1/stockvels/:id/contributions, which resolves the
  // treasurer server-side. The group balance is derived from these rows.
  "stockvel_contribution"
]);

const LIVE_QR_WALLET_SERVICES = new Set([
  "qr_payment",
  "qr_pay",
  "customer_qr_payment"
]);

// Services where TitoPay sells something itself and the schedule fee IS the
// whole price. There is no principal, and no third party to receive one.
//
// Every other service here moves money to somebody: `amount` is what the
// recipient gets and the fee is TitoPay's cut on top. A Business Document PDF
// has no recipient, so the customer app filled the required `amount` in with
// the price — and the server then charged the schedule fee ON TOP of it.
// /v1/transactions/fee-preview returned amount 2.50 + fee 2.50 = total 5.00 for
// a PDF advertised at R2.50, and the 2.50 "principal" had nowhere to go:
// "TitoPay Revenue Wallet" matches no username, email or wallet number, so
// resolveRecipientWallet returned null and only the fee was ever credited.
//
// For these codes the client does not supply an amount at all and cannot name
// its own price: the amount is 0, the fee comes from the pricing schedule, and
// the total is the fee. Debit the fee, credit the fee to revenue, balanced.
const FEE_ONLY_SERVICES = new Set([
  "business_document_pdf"
]);

const REQUEST_ONLY_SERVICES = new Set([
  "payment_request",
  "request_money",
  "business_payment_request"
]);

// Old clients still submit these codes straight into the wallet-debit flow,
// where money would leave with no resolvable recipient on the other side.
// They stay refused. The LIVE flows are elsewhere: bill_split fans out
// payment requests under /v1/payments/requests, and stokvel contributions
// run as treasurer transfers under /v1/stockvels/:id/contributions.
const MULTI_PARTY_SERVICES_PENDING_SETTLEMENT = new Set([
  "bill_split",
  "stockvel"
]);

// Card top-ups are a wallet CREDIT funded by the PAYMENT capability, not a
// wallet debit, so they can never run through createTransaction. They have
// their own lifecycle at /v1/payments/topup.
const CARD_TOPUP_SERVICES = new Set([
  "wallet_top_up",
  "top_up",
  "card_topups",
  "card_payments"
]);

// Withdrawals and payouts are money OUT and belong to the PAYOUT capability,
// never to a collection or checkout rail. They stay unavailable until that
// capability is configured, enabled and its own connection test has succeeded.
// This file asks the capability and never names the company behind it: which
// provider supplies payouts is configuration, resolved in src/providers.
// The service catalogue publishes the code "payouts"; without it here the block
// only happened via the catch-all, and a fee preview first wrote a zero-fee
// "payouts" pricing rule to the database.
// Withdrawal processing was previously held behind a processing-enabled flag
// because a connected payout provider is not the same thing as a withdrawal
// lifecycle: without the debit + submission + provider-confirmation chain, a
// Confirm could have debited a wallet with nothing on the other side to move
// the money. That chain now exists in the withdrawal lifecycle, which debits
// once inside the same database transaction that records the withdrawal,
// submits to the payout provider, and reverses exactly once if the provider
// reports the payout failed. The flag is therefore gone rather than bypassed —
// the safety it was standing in for is implemented.
// BANK payouts only. The payout capability pays a bank account, so a CASH
// withdrawal is a different product with a different partner and is not routed
// here — sending it to the payout flow would tell the customer to use an
// endpoint that then refuses them. Cash stays with the unlaunched services
// below until it has a provider of its own.
const BANK_PAYOUT_SERVICES = new Set([
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
  // Cash out at a till or ATM. The payout capability cannot do this — it pays
  // bank accounts — so it stays unavailable until it has its own provider.
  "withdraw_cash",
  "cash_withdrawal",
  "cash_services",
  "gift_cards",
  "marketplace",
  "marketplace_seller_commission",
  "marketplace_commission",
  "marketplace_buyer_service_fee",
  "marketplace_refund_processing",
  // Catalogue doors whose flows are not built yet. Without these entries the
  // fee preview answered cleanly and only Confirm failed — the exact
  // "payment glitch" experience this file exists to prevent. Listed here,
  // the customer is told at the preview that the service is not live.
  "shop_marketplace",
  "rewards",
  "business_rewards",
  "virtual_doctor",
  "travel",
  "donate",
  "cross_border",
  "get_cash",
  "cash_back",
  "refund"
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
  // Money out: ask the payout capability directly, so the customer is told the
  // real reason and a withdrawal can never be attempted through a collection
  // rail.
  if (BANK_PAYOUT_SERVICES.has(normalizedServiceCode)) {
    // The provider link, so the customer sees the real reason when the payout
    // capability is unconfigured, disabled or unverified — checked here, at the
    // fee preview, so nobody is walked through a fee to a Confirm that cannot
    // settle. The withdrawal itself runs at POST /v1/payouts/withdrawals.
    assertPayoutAvailable(await payoutAvailability());
    return;
  }
  // Card top-ups are deliberately NOT rejected here. The fee preview is a
  // read-only price calculation, and the customer has to be shown the top-up fee
  // before they are sent to the card page — the amount the payment provider
  // charges is amount + fee. Blocking the preview stopped the top-up before it
  // began. The wallet-debit path is refused in assertLiveTransactionSupported
  // instead, so createTransaction still cannot be used to fake a top-up.
  if (REQUEST_ONLY_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(409, "Payment requests create a request only. No wallet debit was made.");
  }
  if (MULTI_PARTY_SERVICES_PENDING_SETTLEMENT.has(normalizedServiceCode)) {
    throw new AppError(503, `${providerPendingMessage(normalizedServiceCode)} This service needs its dedicated settlement workflow before launch.`);
  }
  // Asked, not listed. The adapter declares whether it can send a purchase; if
  // it cannot, the customer is told here at the fee preview rather than after
  // filling in a form and pressing Confirm.
  if (isVasService(normalizedServiceCode)) {
    if (!require("../providers/vas-provider").vasCanPurchase()) {
      throw new AppError(503, providerPendingMessage(normalizedServiceCode));
    }
    return;
  }
  if (PROVIDER_DEPENDENT_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(503, providerPendingMessage(normalizedServiceCode));
  }
}

async function assertLiveTransactionSupported(normalizedServiceCode, payload = {}) {
  await assertServiceLaunched(normalizedServiceCode);
  // A card top-up is a wallet CREDIT funded by the payment provider, so it can
  // never be created through the wallet-debit endpoint. Only createTransaction
  // reaches this, which keeps the fee preview above working.
  if (CARD_TOPUP_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(
      409,
      "Card top-ups are completed through the secure card payment flow. No wallet debit was made.",
      { code: "USE_CARD_TOPUP_FLOW", endpoint: "/v1/payments/topup" }
    );
  }
  // A withdrawal debits the wallet AND submits a payout to the provider, and
  // the two have to happen in one controlled lifecycle so a failed payout can
  // be reversed exactly once. createTransaction only does the debit, so it
  // would take the money with nothing on the other side to move it.
  if (BANK_PAYOUT_SERVICES.has(normalizedServiceCode)) {
    throw new AppError(
      409,
      "Withdrawals are completed through the payout flow. No wallet debit was made.",
      { code: "USE_WITHDRAWAL_FLOW", endpoint: "/v1/payouts/withdrawals" }
    );
  }
  // A VAS PURCHASE MAY NEVER BE A BARE WALLET DEBIT. Same reasoning as a
  // withdrawal, and it is the reason making the tiles "available" is not one
  // change but two: a VAS purchase debits the wallet AND has to deliver a
  // redeemable token. createTransaction only does the first, so opening the
  // fee preview above without this refusal would let a working adapter take
  // the money with nothing on the other side to deliver.
  //
  // This refusal is UNCONDITIONAL — it does not ask the capability. Whether a
  // supplier is contracted has no bearing on whether this endpoint is the
  // right door, and a guard that relaxes on someone else's configuration is a
  // guard that will one day be open when it should not be.
  if (isVasService(normalizedServiceCode)) {
    throw new AppError(
      409,
      "Airtime, data, electricity, vouchers and bill payments are completed through the purchase flow. No wallet debit was made.",
      { code: "USE_VAS_PURCHASE_FLOW", endpoint: "/v1/vas/purchase" }
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
  const feeOnly = FEE_ONLY_SERVICES.has(normalizedServiceCode);
  // A fee-only service has no principal, so it does not ask for one and does
  // not accept one. Anything the caller sends is discarded before pricing.
  const amount = feeOnly ? 0 : Number(payload.amount);
  if (!feeOnly && (!Number.isFinite(amount) || amount <= 0)) {
    throw new AppError(400, "amount must be greater than zero");
  }
  await assertServiceLaunched(normalizedServiceCode);
  const fee = await calculateFee(normalizedServiceCode, amount);
  if (feeOnly) {
    return {
      amount: 0,
      fee: fee.fee,
      total: fee.fee,
      recipient: null,
      transactionType: normalizedServiceCode,
      serviceCode: normalizedServiceCode,
      serviceName: fee.serviceName,
      recipientStatus: null
    };
  }
  let recipientStatus = null;
  const recipientChecks = recipientsForVerification(payload, normalizedServiceCode);
  if (REGISTERED_RECIPIENT_SERVICES.has(normalizedServiceCode) && recipientChecks.length) {
    const verifiedRecipients = [];
    for (const recipient of recipientChecks) {
      const status = await verifyRecipient(payload.actor || { userType: "system", userId: null }, { recipient });
      if (!status.registered) {
        throw new AppError(404, status.message, { invite: status.invite, recipient });
      }
      assertRecipientCanReceive(status.recipient);
      // The recipient's own capacity, from config, derived from the ledger.
      // A payment that fails ONLY on that capacity is not refused: it is
      // held for the recipient to claim by verifying, so the sender is
      // never blocked by someone else's paperwork and no money is lost.
      let holdForVerification = false;
      if (status.recipient?.userId) {
        try {
          await require("./compliance-service").assertCanReceiveAmount(status.recipient.userId, amount, { serviceCode: normalizedServiceCode });
        } catch (error) {
          if (!error.recipientCapacityOnly) throw error;
          if (!(await require("./pending-credit-service").holdApplies(normalizedServiceCode))) throw error;
          holdForVerification = true;
        }
      }
      verifiedRecipients.push({ identifier: recipient, ...status, holdForVerification });
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

// RECEIVING IS OPEN UNLESS THE ACCOUNT IS BLOCKED. Policy decision: FICA
// status does not gate receiving money. The only accounts that cannot
// receive are the ones TitoPay has blocked, suspended or closed.
const { BLOCKED_ACCOUNT_STATUSES } = require("../lib/chat-policy");

function assertRecipientCanReceive(recipient) {
  if (!recipient?.userId) return;
  const accountStatus = String(recipient.status || "").toLowerCase();
  if (BLOCKED_ACCOUNT_STATUSES.has(accountStatus)) {
    throw new AppError(403, "This account cannot receive money at the moment. The recipient should contact TitoPay support.");
  }
}

async function resolveRecipientWallet(recipient) {
  if (!recipient) return null;
  const lookupValues = recipientLookupValues({ recipient }).map((value) => String(value).toLowerCase());
  const phoneLookupValues = recipientPhoneLookupValues({ recipient });
  // w.kind <> 'system' does two jobs. It keeps a TitoKids child wallet from
  // ever being a transfer destination, even one that was assigned a wallet
  // number before the backfills learned to skip them: money reaches a child
  // through the TitoKids fund flow, with its notifications and limits, or not
  // at all. And for username/email/phone matches it makes the oldest REAL
  // wallet win, instead of trusting that a child wallet is never the oldest.
  const { rows } = await pool.query(
    `SELECT w.*, u.username, u.email, u.phone, u.full_name
     FROM users u
     JOIN wallets w ON w.user_id = u.id
     WHERE w.kind <> 'system'
       AND (LOWER(u.username) = ANY($1::TEXT[])
        OR LOWER(u.email) = ANY($1::TEXT[])
        OR LOWER(u.phone) = ANY($1::TEXT[])
        OR LOWER(COALESCE(w.wallet_number, '')) = ANY($1::TEXT[])
        OR REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = ANY($2::TEXT[]))
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
  const feeOnly = FEE_ONLY_SERVICES.has(normalizedServiceCode);
  const amount = feeOnly ? 0 : roundMoney(payload.amount);
  if (!serviceCode) throw new AppError(400, "service is required");
  if (!feeOnly && (!Number.isFinite(amount) || amount <= 0)) {
    throw new AppError(400, "amount must be greater than zero");
  }
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

  // The sender's own tier limits, from config: single transaction and
  // monthly send. Checked before any wallet work so the refusal is clean.
  if (!feeOnly) {
    await require("./compliance-service").assertCanSendAmount(actor.userId, amount, { serviceCode: normalizedServiceCode });
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
  // A fee-only service has no third party, so no recipient is resolved and no
  // recipient is credited. Without this, a caller could name any wallet as the
  // "recipient" of a purchase from TitoPay.
  const recipientWallet = feeOnly ? null : await resolveRecipientWallet(payload.recipient);
  // MONEY WITH NOWHERE TO LAND IS NOT A PAYMENT.
  //
  // Below, the recipient is credited only `if (recipientWallet)`, and there was
  // no else. A payment whose recipient could not be resolved therefore debited
  // the payer in full, collected the fee, credited nobody, held nothing, and
  // returned status "completed". Measured on a QR whose owner had no wallet
  // row: R200.50 left the payer, R0.50 reached revenue, and R200.00 existed
  // nowhere at all.
  //
  // Only the wallet-recipient services reach this line — assertLiveTransactionSupported
  // has already refused everything else with a 503 — so this cannot affect a
  // service that legitimately pays out to somewhere that is not a TitoPay
  // wallet. Nothing has moved yet: this throws before BEGIN.
  if (!feeOnly && !recipientWallet) {
    throw new AppError(404,
      "TitoPay could not find the wallet this payment is for, so nothing was taken from your wallet. "
      + "Check the recipient and try again, or contact Support if it continues.");
  }
  const revenueWallet = (preview.fee > 0 || Number(payload.recipientFee || 0) > 0)
    ? await getRevenueWallet() : null;
  const txId = uuidv4();
  const reference = txReference();
  // preview.amount, not the request body. For every service except the
  // fee-only ones these are the same number — calculateFee returns the amount
  // it was given — so this changes nothing anywhere else. For a fee-only
  // service it is what stops the customer being charged twice: the preview
  // says amount 0, fee 2.50, total 2.50, and the debit follows the preview.
  const chargedAmount = roundMoney(preview.amount);
  // THE RECIPIENT'S OWN FEE, TAKEN OUT OF WHAT THEY ARE CREDITED.
  //
  // A QR payment now has two sides: the customer pays R1.50 + 1% capped at R10
  // on top of the amount, and the merchant is charged 1.5% of it out of
  // settlement. Only the payer's side existed here; merchantReceivesFee simply
  // moved the ONE fee from the payer to the recipient, so a merchant rate could
  // not be expressed at all. A merchant_qr_payment rule has sat in the schedule
  // since it was written, read by nothing, and every merchant has been credited
  // in full on every payment TitoPay has ever settled.
  //
  // The double entry still balances exactly, which is the only thing that
  // matters here:
  //
  //   payer debited     amount + payerFee
  //   recipient credited amount - recipientFee
  //   revenue credited   payerFee + recipientFee
  //
  // Zero for every service that does not pass one, so nothing else moves.
  const recipientFee = feeOnly ? 0 : Math.max(0, roundMoney(Number(payload.recipientFee || 0)));
  if (recipientFee > chargedAmount) {
    throw new AppError(400, "The fee on this payment is larger than the payment itself.");
  }
  // The two fee mechanisms are mutually exclusive: merchantReceivesFee moves the
  // single preview fee onto the recipient, while recipientFee is a separate
  // recipient-side charge. Setting both would credit revenue payerFee+recipientFee
  // while only debiting the payer chargedAmount, so credits would exceed debits by
  // recipientFee and the double entry would not balance. No caller sets both today
  // (the public route strips both fields; qr-service always passes
  // merchantReceivesFee:false), but assert it so a future caller cannot unbalance
  // the ledger.
  if (payload.merchantReceivesFee && recipientFee > 0) {
    throw new AppError(400, "A payment cannot apply both the merchant-fee and recipient-fee mechanisms at once.");
  }
  const netAmount = roundMoney(
    payload.merchantReceivesFee ? chargedAmount - preview.fee : chargedAmount - recipientFee
  );
  // Set inside the money transaction when the recipient's credit is held
  // for verification; read after commit to tell them about it.
  let pendingHold = null;
  const debitTotal = payload.merchantReceivesFee ? chargedAmount : preview.total;

  // A fee-only service priced at zero by an operator would otherwise reach the
  // ledger's amount-must-be-positive guard as a 500. Refuse it as configuration.
  if (!(debitTotal > 0)) throw new AppError(400, "This service is not priced yet. Please try again later.");
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
    // Serialize this sender's limit consumption, ALWAYS — not only when an
    // idempotency key was supplied. The assertCanSendAmount at the top ran
    // unlocked on the pool, so two concurrent R150k sends each read usage 0
    // against a R200k month and both passed. The monthly/velocity cap is a
    // regulatory control; whether the client sent an Idempotency-Key is the
    // client's choice and must never decide whether the cap is enforced. Under
    // this per-user lock a competitor's ledger rows are committed before our
    // re-read, so the second send sees the first one's usage and is refused
    // here — before any row is written, so the throw rolls back cleanly.
    if (!feeOnly) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`limits:${actor.userId}`]);
      await require("./compliance-service").assertCanSendAmount(actor.userId, chargedAmount, { serviceCode: normalizedServiceCode });
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
        chargedAmount,
        preview.fee,
        debitTotal,
        reference,
        payload.recipient || null,
        JSON.stringify({ ...payload.metadata, clientIdempotencyKey: idempotencyKey || payload.metadata?.clientIdempotencyKey || null, netAmount, payerFee: preview.fee, recipientFee, recipientWalletId: recipientWallet?.id || null, ...(recipientWallet ? { recipientName: recipientWallet.full_name || null, recipientUsername: recipientWallet.username || null, recipientContact: recipientWallet.phone || recipientWallet.email || null } : {}) })
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
    // The recipient is credited unless their capacity says the money must
    // wait for them to verify. A held credit posts nothing to their wallet:
    // it is a liability record against the sender's debit, released or
    // returned in full later, never a spendable balance that gets frozen.
    const holdForVerification = Boolean(preview.recipientStatus?.holdForVerification);
    if (recipientWallet && holdForVerification) {
      pendingHold = await require("./pending-credit-service").createHold(client, {
        transactionId: txId,
        senderUserId: actor.userId,
        recipientUserId: recipientWallet.user_id,
        amount: netAmount,
        serviceCode: normalizedServiceCode,
        // The fee travels with the hold: a payment that is never delivered
        // is refunded in full, service fee included, so nobody pays for a
        // transfer that did not happen.
        metadata: { reference, senderName: actor.fullName || null, fee: preview.fee, serviceCode: normalizedServiceCode }
      });
    } else if (recipientWallet) {
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
      // Both sides of the fee land here, so the ledger balances against the
      // payer's debit and the recipient's reduced credit.
      const collected = roundMoney(preview.fee + recipientFee);
      await applyWalletMovement(client, {
        walletId: revenueWallet.id,
        transactionId: txId,
        entryType: "credit",
        amount: collected,
        reference,
        metadata: {
          serviceCode: normalizedServiceCode,
          source: "fee",
          payerFee: preview.fee,
          recipientFee
        }
      });
      await client.query(
        `INSERT INTO revenue_ledger
          (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), txId, normalizedServiceCode, collected, revenueWallet.id]
      );
    }
    if (recipientWallet?.user_id) {
      await recordBeneficiaryPayment(actor.userId, recipientWallet.user_id, chargedAmount, client);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Fire-and-forget monitoring: the transfer has already committed, so a review
  // failure must never surface as a failed payment. reviewForEdd self-guards, but
  // attach a .catch here too so the contract is local — a floating rejection can
  // never become an unhandledRejection if that internal guard is ever removed.
  Promise.resolve(require("./compliance-service").reviewForEdd(actor.userId, chargedAmount, normalizedServiceCode)).catch(() => {});
  // Monitoring follows the money. A held credit has not reached the
  // recipient, so their review happens when it is released, not now.
  if (recipientWallet?.user_id && !pendingHold) {
    Promise.resolve(require("./compliance-service").reviewForEdd(recipientWallet.user_id, netAmount, normalizedServiceCode)).catch(() => {});
  }
  // The held payment is announced after the money is committed, so a
  // notification failure can never undo a transfer.
  if (pendingHold && recipientWallet?.user_id) {
    require("./pending-credit-service").notifyHold({
      id: pendingHold.id,
      recipientUserId: recipientWallet.user_id,
      senderUserId: actor.userId,
      recipientName: recipientWallet.full_name || recipientWallet.username || null,
      senderName: actor.fullName || actor.username || null,
      amount: netAmount,
      holdDays: pendingHold.holdDays
    }).catch(() => {});
  }
  // NOTHING AFTER COMMIT MAY TELL THE CALLER THE PAYMENT FAILED.
  //
  // The money is already gone by this line; the transaction committed above and
  // cannot be undone by anything here. An unguarded throw therefore reported a
  // failure for a payment that had SUCCEEDED, and the customer's natural next
  // move is to try again. I hit exactly this while seeding: 28 contributions
  // committed, 141 ledger rows written, and every single call raised an error.
  //
  // The notifyHold call directly above already gets this right and says so.
  // The audit write did not. A failure to record the audit line is a logging
  // problem worth shouting about in the server log; it is not a reason to tell
  // somebody their money did not move.
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "transaction_completed",
    entityType: "transaction",
    entityId: txId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { serviceCode: normalizedServiceCode, amount: chargedAmount, fee: preview.fee, recipient: payload.recipient || null }
  }).catch((error) => {
    console.error("[transaction] audit log not written; the transfer still stands", {
      transactionId: txId, serviceCode: normalizedServiceCode, reason: error?.message || "unknown"
    });
  });
  try {
    const { rows: accountRows } = await pool.query("SELECT email,full_name FROM users WHERE id=$1", [actor.userId]);
    const account = accountRows[0];
    if (account?.email && await shouldSendCustomerEmail(actor.userId, "transaction")) {
      const templateKey = /qr/.test(normalizedServiceCode) ? "qr_payment_receipt"
        : /top.?up/.test(normalizedServiceCode) ? "wallet_top_up_receipt"
          : /transfer|send/.test(normalizedServiceCode) ? "money_transfer_receipt" : "payment_receipt";
      await queueEmail({ recipient:account.email, templateKey, userId:actor.userId,
        variables:{fullName:account.full_name,email:account.email,amount:chargedAmount.toFixed(2),currency:"ZAR",transactionReference:reference,recipientLine:recipientWallet?[recipientWallet.full_name,recipientWallet.username?`@${recipientWallet.username}`:"",recipientWallet.phone||recipientWallet.email||""].filter(Boolean).join(", "):String(payload.recipient||"")},
        idempotencyKey:`transaction-receipt:${txId}`, metadata:{transactionId:txId,serviceCode:normalizedServiceCode} });
    }
  } catch (error) {
    console.error("[transaction] receipt queue failed", { transactionId:txId, message:error.message });
  }
  // AND THE OTHER HALF: TELL THE PERSON WHO WAS PAID.
  //
  // The receipt above goes to actor.userId, the PAYER, and for as long as this
  // function has existed that was the only message a payment produced. The
  // receiver was told nothing, on every service that routes through here: QR
  // payments from a poster or a till, money sent to a username, a paid payment
  // request, a bill split, a stokvel contribution.
  //
  // netAmount is deliberately the figure used, not chargedAmount: it is what
  // actually reached the wallet once the receiver's own fee came off, so the
  // notice agrees with the balance the person is about to look at.
  //
  // Two cases are skipped because they already have a better notice of their
  // own, and two notices for one payment is its own kind of broken:
  //   send_gift    sends the sender's name, occasion and message
  //   pendingHold  the money has NOT arrived yet; notifyHold says exactly that
  if (recipientWallet?.user_id && !pendingHold && normalizedServiceCode !== "send_gift") {
    const { rows: payerRows } = await pool.query("SELECT full_name, username FROM users WHERE id=$1", [actor.userId]).catch(() => ({ rows: [] }));
    const payer = payerRows[0];
    await require("./payment-received-service").notifyPaymentReceived({
      recipientUserId: recipientWallet.user_id,
      amount: netAmount,
      fee: recipientFee,
      transactionId: txId,
      reference,
      serviceCode: normalizedServiceCode,
      payerName: payer?.full_name || (payer?.username ? `@${payer.username}` : "")
    });
  }
  // A gift is money WITH a message. The transfer above delivered the money;
  // this delivers the gift: the recipient is told who sent it, for what
  // occasion, and what they wrote - in the app and by email. Without this the
  // "digital gift" arrived as an anonymous credit.
  if (normalizedServiceCode === "send_gift" && recipientWallet?.user_id) {
    try {
      const occasion = String(payload.metadata?.customOccasion || payload.metadata?.occasion || "").trim().slice(0, 60);
      const giftMessage = String(payload.metadata?.message || "").trim().slice(0, 240);
      const { rows: senderRows } = await pool.query("SELECT full_name, username FROM users WHERE id=$1", [actor.userId]);
      const senderName = senderRows[0]?.full_name || (senderRows[0]?.username ? `@${senderRows[0].username}` : "Someone");
      const amountLabel = `R${netAmount.toFixed(2)}`;
      const occasionLine = occasion && occasion.toLowerCase() !== "custom" ? ` for ${occasion}` : "";
      await require("./notification-service").createNotification({
        user: { id: recipientWallet.user_id, user_type: "customer" },
        channel: "in_app", notificationType: "gift_received", provider: "in_app",
        title: `${senderName} sent you a gift of ${amountLabel}`,
        body: `${senderName} sent you ${amountLabel}${occasionLine}.${giftMessage ? ` Their message: "${giftMessage}"` : ""} The money is in your wallet now.`,
        metadata: { transactionId: txId, reference, occasion: occasion || null, clientNotificationId: `gift-${txId}` }
      });
      const { rows: recipientRows } = await pool.query("SELECT email, full_name FROM users WHERE id=$1", [recipientWallet.user_id]);
      const giftRecipient = recipientRows[0];
      if (giftRecipient?.email) {
        const emailCentre = require("./email-centre-service");
        const escape = emailCentre.escapeHtml;
        await emailCentre.queueRawEmail({
          recipient: giftRecipient.email,
          subject: `${senderName} sent you a gift on TitoPay`,
          textBody: [
            `Hi ${giftRecipient.full_name || "there"},`,
            "",
            `${senderName} sent you a gift of ${amountLabel}${occasionLine}.`,
            ...(giftMessage ? ["", `Their message: "${giftMessage}"`] : []),
            "",
            "The money is already in your TitoPay wallet. Open the app ({{appUrl}}) to see it.",
            "",
            "TitoPay"
          ].join("\n"),
          htmlBody: [
            `<p>Hi ${escape(giftRecipient.full_name || "there")},</p>`,
            `<p><strong>${escape(senderName)}</strong> sent you a gift of <strong>${escape(amountLabel)}</strong>${escape(occasionLine)}.</p>`,
            ...(giftMessage ? [`<p>Their message: &quot;${escape(giftMessage)}&quot;</p>`] : []),
            `<p>The money is already in your TitoPay wallet. <a href="{{appUrl}}">Open the app</a> to see it.</p>`,
            "<p>TitoPay</p>"
          ].join("\n"),
          userId: recipientWallet.user_id,
          idempotencyKey: `gift-received:${txId}`,
          metadata: { transactionId: txId }
        });
      }
    } catch (error) {
      console.error("[transaction] gift notice failed", { transactionId: txId, message: error.message });
    }
  }
  return {
    transactionId: txId,
    reference,
    amount: chargedAmount,
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

// Today's settled activity for the dashboard "Today" card, in South African
// time (the same clock the limit engine rolls on). This is a SQL aggregate,
// not a slice of the 100-row list, so it is scoped to the actual day and
// never capped: however busy the day, the count and totals stay correct.
// Counts COMPLETED transactions only - money that actually moved - so a
// failed or pending row cannot inflate "Out". Same data source (the
// transactions table owned by this user) the card has always used.
async function todaySummaryForUser(userId) {
  // "Today" is the calendar day in South African time, bounded on BOTH ends:
  // a row dated after today (e.g. a future-scheduled settlement) must not
  // inflate the card, so we window [start-of-today, start-of-tomorrow).
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::INT AS records,
       COALESCE(SUM(total) FILTER (WHERE direction = 'credit'), 0)::NUMERIC AS money_in,
       COALESCE(SUM(total) FILTER (WHERE direction = 'debit'), 0)::NUMERIC AS money_out
     FROM transactions
     WHERE user_id = $1
       AND status = 'completed'
       AND created_at >= (DATE_TRUNC('day', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')
       AND created_at <  ((DATE_TRUNC('day', NOW() AT TIME ZONE 'Africa/Johannesburg') + INTERVAL '1 day') AT TIME ZONE 'Africa/Johannesburg')`,
    [userId]
  );
  const row = rows[0] || {};
  return { records: Number(row.records || 0), moneyIn: Number(row.money_in || 0), moneyOut: Number(row.money_out || 0) };
}

// The customer's statement for a chosen period, computed over the WHOLE window
// rather than the last 100 rows the Activity list caches. The money-in/out
// totals and the record count come from window aggregates (COUNT/SUM OVER()),
// so they are complete even when the row list is capped for delivery; the rows
// themselves are capped at a generous 5000 for the PDF/CSV, and the caller is
// told the true total so it can say "showing latest N of M". The money-in/out
// totals count only COMPLETED transactions - settled money that actually moved -
// so a failed, pending or reversed row cannot inflate them (matching
// todaySummaryForUser and the ledger); the row list itself still shows every
// status, each marked. Dates are SA calendar dates, bounded [from 00:00 SAST,
// (to+1 day) 00:00 SAST).
async function statementForUser(userId, { from = null, to = null } = {}) {
  const fromDate = from ? String(from).slice(0, 10) : null;
  const toDate = to ? String(to).slice(0, 10) : null;
  const { rows } = await pool.query(
    `SELECT t.*, pr.service_name, (t.metadata->>'netAmount')::NUMERIC AS net_amount,
            (posted.entry_count > 0) AS wallet_posted,
            posted.entry_count AS ledger_entry_count,
            posted.net_posted AS posted_amount,
            COUNT(*) OVER()::INT AS total_count,
            COALESCE(SUM(ABS(COALESCE(t.total, t.amount, 0))) FILTER (WHERE t.direction = 'credit' AND t.status = 'completed') OVER(), 0) AS money_in_total,
            COALESCE(SUM(ABS(COALESCE(t.total, t.amount, 0))) FILTER (WHERE t.direction IS DISTINCT FROM 'credit' AND t.status = 'completed') OVER(), 0) AS money_out_total
     FROM transactions t
     LEFT JOIN pricing_rules pr ON pr.service_code = t.service_code
     ${POSTED_LEDGER_LATERAL}
     WHERE t.user_id = $1
       AND ($2::date IS NULL OR t.created_at >= ($2::date AT TIME ZONE 'Africa/Johannesburg'))
       AND ($3::date IS NULL OR t.created_at <  (($3::date + INTERVAL '1 day') AT TIME ZONE 'Africa/Johannesburg'))
     ORDER BY t.created_at DESC
     LIMIT 5000`,
    [userId, fromDate, toDate]
  );
  const totalCount = Number(rows[0]?.total_count || 0);
  const totals = {
    moneyIn: Number(rows[0]?.money_in_total || 0),
    moneyOut: Number(rows[0]?.money_out_total || 0)
  };
  // Strip the window-aggregate columns from each returned row - they are the
  // same on every row and belong at the top level, not on each transaction.
  const items = rows.map((row) => {
    const { total_count, money_in_total, money_out_total, ...rest } = row;
    return rest;
  });
  return { items, totalCount, totals };
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
    // Interpret the admin's date filter as SOUTH AFRICAN calendar dates, so an
    // "Aug 1-31" report is exactly the SA month, not UTC-midnight boundaries
    // (which would drop 00:00-02:00 SAST on the 1st and leak the same slice on
    // Sep 1).
    if (from) where.push(`t.created_at >= (${addValue(from)}::DATE AT TIME ZONE 'Africa/Johannesburg')`);
    if (to) where.push(`t.created_at < ((${addValue(to)}::DATE + INTERVAL '1 day') AT TIME ZONE 'Africa/Johannesburg')`);
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

// Service codes that reverseTransaction MUST NOT unwind by flipping ledger legs.
// It only knows how to reverse wallet_ledger entries, which is correct for a
// wallet-internal transfer or QR sale, but wrong where the money settled OUTSIDE
// the ledger or the transaction issued something a ledger flip does not undo:
//   - bank withdrawals/payouts: the money is already at the customer's bank via
//     the payout provider, so re-crediting the wallet pays them twice. These
//     reverse ONLY through peach-withdrawal-service.releaseWithdrawalFunds, and
//     only when the provider reports the payout failed.
//   - top-ups: the card funds are not clawed back, so a ledger reversal removes a
//     wallet credit the customer genuinely paid for.
//   - ticket purchases: the ticket stays valid; refunds go through the ticket
//     refund flow, which also invalidates the ticket.
const NON_REVERSIBLE_SERVICES = new Set([
  ...BANK_PAYOUT_SERVICES,
  "wallet_top_up",
  "top_up",
  "card_topups",
  "ticket_purchase",
  "ticket_sales"
]);

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
    // A blind ledger reversal is only safe when both legs live in the ledger.
    // For money that has already left the platform (bank payout), card money that
    // is not clawed back (top-up), or issued goods (tickets), flipping the ledger
    // would pay the customer twice or leave the goods valid. Refuse here and send
    // the operator to the correct flow.
    if (NON_REVERSIBLE_SERVICES.has(String(transaction.service_code || "").toLowerCase())) {
      throw new AppError(409,
        "This transaction type cannot be reversed here. A bank withdrawal or payout is reversed only when the "
        + "provider reports it failed; a top-up or ticket purchase has its own refund path. Reversing it here would "
        + "move money twice.");
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
    // A held payment has an open pending_credits row pointing at this
    // transaction. The loop below refunds the sender and empties the suspense
    // leg — if the hold stayed 'awaiting_verification', the expiry sweep would
    // later debit suspense AGAIN (other customers' held funds) and pay the
    // sender a second time. Close the hold inside this same transaction so
    // neither releaseHold nor returnHold can ever fire for it.
    await client.query(
      `UPDATE pending_credits
       SET status = 'returned',
           returned_at = NOW(),
           resolution_note = COALESCE(resolution_note, '') ||
             CASE WHEN COALESCE(resolution_note,'') = '' THEN '' ELSE ' ' END ||
             'Closed by admin reversal of the funding transaction.'
       WHERE transaction_id = $1
         AND status = 'awaiting_verification'`,
      [id]
    );
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
    // Claw back what revenue ACTUALLY collected on this transaction, not just
    // the payer fee column. A merchant QR sale collects payerFee + recipientFee
    // into revenue_ledger; writing only -transaction.fee left the recipient-fee
    // share standing as income on every reversed sale. Summing the ledger rows
    // nets out whatever was truly booked (and is naturally zero-safe if a prior
    // clawback already ran).
    const { rows: revenueRows } = await client.query(
      `SELECT COALESCE(SUM(fee_collected), 0) AS collected,
              MAX(revenue_wallet_id::TEXT) AS revenue_wallet_id
       FROM revenue_ledger
       WHERE transaction_id = $1`,
      [id]
    );
    const collected = roundMoney(Number(revenueRows[0]?.collected || 0));
    if (collected > 0 && revenueRows[0]?.revenue_wallet_id) {
      await client.query(
        `INSERT INTO revenue_ledger
          (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), id, transaction.service_code, -collected, revenueRows[0].revenue_wallet_id]
      );
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
  // Same rule as the completion path: the reversal has committed, so a failure
  // to write the audit line must not surface as a failed reversal.
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "transaction_reversed",
    entityType: "transaction",
    entityId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { automaticLedgerReversal: true }
  }).catch((error) => {
    console.error("[transaction] reversal audit log not written; the reversal still stands", {
      transactionId: id, reason: error?.message || "unknown"
    });
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
        `SELECT TO_CHAR((created_at AT TIME ZONE 'Africa/Johannesburg')::DATE, 'YYYY-MM-DD') AS day, SUM(fee_collected)::NUMERIC AS total
         FROM revenue_ledger
         GROUP BY (created_at AT TIME ZONE 'Africa/Johannesburg')::DATE
         ORDER BY (created_at AT TIME ZONE 'Africa/Johannesburg')::DATE DESC
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
  assertRecipientCanReceive,
  feePreview,
  createTransaction,
  listTransactionsForUser,
  todaySummaryForUser,
  statementForUser,
  listAllTransactions,
  reverseTransaction,
  revenueSummary
};
