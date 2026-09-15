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
