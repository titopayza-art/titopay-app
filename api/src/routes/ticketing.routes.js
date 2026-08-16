const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
// Emailing a ticket sends real mail, so it carries the same tight limiter as the
// other public-facing send endpoints: a handful per window, per caller.
const { publicContactLimiter } = require("../middleware/rate-limits");
const { requireUuid } = require("../lib/validation");
const {
  getBusinessEligibility,
  createEventDraft,
  updateEventDraft,
  replaceEventPoster,
  submitEvent,
  listBusinessEvents,
  getBusinessEvent,
  listPublicApprovedEvents,
  getPublicApprovedEvent,
  listAdminEvents,
  getAdminEvent,
  adminTransitionEvent,
  adminTicketingAnalytics,
  ticketPurchasePreview,
  purchaseTickets,
  emailTicketToRecipient,
  listMyTicketOrders,
  scanTicket,
  eventAttendance,
  addEventStaff,
  removeEventStaff,
  listEventStaff,
  listStaffScanEvents,
  requestTicketRefund,
  requestEventChange,
  listMyEventChangeRequests,
  eventSalesReport,
  listMyTickets,
  setMyTicketRemoved,
  claimTicketByCode,
  canManageEventTicketing,
  EVENT_CATEGORIES,
  ticketOrderRefundPolicy,
  listEventRefunds,
  processTicketRefund,
  joinTicketWaitlist,
  leaveTicketWaitlist,
  myWaitlistEntry,
  listEventWaitlist,
  notifyEventWaitlist,
  listEventPromoters,
  createEventPromoter,
  removeEventPromoter,
  recordPromoterVisit,
  duplicateEvent,
  listEventCoupons,
  createEventCoupon,
  updateEventCoupon,
  deleteEventCoupon
} = require("../services/ticketing-service");
const campaigns = require("../services/event-campaign-service");
const eventTags = require("../services/event-tag-service");
const walletPasses = require("../services/wallet-pass-service");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

// The ticket row with everything a wallet pass needs, owner-scoped: a caller
// can only ever mint a pass for a ticket that is theirs.
async function ticketForPass(userId, code) {
  const { rows } = await pool.query(
    `SELECT t.ticket_code, t.qr_payload, t.attendee_name, t.status,
            o.order_reference, tt.ticket_name,
            e.event_name, e.event_date, e.venue_name, e.city
       FROM tickets t
       JOIN ticket_orders o ON o.id = t.order_id
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       JOIN events e ON e.id = t.event_id
      WHERE t.ticket_code = $1 AND t.owner_user_id = $2
      LIMIT 1`,
    [code, userId]
  );
  if (!rows[0]) throw new AppError(404, "Ticket not found");
  return rows[0];
}

const router = express.Router();

function meta(req) {
  return { ipAddress: req.ip, userAgent: req.get("user-agent") };
}

// Public, unauthenticated: this is the shop window. `items` keeps the shape it
// has always had, so an older app that ignores the new fields still works;
// `categories` and `search` are additive.
router.get("/public/events", async (req, res, next) => {
  try {
    const result = await listPublicApprovedEvents({
      search: req.query.search || req.query.q || "",
      category: req.query.category || "",
      limit: req.query.limit
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// The category vocabulary, so the organiser's form and the buyer's chips are
// filled from one list rather than two that can drift apart.
router.get("/public/event-categories", (_req, res) => {
  res.json({ ok: true, categories: EVENT_CATEGORIES });
});

/* LINK PREVIEWS.
 *
 * WhatsApp, Facebook, X, Slack and iMessage all fetch a URL and read its HTML
 * <meta> tags. They do NOT run JavaScript. The customer app is a single HTML
 * shell that renders itself on the phone, so a shared event link can only ever
 * preview as "TitoPay" no matter what the app does after it loads.
 *
 * So the shareable link points HERE, at a small server-rendered page that
 * carries the event's real title, description and poster, and then sends a
 * human straight on to the app. The crawler gets its tags, the person gets the
 * event, and the app itself needs no server-side rendering and no change to
 * the .htaccess that serves it.
 *
 * A ?ref= promoter code is preserved through the redirect, so a promoter's
 * link still attributes after the preview hop.
 */
function escapeHtmlAttribute(value = "") {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// A description destined for a <meta content="..."> attribute. The old version
// sliced the raw text at 160 characters, so a real event previewed as
// "...users can manage their" — cut mid-word — with the description's own line
// breaks still in it, sitting inside an HTML attribute. This collapses the
// whitespace first and then cuts at a word boundary, with an ellipsis so the
// reader can see it is an extract rather than a sentence that stops.
function metaSummary(text, limit = 160) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:!-]+$/, "")}…`;
}

// The origin a CRAWLER should use to come back for the poster. Taken from the
// request that is being answered, because that is by definition the host the
// crawler could reach; the constant is only a fallback for a call with no Host
// header at all. No new environment variable to forget to set on deploy.
function apiPublicOrigin(req) {
  const host = String(req.get("host") || "").trim();
  if (!host) return "https://api.titopay.co.za";
  const protocol = /^(localhost|127\.|\[?::1)/i.test(host) ? "http" : "https";
  return `${protocol}://${host}`;
}

// THE POSTER, AS AN IMAGE A CRAWLER CAN ACTUALLY FETCH.
//
// Posters are stored as data: URLs, which is right for the app — one row, no
// object store, no second thing to back up — and useless to WhatsApp, which
// fetches og:image over HTTP or shows nothing. Every shared event has previewed
// with no image since the day sharing shipped.
//
// So the bytes are served here, decoded from the same column. Read-only, no
// authentication, approved events only, exactly as the preview page itself is:
// a poster is public the moment its event is.
router.get("/public/events/:slug/poster", async (req, res, next) => {
  try {
    const event = await getPublicApprovedEvent(req.params.slug);
    const raw = String(event.eventBannerUrl || "");
    // Already a real URL: send the crawler straight there rather than proxying
    // somebody else's bytes through TitoPay.
    if (/^https?:\/\//i.test(raw)) return res.redirect(302, raw);
    const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
    if (!match) return res.status(404).json({ ok: false, error: "This event has no poster." });
    const body = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!body.length) return res.status(404).json({ ok: false, error: "This event has no poster." });
    res.set("Content-Type", match[1].toLowerCase());
    res.set("Content-Length", String(body.length));
    // A poster changes rarely and a crawler may fetch it many times.
    res.set("Cache-Control", "public, max-age=3600");
    res.set("X-Content-Type-Options", "nosniff");
    return res.send(body);
  } catch (error) {
    return next(error);
  }
});

router.get("/public/events/:slug/preview", async (req, res, next) => {
  try {
    const event = await getPublicApprovedEvent(req.params.slug);
    const ref = String(req.query.ref || "").slice(0, 32);
    if (ref) recordPromoterVisit(req.params.slug, ref);
    const appUrl = `https://app.titopay.co.za/events/${encodeURIComponent(event.slug)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const when = event.eventDate
      ? new Date(event.eventDate).toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : "Date to be confirmed";
    const where = [event.venueName, event.city].filter(Boolean).join(", ");
    const head = [when, where].filter(Boolean).join(" · ");
    const description = event.description
      ? `${head}. ${metaSummary(event.description, 160)}`
      : head;
    const title = `${event.eventName} | TitoPay Tickets`;
    // Always the poster route, never the stored value: a data: URL cannot be
    // fetched by a crawler, and the route decodes it into bytes that can.
    // Offered only when the event actually has a poster, because an og:image
    // pointing at a 404 previews worse than no og:image at all.
    const image = event.eventBannerUrl
      ? `${apiPublicOrigin(req)}/v1/ticketing/public/events/${encodeURIComponent(event.slug)}/poster`
      : "";
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttribute(title)}</title>
<meta name="description" content="${escapeHtmlAttribute(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="TitoPay">
<meta property="og:title" content="${escapeHtmlAttribute(event.eventName)}">
<meta property="og:description" content="${escapeHtmlAttribute(description)}">
<meta property="og:url" content="${escapeHtmlAttribute(appUrl)}">
${image ? `<meta property="og:image" content="${escapeHtmlAttribute(image)}">` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${escapeHtmlAttribute(event.eventName)}">
<meta name="twitter:description" content="${escapeHtmlAttribute(description)}">
${image ? `<meta name="twitter:image" content="${escapeHtmlAttribute(image)}">` : ""}
<link rel="canonical" href="${escapeHtmlAttribute(appUrl)}">
<meta http-equiv="refresh" content="0; url=${escapeHtmlAttribute(appUrl)}">
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:40px 20px;text-align:center;color:#10203f">
<h1 style="font-size:1.25rem;margin:0 0 8px">${escapeHtmlAttribute(event.eventName)}</h1>
<p style="color:#62708a;margin:0 0 20px">${escapeHtmlAttribute([when, where].filter(Boolean).join(" · "))}</p>
<p><a href="${escapeHtmlAttribute(appUrl)}" style="color:#0a4dff;font-weight:600">Open this event in TitoPay</a></p>
<script>location.replace(${JSON.stringify(appUrl)});</script>
</body>
</html>`);
  } catch (error) {
    next(error);
  }
});

// What a buyer may do about a refund on an order they own, and why. Read by
// the app so it never offers a button that is going to refuse.
router.get("/orders/:id/refund-policy", requireAuth, async (req, res, next) => {
  try {
    const orderId = requireUuid(req.params.id, "Order ID");
    res.json({ ok: true, policy: await ticketOrderRefundPolicy(req.auth, orderId) });
  } catch (error) {
    next(error);
  }
});

// WAITLIST, from the buyer's side.
router.post("/public/events/:slug/waitlist", requireAuth, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, waitlist: await joinTicketWaitlist(req.auth, req.params.slug, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.delete("/public/events/:slug/waitlist", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await leaveTicketWaitlist(req.auth, req.params.slug)) });
  } catch (error) {
    next(error);
  }
});

router.get("/public/events/:slug/waitlist/me", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, waitlist: await myWaitlistEntry(req.auth, req.params.slug) });
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
    res.json({ ok: true, preview: await ticketPurchasePreview(req.params.slug, req.body, req.auth.userId) });
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
    // ?removed=1 shows what the customer put away, so removing a ticket is
    // reversible rather than a one-way door on something they paid for.
    const includeRemoved = ["1", "true", "yes"].includes(String(req.query.removed || "").toLowerCase());
    res.json({ ok: true, items: await listMyTickets(req.auth.userId, { includeRemoved }) });
  } catch (error) {
    next(error);
  }
});

// Remove a ticket from My Tickets, or put it back. This hides it and never
// deletes it: the ticket, its scan history and the organiser's counts are
// untouched, which is why it is offered even on a ticket that is still valid.
router.patch("/tickets/:id/removed", requireAuth, async (req, res, next) => {
  try {
    const removed = req.body?.removed;
    if (typeof removed !== "boolean") throw new AppError(400, "removed must be true or false");
    res.json({ ok: true, ticket: await setMyTicketRemoved(req.auth.userId, req.params.id, removed) });
  } catch (error) {
    next(error);
  }
});

// Claim a gifted ticket by its printed code. Throttled per user inside the
// service; the previous owner is notified in the app and by email so a code
// used without their blessing gets caught, not buried.
router.post("/tickets/claim", requireAuth, async (req, res, next) => {
  try {
    const ticket = await claimTicketByCode(req.auth, req.body?.code, meta(req));
    res.status(200).json({ ok: true, ticket });
  } catch (error) {
    next(error);
  }
});

// Email a ticket you own to yourself or to someone else. Ownership is enforced
// in the service; the limiter stops the endpoint being used to send mail in bulk.
// Wallet passes. A pass is a SIGNED object — Apple's Pass Type ID certificate
// or Google's service-account key — so these switch on when the credentials are
// configured (see WALLET_PASSES_SETUP.md) and answer an honest 404 until then;
// the app then shows its "no pass yet, QR still valid" fallback.
router.get("/tickets/:code/apple-wallet", requireAuth, async (req, res, next) => {
  try {
    const code = String(req.params.code || "").trim();
    await ticketForPass(req.auth.userId, code);
    if (!walletPasses.appleWalletConfigured()) {
      throw new AppError(404, "Apple Wallet passes are not enabled yet. The ticket QR remains valid for entry.");
    }
    res.json({ ok: true, ticket: { appleWalletUrl: walletPasses.applePassDownloadUrl(code) } });
  } catch (error) {
    next(error);
  }
});

router.get("/tickets/:code/google-wallet", requireAuth, async (req, res, next) => {
  try {
    const code = String(req.params.code || "").trim();
    const ticket = await ticketForPass(req.auth.userId, code);
    if (!walletPasses.googleWalletConfigured()) {
      throw new AppError(404, "Google Wallet passes are not enabled yet. The ticket QR remains valid for entry.");
    }
    res.json({ ok: true, ticket: { googleWalletUrl: walletPasses.buildGoogleSaveUrl(ticket) } });
  } catch (error) {
    next(error);
  }
});

// The .pkpass itself. Safari downloads this by plain navigation, which cannot
// carry the Bearer header, so it is gated by the short-lived HMAC token the
// authenticated endpoint above minted — not open to the world, and useless
// once the token expires.
router.get("/tickets/:code/pass.pkpass", async (req, res, next) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!walletPasses.appleWalletConfigured()) throw new AppError(404, "Apple Wallet passes are not enabled");
    if (!walletPasses.verifyPassToken(code, String(req.query.token || ""))) {
      throw new AppError(403, "This pass link has expired. Open the ticket in TitoPay and tap Add to Apple Wallet again.");
    }
    const { rows } = await pool.query(
      `SELECT t.ticket_code, t.qr_payload, t.attendee_name,
              o.order_reference, tt.ticket_name,
              e.event_name, e.event_date, e.venue_name, e.city
         FROM tickets t
         JOIN ticket_orders o ON o.id = t.order_id
         JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
         JOIN events e ON e.id = t.event_id
        WHERE t.ticket_code = $1
        LIMIT 1`,
      [code]
    );
    if (!rows[0]) throw new AppError(404, "Ticket not found");
    const pkpass = walletPasses.buildApplePkpass(rows[0]);
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Content-Disposition", `attachment; filename="titopay-ticket-${code}.pkpass"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(pkpass);
  } catch (error) {
    next(error);
  }
});

router.post("/tickets/:code/email", requireAuth, publicContactLimiter, async (req, res, next) => {
  try {
    const result = await emailTicketToRecipient(req.auth, req.params.code, req.body?.email || req.body?.destination || "", meta(req));
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Vendor in-app SoftPOS: charge a patron's Event Tag by tapping their wristband
// with the phone (or entering its code). Authenticated as the vendor's own
// session — the service resolves their merchant and reuses the proven terminal
// charge path, which still enforces that this merchant is an authorised, active
// vendor for the tag's event. Not on the sensitive limiter: a busy stall taps
// many times a minute, and idempotency plus vendor authorisation are the real
// controls, exactly as they are on the hardware-terminal path.
router.post("/vendor/tag-charge", requireAuth, async (req, res, next) => {
  try {
    const idempotencyKey = String(req.get("idempotency-key") || req.body?.idempotencyKey || "").trim();
    const charge = await eventTags.chargeEventTagAsVendor(req.auth, req.body || {}, idempotencyKey, req.requestId);
    res.status(charge.idempotentReplay ? 200 : 201).json({ ok: true, charge });
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

// The poster is the one thing an organiser may change on an event that is
// already selling. Everything else on an approved event goes through the
// change-request flow an admin reviews; a poster that is wrong on the day is a
// broken shop window the organiser must be able to fix themselves. Audited.
router.put("/business/events/:id/poster", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, event: await replaceEventPoster(req.auth.userId, eventId, req.body, meta(req)) });
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

// Organiser change requests against an already-approved event: postpone,
// cancel, update details or other. The organiser asks; a TitoPay admin reviews
// and applies (see admin.routes.js). Owner-scoped by business_user_id inside
// the service, so a caller can only touch their own event.
router.post("/business/events/:id/change-request", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.status(201).json({ ok: true, changeRequest: await requestEventChange(req.auth, eventId, req.body, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/events/:id/change-requests", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, items: await listMyEventChangeRequests(req.auth, eventId) });
  } catch (error) {
    next(error);
  }
});

router.get("/business/change-requests", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listMyEventChangeRequests(req.auth) });
  } catch (error) {
    next(error);
  }
});

// The approved events the CALLER may scan because an organiser added them as
// staff. Works for any account type — this is what gives a personal account
// the door scanner, for exactly the events they were assigned to.
router.get("/staff/events", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listStaffScanEvents(req.auth.userId) });
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

// The running attendance count for one event, for the door-scanner view. Gated
// by the same "scan" permission the scanner itself uses, so an assigned staff
// member — not only the organiser — can open the scanner and see the count
// before the first ticket is scanned. Read-only.
router.get("/business/events/:id/attendance", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    if (!(await canManageEventTicketing(req.auth.userId, eventId, "scan"))) {
      throw new AppError(403, "You are not allowed to scan this event");
    }
    res.json({ ok: true, attendance: await eventAttendance(eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/staff/:userId/remove", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    const staffUserId = requireUuid(req.params.userId, "Staff user ID");
    res.json({ ok: true, removed: await removeEventStaff(req.auth, eventId, staffUserId, meta(req)) });
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

/* ---- Campaign Tools -------------------------------------------------------
   An organiser reaching their own patrons about their own event. The audience
   is derived server-side from ticket buyers, so there is no endpoint here that
   accepts a list of strangers to message. */
router.get("/business/events/:id/campaigns", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.json({ ok: true, campaigns: await campaigns.campaignOverview(req.auth.userId, eventId) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/campaigns/email-pack", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.status(201).json({ ok: true, ...await campaigns.buyEmailPack(req.auth.userId, eventId, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/campaigns", requireAuth, async (req, res, next) => {
  try {
    const eventId = requireUuid(req.params.id, "Event ID");
    res.status(201).json({ ok: true, result: await campaigns.submitCampaign(req.auth.userId, eventId, req.body) });
  } catch (error) {
    next(error);
  }
});

// A patron stopping event marketing, for every organiser at once.
router.post("/campaigns/opt-out", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...await campaigns.optOut(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

router.get("/admin/analytics", requireAuth, requireAdminPermission("ticketing"), async (_req, res, next) => {
  try {
    res.json({ ok: true, analytics: await adminTicketingAnalytics() });
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

// DISCOUNT CODES. Every one of these goes through requireEventOwner first, so
// an organiser can only ever see or change codes on an event that is theirs;
// a code on somebody else's event answers 404, exactly like the event itself.
router.get("/business/events/:id/coupons", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listEventCoupons(await requireEventOwner(req)) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/coupons", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.status(201).json({ ok: true, coupon: await createEventCoupon(req.auth, eventId, req.body || {}, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.put("/business/events/:id/coupons/:couponId", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    const couponId = requireUuid(req.params.couponId, "Discount code ID");
    res.json({ ok: true, coupon: await updateEventCoupon(req.auth, eventId, couponId, req.body || {}, meta(req)) });
  } catch (error) {
    next(error);
  }
});

router.delete("/business/events/:id/coupons/:couponId", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    const couponId = requireUuid(req.params.couponId, "Discount code ID");
    res.json({ ok: true, ...(await deleteEventCoupon(req.auth, eventId, couponId, meta(req))) });
  } catch (error) {
    next(error);
  }
});

// THE ORGANISER'S REFUND DESK. Their event, their money going back, so they
// decide. requireEventOwner is the whole authorisation story: a refund on an
// event that is not theirs answers 404 like the event itself.
router.get("/business/events/:id/refunds", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.json({ ok: true, items: await listEventRefunds(eventId, { status: req.query.status || "" }) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/refunds/:refundId/action", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    const refundId = requireUuid(req.params.refundId, "Refund ID");
    // Belt and braces: the refund must belong to the event that was just
    // proven to belong to the caller.
    const { rows } = await pool.query("SELECT id FROM ticket_refunds WHERE id = $1 AND event_id = $2 LIMIT 1", [refundId, eventId]);
    if (!rows[0]) throw new AppError(404, "Refund request not found");
    const refund = await processTicketRefund(refundId, req.body || {},
      { userId: req.auth.userId, userType: "customer" }, meta(req));
    res.json({ ok: true, refund });
  } catch (error) {
    next(error);
  }
});

// WAITLIST, from the organiser's side.
router.get("/business/events/:id/waitlist", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await listEventWaitlist(await requireEventOwner(req))) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/waitlist/notify", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.json({ ok: true, ...(await notifyEventWaitlist(req.auth, eventId, req.body || {})) });
  } catch (error) {
    next(error);
  }
});

// PROMOTER LINKS.
router.get("/business/events/:id/promoters", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await listEventPromoters(await requireEventOwner(req)) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/promoters", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.status(201).json({ ok: true, promoter: await createEventPromoter(req.auth, eventId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.delete("/business/events/:id/promoters/:promoterId", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    const promoterId = requireUuid(req.params.promoterId, "Promoter ID");
    res.json({ ok: true, ...(await removeEventPromoter(req.auth, eventId, promoterId)) });
  } catch (error) {
    next(error);
  }
});

// Duplicate an event onto a new date. This is how a weekly market or a tour
// gets made without a recurrence engine underneath the money path.
router.post("/business/events/:id/duplicate", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    res.status(201).json({ ok: true, event: await duplicateEvent(req.auth, eventId, req.body || {}) });
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
    // Whatever the organiser has for the vendor: @username, wallet ID, phone,
    // email, merchant code — or the raw merchant UUID. Resolved in the service.
    const identifier = String(req.body?.merchantId || req.body?.identifier || "").trim();
    res.status(201).json({ ok: true, vendor: await eventTags.addEventVendor(req.auth, eventId, identifier) });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/vendors/:vendorId/revoke", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireEventOwner(req);
    const vendorRowId = requireUuid(req.params.vendorId, "Vendor ID");
    res.json({ ok: true, vendor: await eventTags.suspendEventVendor(req.auth, eventId, vendorRowId) });
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

// requireTagStaff returns the event the caller is authorised for. Both routes
// below take a tag id from the URL as well, and the two must be checked against
// each other — being staff at one event authorises nothing at another. The
// service does that check; these routes exist to carry the answer to it.
router.post("/business/events/:id/tags/:tagId/status", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireTagStaff(req);
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.json({
      ok: true,
      tag: await eventTags.setTagStatus(req.auth, eventId, tagId, String(req.body?.status || "").toUpperCase(), { reason: req.body?.reason })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/business/events/:id/tags/:tagId/replace", requireAuth, async (req, res, next) => {
  try {
    const eventId = await requireTagStaff(req);
    const tagId = requireUuid(req.params.tagId, "Tag ID");
    res.status(201).json({ ok: true, ...(await eventTags.replaceTag(req.auth, eventId, tagId, req.body || {})) });
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
