const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { writeAuditLog } = require("../services/audit-service");
const { generateUniqueTicketRef } = require("../lib/ticket-id");
const {
  processBotExchange,
  escalateConversation
} = require("../services/support-chat-service");

const router = express.Router();

router.use(requireAuth);

async function createInAppSupportNotification({ userId, type, title, body, metadata = {} }) {
  if (!userId) return null;
  const notificationId = uuidv4();
  await pool.query(
    `INSERT INTO notifications (
       id, user_id, channel, notification_type, title, body, status, provider, metadata, sent_at, delivered_at
     )
     VALUES ($1, $2, 'in_app', $3, $4, $5, 'sent', 'titopay', $6::JSONB, NOW(), NOW())
     RETURNING id`,
    [
      notificationId,
      userId,
      type,
      title,
      body,
      JSON.stringify({ ...metadata, clientNotificationId: metadata.clientNotificationId || notificationId })
    ]
  );
  return notificationId;
}

function chatbotAnswer(message, accountType) {
  const text = String(message || "").toLowerCase();
  const business = accountType === "business";

  if (/\b(human|agent|person|customer care|support consultant|speak to someone)\b/.test(text)) {
    return {
      needsEscalation: true,
      answer: "I’ll connect you to TitoPay Customer Care. Your conversation history will stay in this chat for the support agent."
    };
  }

  if (text.includes("send money") || text.includes("transfer")) {
    return {
      needsEscalation: false,
      answer: "To send money, choose Send Money, select username, cellphone or email, verify the TitoPay recipient preview, review fees and confirm. If the person is not on TitoPay, send an invite link first."
    };
  }
  if (text.includes("receive money") || text.includes("get paid")) {
    return {
      needsEscalation: false,
      answer: business
        ? "Business users can receive payments with QR Receive, invoice links and payment requests. Each payment is recorded in business transactions."
        : "You can receive money by sharing your TitoPay username, cellphone number, email, payment request or QR code."
    };
  }
  if (text.includes("qr")) {
    return {
      needsEscalation: false,
      answer: "TitoPay QR lets users scan, pay, receive and share payment codes. Use QR Pay for scanning and QR Receive for your own payment code."
    };
  }
  if (text.includes("withdraw") || text.includes("payout")) {
    return {
      needsEscalation: false,
      answer: business
        ? "Business payouts use saved beneficiaries, amount confirmation, fee preview and transaction records before funds leave the business wallet."
        : "Withdrawals use your verified bank account, amount confirmation and fee preview. Wallet Lock blocks withdrawals until OTP unlock is completed."
    };
  }
  if (text.includes("top up") || text.includes("top-up")) {
    return {
      needsEscalation: false,
      answer: "Top Up supports card funding through Peach Payments and EFT bank-transfer funding. TitoPay shows the amount, funding method and fee preview before confirmation."
    };
  }
  if (text.includes("verify") || text.includes("fica") || text.includes("kyc")) {
    return {
      needsEscalation: false,
      answer: "FICA verification is handled in Profile and Security. Submit identity and address documents once, then track Not Started, Pending Review, Approved or Rejected status."
    };
  }
  if (text.includes("business profile") || text.includes("merchant")) {
    return {
      needsEscalation: false,
      answer: "Create a business profile from registration or Profile. Business users get QR payments, payment requests, payouts, invoices, quotes, reports and merchant tools."
    };
  }
  if (text.includes("transaction") || text.includes("failed payment") || text.includes("refund")) {
    return {
      needsEscalation: text.includes("failed") || text.includes("refund"),
      answer: "Transaction history shows status, references, PDF receipts and CSV exports. For failed payments or refunds, I can connect you to Customer Care so they can investigate."
    };
  }
  if (text.includes("security") || text.includes("fraud") || text.includes("scam") || text.includes("account access")) {
    return {
      needsEscalation: text.includes("account access"),
      answer: "Never share your PIN, password or verification code. Use Wallet Lock immediately if you suspect fraud, then contact support from the chatbot or Support screen."
    };
  }
  if (text.includes("fee") || text.includes("price") || text.includes("cost")) {
    return {
      needsEscalation: false,
      answer: "TitoPay displays fee previews before paid actions. Pricing is managed centrally by TitoPay Admin and shown before you confirm."
    };
  }
  if (text.includes("general") || text.includes("faq") || text.includes("help")) {
    return {
      needsEscalation: false,
      answer: "TitoPay helps you send money, receive money, pay by QR, buy VAS services, manage wallet security and run business payment tools from one wallet."
    };
  }

  return {
    needsEscalation: true,
    answer: "I may need a Customer Care Specialist for this. I can create a live support request, callback request, or keep you waiting in the queue."
  };
}

router.post("/messages", async (req, res, next) => {
  try {
    const { message, accountType, channelProvider } = req.body;
    const response = chatbotAnswer(message, accountType || req.auth.accountType);
    const exchange = await processBotExchange(req.auth, {
      conversationId: req.body.conversationId,
      clientMessageId: req.body.clientMessageId,
      botMessageId: req.body.botMessageId,
      message,
      channelProvider,
      needsEscalation: response.needsEscalation
    }, response.answer);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "chatbot_message_processed",
      entityType: "chatbot",
      entityId: req.auth.userId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: {
        accountType: accountType || req.auth.accountType,
        channelProvider: channelProvider || "web",
        needsEscalation: response.needsEscalation
      }
    }).catch((error) => {
      console.error({ event: "chatbot_audit_failed", conversationId: exchange.conversationId, error: error.message });
    });
    res.json({ ok: true, ...response, ...exchange });
  } catch (error) {
    next(error);
  }
});

router.post("/escalations", async (req, res, next) => {
  try {
    const { mode = "live_chat", message = "", accountType, channelProvider } = req.body;
    const escalation = await escalateConversation(req.auth, {
      conversationId: req.body.conversationId,
      clientMessageId: req.body.clientMessageId,
      reason: req.body.reason || message || "Customer requested a human support agent",
      message,
      accountType,
      channelProvider,
      mode
    });
    const ticketRef = escalation.ticketRef || escalation.conversation.ticketRef;
    const notificationId = await createInAppSupportNotification({
      userId: req.auth.userId,
      type: "support_reference",
      title: "Customer Care reference created",
      body: `Your conversation has been escalated to Customer Care. Reference ${ticketRef}.`,
      metadata: {
        conversationId: escalation.conversation.id,
        ticketId: escalation.conversation.ticketId,
        ticketRef,
        mode,
        supportStatus: escalation.conversation.status,
        clientNotificationId: `support-${ticketRef}`
      }
    }).catch((error) => {
      console.error({ event: "support_notification_failed", conversationId: escalation.conversation.id, error: error.message });
      return null;
    });

    res.json({
      ok: true,
      conversation: escalation.conversation,
      ticket: {
        id: escalation.conversation.ticketId,
        ticketRef,
        status: escalation.conversation.status
      },
      ticketRef,
      estimatedWait: "2-5 minutes",
      supportStatus: "WAITING_FOR_AGENT",
      message: "Your conversation has been escalated. A TitoPay support agent will join this same chat.",
      notificationId
    });
  } catch (error) {
    next(error);
  }
});

router.post("/ratings", async (req, res, next) => {
  try {
    const { ticketId, rating, feedback = "", accountType } = req.body;
    const score = Math.max(1, Math.min(5, Number(rating) || 0));
    const ratingId = uuidv4();
    const ticketRef = await generateUniqueTicketRef(pool, "TR");

    await pool.query(
      `INSERT INTO support_tickets (id, ticket_ref, user_id, category, subject, message, status, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ratingId,
        ticketRef,
        req.auth.userId,
        "support_rating",
        `Support rating: ${score} star${score === 1 ? "" : "s"}`,
        `Ticket: ${ticketId || "not supplied"}\nFeedback: ${String(feedback).slice(0, 2000)}`,
        "resolved",
        "Quality Assurance"
      ]
    );
    await createInAppSupportNotification({
      userId: req.auth.userId,
      type: "support_rating",
      title: "Service rating received",
      body: "Thank you. Your service rating has been sent to TitoPay Customer Care.",
      metadata: {
        ticketId,
        rating: score,
        ratingRef: ticketRef,
        clientNotificationId: `support-rating-${ticketRef}`
      }
    });

    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_rating_submitted",
      entityType: "support_rating",
      entityId: ratingId,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { ticketId, rating: score, accountType: accountType || req.auth.accountType }
    });

    res.json({ ok: true, rating: score, itemId: ratingId });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
