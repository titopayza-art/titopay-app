"use strict";

// MONEY IS NEVER LOST TO A LIMIT.
//
// When a payment fails only because the recipient has no receiving capacity
// left, refusing it punishes the sender for someone else's paperwork and
// tells the recipient nothing. Instead the transfer completes on the
// sender's side and the credit is HELD: the recipient is told there is
// money waiting, verifying releases it, and if nobody claims it inside the
// configured window it goes back to the sender in full.
//
// Two rules make this safe:
//
//   THE HELD AMOUNT IS NEVER SPENDABLE. It is not credited to the
//   recipient's wallet at any point before release, so nothing has to be
//   frozen or clawed back later. The sender's debit is a real ledger entry;
//   the hold is a liability record against it.
//
//   RELEASE AND RETURN HAPPEN EXACTLY ONCE. Every state change takes the
//   row under a database lock and checks the status inside the same
//   transaction, so a double tap, a retry and a sweep racing each other
//   cannot double credit or double return.
//
// Whether holding happens at all, and for how long, is configuration under
// the approved compliance framework (compliance config, `receiving`).

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

let schemaReady = null;
function ensurePendingCreditSchema() {
  schemaReady ||= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_credits (
        id UUID PRIMARY KEY,
        transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
        sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(18,2) NOT NULL,
        service_code TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'receiving_capacity',
        status TEXT NOT NULL DEFAULT 'awaiting_verification',
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        released_at TIMESTAMPTZ,
        returned_at TIMESTAMPTZ,
        resolution_note TEXT
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS pending_credits_recipient_idx ON pending_credits (recipient_user_id, status, created_at DESC)");
    await pool.query(
      "CREATE INDEX IF NOT EXISTS pending_credits_open_idx ON pending_credits (status, expires_at)");
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

async function receivingPolicy() {
  const config = await require("./compliance-service").loadComplianceConfig();
  const policy = config.receiving || {};
  return {
    holdForVerification: policy.holdForVerification !== false,
    holdDays: Number(policy.holdDays) > 0 ? Number(policy.holdDays) : 14,
    services: Array.isArray(policy.services) ? policy.services : []
  };
}

// Does this rail hold, or refuse? Card top-ups and provider settlement
// answer to the provider and are never held here.
async function holdApplies(serviceCode) {
  const policy = await receivingPolicy();
  if (!policy.holdForVerification) return false;
  return policy.services.includes(String(serviceCode || ""));
}

// Called by the transaction rail INSIDE the money transaction, after the
// sender has been debited and instead of crediting the recipient. The money
// is credited to the SUSPENSE WALLET, so the transfer still balances and
// the held value is visible in the ledger rather than living as an implicit
// float.
async function createHold(client, { transactionId, senderUserId, recipientUserId, amount, serviceCode, reason = "receiving_capacity", metadata = {} }) {
  await ensurePendingCreditSchema();
  const policy = await receivingPolicy();
  const { applyWalletMovement, getSuspenseWallet } = require("./wallet-service");
  const suspense = await getSuspenseWallet(client);
  const id = crypto.randomUUID();
  await applyWalletMovement(client, {
    walletId: suspense.id,
    transactionId,
    entryType: "credit",
    amount: Number(amount),
    reference: `pending-hold:${id}`,
    metadata: { pendingCreditId: id, heldFor: recipientUserId, serviceCode }
  });
  await client.query(
    `INSERT INTO pending_credits
       (id, transaction_id, sender_user_id, recipient_user_id, amount, service_code, reason, metadata, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::JSONB, NOW() + ($9 || ' days')::INTERVAL)`,
    [id, transactionId, senderUserId, recipientUserId, Number(amount), serviceCode, reason,
      JSON.stringify(metadata), String(policy.holdDays)]
  );
  return { id, holdDays: policy.holdDays };
}

// Told after the money transaction commits, so a notification failure can
// never roll back a payment. BOTH sides hear: the recipient because there
// is money waiting, and the sender because their money has left their
// wallet without arriving, which they would otherwise discover as a
// mystery.
//
// IN-APP ONLY, DELIBERATELY. "You have money waiting, verify to claim" is
// the exact shape of the phishing message South Africans are targeted with
// every day. Behind an authenticated app it is safe. Sent as an email or
// SMS carrying a link, it would teach customers to trust the fraudulent
// version. Do not add an email template for this notice.
async function notifyHold({ id, recipientUserId, senderUserId, recipientName, senderName, amount, holdDays }) {
  const { createNotification } = require("./notification-service");
  const value = `R${Number(amount).toFixed(2)}`;
  await createNotification({
    user: { id: recipientUserId, user_type: "customer" },
    channel: "in_app",
    notificationType: "pending_credit",
    provider: "in_app",
    title: `${value} is waiting for you`,
    body: `${senderName || "Someone"} sent you ${value}. Verify your identity under Limits and Verification in your wallet to receive it. It is held safely for ${holdDays} days, and returns to the sender if it is not claimed. TitoPay will never ask you to claim money through a link in a message.`,
    metadata: { clientNotificationId: `pending-credit-${id}`, pendingCreditId: id }
  }).catch(() => {});
  if (!senderUserId) return;
  await createNotification({
    user: { id: senderUserId, user_type: "customer" },
    channel: "in_app",
    notificationType: "pending_credit",
    provider: "in_app",
    title: `${value} is on hold for ${recipientName || "the person you paid"}`,
    body: `Your payment of ${value} left your wallet, but ${recipientName || "the recipient"} needs to verify their identity before it can land. They have been told. If they do not claim it within ${holdDays} days, the full amount, including the fee, comes back to you automatically.`,
    metadata: { clientNotificationId: `pending-credit-sender-${id}`, pendingCreditId: id }
  }).catch(() => {});
}

async function listForRecipient(userId) {
  await ensurePendingCreditSchema();
  const { rows } = await pool.query(
    `SELECT pc.id, pc.amount, pc.service_code, pc.status, pc.created_at, pc.expires_at,
            u.full_name AS sender_name, u.username AS sender_username
     FROM pending_credits pc
     LEFT JOIN users u ON u.id = pc.sender_user_id
     WHERE pc.recipient_user_id = $1 AND pc.status = 'awaiting_verification'
     ORDER BY pc.created_at DESC LIMIT 50`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    serviceCode: row.service_code,
    from: row.sender_name || row.sender_username || "A TitoPay customer",
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));
}

// RELEASE. Runs when the recipient now has the capacity to receive: the
// credit posts to their wallet as a normal ledger movement, under a row
// lock that makes a second release impossible.
async function releaseHold(pendingId, { actorId = null, note = null } = {}) {
  await ensurePendingCreditSchema();
  const { applyWalletMovement } = require("./wallet-service");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM pending_credits WHERE id = $1 FOR UPDATE", [pendingId]);
    const hold = rows[0];
    if (!hold) throw new AppError(404, "That held payment was not found.");
    if (hold.status !== "awaiting_verification") throw new AppError(409, "That payment has already been settled.");
    const { rows: wallets } = await client.query(
      "SELECT id FROM wallets WHERE user_id = $1 ORDER BY created_at LIMIT 1", [hold.recipient_user_id]);
    if (!wallets[0]) throw new AppError(404, "The recipient has no wallet to receive into.");
    // Out of suspense, into the recipient: two legs, so the release balances
    // and the suspense wallet always equals the value of the open holds.
    const suspense = await require("./wallet-service").getSuspenseWallet(client);
    await applyWalletMovement(client, {
      walletId: suspense.id,
      transactionId: hold.transaction_id,
      entryType: "debit",
      amount: Number(hold.amount),
      reference: `pending-release:${hold.id}`,
      metadata: { pendingCreditId: hold.id, releasedTo: hold.recipient_user_id }
    });
    await applyWalletMovement(client, {
      walletId: wallets[0].id,
      transactionId: hold.transaction_id,
      entryType: "credit",
      amount: Number(hold.amount),
      reference: `pending-release:${hold.id}`,
      metadata: { pendingCreditId: hold.id, releasedBy: actorId || "customer_verification" }
    });
    await client.query(
      "UPDATE pending_credits SET status = 'released', released_at = NOW(), resolution_note = $2 WHERE id = $1",
      [pendingId, note]);
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actorId ? "admin" : "system",
      actorId,
      action: "pending_credit_released",
      entityType: "pending_credit",
      entityId: pendingId,
      metadata: { amount: Number(hold.amount), recipientUserId: hold.recipient_user_id, transactionId: hold.transaction_id }
    });
    // The money has now actually reached the recipient, so this is the
    // moment it enters transaction monitoring for them.
    require("./compliance-service")
      .reviewForEdd(hold.recipient_user_id, Number(hold.amount), hold.service_code);
    const { createNotification } = require("./notification-service");
    await createNotification({
      user: { id: hold.recipient_user_id, user_type: "customer" },
      channel: "in_app", notificationType: "pending_credit", provider: "in_app",
      title: `R${Number(hold.amount).toFixed(2)} is now in your wallet`,
      body: "The payment that was waiting for you has been released into your wallet.",
      metadata: { clientNotificationId: `pending-credit-released-${pendingId}` }
    }).catch(() => {});
    // The sender was told their money was on hold, so they are told when it
    // finally lands. An open loop is what turns into a support ticket.
    await createNotification({
      user: { id: hold.sender_user_id, user_type: "customer" },
      channel: "in_app", notificationType: "pending_credit", provider: "in_app",
      title: `Your R${Number(hold.amount).toFixed(2)} payment has been delivered`,
      body: "The person you paid completed their verification, so the payment that was on hold has landed in their wallet.",
      metadata: { clientNotificationId: `pending-credit-delivered-${pendingId}` }
    }).catch(() => {});
    return { id: pendingId, amount: Number(hold.amount), status: "released" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// RETURN. The money goes back to the sender, in full, as its own ledger
// movement. Used on expiry and by compliance where a hold should not be
// released.
async function returnHold(pendingId, { actorId = null, note = "expired" } = {}) {
  await ensurePendingCreditSchema();
  const { applyWalletMovement } = require("./wallet-service");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM pending_credits WHERE id = $1 FOR UPDATE", [pendingId]);
    const hold = rows[0];
    if (!hold) throw new AppError(404, "That held payment was not found.");
    if (hold.status !== "awaiting_verification") throw new AppError(409, "That payment has already been settled.");
    const { rows: wallets } = await client.query(
      "SELECT id FROM wallets WHERE user_id = $1 ORDER BY created_at LIMIT 1", [hold.sender_user_id]);
    if (!wallets[0]) throw new AppError(404, "The sender has no wallet to return to.");
    // Out of suspense, back to the sender: the return balances the hold.
    const suspense = await require("./wallet-service").getSuspenseWallet(client);
    await applyWalletMovement(client, {
      walletId: suspense.id,
      transactionId: hold.transaction_id,
      entryType: "debit",
      amount: Number(hold.amount),
      reference: `pending-return:${hold.id}`,
      metadata: { pendingCreditId: hold.id, returnedTo: hold.sender_user_id }
    });
    await applyWalletMovement(client, {
      walletId: wallets[0].id,
      transactionId: hold.transaction_id,
      entryType: "credit",
      amount: Number(hold.amount),
      reference: `pending-return:${hold.id}`,
      metadata: { pendingCreditId: hold.id, returned: true, note }
    });
    // A payment that was never delivered costs the sender nothing: the
    // service fee is refunded too, and the revenue it was booked against is
    // reversed in the same breath so the books stay true.
    const fee = Number(hold.metadata?.fee || 0);
    if (fee > 0) {
      const { rows: revenueRows } = await client.query(
        "SELECT revenue_wallet_id FROM revenue_ledger WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1",
        [hold.transaction_id]
      );
      const revenueWalletId = revenueRows[0]?.revenue_wallet_id;
      if (revenueWalletId) {
        await applyWalletMovement(client, {
          walletId: revenueWalletId,
          transactionId: hold.transaction_id,
          entryType: "debit",
          amount: fee,
          reference: `pending-return-fee:${hold.id}`,
          metadata: { pendingCreditId: hold.id, feeRefund: true }
        });
        await client.query(
          `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [crypto.randomUUID(), hold.transaction_id, hold.service_code, -Math.abs(fee), revenueWalletId]
        );
      }
      await applyWalletMovement(client, {
        walletId: wallets[0].id,
        transactionId: hold.transaction_id,
        entryType: "credit",
        amount: fee,
        reference: `pending-return-fee:${hold.id}`,
        metadata: { pendingCreditId: hold.id, feeRefund: true }
      });
    }
    await client.query(
      "UPDATE pending_credits SET status = 'returned', returned_at = NOW(), resolution_note = $2 WHERE id = $1",
      [pendingId, note]);
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: actorId ? "admin" : "system",
      actorId,
      action: "pending_credit_returned",
      entityType: "pending_credit",
      entityId: pendingId,
      metadata: { amount: Number(hold.amount), senderUserId: hold.sender_user_id, note }
    });
    const { createNotification } = require("./notification-service");
    await createNotification({
      user: { id: hold.sender_user_id, user_type: "customer" },
      channel: "in_app", notificationType: "pending_credit", provider: "in_app",
      title: `R${Number(hold.amount).toFixed(2)} has been returned to you`,
      body: "The payment you sent was not claimed in time, so the full amount is back in your wallet.",
      metadata: { clientNotificationId: `pending-credit-returned-${pendingId}` }
    }).catch(() => {});
    return { id: pendingId, amount: Number(hold.amount), status: "returned" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Called after a customer verifies: everything waiting for them that now
// fits inside their capacity is released, largest first, and anything that
// still does not fit simply keeps waiting.
async function releaseWhatFits(userId, { actorId = null } = {}) {
  await ensurePendingCreditSchema();
  const limits = require("./limit-engine");
  const { rows } = await pool.query(
    `SELECT id, amount FROM pending_credits
     WHERE recipient_user_id = $1 AND status = 'awaiting_verification'
     ORDER BY amount DESC`, [userId]);
  const released = [];
  for (const row of rows) {
    const outcome = await limits.evaluateReceive(userId, Number(row.amount));
    if (outcome.decision !== "approve") continue;
    try {
      await releaseHold(row.id, { actorId });
      released.push({ id: row.id, amount: Number(row.amount) });
    } catch (error) {
      if (error.status !== 409) console.error("[pending-credit] release failed", { id: row.id, message: error.message });
    }
  }
  return released;
}

// The expiry sweep, run by the worker beside the integrity sweep.
async function returnExpiredHolds() {
  await ensurePendingCreditSchema();
  const { rows } = await pool.query(
    "SELECT id FROM pending_credits WHERE status = 'awaiting_verification' AND expires_at < NOW() LIMIT 200");
  const returned = [];
  for (const row of rows) {
    try {
      await returnHold(row.id, { note: "not claimed within the holding period" });
      returned.push(row.id);
    } catch (error) {
      if (error.status !== 409) console.error("[pending-credit] return failed", { id: row.id, message: error.message });
    }
  }
  return returned;
}

module.exports = {
  ensurePendingCreditSchema,
  receivingPolicy,
  holdApplies,
  createHold,
  notifyHold,
  listForRecipient,
  releaseHold,
  returnHold,
  releaseWhatFits,
  returnExpiredHolds
};
