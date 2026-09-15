const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { publicContactLimiter } = require("../middleware/rate-limits");
const { writeAuditLog } = require("../services/audit-service");
const { generateUniqueTicketRef } = require("../lib/ticket-id");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum } = require("../lib/validation");
const { queueEmail } = require("../services/email-centre-service");
const { shouldSendCustomerEmail } = require("../services/customer-notification-preference-service");
const {
  listConversations,
  getConversation,
  listMessages,
  markRead,
  sendMessage
} = require("../services/support-chat-service");
const { listMyTickets, addCustomerReply, hideMyTicket } = require("../services/support-ticket-reply-service");

const router = express.Router();

router.post("/public/contact", publicContactLimiter, async (req, res, next) => {
  try {
    const website = String(req.body?.website || "").trim();
    if (website) {
      return res.status(201).json({ ok: true, ticketRef: "Submitted" });
    }

    const fullName = boundedText(req.body?.fullName, "Full name", { min: 2, max: 100 });
    const cellphone = boundedText(req.body?.cellphone, "Cellphone number", { min: 7, max: 24 });
    const phoneDigits = cellphone.replace(/\D/g, "");
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      throw new AppError(400, "Enter a valid cellphone number");
    }
    const categoryKey = requireEnum(
      req.body?.category || "General Enquiries",
      ["account access", "payments", "withdrawals", "airtime & data", "qr payments", "fica", "business", "technical support", "general enquiries"],
      "Category"
    );
    const category = {
      "account access": "Account Access",
      payments: "Payments",
      withdrawals: "Withdrawals",
      "airtime & data": "Airtime & Data",
      "qr payments": "QR Payments",
      fica: "FICA",
      business: "Business",
      "technical support": "Technical Support",
      "general enquiries": "General Enquiries"
    }[categoryKey];
    const message = boundedText(req.body?.message, "Message", { min: 10, max: 2000 });
    if (req.body?.consent !== true && req.body?.consent !== "true") {
      throw new AppError(400, "Please consent to TitoPay using these details to respond");
    }

    const id = uuidv4();
    const ticketRef = await generateUniqueTicketRef(pool, "TC");
    const storedMessage = [
      "Public PWA contact request",
      `Name: ${fullName}`,
      `Cellphone: ${cellphone}`,
      "",
      message
    ].join("\n");
    await pool.query(
      `INSERT INTO support_tickets (id, ticket_ref, user_id, category, subject, message, status, assigned_to)
       VALUES ($1, $2, NULL, $3, $4, $5, 'open', 'Customer Care Queue')`,
      [id, ticketRef, category, `Website contact: ${category} from ${fullName}`.slice(0, 255), storedMessage]
    );

    res.status(201).json({ ok: true, ticketRef });
  } catch (error) {
    next(error);
  }
});

router.use(requireAuth);

function requireCustomer(req) {
  if (req.auth.userType !== "customer") {
    throw new AppError(403, "Customer support access required");
  }
}

async function ensureReviewStore() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::JSONB,
      updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL");
  await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
}

async function getStoredReviews() {
  await ensureReviewStore();
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'pwa_customer_reviews' LIMIT 1"
  );
  return Array.isArray(rows[0]?.value?.reviews) ? rows[0].value.reviews : [];
}

async function saveStoredReviews(reviews) {
  await ensureReviewStore();
  const trimmed = [...reviews]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 500);
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ('pwa_customer_reviews', $1::JSONB, NULL, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ reviews: trimmed })]
  );
  return trimmed;
}

router.post("/tickets", async (req, res, next) => {
  try {
    requireCustomer(req);
    const category = String(req.body?.category || "general").trim().slice(0, 80) || "general";
    const message = String(req.body?.message || "").trim();
    if (message.length < 10) throw new AppError(400, "Enter at least 10 characters for support");

    const id = uuidv4();
    const ticketRef = await generateUniqueTicketRef(pool, "TC");
    const { rows } = await pool.query(
      `INSERT INTO support_tickets (id, ticket_ref, user_id, category, subject, message, status, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', 'Customer Care Queue')
       RETURNING id, ticket_ref, user_id, category, subject, message, status, assigned_to, created_at`,
      [
        id,
        ticketRef,
        req.auth.userId,
        category,
        `Customer support: ${category}`,
        message.slice(0, 4000)
      ]
    );

    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_ticket_created",
      entityType: "support_ticket",
      entityId: id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { category, source: "pwa" }
    });

    try {
      const {rows:accounts}=await pool.query("SELECT email,full_name FROM users WHERE id=$1",[req.auth.userId]);
      if(accounts[0]?.email&&await shouldSendCustomerEmail(req.auth.userId,"support"))await queueEmail({recipient:accounts[0].email,templateKey:"support_ticket_created",userId:req.auth.userId,variables:{fullName:accounts[0].full_name,email:accounts[0].email,ticketReference:rows[0].ticket_ref},idempotencyKey:`support-ticket-created:${id}`,metadata:{ticketId:id}});
    } catch(error) { console.error("[support] email queue failed",{ticketId:id,message:error.message}); }

    res.status(201).json({
      ok: true,
      ticket: { ...rows[0], ticketRef: rows[0].ticket_ref },
      ticketRef: rows[0].ticket_ref
    });
  } catch (error) {
    next(error);
  }
});

router.get("/tickets", async (req, res, next) => {
  try {
    requireCustomer(req);
    const items = await listMyTickets(req.auth.userId);
    res.json({ ok: true, items });
  } catch (error) {
    next(error);
  }
});

router.delete("/tickets", async (req, res, next) => {
  try {
    requireCustomer(req);
    const { hideMyFinishedTickets } = require("../services/support-ticket-reply-service");
    const result = await hideMyFinishedTickets(req.auth);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_tickets_cleared_by_customer",
      entityType: "support_ticket",
      entityId: null,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { removed: result.removed }
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.delete("/tickets/:id", async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await hideMyTicket(req.auth, req.params.id);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_ticket_hidden_by_customer",
      entityType: "support_ticket",
      entityId: req.params.id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: {}
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/tickets/:id/replies", async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await addCustomerReply(req.auth, req.params.id, req.body || {});
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "support_ticket_customer_reply",
      entityType: "support_ticket",
      entityId: result.ticket.id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { replyId: result.reply.id }
    });
    res.status(201).json({ ok: true, ticket: result.ticket, reply: result.reply });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations", async (req, res, next) => {
  try {
    requireCustomer(req);
    const result = await listConversations(req.auth);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id", async (req, res, next) => {
  try {
    requireCustomer(req);
    const conversation = await getConversation(req.auth, req.params.id);
    res.json({ ok: true, conversation });
  } catch (error) {
    next(error);
  }
});

router.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    requireCustomer(req);
    const messages = await listMessages(req.auth, req.params.id);
    res.json({ ok: true, messages });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    requireCustomer(req);
    const message = await sendMessage(req.auth, req.params.id, req.body || {});
    res.status(201).json({ ok: true, message });
  } catch (error) {
    next(error);
  }
});

router.post("/conversations/:id/read", async (req, res, next) => {
  try {
    requireCustomer(req);
    res.json({ ok: true, read: await markRead(req.auth, req.params.id) });
  } catch (error) {
    next(error);
  }
});

router.post("/reviews", async (req, res, next) => {
  try {
    requireCustomer(req);
    const rating = Number(req.body?.rating || 0);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError(400, "Select a rating from 1 to 5");
    }
    const category = requireEnum(req.body?.category || "general", ["general", "payments", "chat", "support", "performance", "design", "security"], "Review category");
    const message = boundedText(req.body?.message, "Review message", { min: 8, max: 1200 });
    const contactPermission = Boolean(req.body?.contactPermission);
    const appVersion = boundedText(req.body?.appVersion || "", "App version", { min: 0, max: 80 }) || "";

    const { rows } = await pool.query(
      `SELECT id, full_name, username, email, phone, account_type
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.auth.userId]
    );
    const user = rows[0] || {};
    const reviews = await getStoredReviews();
    const review = {
      id: uuidv4(),
      source: "pwa_profile",
      rating,
      category,
      message,
      contactPermission,
      appVersion,
      status: "new",
      userId: req.auth.userId,
      userName: user.full_name || user.username || "TitoPay user",
      username: user.username || "",
      accountType: user.account_type || "personal",
      email: contactPermission ? user.email || "" : "",
      phone: contactPermission ? user.phone || "" : "",
      createdAt: new Date().toISOString()
    };
    reviews.unshift(review);
    await saveStoredReviews(reviews);
    await writeAuditLog({
      actorType: req.auth.userType,
      actorId: req.auth.userId,
      action: "pwa_customer_review_submitted",
      entityType: "pwa_customer_review",
      entityId: review.id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      metadata: { rating, category, source: "pwa_profile" }
    });

    res.status(201).json({
      ok: true,
      review: {
        id: review.id,
        rating: review.rating,
        category: review.category,
        status: review.status,
        createdAt: review.createdAt
      },
      message: "Thank you. Your feedback helps us improve TitoPay."
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
