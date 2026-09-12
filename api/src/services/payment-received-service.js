"use strict";

// THE OTHER HALF OF EVERY PAYMENT.
//
// TitoPay has always written a receipt to the person who PAID. It has never
// written anything to the person who was PAID. Every receipt in
// transaction-service is queued against actor.userId, which is the payer, and
// the only recipient-side notice in the whole codebase belonged to send_gift.
//
// So a poster on a counter, a tip poster on a table, a till, an event selling
// tickets and a person simply being sent money were all told NOTHING. The
// money arrived and the app stayed silent. The "Payment received" line on the
// merchant POS is written by the till screen in the browser while that screen
// is open, so a poster on a wall with nobody watching produced nothing at all.
//
// This is the one place that tells the receiver, and every path that moves
// money into a customer's wallet calls it. Adding a new way to be paid means
// adding one call here, not remembering to write a notification again.
//
// TWO CHANNELS, DELIBERATELY.
//
//   in-app   always, because it is free, instant and belongs in the app
//   email    only when the customer has left transaction receipts on
//
// NOT SMS. Transactional comms on TitoPay are in-app and email. The SMS
// provider exists and is used for one-time passcodes; it is not used here.
//
// NOTHING IN THIS FILE MAY EVER FAIL A PAYMENT. The money has already moved by
// the time any of this runs. Every path is wrapped, and a failure is logged and
// swallowed: a customer who was paid but not told is a bad day, a customer
// whose payment was rolled back because an email queue was busy is a disaster.

const { pool } = require("../db/pool");
const { createNotification } = require("./notification-service");
const { queueEmail } = require("./email-centre-service");
const { shouldSendCustomerEmail } = require("./customer-notification-preference-service");

// HOW EACH KIND OF PAYMENT READS.
//
// "You received R250.00" is true for all of them and says almost nothing. A
// person wants to know WHY money arrived, and the service code already knows.
// The verb is written for the RECEIVER, so it reads from their side.
const ARRIVALS = [
  [/^(qr_payment|qr_pay|customer_qr_payment|scan_to_pay)$/, "paid your QR code"],
  [/^ticket_purchase$/, "bought tickets"],
  [/^(payment_request|request_money)$/, "paid your request"],
  [/^bill_split$/, "paid their share"],
  [/^(stockvel|stokvel)/, "contributed"],
  [/(transfer|send_money)/, "sent you money"],
  [/^event_tag/, "topped up at your event"]
];

function arrivalVerb(serviceCode) {
  const code = String(serviceCode || "").trim().toLowerCase();
  for (const [pattern, verb] of ARRIVALS) {
    if (pattern.test(code)) return verb;
  }
  return "paid you";
}

const money = (value) => `R${(Math.round((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2)}`;

/**
 * Tell a customer that money reached their wallet.
 *
 * @param {object} input
 * @param {string} input.recipientUserId  who was paid
 * @param {number} input.amount           what actually REACHED the wallet, after any fee
 * @param {string} input.transactionId    the payment, and the idempotency anchor
 * @param {string} [input.reference]      the customer-visible reference
 * @param {string} [input.serviceCode]    shapes the wording
 * @param {string} [input.payerName]      who paid, when it is theirs to know
 * @param {number} [input.fee]            what TitoPay took off the receiver, if anything
 * @param {string} [input.detail]         one extra clause, e.g. an event or QR label
 */
async function notifyPaymentReceived(input = {}) {
  const recipientUserId = String(input.recipientUserId || "").trim();
  const amount = Number(input.amount);
  const transactionId = String(input.transactionId || "").trim();
  // A zero or negative arrival is not a payment, and a notice without a
  // transaction to anchor on cannot be made idempotent, so it is not sent.
  if (!recipientUserId || !transactionId || !Number.isFinite(amount) || amount <= 0) return { skipped: true, reason: "not_a_payment" };

  try {
    const { rows } = await pool.query(
      "SELECT email, full_name, account_type FROM users WHERE id = $1 LIMIT 1",
      [recipientUserId]
    );
    const recipient = rows[0];
    if (!recipient) return { skipped: true, reason: "no_such_user" };

    const reference = String(input.reference || "").trim();
    const fee = Math.max(0, Number(input.fee || 0));
    const payerName = String(input.payerName || "").trim();
    const detail = String(input.detail || "").trim();
    const verb = arrivalVerb(input.serviceCode);

    // "Thabo Mokoena paid your QR code." / "Someone paid your QR code."
    // The payer's name is used when the caller passes one and nothing is
    // invented when it does not: a made-up name on a payment notice is worse
    // than no name, because people act on these.
    const who = payerName || "Someone";
    const sentence = `${who} ${verb}${detail ? ` (${detail})` : ""}.`;
    const feeSentence = fee > 0 ? ` The TitoPay fee of ${money(fee)} has already been taken off.` : "";

    // 1. IN-APP. Always. It costs nothing and it is where people look.
    await createNotification({
      user: { id: recipientUserId, user_type: "customer" },
      channel: "in_app",
      notificationType: "payment_received",
      provider: "in_app",
      title: `You received ${money(amount)}`,
      body: `${sentence}${feeSentence} The money is in your wallet now.${reference ? ` Reference ${reference}.` : ""}`,
      metadata: {
        transactionId,
        reference: reference || null,
        amount,
        fee: fee || 0,
        serviceCode: input.serviceCode || null,
        // The PWA keys its local notification list on this, so a notice that
        // arrives twice from a retry still renders once.
        clientNotificationId: `payment-received-${transactionId}`
      }
    });

    // 2. EMAIL. Only if the customer still wants transaction receipts, which is
    // the same switch that governs the payer's own receipt.
    if (recipient.email && await shouldSendCustomerEmail(recipientUserId, "transaction")) {
      await queueEmail({
        recipient: recipient.email,
        templateKey: "payment_received",
        userId: recipientUserId,
        variables: {
          fullName: recipient.full_name || "there",
          amount: (Math.round((amount + Number.EPSILON) * 100) / 100).toFixed(2),
          currency: "ZAR",
          transactionReference: reference || transactionId,
          payerLine: sentence,
          feeLine: feeSentence
        },
        // The anchor that makes this safe to call more than once.
        idempotencyKey: `payment-received:${transactionId}`,
        metadata: { transactionId, serviceCode: input.serviceCode || null }
      });
    }
    return { sent: true };
  } catch (error) {
    // The money is already in the wallet. Losing the notice is survivable;
    // throwing from here would not be.
    console.error("[payment-received] could not tell the recipient", {
      transactionId, recipientUserId, message: error.message
    });
    return { skipped: true, reason: "error" };
  }
}

module.exports = { notifyPaymentReceived, arrivalVerb };
