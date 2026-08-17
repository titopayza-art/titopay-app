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

const router = express.Router();

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

module.exports = router;
