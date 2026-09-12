"use strict";

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireUuid } = require("../lib/validation");
const {
  createBeneficiary,
  deleteBeneficiary,
  listBeneficiaries,
  updateBeneficiary
} = require("../services/beneficiary-service");

const router = express.Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await listBeneficiaries(req.auth, req.query)) });
  } catch (error) {
    next(error);
  }
});

router.get("/search", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await listBeneficiaries(req.auth, { ...req.query, search: req.query.q || req.query.search })) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, beneficiary: await createBeneficiary(req.auth, req.body) });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    res.json({ ok: true, beneficiary: await updateBeneficiary(req.auth, requireUuid(req.params.id, "Beneficiary ID"), req.body) });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await deleteBeneficiary(req.auth, requireUuid(req.params.id, "Beneficiary ID"));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
