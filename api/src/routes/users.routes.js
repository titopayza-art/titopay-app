const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requireAdminPermission } = require("../middleware/rbac");
const { AppError } = require("../lib/errors");
const { ensureAuthenticationPreferenceSchema } = require("../services/authentication-preference-service");

const router = express.Router();

router.use(requireAuth);
router.use((req, _res, next) => {
  if (req.auth.userType !== "admin") {
    next(new AppError(403, "Admin access required"));
    return;
  }
  next();
});
router.use(requireAdminPermission("users"));

router.get("/", async (_req, res, next) => {
  try {
    await ensureAuthenticationPreferenceSchema();
    const { rows } = await pool.query(
      `SELECT id, account_type, full_name, username, email, phone, status, profile_locked, fica_status,
              preferred_authentication_method, authentication_method_updated_at,
              COALESCE(last_successful_authentication_at, last_login_at) AS last_successful_authentication_at,
              COALESCE(last_failed_authentication_at, last_failed_login_at) AS last_failed_authentication_at,
              created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 250`
    );
    res.json({ ok: true, items: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    await ensureAuthenticationPreferenceSchema();
    const { rows } = await pool.query(
      `SELECT id, account_type, full_name, username, email, phone, status, profile_locked, fica_status,
              preferred_authentication_method, authentication_method_updated_at,
              COALESCE(last_successful_authentication_at, last_login_at) AS last_successful_authentication_at,
              COALESCE(last_failed_authentication_at, last_failed_login_at) AS last_failed_authentication_at,
              created_at, updated_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError(404, "User not found");
    res.json({ ok: true, user: rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
