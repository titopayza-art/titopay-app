const express = require("express");
const config = require("../config");
const db = require("../lib/db");
const audit = require("../lib/audit");
const { r, check } = require("../lib/validate");
const { hit, limit, reached, clear } = require("../lib/ratelimit");
const { randomToken, sha256, hashSecret, verifySecret, DUMMY_HASH, signLink, verifyLink } = require("../lib/crypto");
const { AppError, conflict, bad, tooMany } = require("../lib/errors");
const { wrap, requireAuth, setSessionCookie, clearSessionCookie } = require("../middleware/http");
const outbox = require("../modules/messaging/outbox");
const templates = require("../modules/messaging/templates");
const marketing = require("../modules/marketing/service");
const { userByEmail, phoneTaken } = require("../lib/accounts");

const router = express.Router();
const LOCK_AFTER = 30;

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

// Someone signs up with an email that has only bought as a guest. The
// password is chosen from a link sent to that inbox, never typed into the
// sign-up form, so nobody can pick a password for someone else's tickets.
async function sendFinishAccount(q, user) {
  const token = randomToken(32);
  await q.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '24 hours')", [sha256(token), user.id]);
  await outbox.enqueue(q, { to: user.email, userId: user.id, ...templates.finishAccount({ name: user.full_name, url: `${config.publicBaseUrl}/account#/reset/${token}` }) });
}

// Sign-up. Every account confirms its email before it can sign in, and one
// email (or mobile number) belongs to one account. Someone who bought as a
// guest signs up with the same email: they get a link to choose a password,
// and the guest account (with every ticket in it) becomes theirs.
router.post("/register", limit("register", 60, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, {
    fullName: r.str({ min: 2, max: 120 }), email: r.email(), phone: r.phone({ optional: true }),
    password: r.password(), marketingOptIn: r.bool(), acceptTerms: r.bool(),
  });
  if (!b.acceptTerms) throw bad("Please accept the Terms and Privacy Notice.", { acceptTerms: "Required." });
  await db.withTx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('signup:' || tr.email_key($1)))", [b.email]);
    const existing = await userByEmail(c, b.email);
    if (existing && !existing.guest) {
      throw conflict('An account with this email already exists. Sign in, or use "Forgot password?" if you can\'t remember it.', "email_taken", { email: "Already has an account." });
    }
    if (await phoneTaken(c, b.phone, existing?.id)) {
      throw conflict("This mobile number is already on another TicketRoom account. Sign in to that account, or leave the number out.", "phone_taken", { phone: "Already on another account." });
    }
    let u;
    if (existing) {
      // A guest's account: they choose the password from their inbox.
      u = existing;
      if (hit(`finishsend:${u.id}`, 3, 60 * 60e3)) await sendFinishAccount(c, u);
    } else {
      ({ rows: [u] } = await c.query("INSERT INTO users (email, phone, full_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING *",
        [b.email, b.phone || null, b.fullName, hashSecret(b.password)]));
      await sendVerification(c, u);
    }
    if (b.marketingOptIn) await marketing.setConsent(c, u.id, null, "email", true, "signup");
    await audit.record(c, { actor: { id: u.id }, action: "user.registered", entityType: "user", entityId: u.id, ip: req.ip, details: { fromGuest: !!existing } });
  });
  res.status(201).json({ needsVerification: true, email: b.email, message: `We've sent a confirmation link to ${b.email}. Open it to finish creating your account.` });
}));

router.post("/login", limit("login", 120, 15 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email(), password: r.str({ min: 1, max: 200 }) });
  const { rows } = await db.query("SELECT * FROM users WHERE lower(email) = $1 AND status <> 'deleted'", [b.email]);
  const u = rows[0] || await userByEmail(db, b.email);
  const ok = verifySecret(b.password, u?.password_hash || DUMMY_HASH);
  // The same answer for an unknown email, a wrong password, a guest account
  // (no password) and a locked account, so the sign-in box never reveals who
  // has an account.
  const generic = new AppError(401, "bad_credentials", 'Email or password is incorrect. After several tries, wait 15 minutes or use "Forgot password?".');
  if (!u || u.status === "deleted") throw generic;
  // 5 wrong passwords per email from one connection every 15 minutes, and a
  // pause for the whole account only after 30 failures from anywhere, which
  // then clears itself: nobody can keep someone else locked out for long.
  // Signing in correctly never counts, so several devices are fine.
  const pair = `loginpair:${b.email}|${req.ip}`;
  if (reached(pair, 5)) throw tooMany();
  const locked = u.locked_until && new Date(u.locked_until) > new Date();
  if (u.locked_until && !locked) await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]);
  if (locked) throw generic;
  if (!ok) {
    hit(pair, 5, 15 * 60e3);
    await db.query("UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' END WHERE id = $1", [u.id, LOCK_AFTER]);
    throw generic;
  }
  if (u.status === "suspended") throw new AppError(403, "suspended", "This account is suspended. Contact hello@ticketroom.co.za.");
  // Right password, email not confirmed yet: send a fresh link (a few per hour at most).
  if (!u.email_verified_at) {
    if (hit(`verifysend:${u.id}`, 3, 60 * 60e3)) await db.withTx((c) => sendVerification(c, u));
    throw new AppError(403, "email_not_verified", `Please confirm your email first. We've sent a link to ${u.email}: open it and you're in.`);
  }
  await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]);
  clear(pair);
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

// The link in the confirmation email. The first time it is used it confirms
// the address and signs the person in (proof enough: only the inbox's owner
// has the link); a guest account becomes a full one, tickets and all.
router.post("/verify-email", limit("verifylink", 30, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { token: r.str({ max: 600 }) });
  const data = verifyLink(b.token);
  if (!data?.v) throw bad("This confirmation link is invalid or has expired.");
  if (!/^[0-9a-f-]{36}$/i.test(String(data.v))) throw bad("This confirmation link is invalid or has expired.");
  const result = await db.withTx(async (c) => {
    const { rows: [u] } = await c.query("SELECT * FROM users WHERE id = $1 AND lower(email) = lower($2) AND status = 'active' FOR UPDATE", [data.v, data.e || ""]);
    if (!u) throw bad("This confirmation link is invalid or has expired.");
    // A guest account has no password yet: it is finished from the
    // choose-a-password email, never from a confirmation link.
    if (u.guest) {
      if (hit(`finishsend:${u.id}`, 3, 60 * 60e3)) await sendFinishAccount(c, u);
      return { user: u, guest: true };
    }
    if (u.email_verified_at) return { user: u, first: false };
    await c.query("UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1", [u.id]);
    await audit.record(c, { actor: { id: u.id }, action: "user.email_verified", entityType: "user", entityId: u.id, ip: req.ip });
    await createSession(res, req, u.id, c);
    return { user: u, first: true };
  });
  if (result.guest) throw bad(`This link has been replaced. We've emailed ${result.user.email} a link to choose your password: open the newest email from us.`);
  const { rows: [{ n }] } = await db.query("SELECT count(*)::int AS n FROM tickets WHERE owner_user_id = $1 AND status = 'valid'", [result.user.id]);
  const { rows: org } = await db.query("SELECT 1 FROM organiser_members WHERE user_id = $1 LIMIT 1", [result.user.id]);
  res.json({ ok: true, signedIn: result.first, firstName: String(result.user.full_name || "").trim().split(/\s+/)[0], tickets: n, organiser: !!org[0] });
}));

// "Didn't get the email?" Same answer whether or not the address has an account.
router.post("/verify-email/resend", limit("verifyresend", 5, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email({ optional: true }) });
  let u = null;
  if (req.user) u = (await db.query("SELECT * FROM users WHERE id = $1", [req.user.id])).rows[0];
  else if (b.email) u = await userByEmail(db, b.email);
  // A guest account has no password yet: it gets the link to choose one instead.
  if (u && u.status === "active" && (!u.email_verified_at || u.guest) && hit(`verifysend:${u.id}`, 3, 60 * 60e3)) {
    await db.withTx((c) => (u.guest ? sendFinishAccount(c, u) : sendVerification(c, u)));
  }
  res.json({ ok: true, message: "If that email is waiting to be confirmed, a new link is on its way." });
}));

// Always answers the same way, whether or not the email exists.
router.post("/password/forgot", limit("forgot", 5, 60 * 60e3), wrap(async (req, res) => {
  const b = check(req.body, { email: r.email() });
  const found = await userByEmail(db, b.email);
  const rows = found && found.status === "active" ? [found] : [];
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
  const userId = await db.withTx(async (c) => {
    const { rows } = await c.query("UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id", [sha256(b.token)]);
    if (!rows[0]) throw bad("This reset link is invalid or has expired.");
    // A reset link proves the inbox too: the email is confirmed (a staff invite
    // doubles as email proof), and a guest account becomes a full one.
    await c.query(
      `UPDATE users SET password_hash = $2, guest = false, failed_logins = 0, locked_until = NULL,
              email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`, [rows[0].user_id, hashSecret(b.password)]);
    await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [rows[0].user_id]);
    await audit.record(c, { actor: { id: rows[0].user_id }, action: "user.password_reset", entityType: "user", entityId: rows[0].user_id, ip: req.ip });
    return rows[0].user_id;
  });
  // The link proved the inbox, so the new password signs them straight in.
  const { rows: [u] } = await db.query(
    `SELECT u.status, (SELECT count(*) FROM tickets WHERE owner_user_id = u.id AND status = 'valid')::int AS tickets,
            EXISTS (SELECT 1 FROM platform_roles WHERE user_id = u.id) AS staff, EXISTS (SELECT 1 FROM organiser_members WHERE user_id = u.id) AS organiser
       FROM users u WHERE u.id = $1`, [userId]);
  if (u.status === "active") await createSession(res, req, userId);
  res.json({ ok: true, signedIn: u.status === "active", tickets: u.tickets, staff: u.staff, organiser: u.organiser });
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
