"use strict";

// TITOPRO: THE DOOR.
//
// Everything behind this file was built first and was unreachable - the
// listing service, the job lifecycle, the vetting gate and the fees all
// existed with no route into any of them, so nobody could list, search or
// raise a job. This is that door.
//
// THE ACTOR IS TAKEN FROM THE TOKEN, NEVER FROM THE BODY. A job belongs to
// two people and each of them may only do their own half - the customer
// accepts, the professional quotes - and the services enforce that by
// comparing against req.auth. A userId accepted from a request body would
// make every one of those checks decorative.
//
// Nothing here moves money. A job records what was quoted and what the fees
// would be; holding a customer's payment for an unrelated professional is a
// different regulated activity and is not built.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireUuid } = require("../lib/validation");
const reference = require("../config/titopro-reference");
const profiles = require("../services/titopro-profile-service");
const vetting = require("../services/titopro-vetting-service");
const jobs = require("../services/titopro-service");
const reputation = require("../services/titopro-reputation-service");
const chat = require("../services/chat-service");
const { AppError } = require("../lib/errors");

const router = express.Router();
router.use(requireAuth);

/* ------------------------------------------------------------- catalogue */

// What TitoPay lists, and how each kind of work is actually fulfilled. The
// app builds its pickers from this rather than carrying a second copy that
// would drift the first time a profession is added or withdrawn.
router.get("/professions", (_req, res) => {
  res.json({
    ok: true,
    shapes: reference.SHAPES.map((key) => ({ key, ...reference.SHAPE_COPY[key] })),
    // What a customer is told before they let somebody into their house.
    // Served rather than written into the app, so the wording legal signs off
    // is the wording every surface shows.
    vettingAdvisory: reference.VETTING_ADVISORY,
    professions: reference.PROFESSIONS.map((item) => ({
      key: item.key,
      label: item.label,
      group: item.group,
      shape: item.shape,
      hint: item.hint,
      usesDiary: reference.usesBookingDiary(item.key),
      // So a professional is told what listing this work will require BEFORE
      // they fill the form in, rather than at the moment they press publish.
      requiredChecks: reference.requiredChecksFor(item.key).map((check) => ({
        key: check,
        label: reference.vettingCheck(check).label,
        says: reference.vettingCheck(check).says
      }))
    }))
  });
});

/* ---------------------------------------------------------- my listing */

router.get("/me/listing", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await profiles.getMyProfile(req.auth)) });
  } catch (error) {
    next(error);
  }
});

router.put("/me/listing", async (req, res, next) => {
  try {
    res.json({ ok: true, profile: await profiles.saveProfile(req.auth, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.post("/me/listing/publish", async (req, res, next) => {
  try {
    res.json({ ok: true, profile: await profiles.publishProfile(req.auth) });
  } catch (error) {
    next(error);
  }
});

router.post("/me/listing/pause", async (req, res, next) => {
  try {
    res.json({ ok: true, profile: await profiles.pauseProfile(req.auth) });
  } catch (error) {
    next(error);
  }
});

// Throwing away a listing that never went live. DELETE rather than another
// POST under /me/listing, because that is what it does: the row goes.
router.delete("/me/listing", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await profiles.clearDraftProfile(req.auth)) });
  } catch (error) {
    next(error);
  }
});

// A professional may see the state of their OWN checks - cleared, pending,
// when one expires - so they can renew a certificate before their listing
// drops rather than after. They cannot decide one; that is admin only.
router.get("/me/vetting", async (req, res, next) => {
  try {
    res.json({ ok: true, checks: await vetting.checksForUser(req.auth.userId) });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------ discovery */

router.get("/search", async (req, res, next) => {
  try {
    res.json({
      ok: true,
      professionals: await profiles.searchProfessionals({
        profession: req.query.profession ? String(req.query.profession) : null,
        city: req.query.city ? String(req.query.city) : null,
        limit: Number(req.query.limit) || 50
      })
    });
  } catch (error) {
    next(error);
  }
});

// One professional's page: who they are, what they do, and what the customers
// who actually paid them said afterwards.
router.get("/professionals/:userId", async (req, res, next) => {
  try {
    res.json({ ok: true, professional: await profiles.publicProfile(requireUuid(req.params.userId, "Professional ID")) });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ chat */

// TALKING TO THE OTHER SIDE, ON THE CHAT TITOPAY ALREADY HAS.
//
// A price for painting a house is negotiated, not listed, so TitoPro needs a
// conversation. It does NOT need a second messaging system: TitoPay Chat
// already carries threads, delivery state, read receipts, muting, blocking and
// a moderation trail, and a parallel one would be a second thing to secure, a
// second place a customer looks for the same message, and a second inbox to
// keep in sync. This opens a thread on that system and hands back its id.
//
// The chat service does its own checks - both sides verified, no thread with
// yourself, blocked threads refused - so this adds only the TitoPro question:
// is this person actually listed? Without that, the endpoint would be a
// directory for messaging any user id somebody cared to type.
router.post("/professionals/:userId/chat", async (req, res, next) => {
  try {
    const userId = requireUuid(req.params.userId, "Professional ID");
    const listing = await profiles.requirePublishedProfessional(userId);
    const thread = await chat.openThread(req.auth, {
      recipientId: userId,
      title: listing.trading_name || undefined
    });
    res.json({ ok: true, thread });
  } catch (error) {
    next(error);
  }
});

// THE CONVERSATION ABOUT A JOB, KEPT WITH THE JOB.
//
// Either side may open it, and the thread id is written onto the job record,
// so the messages where a price was agreed can be found from the job months
// later rather than living in an inbox nobody thinks to search. Both parties
// are checked by the job service; a listing that has since been taken down
// does NOT close the conversation, because a customer mid-job still has to be
// able to reach the person in their house.
router.post("/jobs/:id/chat", async (req, res, next) => {
  try {
    const jobId = requireUuid(req.params.id, "Job ID");
    const job = await jobs.getJob(req.auth, jobId);
    const otherSide = await jobs.chatCounterpart(req.auth, jobId);
    if (!otherSide) {
      throw new AppError(409, "No professional has taken this job yet, so there is nobody to message.");
    }
    const thread = await chat.openThread(req.auth, { recipientId: otherSide, title: job.title });
    // Recorded on the job, not just returned. Best effort on purpose: a thread
    // that opens and a job record that does not learn about it is still a
    // working conversation, and failing the request would take that away too.
    // LOGGED rather than swallowed, because a catch that says nothing is how a
    // column type mismatch survives for months - the test asserts the id
    // really lands, so this only ever fires for something unforeseen.
    await jobs.attachChatThread(req.auth, jobId, thread.id || thread.threadId)
      .catch((error) => console.error("[titopro] chat thread not attached to job",
        { jobId, message: error.message }));
    res.json({ ok: true, thread });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------- reporting */

// The reasons a customer can pick from, served rather than hard-coded in the
// app, so the list the customer sees and the list the API accepts cannot drift.
router.get("/report-reasons", (_req, res) => {
  res.json({
    ok: true,
    reasons: reference.REPORT_CATEGORIES.map((item) => ({
      key: item.key, label: item.label, says: item.says
    }))
  });
});

// REPORTING A LISTING. Open to any signed-in user, not only to somebody who
// hired them - see titopro-reputation-service for why that matters.
router.post("/professionals/:userId/report", async (req, res, next) => {
  try {
    const userId = requireUuid(req.params.userId, "Professional ID");
    res.status(201).json({ ok: true, report: await reputation.reportListing(req.auth, userId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

// Whether this customer has already reported this listing, so the app can say
// so instead of offering the form a second time.
router.get("/professionals/:userId/my-report", async (req, res, next) => {
  try {
    const userId = requireUuid(req.params.userId, "Professional ID");
    res.json({ ok: true, report: await reputation.myReportFor(req.auth, userId) });
  } catch (error) {
    next(error);
  }
});

/* ----------------------------------------------------------------- jobs */

router.post("/jobs", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, job: await jobs.createJob(req.auth, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.get("/jobs", async (req, res, next) => {
  try {
    const role = req.query.role === "professional" ? "professional" : "customer";
    res.json({ ok: true, role, jobs: await jobs.listJobsForUser(req.auth.userId, { role }) });
  } catch (error) {
    next(error);
  }
});

// What a job of this size would cost both sides, before anybody commits to
// it. Read from the pricing engine, so a rate an operator changes in the
// console changes this too.
router.get("/quote-preview", async (req, res, next) => {
  try {
    res.json({ ok: true, fees: await jobs.quoteFees(Number(req.query.amount) || 0) });
  } catch (error) {
    next(error);
  }
});

router.get("/jobs/:id", async (req, res, next) => {
  try {
    res.json({ ok: true, job: await jobs.getJob(req.auth, requireUuid(req.params.id, "Job ID")) });
  } catch (error) {
    next(error);
  }
});

/* --------------------------------------------------------------- ratings */

// DECLARED BEFORE THE /jobs/:id/:step ROUTE BELOW, because Express matches in
// order and that one would otherwise swallow "rate" and answer "Unknown step".
// Rating is not a step in the job's state machine - the job is already
// finished - so it does not belong in that map either.
router.post("/jobs/:id/rate", async (req, res, next) => {
  try {
    const jobId = requireUuid(req.params.id, "Job ID");
    res.status(201).json({ ok: true, rating: await reputation.rateJob(req.auth, jobId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

router.get("/jobs/:id/rating", async (req, res, next) => {
  try {
    const jobId = requireUuid(req.params.id, "Job ID");
    res.json({ ok: true, rating: await reputation.ratingForJob(req.auth, jobId) });
  } catch (error) {
    next(error);
  }
});

// Each step names the side that may take it. The service checks that against
// the token and refuses the other one, so these are routes rather than a
// single "set status" endpoint that would put the state machine in the hands
// of whoever is calling.
const STEPS = {
  quote: (auth, id, body) => jobs.quoteJob(auth, id, body),
  requote: (auth, id, body) => jobs.reQuoteJob(auth, id, body),
  accept: (auth, id) => jobs.acceptQuote(auth, id),
  decline: (auth, id, body) => jobs.declineQuote(auth, id, body),
  schedule: (auth, id, body) => jobs.scheduleJob(auth, id, body),
  start: (auth, id) => jobs.startJob(auth, id),
  done: (auth, id, body) => jobs.markWorkDone(auth, id, body),
  confirm: (auth, id) => jobs.confirmJob(auth, id),
  dispute: (auth, id, body) => jobs.disputeJob(auth, id, body),
  cancel: (auth, id, body) => jobs.cancelJob(auth, id, body)
};

router.post("/jobs/:id/:step", async (req, res, next) => {
  try {
    const step = STEPS[req.params.step];
    if (!step) return res.status(404).json({ ok: false, error: "Unknown step" });
    const jobId = requireUuid(req.params.id, "Job ID");
    res.json({ ok: true, job: await step(req.auth, jobId, req.body || {}) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
