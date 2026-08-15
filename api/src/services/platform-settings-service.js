const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { AppError } = require("../lib/errors");

const ADMIN_AUTHENTICATION_KEY = "admin_authentication";
const AUTHENTICATION_MODES = new Set(["password_only", "password_email_otp"]);
const PASSWORD_ONLY_VALUE = JSON.stringify({ mode: "password_only" });
const PASSWORD_ONLY_POLICY = {
  mode: "password_only",
  otpRequired: false
};

function normalizeAuthenticationMode(mode) {
  return AUTHENTICATION_MODES.has(mode) ? mode : "password_only";
}

function explicitAdminAuthenticationMode() {
  const raw = process.env.ADMIN_OTP_REQUIRED ?? process.env.VERIFY_ADMIN_OTP;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  return ["false", "0", "no", "off"].includes(String(raw).trim().toLowerCase())
    ? "password_only"
    : "password_email_otp";
}

// ONE DDL PER PROCESS, NOT ONE PER REQUEST.
//
// This ran a CREATE TABLE IF NOT EXISTS ahead of every single read and write of
// every platform setting. That was invisible while the callers were all admin
// screens, and stopped being invisible the moment a PUBLIC unauthenticated
// endpoint started reading a setting: an anonymous request could put a DDL
// statement on the database, which is a cheap thing to send and a not-cheap
// thing to serve.
//
// The promise is memoised rather than a boolean, so concurrent first callers
// wait on the same statement instead of racing to issue their own. A failure is
// not cached: the next caller retries rather than the process deciding forever
// that the table cannot be made.
let platformSettingsTableReady = null;

async function ensurePlatformSettingsTable() {
  if (!platformSettingsTableReady) {
    platformSettingsTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::JSONB,
        updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((error) => {
      platformSettingsTableReady = null;
      throw error;
    });
  }
  await platformSettingsTableReady;
}

function policyFromValue(value = {}) {
  const mode = normalizeAuthenticationMode(value.mode);
  return {
    mode,
    otpRequired: mode === "password_email_otp",
    source: "database"
  };
}

async function getAdminAuthenticationPolicy() {
  try {
    await ensurePlatformSettingsTable();
    const { rows } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1",
      [ADMIN_AUTHENTICATION_KEY]
    );
    const explicitMode = explicitAdminAuthenticationMode();
    // Environment flags provide the initial/default mode only. Once a Super
    // Admin saves a choice, the persisted Admin Portal setting is the source
    // of truth so the toggle survives refreshes and restarts.
    if (!rows[0]) {
      const initialMode = explicitMode || (config.adminOtpRequired ? "password_email_otp" : "password_only");
      const { rows: inserted } = await pool.query(
        `INSERT INTO platform_settings (key, value)
         VALUES ($1, $2::JSONB)
         ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
         RETURNING value`,
        [ADMIN_AUTHENTICATION_KEY, JSON.stringify({ mode: initialMode })]
      );
      return policyFromValue(inserted[0]?.value);
    }
    return policyFromValue(rows[0].value);
  } catch (error) {
    return {
      mode: config.adminOtpRequired ? "password_email_otp" : "password_only",
      otpRequired: Boolean(config.adminOtpRequired),
      source: "environment_fallback",
      error: error.message
    };
  }
}

async function forceAdminPasswordOnlyPolicy(source = "forced_password_only") {
  await ensurePlatformSettingsTable();
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2::JSONB, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [ADMIN_AUTHENTICATION_KEY, PASSWORD_ONLY_VALUE]
  );
  return { ...PASSWORD_ONLY_POLICY, source };
}

async function setAdminAuthenticationPolicy({ mode, updatedBy }) {
  await ensurePlatformSettingsTable();
  const normalizedMode = normalizeAuthenticationMode(mode);
  if (normalizedMode !== mode) {
    throw new AppError(400, "Unsupported authentication mode");
  }
  const { rows } = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::JSONB, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING value, updated_at`,
    [ADMIN_AUTHENTICATION_KEY, JSON.stringify({ mode: normalizedMode }), updatedBy || null]
  );
  return { ...policyFromValue(rows[0].value), updatedAt: rows[0].updated_at };
}

async function getPlatformSetting(key, fallback = {}) {
  await ensurePlatformSettingsTable();
  const { rows } = await pool.query("SELECT value, updated_at FROM platform_settings WHERE key = $1 LIMIT 1", [key]);
  return {
    key,
    value: rows[0]?.value || fallback,
    updatedAt: rows[0]?.updated_at || null
  };
}

// The same read, plus who last wrote it and whether a row exists at all.
//
// getPlatformSetting folds "no row" and "row holding the default" into the same
// answer, which is right for a caller that only wants the value and wrong for
// an editing screen: an operator looking at a form cannot tell whether they are
// about to revise a colleague's wording or write the first version. The join is
// LEFT so a setting written by a since-deleted admin still reports its date.
async function getPlatformSettingRecord(key) {
  await ensurePlatformSettingsTable();
  const { rows } = await pool.query(
    `SELECT s.value, s.updated_at, s.updated_by,
            COALESCE(NULLIF(a.full_name, ''), a.username, a.email) AS updated_by_name
       FROM platform_settings s
       LEFT JOIN admin_users a ON a.id = s.updated_by
      WHERE s.key = $1
      LIMIT 1`,
    [key]
  );
  const row = rows[0] || null;
  return {
    key,
    exists: Boolean(row),
    value: row ? row.value : null,
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
    updatedByName: row?.updated_by_name || null
  };
}

async function setPlatformSetting(key, value = {}, updatedBy = null) {
  await ensurePlatformSettingsTable();
  const { rows } = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::JSONB, $3, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING value, updated_at`,
    [key, JSON.stringify(value || {}), updatedBy]
  );
  return { key, value: rows[0].value, updatedAt: rows[0].updated_at };
}

module.exports = {
  AUTHENTICATION_MODES,
  forceAdminPasswordOnlyPolicy,
  getAdminAuthenticationPolicy,
  setAdminAuthenticationPolicy,
  getPlatformSetting,
  getPlatformSettingRecord,
  setPlatformSetting
};
