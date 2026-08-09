const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { requireUuid } = require("../lib/validation");
const {
  getBusinessEligibility,
  createEventDraft,
  updateEventDraft,
  submitEvent,
  listBusinessEvents,
  getBusinessEvent,
  listPublicApprovedEvents,
  getPublicApprovedEvent,
  listAdminEvents,
  getAdminEvent,
  adminTransitionEvent,
  ticketPurchasePreview,
  purchaseTickets,
  listMyTicketOrders,
  scanTicket,
  addEventStaff,
  listEventStaff,
  requestTicketRefund,
  eventSalesReport,
  listMyTickets,
  canManageEventTicketing
} = require("../services/ticketing-service");
const eventTags = require("../services/event-tag-service");
const { AppError } = require("../lib/errors");

const router = express.Router();

function meta(req) {
  return { ipAddress: req.ip, userAgent: req.get("user-agent") };
}

router.get("/public/events", async (_req, res, next) => {
  try {
    res.json({ ok: true, items: await listPublicApprovedEvents() });
  } catch (error) {
    next(error);
  }
});

router.get("/public/events/:slug", async (req, res, next) => {
  try {
    res.json({ ok: true, event: await getPublicApprovedEvent(req.params.slug) });
  } catch (error) {
    next(error);
  }
});

router.post("/public/events/:slug/purchase-preview", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, preview: await ticketPurchasePreview(req.params.slug, req.body) });
  } catch (error) {
    next(error);
  }
});

router.post("/public/events/:slug/purchase", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, order: await purchaseTickets(req.auth, req.params.slug, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listMyTicketOrders(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/refund", requireAuth, async (req, res, next) => {
  try {
    const orderId = requireUuid(req.params.id, "Order ID");
    res.status(201).json({ ok: true, refund: await requestTicketRefund(req.auth, orderId, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

// The flat ticket list the PWA's "My Tickets" screen reads. See listMyTickets:
// this route did not exist, so that screen has never loaded.
router.get("/tickets", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listMyTickets(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/scanner/validate", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, result: await scanTicket(req.auth, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/eligibility", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, eligibility: await getBusinessEligibility(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listBusinessEvents(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events", requireAuth, async (req, res, next) => {
  try {
    const event = await createEventDraft(req.auth.userId, req.body, meta(req));
    res.status(201).json({ ok: true, event });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await getBusinessEvent(req.auth.userId, eventId) });
  } catch (error) {
    next(error);
  }
});

router.put("/business/events/:id", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await updateEventDraft(req.auth.userId, eventId, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/submit", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await submitEvent(req.auth.userId, eventId, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id/staff", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, items: await listEventStaff(req.auth, eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/staff", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.status(201).json({ ok: true, staff: await addEventStaff(req.auth, eventId, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id/report", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    const event = await getBusinessEvent(req.auth.userId, eventId);
    res.json({ ok: true, event, report: await eventSalesReport(eventId) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/events", requireAuth, requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listAdminEvents({ status: req.query.status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/events/:id", requireAuth, requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await getAdminEvent(eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/admin/events/:id/action", requireAuth, requireAdminPermission("ticketing"), async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await adminTransitionEvent(eventId, req.body, req.auth, meta(req)) });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   Event Tags — cashless NFC/RFID credentials
   ==========================================================================
   Three audiences, three different gates, and none of them trusts the client
   for the relationship it is asserting:

     organiser  — owns the event. Verified with getBusinessEvent, which only
                  returns an event whose business_user_id is the caller.
     event staff— verified with canManageEventTicketing(..., "tags"), the same
                  helper the ticket scanner uses, so a gate attendant can be
                  given tag duties without being given the whole event.
     attendee   — sees only tags resolved from their own authenticated user id.

   The admin-side reads and the block control live in admin.routes.js with the
   rest of the ticketing console, behind the "event_tags" permission.

   Nothing here reads a wallet id, user id or event id out of the request body. */

// Owner-only. Enabling cashless, choosing vendors and minting credentials are
// decisions about the event itself, not gate operations.
async function requireEventOwner(req) {
  const eventId = requireUuid(req.params.id, "Event ID");
  await getBusinessEvent(req.auth.userId, eventId);   // throws 404 unless owned
  return eventId;
}

// Owner or staff carrying the "tags" permission. This is the gate-side gate.
async function requireTagStaff(req) {
  const eventId = requireUuid(req.params.id, "Event ID");
  if (!(await canManageEventTicketing(req.auth.userId, eventId, "tags"))) {
    throw new AppError(404, "Event not found");
  }
  return eventId;
}

router.post("/business/events/:id/cashless", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.json({
      ok: true,
      cashless: await eventTags.setEventCashless(req.auth, eventId, req.body?.enabled, req.body?.settings || {})
    });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id/vendors", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await eventTags.listEventVendors(await requireEventOwner(req)) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/vendors", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    const merchantId = requireUuid(req.body?.merchantId, "Merchant ID");
    res.status(201).json({ ok: true, vendor: await eventTags.addEventVendor(req.auth, eventId, merchantId) });
  } catch (error) {
    next(error);
  }
});

// The blank credentials come back ONCE, here, for writing to the physical tags.
// They are never readable again from any endpoint.
router.post("/business/events/:id/tags/issue", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.status(201).json({ ok: true, ...(await eventTags.issueTags(req.auth, eventId, req.body?.count)) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id/tags", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireTagStaff(req);
    res.json({ ok: true, items: await eventTags.listEventTags(eventId, { status: req.query.status, limit: req.query.limit }) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/tags/assign", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireTagStaff(req);
    res.status(201).json({ ok: true, tag: await eventTags.assignTag(req.auth, eventId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/tags/:tagId/status", requireAuth, async (req, res, next) => {
  try {
    await requireTagStaff(req);
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.json({
      ok: true,
      tag: await eventTags.setTagStatus(req.auth, tagId, String(req.body?.status || "").toUpperCase(), { reason: req.body?.reason })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/tags/:tagId/replace", requireAuth, async (req, res, next) => {
  try {
    await requireTagStaff(req);
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.status(201).json({ ok: true, ...(await eventTags.replaceTag(req.auth, tagId, req.body || {})) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id/tags/analytics", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, analytics: await eventTags.eventTagAnalytics(await requireTagStaff(req)) });
  } catch (error) {
    next(error);
  }
});

// The attendee's own view. Their user id comes from the token, never the URL.
router.get("/tags", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await eventTags.listMyEventTags(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

// The tickets waiting for a wristband — what the "Link Event Tag" screen lists.
router.get("/tags/linkable", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await eventTags.linkableTickets(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

// The attendee links their own wristband by holding it against their phone.
// Their user id comes from the token, so this can only ever attach a tag to a
// ticket they own.
router.post("/tags/link", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, tag: await eventTags.linkMyTag(req.auth, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

// Reporting a lost wristband is the one write an attendee can make. It blocks
// the credential; it moves no money, because the money was never on it.
router.post("/tags/:tagId/lost", requireAuth, async (req, res, next) => {
  try {
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.json({ ok: true, tag: await eventTags.reportMyTagLost(req.auth, tagId) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
