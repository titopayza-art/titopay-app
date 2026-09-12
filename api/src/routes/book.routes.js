"use strict";

// TITOPAY BOOK.
//
//   GET  /v1/book/options                what kinds of business exist
//   GET  /v1/book/activation             the price, and whether this business has it
//   POST /v1/book/activation             pay the once-off R250
//   GET  /v1/book/venues                 the venues this business runs
//   POST /v1/book/venues                 create one
//   GET  /v1/book/venues/:id             read one
//   PATCH /v1/book/venues/:id            edit one
//   POST /v1/book/venues/:id/status      publish, pause or archive
//
// MOUNTED ABOVE lookupRoutes IN routes/index.js, AND THAT MATTERS. lookupRoutes
// sits on the bare /v1 prefix with requireAuth on it, so anything mounted after
// it never receives a request - every unmatched path turns into 401 instead of
// 404. Book's public link preview will live here later, and mounted below that
// line it would answer 401 to a WhatsApp crawler and preview as nothing.
//
// Authentication is router-level today because every endpoint below belongs to a
// signed-in business. When the public venue page is added it must be declared
// BEFORE this router.use(requireAuth), the way ticketing declares /public/events.

const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { AppError } = require("../lib/errors");
const activation = require("../services/book-activation-service");
const book = require("../services/book-service");
const catalogue = require("../services/book-catalogue-service");
const bookings = require("../services/book-booking-service");
const publicBook = require("../services/book-public-service");
const { publicBookingLimiter } = require("../middleware/rate-limits");

const router = express.Router();

// One wrapper so no handler can forget to pass an error to next().
const handlePublic = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

/* ======================================================= THE PUBLIC PAGE
 *
 * DECLARED BEFORE router.use(requireAuth) ON PURPOSE. A person tapping a
 * business's link on WhatsApp has no TitoPay account and no token, and
 * requiring one would throw away most of the reach that link exists to give.
 * Everything below this block is signed-in only.
 *
 * Cached for five minutes and rate limited, because this is the one Book
 * surface the open internet can reach and it must not become a way to slow the
 * rest of TitoPay down.
 */
router.get("/public/venues/:slug", handlePublic(async (req, res) => {
  const venue = await publicBook.publicVenue(req.params.slug);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ ok: true, venue });
}));

router.get("/public/venues/:slug/availability", handlePublic(async (req, res) => {
  const result = await publicBook.publicAvailability(
    req.params.slug, String(req.query.serviceId || ""), String(req.query.date || ""));
  // Shorter than the venue itself: a time that was open a minute ago may not be.
  res.set("Cache-Control", "public, max-age=30");
  res.json({ ok: true, ...result });
}));

// The only public WRITE in Book. Behind the same limiter the other public
// contact endpoints use, because an unauthenticated write is a spam surface.
router.post("/public/venues/:slug/bookings", publicBookingLimiter, handlePublic(async (req, res) => {
  const made = await publicBook.publicBooking(req.params.slug, req.body || {},
    { ipAddress: req.ip, userAgent: req.get("user-agent") });
  res.status(201).json({ ok: true, booking: made });
}));

router.get("/public/discover", handlePublic(async (req, res) => {
  const venues = await publicBook.discover({
    category: String(req.query.category || ""),
    city: String(req.query.city || ""),
    search: String(req.query.search || req.query.q || ""),
    limit: req.query.limit
  });
  res.set("Cache-Control", "public, max-age=120");
  res.json({ ok: true, venues });
}));

// Whether Book is worth showing a customer at all. Cheap, cached, and the thing
// that keeps a personal user from meeting an empty screen.
router.get("/public/discovery-summary", handlePublic(async (_req, res) => {
  const summary = await publicBook.discoverySummary();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ ok: true, ...summary });
}));

router.use(requireAuth);

// There is no shared requireCustomer middleware in this codebase; every router
// that needs one declares it locally and calls it per handler. Copied rather
// than invented so Book behaves like the routers beside it.
function requireCustomer(req) {
  if (req.auth.userType !== "customer") throw new AppError(403, "Customer access required");
}
function requireBusiness(req) {
  requireCustomer(req);
  if (req.auth.accountType !== "business") {
    throw new AppError(403, "This is a business feature. Switch to your business account to use TitoPay Book.");
  }
}
const actorOf = (req) => ({
  userId: req.auth.userId,
  accountType: req.auth.accountType,
  profileLocked: req.auth.profileLocked
});
const metaOf = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

// One wrapper so no handler can forget to pass an error to next().
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

/* ------------------------------------------------------------- reference */

router.get("/options", handle(async (req, res) => {
  requireCustomer(req);
  res.json({ ok: true, ...book.options() });
}));

/* ------------------------------------------------------------ activation */

router.get("/activation", handle(async (req, res) => {
  requireBusiness(req);
  res.json({ ok: true, activation: await activation.activationStatus(req.auth.userId) });
}));

router.post("/activation", handle(async (req, res) => {
  requireBusiness(req);
  const result = await activation.activate(actorOf(req), metaOf(req));
  // 200 when it was already theirs, 201 when this call is what bought it, so a
  // retried request is distinguishable from the one that took the money.
  res.status(result.alreadyActive ? 200 : 201).json({ ok: true, ...result });
}));

/* ---------------------------------------------------------------- venues */

router.get("/venues", handle(async (req, res) => {
  requireBusiness(req);
  res.json({ ok: true, venues: await book.listVenues(req.auth.userId) });
}));

router.post("/venues", handle(async (req, res) => {
  requireBusiness(req);
  const venue = await book.createVenue(actorOf(req), req.body || {}, metaOf(req));
  res.status(201).json({ ok: true, venue });
}));

router.get("/venues/:id", handle(async (req, res) => {
  requireBusiness(req);
  res.json({ ok: true, venue: await book.getVenue(req.auth.userId, req.params.id) });
}));

router.patch("/venues/:id", handle(async (req, res) => {
  requireBusiness(req);
  const venue = await book.updateVenue(actorOf(req), req.params.id, req.body || {}, metaOf(req));
  res.json({ ok: true, venue });
}));

router.post("/venues/:id/status", handle(async (req, res) => {
  requireBusiness(req);
  const venue = await book.setVenueStatus(actorOf(req), req.params.id, String(req.body?.status || ""), metaOf(req));
  res.json({ ok: true, venue });
}));

/* ------------------------------------------------- what a venue offers */

router.get("/venues/:id/services", handle(async (req, res) => {
  requireBusiness(req);
  res.json({ ok: true, services: await catalogue.listServices(req.auth.userId, req.params.id) });
}));

router.post("/venues/:id/services", handle(async (req, res) => {
  requireBusiness(req);
  const service = await catalogue.createService(actorOf(req), req.params.id, req.body || {}, metaOf(req));
  res.status(201).json({ ok: true, service });
}));

router.patch("/venues/:id/services/:serviceId", handle(async (req, res) => {
  requireBusiness(req);
  const service = await catalogue.updateService(
    actorOf(req), req.params.id, req.params.serviceId, req.body || {}, metaOf(req));
  res.json({ ok: true, service });
}));

router.get("/venues/:id/resources", handle(async (req, res) => {
  requireBusiness(req);
  res.json({ ok: true, resources: await catalogue.listResources(req.auth.userId, req.params.id) });
}));

router.post("/venues/:id/resources", handle(async (req, res) => {
  requireBusiness(req);
  const resource = await catalogue.createResource(actorOf(req), req.params.id, req.body || {}, metaOf(req));
  res.status(201).json({ ok: true, resource });
}));

router.patch("/venues/:id/resources/:resourceId", handle(async (req, res) => {
  requireBusiness(req);
  const resource = await catalogue.updateResource(
    actorOf(req), req.params.id, req.params.resourceId, req.body || {}, metaOf(req));
  res.json({ ok: true, resource });
}));

/* --------------------------------------------------------- opening hours */

router.get("/venues/:id/opening-hours", handle(async (req, res) => {
  requireBusiness(req);
  res.json({ ok: true, openingHours: await catalogue.listOpeningHours(req.auth.userId, req.params.id) });
}));

// The whole week at once, deliberately: a screen edits the WEEK, and sending
// only what changed leaves a removed Sunday behind.
router.put("/venues/:id/opening-hours", handle(async (req, res) => {
  requireBusiness(req);
  const openingHours = await catalogue.setOpeningHours(
    actorOf(req), req.params.id, req.body?.openingHours || [], metaOf(req));
  res.json({ ok: true, openingHours });
}));

/* -------------------------------------------------------------- bookings */

router.get("/venues/:id/bookings", handle(async (req, res) => {
  requireBusiness(req);
  await book.canManageVenue(req.auth.userId, req.params.id);
  const statuses = String(req.query.status || "").split(",").map((s) => s.trim()).filter(Boolean);
  res.json({ ok: true, bookings: await bookings.listVenueBookings(req.params.id, {
    from: req.query.from || null, to: req.query.to || null,
    statuses: statuses.length ? statuses : null
  })});
}));

router.post("/venues/:id/bookings/:bookingId/status", handle(async (req, res) => {
  requireBusiness(req);
  // Ownership FIRST: without this a business could move a booking belonging to
  // somebody else's venue simply by knowing its id.
  await book.canManageVenue(req.auth.userId, req.params.id);
  const { rows } = await require("../db/pool").pool.query(
    "SELECT id FROM book_bookings WHERE id = $1 AND venue_id = $2 LIMIT 1",
    [req.params.bookingId, req.params.id]);
  if (!rows[0]) throw new AppError(404, "That booking was not found.");
  const updated = await bookings.setBookingStatus(
    req.params.bookingId, String(req.body?.status || ""), actorOf(req),
    { ...metaOf(req), reason: req.body?.reason });
  res.json({ ok: true, booking: updated });
}));

/* ------------------------------------------------- a customer's own list */

router.get("/my-bookings", handle(async (req, res) => {
  requireCustomer(req);
  res.json({ ok: true, bookings: await bookings.listCustomerBookings(req.auth.userId) });
}));

module.exports = router;
