const express = require("express");
const config = require("../config");
const db = require("../lib/db");
const audit = require("../lib/audit");
const { r, check } = require("../lib/validate");
const { limit } = require("../lib/ratelimit");
const { randomToken, sha256, hashSecret, verifySecret, DUMMY_HASH, signLink, verifyLink } = require("../lib/crypto");
const { AppError, conflict, bad } = require("../lib/errors");
const { wrap, requireAuth, setSessionCookie, clearSessionCookie } = require("../middleware/http");
const outbox = require("../modules/messaging/outbox");
const templates = require("../modules/messaging/templates");
const marketing = require("../modules/marketing/service");

const router = express.Router();
const LOCK_AFTER = 5;

async function createSession(res, req, userId, q = db) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  await q.query("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6)",
    [sha256(token), userId, randomToken(24), expires, String(req.headers["user-agent"] || "").slice(0, 200), req.ip]);
  setSessionCookie(res, token, expires);
}

async function profile(userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.email_verified_at, (u.spending_pin_hash IS NOT NULL) AS has_pin, u.created_at,
            COALESCE((SELECT array_agg(role) FROM platform_roles WHERE user_id = u.id), '{}') AS platform_roles,
            COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'status', o.status, 'role', m.role))
                        FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = u.id), '[]') AS organisers,
            COALESCE((SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'role', vm.role, 'eventId', v.event_id, 'eventTitle', e.title))
                        FROM vendor_members vm JOIN vendors v ON v.id = vm.vendor_id JOIN events e ON e.id = v.event_id WHERE vm.user_id = u.id), '[]') AS vendors,
            COALESCE((SELECT json_agg(json_build_object('eventId', e.id, 'title', e.title, 'canScan', s.can_scan, 'canManageTags', s.can_manage_tags))
                        FROM event_staff s JOIN events e ON e.id = s.event_id WHERE s.user_id = u.id), '[]') AS staff_events
       FROM users u WHERE u.id = $1`, [userId]);
  return rows[0];
}

function sendVerification(q, user) {
  const url = `${config.publicBaseUrl}/account#/verify/${signLink({ v: user.id, e: user.email }, 7 * 86400)}`;
  return outbox.enqueue(q, { to: user.email, userId: user.id, ...templates.verifyEmail({ name: user.full_name, url }) });
}

router.post("/register", limit("register", 10, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, {
    fullName: r.str({ min: 2, max: 120 }), email: r.email(), phone: r.phone({ optional: true }),
    password: r.password(), marketingOptIn: r.bool(), acceptTerms: r.bool(),
  });
  if (!b.acceptTerms) throw bad("Please accept the Terms and Privacy Notice.", { acceptTerms: "Required." });
  const user = await db.withTx(async (c) => {
    const { rows: exists } = await c.query("SELECT 1 FROM users WHERE lower(email) = $1", [b.email]);
    if (exists[0]) throw conflict("An account with this email already exists. Sign in instead.", "email_taken");
    const { rows } = await c.query("INSERT INTO users (email, phone, full_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING *",
      [b.email, b.phone || null, b.fullName, hashSecret(b.password)]);
    if (b.marketingOptIn) await marketing.setConsent(c, rows[0].id, null, "email", true, "signup");
    await sendVerification(c, rows[0]);
    await audit.record(c, { actor: { id: rows[0].id }, action: "user.registered", entityType: "user", entityId: rows[0].id, ip: req.ip });
    await createSession(res, req, rows[0].id, c);
    return rows[0];
  });
  res.status(201).json({ user: await profile(user.id) });
}));

router.post("/login", limit("login", 20, 15 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email(), password: r.str({ min: 1, max: 200 }) });
  const { rows } = await db.query("SELECT * FROM users WHERE lower(email) = $1", [b.email]);
  const u = rows[0];
  const ok = verifySecret(b.password, u?.password_hash || DUMMY_HASH);
  const generic = new AppError(401, "bad_credentials", "Email or password is incorrect.");
  if (!u || u.status === "deleted") throw generic;
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError(423, "locked", "Too many attempts. Try again in 15 minutes, or reset your password.");
  if (!ok) {
    await db.query("UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' END WHERE id = $1", [u.id, LOCK_AFTER]);
    throw generic;
  }
  if (u.status === "suspended") throw new AppError(403, "suspended", "This account is suspended. Contact hello@ticketroom.co.za.");
  await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]);
  await createSession(res, req, u.id);
  res.json({ user: await profile(u.id) });
}));

router.post("/logout", wrap(async (req, res) => {
  if (req.session) await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [req.session.id]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

router.get("/me", wrap(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: await profile(req.user.id), csrfToken: req.session.csrfToken });
}));

router.patch("/me", requireAuth, wrap(async (req, res) => {
  const b = check(req.body, { fullName: r.str({ min: 2, max: 120 }), phone: r.phone({ optional: true }) });
  await db.query("UPDATE users SET full_name = $2, phone = $3, updated_at = now() WHERE id = $1", [req.user.id, b.fullName, b.phone || null]);
  res.json({ user: await profile(req.user.id) });
}));

router.post("/me/password", requireAuth, limit("pwchange", 10, 15 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { currentPassword: r.str({ max: 200 }), newPassword: r.password() });
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!verifySecret(b.currentPassword, rows[0].password_hash)) throw new AppError(401, "bad_credentials", "Current password is incorrect.");
  await db.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [req.user.id, hashSecret(b.newPassword)]);
  await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [req.user.id, req.session.id]);
  await audit.record(null, { actor: req.user, action: "user.password_changed", entityType: "user", entityId: req.user.id, ip: req.ip });
  res.json({ ok: true });
}));

// Spending PIN for cashless purchases above the PIN threshold.
router.post("/me/pin", requireAuth, limit("pin", 10, 15 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const b = check(req.body, { pin: r.str({ min: 4, max: 6, pattern: /^\d{4,6}$/, message: "Use 4 to 6 digits." }), password: r.str({ max: 200 }) });
  if (/^(\d)\1+$/.test(b.pin) || "0123456789".includes(b.pin) || "9876543210".includes(b.pin)) throw bad("Choose a PIN that is not a sequence or a repeated digit.", { pin: "Too easy to guess." });
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!verifySecret(b.password, rows[0].password_hash)) throw new AppError(401, "bad_credentials", "Password is incorrect.");
  await db.query("UPDATE users SET spending_pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1", [req.user.id, hashSecret(b.pin)]);
  await audit.record(null, { actor: req.user, action: "user.pin_set", entityType: "user", entityId: req.user.id });
  res.json({ ok: true });
}));

router.post("/verify-email", wrap(async (req, res) => {
  const b = check(req.body, { token: r.str({ max: 600 }) });
  const data = verifyLink(b.token);
  if (!data?.v) throw bad("This verification link is invalid or has expired.");
  await db.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 AND lower(email) = lower($2)", [data.v, data.e]);
  res.json({ ok: true });
}));

router.post("/verify-email/resend", requireAuth, limit("verify", 3, 60 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  await db.withTx((c) => sendVerification(c, rows[0]));
  res.json({ ok: true });
}));

// Always answers the same way, whether or not the email exists.
router.post("/password/forgot", limit("forgot", 5, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email() });
  const { rows } = await db.query("SELECT * FROM users WHERE lower(email) = $1 AND status = 'active'", [b.email]);
  if (rows[0]) {
    const token = randomToken(32);
    await db.withTx(async (c) => {
      await c.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [sha256(token), rows[0].id]);
      await outbox.enqueue(c, { to: rows[0].email, userId: rows[0].id, ...templates.passwordReset({ name: rows[0].full_name, url: `${config.publicBaseUrl}/account#/reset/${token}` }) });
    });
    if (!config.isProd) res.setHeader("X-Dev-Reset-Token", token);
  }
  res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
}));

router.post("/password/reset", limit("reset", 10, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { token: r.str({ max: 100 }), password: r.password() });
  await db.withTx(async (c) => {
    const { rows } = await c.query("UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id", [sha256(b.token)]);
    if (!rows[0]) throw bad("This reset link is invalid or has expired.");
    await c.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [rows[0].user_id, hashSecret(b.password)]);
    await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [rows[0].user_id]);
    await audit.record(c, { actor: { id: rows[0].user_id }, action: "user.password_reset", entityType: "user", entityId: rows[0].user_id, ip: req.ip });
  });
  res.json({ ok: true });
}));

// POPIA: access to personal information.
router.get("/me/export", requireAuth, limit("export", 5, 60 * 60e3, (q) => q.user.id), wrap(async (req, res) => {
  const id = req.user.id;
  const q = (sql) => db.query(sql, [id]).then((x) => x.rows);
  const data = {
    exportedAt: new Date().toISOString(),
    operator: config.operator,
    profile: (await q("SELECT id, email, full_name, phone, email_verified_at, created_at FROM users WHERE id = $1"))[0],
    orders: await q("SELECT reference, status, total_cents, buyer_name, buyer_email, buyer_phone, created_at, paid_at FROM orders WHERE user_id = $1"),
    tickets: await q("SELECT code, status, holder_name, admitted_at, created_at FROM tickets WHERE owner_user_id = $1"),
    tags: await q("SELECT display_code, tag_type, status, linked_at, last_used_at FROM tags WHERE user_id = $1"),
    topups: await q("SELECT reference, amount_cents, status, created_at FROM wallet_topups WHERE user_id = $1"),
    purchases: await q("SELECT reference, total_cents, status, created_at FROM pos_sales WHERE user_id = $1"),
    refunds: await q("SELECT reference, kind, amount_cents, status, created_at FROM refunds WHERE user_id = $1"),
    marketingConsents: await q("SELECT organiser_id, channel, granted, source, updated_at FROM marketing_consents WHERE user_id = $1"),
    supportCases: await q("SELECT reference, subject, status, created_at FROM support_cases WHERE user_id = $1"),
  };
  res.setHeader("Content-Disposition", "attachment; filename=ticketroom-my-data.json");
  res.json(data);
}));

// POPIA: deletion. Personal details are removed; financial records are kept
// (with the person de-identified) for the legally required retention period.
router.post("/me/delete", requireAuth, wrap(async (req, res) => {
  const b = check(req.body, { password: r.str({ max: 200 }) });
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!verifySecret(b.password, rows[0].password_hash)) throw new AppError(401, "bad_credentials", "Password is incorrect.");
  await db.withTx(async (c) => {
    const { rows: live } = await c.query(
      `SELECT 1 FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.owner_user_id = $1 AND t.status = 'valid' AND e.ends_at > now() LIMIT 1`, [req.user.id]);
    if (live[0]) throw conflict("You have tickets for upcoming events. Transfer or use them before deleting your account.", "has_live_tickets");
    const { rows: bal } = await c.query(
      `SELECT COALESCE(SUM(-e.amount_cents),0)::bigint AS s FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id WHERE a.code LIKE 'attendee_wallet:' || $1 || ':%'`, [req.user.id]);
    if (bal[0].s > 0) throw conflict("You have an unused cashless balance. Request a refund before deleting your account.", "has_balance");
    await c.query(
      `UPDATE users SET email = 'deleted+' || id || '@invalid.ticketroom', full_name = 'Deleted user', phone = NULL, status = 'deleted',
              spending_pin_hash = NULL, password_hash = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1`, [req.user.id]);
    await c.query("UPDATE orders SET buyer_name = 'Deleted user', buyer_email = 'deleted@invalid.ticketroom', buyer_phone = NULL WHERE user_id = $1", [req.user.id]);
    await c.query("UPDATE tickets SET holder_name = NULL WHERE owner_user_id = $1", [req.user.id]);
    await c.query("UPDATE marketing_consents SET granted = false, updated_at = now() WHERE user_id = $1", [req.user.id]);
    await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [req.user.id]);
    await c.query("UPDATE message_outbox SET status = 'suppressed' WHERE user_id = $1 AND status = 'queued'", [req.user.id]);
    await audit.record(c, { actor: req.user, action: "user.deleted", entityType: "user", entityId: req.user.id });
  });
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// One switch to stop all marketing (every organiser, every channel).
router.post("/me/consents/unsubscribe-all", requireAuth, wrap(async (req, res) => {
  await db.withTx(async (c) => {
    const { rows } = await c.query("SELECT organiser_id, channel FROM marketing_consents WHERE user_id = $1 AND granted", [req.user.id]);
    for (const x of rows) await marketing.setConsent(c, req.user.id, x.organiser_id, x.channel, false, "account_unsubscribe_all");
  });
  res.json({ consents: await marketing.consentsFor(req.user.id) });
}));

router.get("/me/consents", requireAuth, wrap(async (req, res) => res.json({ consents: await marketing.consentsFor(req.user.id) })));

router.put("/me/consents", requireAuth, wrap(async (req, res) => {
  const b = check(req.body, { organiserId: r.uuid({ optional: true }), channel: r.oneOf(["email", "sms"]), granted: r.bool() });
  await db.withTx((c) => marketing.setConsent(c, req.user.id, b.organiserId || null, b.channel, b.granted, "account_settings"));
  res.json({ consents: await marketing.consentsFor(req.user.id) });
}));

module.exports = { router, profile };
