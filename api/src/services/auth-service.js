const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { AppError } = require("../lib/errors");
const { sha256, sixDigitOtp } = require("../lib/crypto");
const { hashPassword, verifyPassword } = require("../lib/passwords");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../lib/jwt");
const { generateUniqueWalletNumber } = require("../lib/wallet-id");
const { isMissingDbObjectError, logDbCompatibilityWarning } = require("../lib/db-safe");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");
const { sendOtpNotification, createNotification, markNotification } = require("./notification-service");
const { getAdminAuthenticationPolicy, getPlatformSetting } = require("./platform-settings-service");
const { createVerificationForUser, queueWelcomeEmail, requestEmailPasswordReset, queueEmail } = require("./email-centre-service");
const emailOtp = require("./email-otp-service");
const {
  createChallenge: createEmailOtpChallenge,
  verifyChallenge: verifyEmailOtpChallenge
} = emailOtp;
const {
  passwordChangeOptions: loadPasswordChangeOptions,
  requestEmailPasswordChangeOtp
} = require("./password-change-otp-service");

const ADMIN_ROLE_PERMISSIONS = {
  owner: ["*"],
  root: ["*"],
  super_admin: ["*"],
  ceo: ["*"],
  coo: ["dashboard", "analytics", "marketing", "marketing_sms_approve", "marketing_email_approve", "ticketing", "enterprise_distribution", "audit"],
  developer: ["*"],
  engineering: ["engineering", "security", "audit", "dashboard", "transactions", "services", "EMAIL_VIEW", "EMAIL_LOG_VIEW", "EMAIL_QUEUE_MANAGE", "EMAIL_OTP_VIEW", "EMAIL_OTP_LOGS"],
  // "event_tags" gates the Event Tag console: searching an attendee's cashless
  // credential, blocking a lost one and reading its audit trail. It is granted
  // only to the roles that already field lost-tag reports and reconcile event
  // money — deliberately NOT to marketing, which holds "ticketing" for sales
  // reporting and has no reason to disable someone's wristband. Widening it
  // later needs no code change: admin_role_permission_overrides already covers
  // it, like every other permission.
  customer_support: ["dashboard", "users", "wallets", "support", "transactions", "profile_lock", "ticketing", "event_tags", "EMAIL_VIEW", "EMAIL_LOG_VIEW", "EMAIL_OTP_VIEW", "EMAIL_OTP_LOGS"],
  compliance: ["dashboard", "compliance", "users", "merchants", "ticketing", "event_tags", "enterprise_distribution", "audit", "EMAIL_VIEW", "EMAIL_LOG_VIEW", "EMAIL_OTP_VIEW", "EMAIL_OTP_LOGS"],
  finance: ["dashboard", "wallets", "transactions", "revenue", "payouts", "ticketing", "event_tags", "enterprise_distribution", "EMAIL_VIEW", "EMAIL_LOG_VIEW"],
  marketing: ["dashboard", "analytics", "marketing", "ticketing"]
};

function normalizeAdminRole(role) {
  return String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function getAdminRolePermissions(role) {
  return ADMIN_ROLE_PERMISSIONS[normalizeAdminRole(role)] || [];
}

async function getEffectiveAdminRolePermissions(role) {
  const normalized = normalizeAdminRole(role);
  if (["owner", "root", "super_admin", "developer", "ceo"].includes(normalized)) {
    return getAdminRolePermissions(normalized);
  }
  const { value: overrides } = await getPlatformSetting("admin_role_permission_overrides", {});
  const configured = overrides && Array.isArray(overrides[normalized]) ? overrides[normalized] : null;
  return configured || getAdminRolePermissions(normalized);
}

function isRootAdminRole(role) {
  return ["owner", "root", "ceo", "super_admin"].includes(normalizeAdminRole(role));
}

function maskDestination(value) {
  if (!value) return null;
  if (value.includes("@")) {
    const [name, domain] = value.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

async function safeAuditLog(entry) {
  try {
    await writeAuditLog(entry);
  } catch (error) {
    console.error("[auth-audit-log-failed]", {
      action: entry?.action,
      actorType: entry?.actorType,
      actorId: entry?.actorId,
      message: error.message,
      code: error.code
    });
  }
}

async function safeSecurityLog(entry) {
  try {
    await writeSecurityLog(entry);
  } catch (error) {
    console.error("[auth-security-log-failed]", {
      eventType: entry?.eventType,
      actorType: entry?.actorType,
      actorId: entry?.actorId,
      message: error.message,
      code: error.code
    });
  }
}

let authRuntimeSchemaReady = false;

async function ensureAuthRuntimeSchema() {
  if (authRuntimeSchemaReady) return;
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_locked BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS fica_status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_authentication_method TEXT NOT NULL DEFAULT 'PUSH'");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS authentication_method_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_successful_authentication_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_authentication_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_ip TEXT");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'admin')),
      user_id UUID NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('customer', 'admin')),
      refresh_token_hash TEXT NOT NULL,
      access_jti TEXT NOT NULL,
      device_name TEXT,
      platform TEXT,
      user_agent TEXT,
      ip_address TEXT,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS platform TEXT");
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_reason TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_type, user_id, scope)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_sessions_access_jti ON sessions (access_jti)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions (refresh_token_hash)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id UUID PRIMARY KEY,
      user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'admin')),
      user_id UUID NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      channels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      attempts INTEGER NOT NULL DEFAULT 0,
      resend_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS resend_count INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_otp_codes_lookup ON otp_codes (user_type, user_id, purpose, expires_at)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id UUID,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id UUID,
      ip_address TEXT,
      user_agent TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_logs (
      id UUID PRIMARY KEY,
      actor_type TEXT NOT NULL DEFAULT 'unknown',
      actor_id UUID,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      ip_address TEXT,
      user_agent TEXT,
      device_fingerprint TEXT,
      session_id TEXT,
      success BOOLEAN,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_security_logs_created_at ON security_logs (created_at DESC)");
  authRuntimeSchemaReady = true;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    userType: user.user_type,
    accountType: user.account_type,
    role: user.role,
    fullName: user.full_name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    status: user.status,
    profileLocked: user.profile_locked,
    ficaStatus: user.fica_status,
    profilePhotoUrl: user.profile_photo_url,
    businessLogoUrl: user.business_logo_url,
    preferredAuthenticationMethod: user.preferred_authentication_method || "PUSH",
    authenticationMethodUpdatedAt: user.authentication_method_updated_at || null,
    lastSuccessfulAuthenticationAt: user.last_successful_authentication_at || user.last_login_at || null,
    lastFailedAuthenticationAt: user.last_failed_authentication_at || user.last_failed_login_at || null
  };
}

function normalizeCustomer(row) {
  return {
    ...row,
    user_type: "customer",
    role: "customer"
  };
}

function normalizeAdmin(row) {
  return {
    ...row,
    user_type: "admin",
    account_type: null,
    phone: null,
    profile_locked: false,
    fica_status: null
  };
}

function normalizeSouthAfricanPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("27") && digits.length === 11) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+27${digits.slice(1)}`;
  return raw.replace(/\s+/g, "");
}

function assertSouthAfricanPhone(value) {
  const phone = normalizeSouthAfricanPhone(value);
  if (!/^\+27[6-8][0-9]{8}$/.test(phone)) {
    throw new AppError(400, "Enter a valid South African cellphone number starting with +27.");
  }
  return phone;
}

async function getAccountById(userType, id) {
  if (userType === "admin") {
    const { rows } = await pool.query("SELECT * FROM admin_users WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ? normalizeAdmin(rows[0]) : null;
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
  return rows[0] ? normalizeCustomer(rows[0]) : null;
}

async function issueTokens({ user, scope, deviceName, platform, userAgent, ipAddress }) {
  await ensureAuthRuntimeSchema();
  const sessionId = uuidv4();
  const accessJti = uuidv4();
  const refreshToken = signRefreshToken({ sub: user.id, sid: sessionId, typ: user.user_type, scope });
  const accessToken = signAccessToken({
    sub: user.id,
    sid: sessionId,
    jti: accessJti,
    typ: user.user_type,
    role: user.role,
    scope
  });
  await pool.query(
    `INSERT INTO sessions
      (id, user_type, user_id, scope, refresh_token_hash, access_jti, device_name, platform, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW() + ($11 || ' seconds')::interval)`,
    [sessionId, user.user_type, user.id, scope, sha256(refreshToken), accessJti, deviceName, platform, userAgent, ipAddress, 7 * 24 * 60 * 60]
  );
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    user: sanitizeUser(user)
  };
}

async function createOtpChallenge({ user, purpose, channels, ipAddress, userAgent, metadata = {} }) {
  await ensureAuthRuntimeSchema();
  const deliveryChannels = user.user_type === "admin" ? ["email"] : ["sms"];
  if (user.user_type !== "admin" && !user.phone) {
    throw new AppError(400, "A verified cellphone number is required for TitoPay OTP.");
  }
  const code = sixDigitOtp();
  const challengeId = uuidv4();
  await pool.query(
    `INSERT INTO otp_codes
      (id, user_type, user_id, purpose, code_hash, channels, expires_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() + ($7 || ' seconds')::interval,$8)`,
    [
      challengeId,
      user.user_type,
      user.id,
      purpose,
      sha256(code),
      deliveryChannels,
      config.otpTtlSeconds,
      JSON.stringify({ ipAddress, userAgent, ...metadata })
    ]
  );
  await safeAuditLog({
    actorType: user.user_type,
    actorId: user.id,
    action: "otp_challenge_created",
    entityType: "otp_challenge",
    entityId: challengeId,
    ipAddress,
    userAgent,
    metadata: { purpose, channels: deliveryChannels }
  });
  await safeSecurityLog({
    actorType: user.user_type,
    actorId: user.id,
    eventType: "otp_challenge_created",
    severity: "info",
    ipAddress,
    userAgent,
    success: true,
    metadata: { purpose, channels: deliveryChannels }
  });
  await sendOtpNotification({ user, code, purpose, channels: deliveryChannels });
  const maskedValue = deliveryChannels.includes("sms") && user.phone ? user.phone : user.email;
  return {
    challengeId,
    otpRequired: true,
    maskedDestination: maskDestination(maskedValue),
    remainingAttempts: config.maxOtpAttempts
  };
}

// The only two challenge purposes that may be redeemed for a full login session.
// Everything else in otp_codes — wallet unlock, password change, step-up
// verification — authorises its own narrow action and is verified elsewhere.
const LOGIN_OTP_PURPOSES = ["login", "admin_login"];

async function getLatestOtpChallengeId({ userType, userId, purpose }) {
  await ensureAuthRuntimeSchema();
  const { rows } = await pool.query(
    `SELECT id
     FROM otp_codes
     WHERE user_type = $1
       AND user_id = $2
       AND purpose = $3
       AND used_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [userType, userId, purpose]
  );
  return rows[0]?.id || null;
}

async function expireOutstandingOtpChallenges({ userType, userId, purpose }) {
  await ensureAuthRuntimeSchema();
  await pool.query(
    `UPDATE otp_codes
     SET expires_at = NOW()
     WHERE user_type = $1
       AND user_id = $2
       AND purpose = $3
       AND used_at IS NULL
       AND expires_at > NOW()`,
    [userType, userId, purpose]
  );
}

async function resendOtpChallenge(payload, meta) {
  const userType = payload.userType === "admin" || payload.scope === "admin" ? "admin" : "customer";
  const purpose = payload.purpose || (userType === "admin" ? "admin_login" : "login");
  const challengeId = payload.challengeId || await getLatestOtpChallengeId({
    userType,
    userId: payload.adminId || payload.accountId || payload.userId,
    purpose
  });
  if (!challengeId) throw new AppError(404, "Active OTP challenge not found");
  const { rows } = await pool.query("SELECT * FROM otp_codes WHERE id = $1 LIMIT 1", [challengeId]);
  const existing = rows[0];
  if (!existing) throw new AppError(404, "OTP challenge not found");
  if (existing.used_at) throw new AppError(400, "OTP already used");
  if (Number(existing.resend_count || 0) >= config.maxOtpResends) throw new AppError(429, "OTP resend limit reached");
  const user = await getAccountById(existing.user_type, existing.user_id);
  if (!user) throw new AppError(404, "Account not found");

  await pool.query("UPDATE otp_codes SET expires_at = NOW() WHERE id = $1", [challengeId]);
  const next = await createOtpChallenge({
    user,
    purpose: existing.purpose,
    channels: existing.channels,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent
  });
  await pool.query("UPDATE otp_codes SET resend_count = $2 WHERE id = $1", [next.challengeId, Number(existing.resend_count || 0) + 1]);
  return {
    ...next,
    adminId: existing.user_type === "admin" ? existing.user_id : undefined,
    accountId: existing.user_id
  };
}

async function getUserByIdentifier(identifier, scope = "customer") {
  const lookup = String(identifier || "").trim();
  if (scope === "admin") {
    const adminUsername = lookup.replace(/^@/, "").toLowerCase();
    const adminEmail = lookup.toLowerCase();
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT * FROM admin_users
         WHERE LOWER(email) = $1 OR LOWER(username) = $2
         ORDER BY
           CASE WHEN LOWER(email) = $1 THEN 0 ELSE 1 END,
           CASE WHEN status = 'active' THEN 0 ELSE 1 END,
           updated_at DESC,
           created_at DESC
         LIMIT 1`,
        [adminEmail, adminUsername]
      ));
    } catch (error) {
      if (!isMissingDbObjectError(error)) throw error;
      logDbCompatibilityWarning("auth.adminIdentifierLookup", error);
      ({ rows } = await pool.query(
        `SELECT * FROM admin_users
         WHERE LOWER(email) = $1 OR LOWER(username) = $2
         LIMIT 1`,
        [adminEmail, adminUsername]
      ));
    }
    return rows[0] ? normalizeAdmin(rows[0]) : null;
  }
  const normalizedPhone = normalizeSouthAfricanPhone(lookup);
  const localPhone = normalizedPhone.startsWith("+27") ? `0${normalizedPhone.slice(3)}` : "";
  const lookupValues = Array.from(new Set([
    lookup,
    lookup.toLowerCase(),
    lookup.replace(/^@/, "").toLowerCase(),
    normalizedPhone,
    localPhone
  ].filter(Boolean)));
  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE LOWER(email) = ANY($1::TEXT[])
        OR LOWER(username) = ANY($1::TEXT[])
        OR phone = ANY($1::TEXT[])
     LIMIT 1`,
    [lookupValues]
  );
  return rows[0] ? normalizeCustomer(rows[0]) : null;
}

function assertActive(user) {
  if (!user) throw new AppError(401, "Invalid credentials");
  if (user.status !== "active") throw new AppError(403, "Account is not active");
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new AppError(423, `Account locked until ${user.locked_until}`);
  }
}

async function markFailedLogin(user, identifier, ipAddress, userAgent) {
  if (!user) {
    await safeAuditLog({
      actorType: "unknown",
      action: "login_failed",
      entityType: "session",
      ipAddress,
      userAgent,
      metadata: { identifier }
    });
    await safeSecurityLog({
      actorType: "unknown",
      eventType: "login_failed",
      severity: "warning",
      ipAddress,
      userAgent,
      success: false,
      metadata: { identifier }
    });
    return;
  }
  const attempts = Number(user.failed_login_attempts || 0) + 1;
  const lockNow = attempts >= config.failedLoginLockoutThreshold;
  const table = user.user_type === "admin" ? "admin_users" : "users";
  try {
    await pool.query(
      `UPDATE ${table}
       SET failed_login_attempts = $2,
           last_failed_login_at = NOW(),
           locked_until = CASE WHEN $3 THEN NOW() + ($4 || ' seconds')::interval ELSE locked_until END,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id, lockNow ? 0 : attempts, lockNow, config.failedLoginLockoutSeconds]
    );
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning(`auth.markFailedLogin.${table}`, error);
  }
  await safeAuditLog({
    actorType: user.user_type,
    actorId: user.id,
    action: lockNow ? "account_lockout" : "login_failed",
    entityType: "session",
    entityId: null,
    ipAddress,
    userAgent,
    metadata: { identifier }
  });
  await safeSecurityLog({
    actorType: user.user_type,
    actorId: user.id,
    eventType: lockNow ? "account_lockout" : "login_failed",
    severity: lockNow ? "critical" : "warning",
    ipAddress,
    userAgent,
    success: false,
    metadata: { identifier }
  });
}

async function clearFailedLogin(userId, ipAddress) {
  const user = await getAccountById("customer", userId) || await getAccountById("admin", userId);
  const table = user?.user_type === "admin" ? "admin_users" : "users";
  try {
    await pool.query(
      `UPDATE ${table}
       SET failed_login_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW(),
           last_login_ip = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, ipAddress]
    );
  } catch (error) {
    if (!isMissingDbObjectError(error)) throw error;
    logDbCompatibilityWarning(`auth.clearFailedLogin.${table}`, error);
  }
}

function normalizeCustomerEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email || null;
}

function normalizePublicUsername(value, fallback = "") {
  const username = String(value || fallback || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "");
  if (!/^[a-z0-9][a-z0-9._]{2,28}[a-z0-9]$/.test(username)) {
    throw new AppError(400, "Choose a unique username using 4-30 letters, numbers, dots or underscores.");
  }
  return username;
}

async function findCustomerRegistrationConflicts({ username, email, phone }) {
  const { rows } = await pool.query(
    `SELECT id, username, email, phone, account_type, status
     FROM users
     WHERE LOWER(username) = LOWER($1)
        OR ($2::TEXT IS NOT NULL AND LOWER(email) = LOWER($2))
        OR ($3::TEXT IS NOT NULL AND phone = $3)
     LIMIT 10`,
    [username, email, phone || null]
  );
  const fields = new Set();
  for (const row of rows) {
    if (row.username && row.username.toLowerCase() === username.toLowerCase()) fields.add("username");
    if (email && row.email && row.email.toLowerCase() === email.toLowerCase()) fields.add("email");
    if (phone && row.phone === phone) fields.add("phone");
  }
  return {
    rows,
    fields: Array.from(fields)
  };
}

async function logDuplicateRegistrationAttempt({ conflicts, username, email, phone, accountType }, meta) {
  writeSecurityLog({
    actorType: "unknown",
    eventType: "duplicate_registration_blocked",
    severity: "warning",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: false,
    metadata: {
      conflictFields: conflicts.fields,
      matchedUserIds: conflicts.rows.map((row) => row.id),
      attemptedUsername: username,
      attemptedEmail: email,
      attemptedPhone: phone,
      accountType
    }
  }).catch((error) => {
    console.warn("[auth] duplicate registration audit failed", { message: error.message });
  });
}

async function register(payload, meta) {
  if (payload.scope === "admin") {
    throw new AppError(403, "Admin registration is not allowed through the public API");
  }
  const accountType = payload.accountType || "personal";
  if (!["personal", "business"].includes(accountType)) {
    throw new AppError(400, "accountType must be personal or business");
  }
  const fullName = String(payload.fullName || "").trim();
  if (!fullName) throw new AppError(400, "fullName is required");
  const phone = payload.phone ? assertSouthAfricanPhone(payload.phone) : "";
  if (config.customerRegistration.requireSouthAfricanPhone && !phone) {
    throw new AppError(400, "A South African cellphone number starting with +27 is required.");
  }
  const email = normalizeCustomerEmail(payload.email);
  if (!email && !phone) {
    throw new AppError(400, "email or South African cellphone number is required");
  }
  if (!payload.password) {
    throw new AppError(400, accountType === "business" ? "password is required" : "PIN is required");
  }
  const usernameFallback = email ? email.split("@")[0] : `user${phone.replace(/\D/g, "").slice(-9)}`;
  const username = normalizePublicUsername(payload.username, usernameFallback);
  const conflicts = await findCustomerRegistrationConflicts({ username, email, phone });
  if (conflicts.fields.length) {
    await logDuplicateRegistrationAttempt({ conflicts, username, email, phone, accountType }, meta);
    throw new AppError(409, "An account already exists with these details", {
      fields: conflicts.fields,
      nextStep: "Sign in or use Forgot PIN or Password."
    });
  }
  const passwordHash = await hashPassword(payload.password);
  const userId = uuidv4();
  const walletId = uuidv4();
  const userType = "customer";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const walletNumber = await generateUniqueWalletNumber(client);
    await client.query(
      `INSERT INTO users
        (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,'pending')`,
      [userId, accountType, fullName, username, email, phone || null, passwordHash]
    );
    if (userType === "customer") {
      await client.query(
        `INSERT INTO wallets
          (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
         VALUES ($1,$2,$3,$4,'ZAR',0,0,'active')`,
        [walletId, walletNumber, userId, accountType === "business" ? "business" : "personal"]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw new AppError(409, "Account already exists", {
        constraint: error.constraint,
        fields: ["username", "email", "phone"]
      });
    }
    throw error;
  } finally {
    client.release();
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  await safeAuditLog({
    actorType: userType,
    actorId: userId,
    action: "registered",
    entityType: "user",
    entityId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { scope: payload.scope || "customer", accountType }
  });
  await createVerificationForUser(rows[0], meta).catch((error) => {
    console.error("[auth] registration verification email queue failed", { userId, message:error.message, code:error.code });
  });
  const welcomeEmail = await queueWelcomeEmail(rows[0], {
    ...meta,
    accountType,
    businessName:payload.businessName||rows[0].full_name
  }).catch(async (error) => {
    console.error("[auth] registration welcome email queue failed", { userId, accountType, message:error.message, code:error.code });
    await safeAuditLog({
      actorType:userType, actorId:userId, action:"welcome_email_queue_failed",
      entityType:"user", entityId:userId, ipAddress:meta.ipAddress, userAgent:meta.userAgent,
      metadata:{accountType,reason:String(error.message||"Queue creation failed").slice(0,500)}
    });
    return null;
  });
  const welcomeNotification = await createNotification({
    user: { ...rows[0], user_type: "customer" },
    channel: "in_app",
    notificationType: "account_welcome",
    title: accountType === "business" ? "Welcome to TitoPay Business" : "Welcome to TitoPay",
    body: accountType === "business"
      ? "Your TitoPay Business account has been created. Complete business verification to unlock all eligible services."
      : "Your TitoPay Personal account has been created. Welcome to smart, simple payments.",
    provider: "titopay",
    metadata: {
      accountType,
      clientNotificationId: `account-welcome-${userId}`,
      route: "dashboard"
    }
  }).then(async (notificationId) => {
    if (notificationId) await markNotification(notificationId, "sent");
    return notificationId;
  }).catch(async (error) => {
    console.error("[auth] registration welcome in-app notification failed", { userId, accountType, message:error.message, code:error.code });
    await safeAuditLog({
      actorType:userType, actorId:userId, action:"welcome_in_app_notification_failed",
      entityType:"user", entityId:userId, ipAddress:meta.ipAddress, userAgent:meta.userAgent,
      metadata:{accountType,reason:String(error.message||"Notification creation failed").slice(0,500)}
    });
    return null;
  });
  if(accountType==="business"&&rows[0].email)await queueEmail({recipient:rows[0].email,templateKey:"business_account_submitted",userId,variables:{fullName:rows[0].full_name,email:rows[0].email,businessName:payload.businessName||rows[0].full_name,accountType},idempotencyKey:`business-account-submitted:${userId}`}).catch((error)=>console.error("[auth] business submission email queue failed",{userId,message:error.message}));
  return {
    ...sanitizeUser(normalizeCustomer(rows[0])),
    welcomeEmailQueued:Boolean(welcomeEmail&&!welcomeEmail.skipped),
    welcomeInAppNotificationCreated:Boolean(welcomeNotification)
  };
}

function getLoginIdentifier(payload = {}) {
  return payload.identifier ||
    payload.email ||
    payload.username ||
    payload.emailOrUsername ||
    payload.usernameOrEmail ||
    payload.staffEmail ||
    payload.login ||
    payload.user ||
    "";
}

function environmentFlagValue(name) {
  if (process.env[name] === undefined || process.env[name] === null || process.env[name] === "") {
    return null;
  }
  const value = String(process.env[name]).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(value)) return false;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  return null;
}

function isAdminOtpDisabledByEnvironment() {
  // ADMIN_OTP_REQUIRED/VERIFY_ADMIN_OTP are legacy defaults used when no
  // platform setting exists. The saved Security Dashboard mode controls
  // runtime behavior, including when those defaults are false.
  return false;
}

async function issueAdminPasswordOnlySession({ user, payload, meta, scope, policySource }) {
  await expireOutstandingOtpChallenges({
    userType: "admin",
    userId: user.id,
    purpose: "admin_login"
  });
  await safeAuditLog({
    actorType: user.user_type,
    actorId: user.id,
    action: "login_success",
    entityType: "session",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { scope, otpBypassed: true, authenticationMode: "password_only", policySource }
  });
  await safeSecurityLog({
    actorType: user.user_type,
    actorId: user.id,
    eventType: "login_success",
    severity: "info",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    metadata: { scope, otpBypassed: true, authenticationMode: "password_only", policySource }
  });
  const tokens=await issueTokens({
    user,
    scope,
    deviceName: payload.deviceName || "Admin Browser",
    platform: payload.platform || "web",
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress
  });
  await queueLoginNotice(user,tokens.accessToken,payload);
  return {
    auth_mode: "PASSWORD_ONLY",
    otp_required: false,
    otpRequired: false,
    authenticationMode: "password_only",
    policySource,
    ...tokens
  };
}

async function queueLoginNotice(user,accessToken,payload={}) {
  if(!user?.id)return;
  try {
    const fingerprint=String(payload.deviceFingerprint||payload.device_fingerprint||"").trim();let templateKey="login_notification";
    if(fingerprint){const column=user.user_type==="admin"?"admin_user_id":"user_id";const trusted=await pool.query(`SELECT 1 FROM trusted_devices WHERE ${column}=$1 AND device_fingerprint=$2 AND revoked_at IS NULL LIMIT 1`,[user.id,fingerprint]);if(!trusted.rowCount)templateKey="new_device_login";}
    const device=payload.deviceName||(user.user_type==="admin"?"Admin Browser":"Web Browser");
    const noticeKey=sha256(accessToken).slice(0,32);
    if(user.user_type==="customer"&&templateKey==="login_notification") {
      const notificationId=await createNotification({
        user,
        channel:"in_app",
        notificationType:"login_notification",
        title:"New TitoPay login",
        body:`A login to your TitoPay account was recorded from ${device}. If this was not you, lock your profile and contact TitoPay support.`,
        provider:"titopay",
        metadata:{
          category:"security",
          clientNotificationId:`login-notification-${noticeKey}`,
          route:"profile",
          device,
          newDevice:false
        }
      });
      if(notificationId)await markNotification(notificationId,"sent",null,{deliveredInApp:true});
      return;
    }
    if(!user.email)return;
    const names=String(user.full_name||"").trim().split(/\s+/);
    await queueEmail({recipient:user.email,templateKey,userId:user.user_type==="customer"?user.id:null,variables:{firstName:names[0]||"there",fullName:user.full_name,email:user.email},idempotencyKey:`login-notification:${noticeKey}`,metadata:{device,newDevice:templateKey==="new_device_login"}});
  } catch(error) {console.error("[auth] login notification queue failed",{userType:user.user_type,userId:user.id,message:error.message});}
}

async function login(payload, meta) {
  const scope = payload.scope === "admin" ? "admin" : "customer";
  const identifier = String(getLoginIdentifier(payload)).trim();
  const password = typeof payload.password === "string" ? payload.password : "";
  if (!identifier || !password) {
    throw new AppError(400, "Identifier and password are required");
  }
  const user = await getUserByIdentifier(identifier, scope);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await markFailedLogin(user, identifier, meta.ipAddress, meta.userAgent);
    throw new AppError(401, "Invalid credentials");
  }
  assertActive(user);
  await clearFailedLogin(user.id, meta.ipAddress);
  const adminPolicy = scope === "admin" ? await getAdminAuthenticationPolicy() : null;
  const adminAuthenticationRequiresOtp = scope === "admin" &&
    Boolean(adminPolicy?.otpRequired) &&
    !isAdminOtpDisabledByEnvironment();
  // Customer sign-in is deliberately password/PIN-only. Admin Email OTP is
  // governed exclusively by the persisted Admin Authentication Mode.
  if (adminAuthenticationRequiresOtp) {
    const challenge = await createEmailOtpChallenge(user, "login", {
      ...meta,
      deviceName: payload.deviceName || (scope === "admin" ? "Admin Browser" : "Web Browser"),
      location: payload.location || null
    });
    return { auth_mode:"EMAIL_OTP", otp_required:true, ...challenge };
  }
  if (scope === "admin") {
    return issueAdminPasswordOnlySession({
      user,
      payload,
      meta,
      scope,
      policySource: isAdminOtpDisabledByEnvironment()
        ? "environment_forced_password_only"
        : "admin_login_password_only"
    });
  }
  await safeAuditLog({
    actorType: user.user_type,
    actorId: user.id,
    action: "login_success",
    entityType: "session",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { scope }
  });
  await safeSecurityLog({
    actorType: user.user_type,
    actorId: user.id,
    eventType: "login_success",
    severity: "info",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    metadata: { scope }
  });
  const tokens=await issueTokens({
    user,
    scope,
    deviceName: payload.deviceName || "Web Browser",
    platform: payload.platform || "web",
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress
  });
  await queueLoginNotice(user,tokens.accessToken,payload);
  return tokens;
}

async function verifyEmailOtpLogin(payload, meta) {
  const challenge = await verifyEmailOtpChallenge(payload.challengeId, payload.otp, meta);
  if (challenge.event !== "login") return { verified:true, purpose:challenge.event };
  const user = await getAccountById(challenge.user_type, challenge.user_id);
  if (!user) throw new AppError(401, "Account not found");
  assertActive(user);
  const scope = challenge.user_type === "admin" ? "admin" : "customer";
  await safeAuditLog({actorType:challenge.user_type,actorId:challenge.user_id,action:"login_success",entityType:"session",ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{scope,authenticationMode:"email_otp"}});
  const deviceName=payload.deviceName||(scope==="admin"?"Admin Browser":"Web Browser"),tokens=await issueTokens({user,scope,deviceName,platform:payload.platform||"web",userAgent:meta.userAgent,ipAddress:meta.ipAddress});await queueLoginNotice(user,tokens.accessToken,{...payload,deviceName});return {auth_mode:"EMAIL_OTP",otp_required:false,authenticationMode:"email_otp",...tokens};
}

async function getPasswordChangeOptions(userId, userType = "customer") {
  if (userType !== "customer") throw new AppError(403, "Customer access required");
  return loadPasswordChangeOptions(userId);
}

async function requestPasswordChangeOtp(userId, userType, payload = {}, meta = {}) {
  if (userType !== "customer") throw new AppError(403, "Customer access required");
  const user = await getAccountById("customer", userId);
  assertActive(user);
  const channel = String(payload.channel || "sms").trim().toLowerCase();
  if (!["sms", "email"].includes(channel)) throw new AppError(400, "OTP channel must be SMS or Email");
  if (channel === "email") return requestEmailPasswordChangeOtp(userId, payload, meta);
  const challenge = await createOtpChallenge({
    user,
    purpose: "password_reset",
    channels: ["sms"],
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent
  });
  return { accountId: user.id, userId: user.id, channel: "sms", fee: 0, ...challenge };
}

async function requestPasswordReset(payload, meta) {
  const scope = payload.scope === "admin" || payload.userType === "admin" ? "admin" : "customer";
  if (!payload.identifier) {
    throw new AppError(400, "Identifier is required");
  }
  const user = await getUserByIdentifier(payload.identifier, scope);
  if (!user) return { accepted: true };
  const channels = scope === "admin" ? ["email"] : ["sms"];
  const challenge = await createOtpChallenge({
    user,
    purpose: "password_reset",
    channels,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent
  });
  await requestEmailPasswordReset(user, meta).catch((error) => {
    console.error("[auth] password reset email queue failed", { userType:user.user_type, userId:user.id, message:error.message });
  });
  return { accountId: user.id, userId: user.id, ...challenge };
}

async function confirmPasswordReset(payload, meta) {
  const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
  if (newPassword.length < 4) {
    throw new AppError(400, "Enter a new PIN or password with at least 4 characters");
  }
  const challengeId = payload.challengeId || await getLatestOtpChallengeId({
    userType: payload.userType === "admin" || payload.scope === "admin" ? "admin" : "customer",
    userId: payload.accountId || payload.userId,
    purpose: "password_reset"
  });
  if (!challengeId) throw new AppError(404, "OTP challenge not found");
  const { rows } = await pool.query(
    `SELECT *
     FROM otp_codes
     WHERE id = $1
     LIMIT 1`,
    [challengeId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "OTP challenge not found");
  const isEmailPasswordChange = row.purpose === "email_otp:change_password";
  if (row.purpose !== "password_reset" && !isEmailPasswordChange) throw new AppError(400, "Invalid challenge purpose");
  if (row.revoked_at) throw new AppError(400, "OTP has been revoked");
  if (row.used_at) throw new AppError(400, "OTP already used");
  if (new Date(row.expires_at).getTime() < Date.now()) {
    if (isEmailPasswordChange) {
      await safeAuditLog({
        actorType: row.user_type,
        actorId: row.user_id,
        action: "email_otp_expired",
        entityType: "otp_challenge",
        entityId: challengeId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { purpose: row.purpose }
      });
    }
    throw new AppError(400, "OTP expired");
  }
  const maximumAttempts = isEmailPasswordChange
    ? Number((await emailOtp.getOtpSettings()).maximumAttempts)
    : config.maxOtpAttempts;
  if (Number(row.attempts) >= maximumAttempts) throw new AppError(isEmailPasswordChange ? 423 : 429, "OTP attempts exceeded");
  if (sha256(payload.otp) !== row.code_hash) {
    await pool.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [challengeId]);
    const remainingAttempts = Math.max(0, maximumAttempts - Number(row.attempts) - 1);
    if (isEmailPasswordChange) {
      await safeAuditLog({
        actorType: row.user_type,
        actorId: row.user_id,
        action: "email_otp_failed",
        entityType: "otp_challenge",
        entityId: challengeId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { purpose: row.purpose, attempts: Number(row.attempts) + 1 }
      });
    }
    throw new AppError(isEmailPasswordChange && remainingAttempts === 0 ? 423 : 401, "Invalid OTP", { remainingAttempts });
  }
  const passwordHash = await hashPassword(newPassword);
  const table = row.user_type === "admin" ? "admin_users" : "users";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE otp_codes SET used_at = NOW() WHERE id = $1", [challengeId]);
    if (isEmailPasswordChange) {
      await writeAuditLog({
        actorType: row.user_type,
        actorId: row.user_id,
        action: "email_otp_verified",
        entityType: "otp_challenge",
        entityId: challengeId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { purpose: row.purpose },
        db: client
      });
    }
    await client.query(
      `UPDATE ${table}
       SET password_hash = $2,
           failed_login_attempts = 0,
           locked_until = NULL,
           last_failed_login_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [row.user_id, passwordHash]
    );
    await client.query(
      "UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'password_reset' WHERE user_type = $2 AND user_id = $1 AND revoked_at IS NULL",
      [row.user_id, row.user_type]
    );
    await client.query("COMMIT");
    console.info("[auth] password reset completed", {
      userType: row.user_type,
      userId: row.user_id,
      challengeId,
      lockoutCleared: true
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await safeAuditLog({
    actorType: row.user_type,
    actorId: row.user_id,
    action: "password_reset_completed",
    entityType: "user",
    entityId: row.user_id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { channel: isEmailPasswordChange ? "email" : "sms" }
  });
  await safeSecurityLog({
    actorType: row.user_type,
    actorId: row.user_id,
    eventType: "password_reset_completed",
    severity: "warning",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    metadata: { channel: isEmailPasswordChange ? "email" : "sms" }
  });
  const account = await getAccountById(row.user_type, row.user_id);
  if (account?.email) {
    await queueEmail({recipient:account.email,templateKey:"password_changed",variables:{fullName:account.full_name,email:account.email},idempotencyKey:`password-changed-otp:${challengeId}`}).catch((error)=>{
      console.error("[auth] password changed email queue failed", {userType:row.user_type,userId:row.user_id,message:error.message});
    });
  }
  return { ok: true };
}

async function verifyOtpLogin(payload, meta) {
  const challengeId = payload.challengeId || await getLatestOtpChallengeId({
    userType: payload.scope === "customer" || payload.userType === "customer" ? "customer" : "admin",
    userId: payload.adminId || payload.accountId || payload.userId,
    purpose: payload.scope === "customer" || payload.userType === "customer" ? "login" : "admin_login"
  });
  if (!challengeId) throw new AppError(404, "OTP challenge not found");
  // Every one-time code the platform issues lands in otp_codes — sign-in, wallet
  // unlock, password change, step-up verification — separated only by `purpose`.
  // This query ignored that column, so a challenge created for any of them could
  // be redeemed here for a full login session: a wallet-unlock code posted to
  // this unauthenticated endpoint was accepted as a sign-in. The fallback lookup
  // directly above already restricts itself to login purposes; this applies the
  // same rule when the caller supplies the challenge id itself, which was the way
  // around it.
  const { rows } = await pool.query(
    `SELECT *
     FROM otp_codes
     WHERE id = $1
       AND purpose = ANY($2::TEXT[])
     LIMIT 1`,
    [challengeId, LOGIN_OTP_PURPOSES]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "OTP challenge not found");
  if (row.used_at) throw new AppError(400, "OTP already used");
  if (new Date(row.expires_at).getTime() < Date.now()) throw new AppError(400, "OTP expired");
  if (Number(row.attempts) >= config.maxOtpAttempts) throw new AppError(429, "OTP attempts exceeded");
  if (sha256(payload.otp) !== row.code_hash) {
    await pool.query("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1", [challengeId]);
    await safeSecurityLog({
      actorType: row.user_type,
      actorId: row.user_id,
      eventType: "otp_failed",
      severity: "warning",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      metadata: { purpose: row.purpose }
    });
    throw new AppError(401, "Invalid OTP");
  }
  await pool.query("UPDATE otp_codes SET used_at = NOW() WHERE id = $1", [challengeId]);
  const user = await getAccountById(row.user_type, row.user_id);
  if (!user) throw new AppError(404, "Account not found");
  await safeAuditLog({
    actorType: user.user_type,
    actorId: user.id,
    action: "otp_verified",
    entityType: "otp_challenge",
    entityId: challengeId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { purpose: row.purpose }
  });
  await safeSecurityLog({
    actorType: user.user_type,
    actorId: user.id,
    eventType: "otp_verified",
    severity: "info",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    metadata: { purpose: row.purpose }
  });
  return issueTokens({
    user,
    scope: payload.scope || (row.user_type === "admin" ? "admin" : "customer"),
    deviceName: payload.deviceName || "Admin Browser",
    platform: payload.platform || "web",
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress
  });
}

async function refreshTokens(payload, meta) {
  const decoded = verifyRefreshToken(payload.refreshToken);
  const { rows } = await pool.query(
    `SELECT s.*
     FROM sessions s
     WHERE s.id = $1
       AND s.revoked_at IS NULL
       AND s.refresh_token_hash = $2
     LIMIT 1`,
    [decoded.sid, sha256(payload.refreshToken)]
  );
  const row = rows[0];
  if (!row) throw new AppError(401, "Refresh session not found");
  await pool.query(
    "UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'refresh_rotated' WHERE id = $1",
    [decoded.sid]
  );
  const user = await getAccountById(row.user_type, row.user_id);
  if (!user) throw new AppError(404, "Account not found");
  return issueTokens({
    user,
    scope: row.scope,
    deviceName: row.device_name || "Refreshed Session",
    platform: row.platform || "web",
    userAgent: meta.userAgent || row.user_agent,
    ipAddress: meta.ipAddress || row.ip_address
  });
}

async function logout(refreshToken, actor) {
  await pool.query(
    "UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'logout' WHERE refresh_token_hash = $1",
    [sha256(refreshToken)]
  );
  await safeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "logout",
    entityType: "session",
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: {}
  });
}

async function logoutAll(actor) {
  await pool.query(
    "UPDATE sessions SET revoked_at = NOW(), revoked_reason = 'logout_all' WHERE user_type = $2 AND user_id = $1 AND revoked_at IS NULL",
    [actor.userId, actor.userType]
  );
  await safeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "logout_all",
    entityType: "session",
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: {}
  });
}

async function getMe(userId, userType = "customer") {
  const user = await getAccountById(userType, userId);
  if (!user) throw new AppError(404, "User not found");
  return sanitizeUser(user);
}

async function requirePermission(user, permission) {
  if (user.user_type !== "admin") throw new AppError(403, "Admin access required");
  if (isRootAdminRole(user.role)) return;
  const allowed = await getEffectiveAdminRolePermissions(user.role);
  if (!allowed.includes("*") && !allowed.includes(permission)) {
    throw new AppError(403, "Permission denied");
  }
}

module.exports = {
  ADMIN_ROLE_PERMISSIONS,
  normalizeAdminRole,
  isRootAdminRole,
  getAdminRolePermissions,
  getEffectiveAdminRolePermissions,
  createOtpChallenge,
  register,
  login,
  getPasswordChangeOptions,
  requestPasswordChangeOtp,
  requestPasswordReset,
  confirmPasswordReset,
  resendOtpChallenge,
  verifyOtpLogin,
  verifyEmailOtpLogin,
  refreshTokens,
  logout,
  logoutAll,
  getMe,
  requirePermission
};
