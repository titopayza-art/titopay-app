"use strict";

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { isVerifiedTitoPayUser } = require("../lib/chat-policy");
const { writeAuditLog, writeSecurityLog } = require("./audit-service");

const NOT_REGISTERED_MESSAGE = "This recipient is not yet registered on TitoPay.";

function normalizeIdentifier(value = "") {
  return String(value).trim().toLowerCase();
}

function normalizeSouthAfricanPhone(value = "") {
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("27") && digits.length === 11) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+27${digits.slice(1)}`;
  if (digits.length === 9) return `+27${digits}`;
  return String(value).replace(/\s+/g, "");
}

function recipientLookupValues(payload = {}) {
  const source = payload.recipient || payload.identifier || payload.lookup || payload.phone || payload.email || payload.username || "";
  const raw = String(source).trim();
  const lower = normalizeIdentifier(raw);
  const withoutAt = lower.replace(/^@/, "");
  const phone = normalizeSouthAfricanPhone(raw);
  const compact = raw.replace(/\s+/g, "");
  const digits = phone.replace(/\D/g, "") || compact.replace(/\D/g, "");
  const localPhone = digits.startsWith("27") && digits.length === 11 ? `0${digits.slice(2)}` : "";
  const nationalPhone = digits.startsWith("0") && digits.length === 10 ? `27${digits.slice(1)}` : "";
  const shortPhone = digits.startsWith("27") && digits.length === 11 ? digits.slice(2) : "";
  return Array.from(new Set([raw, lower, withoutAt, phone, compact, digits, localPhone, nationalPhone, shortPhone].filter(Boolean)));
}

function recipientPhoneLookupValues(payload = {}) {
  return recipientLookupValues(payload)
    .map((value) => String(value).replace(/\D/g, ""))
    .filter(Boolean);
}

function inviteMessage(identifier) {
  return `Join TitoPay to receive this payment request from a TitoPay user. Register at https://app.titopay.co.za using ${identifier}.`;
}

function parseQrPayload(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

async function verifyRecipient(actor, payload = {}) {
  const rawIdentifier = payload.recipient || payload.identifier || payload.qrPayload || payload.qrId;
  const identifier = normalizeIdentifier(rawIdentifier);
  if (!identifier) throw new AppError(400, "Recipient is required");

  const qrPayload = parseQrPayload(rawIdentifier);
  if (qrPayload?.id || payload.qrId) {
    const qrId = qrPayload?.id || payload.qrId;
    const { rows } = await pool.query(
      `SELECT q.id, q.reference, q.user_id, u.username, u.email, u.phone
       FROM qr_codes q
       JOIN users u ON u.id = q.user_id
       WHERE q.id = $1 AND q.status = 'active'
       LIMIT 1`,
      [qrId]
    );
    const qr = rows[0];
    if (qr) {
      return {
        registered: true,
        recipient: {
          userId: qr.user_id,
          username: qr.username,
          email: qr.email,
          phone: qr.phone,
          qrId: qr.id,
          qrReference: qr.reference
        }
      };
    }
  }

  const lookupValues = recipientLookupValues(payload).map((value) => String(value).toLowerCase());
  const phoneLookupValues = recipientPhoneLookupValues(payload);
  const { rows } = await pool.query(
    `SELECT id, username, email, phone, account_type, full_name, status, fica_status,
            profile_photo_url, business_logo_url, w.wallet_number AS wallet_id
     FROM users
     LEFT JOIN LATERAL (
       SELECT wallet_number
       FROM wallets
       WHERE user_id = users.id
       ORDER BY created_at ASC
       LIMIT 1
     ) w ON TRUE
     WHERE LOWER(username) = ANY($1::TEXT[])
        OR LOWER(email) = ANY($1::TEXT[])
        OR LOWER(phone) = ANY($1::TEXT[])
        OR LOWER(COALESCE(w.wallet_number, '')) = ANY($1::TEXT[])
        OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = ANY($2::TEXT[])
     LIMIT 1`,
    [lookupValues, phoneLookupValues]
  );
  const user = rows[0];
  const chatLookup = payload.purpose === "titopay_chat";
  if (user && (!chatLookup || isVerifiedTitoPayUser(user))) {
    return {
      registered: true,
      recipient: {
        userId: user.id,
        id: user.id,
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        walletId: user.wallet_id,
        wallet_id: user.wallet_id,
        accountType: user.account_type,
        profilePhotoUrl: user.account_type === "business" ? user.business_logo_url : user.profile_photo_url,
        verificationStatus: user.fica_status,
        status: user.status,
        ficaStatus: user.fica_status,
        verified: isVerifiedTitoPayUser(user)
      }
    };
  }

  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "recipient_not_registered",
    entityType: "recipient",
    entityId: null,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { identifier: rawIdentifier }
  });

  return {
    registered: false,
    message: NOT_REGISTERED_MESSAGE,
    invite: {
      identifier: rawIdentifier,
      url: "https://app.titopay.co.za",
      message: inviteMessage(rawIdentifier),
      channels: ["sms", "email", "whatsapp"]
    }
  };
}

async function resolveTitoPayUser(actor, payload = {}) {
  return verifyRecipient(actor, payload);
}

async function createInvite(actor, payload = {}) {
  const identifier = payload.identifier || payload.recipient;
  if (!identifier) throw new AppError(400, "Invite recipient is required");
  const id = uuidv4();
  const message = payload.message || inviteMessage(identifier);
  await pool.query(
    `INSERT INTO invite_links
      (id, invited_by_user_id, invitee_identifier, channels, message, url, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,'created',$7)`,
    [
      id,
      actor.userType === "customer" ? actor.userId : null,
      identifier,
      payload.channels || ["sms", "email", "whatsapp"],
      message,
      "https://app.titopay.co.za",
      JSON.stringify(payload.metadata || {})
    ]
  );
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "invite_created",
    entityType: "invite_link",
    entityId: id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { identifier }
  });
  return { id, identifier, message, url: "https://app.titopay.co.za", status: "created" };
}

async function trackInviteEvent(actor, payload = {}) {
  if (!payload.inviteId || !payload.eventType) throw new AppError(400, "Invite ID and event type are required");
  const id = uuidv4();
  await pool.query(
    `INSERT INTO invite_events (id, invite_id, event_type, metadata)
     VALUES ($1,$2,$3,$4)`,
    [id, payload.inviteId, payload.eventType, JSON.stringify(payload.metadata || {})]
  );
  if (payload.eventType === "sent") {
    await pool.query("UPDATE invite_links SET status = 'sent', sent_at = NOW() WHERE id = $1", [payload.inviteId]);
  }
  return { id, ok: true };
}

async function getSecurityCentre(actor) {
  const [trustedDevices, sessions, events, duplicateFlags, loginAttempts, pinAttempts] = await Promise.all([
    pool.query(
      `SELECT id, device_label AS "deviceLabel", user_agent AS "userAgent", ip_address AS "ipAddress",
              trusted_at AS "trustedAt", last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"
       FROM trusted_devices
       WHERE user_id = $1
       ORDER BY COALESCE(last_seen_at, trusted_at) DESC
       LIMIT 20`,
      [actor.userId]
    ),
    // Read from `sessions`, which is the table requireAuth actually validates
    // against on every request. This used to read `active_sessions` — a table
    // nothing in the codebase has ever inserted into, so the Security Centre's
    // device list was empty for every customer who has ever opened it, however
    // many devices they were really signed in on.
    pool.query(
      `SELECT id, id::TEXT AS "sessionId", device_name AS "deviceLabel", ip_address AS "ipAddress",
              user_agent AS "userAgent",
              (revoked_at IS NULL AND expires_at > NOW()) AS active,
              created_at AS "createdAt", last_activity_at AS "lastSeenAt", revoked_at AS "revokedAt"
       FROM sessions
       WHERE user_id = $1 AND user_type = 'customer'
       ORDER BY COALESCE(last_activity_at, created_at) DESC
       LIMIT 20`,
      [actor.userId]
    ),
    pool.query(
      `SELECT event_type AS "eventType", severity, success, metadata, created_at AS "createdAt"
       FROM security_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [actor.userId]
    ),
    pool.query(
      `SELECT id, match_type AS "matchType", matched_value AS "matchedValue", status, created_at AS "createdAt"
       FROM duplicate_account_flags
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [actor.userId]
    ),
    pool.query(
      `SELECT identifier, success, ip_address AS "ipAddress", created_at AS "createdAt"
       FROM login_attempts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [actor.userId]
    ),
    pool.query(
      `SELECT success, ip_address AS "ipAddress", created_at AS "createdAt"
       FROM pin_attempts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [actor.userId]
    )
  ]);
  return {
    walletLock: { locked: Boolean(actor.profileLocked) },
    trustedDevices: trustedDevices.rows,
    activeSessions: sessions.rows,
    securityEvents: events.rows,
    duplicateAccountFlags: duplicateFlags.rows,
    loginAttempts: loginAttempts.rows,
    pinAttempts: pinAttempts.rows
  };
}

async function trustCurrentDevice(actor, payload = {}) {
  const id = uuidv4();
  const fingerprint = payload.deviceFingerprint || `${actor.userAgent || "browser"}:${actor.ipAddress || "unknown"}`;
  await pool.query(
    `INSERT INTO trusted_devices
      (id, user_id, device_fingerprint, device_label, user_agent, ip_address, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, device_fingerprint) WHERE user_id IS NOT NULL
     DO UPDATE SET last_seen_at = NOW(), revoked_at = NULL, device_label = EXCLUDED.device_label`,
    [id, actor.userId, fingerprint, payload.deviceLabel || "Current device", actor.userAgent, actor.ipAddress, JSON.stringify(payload.metadata || {})]
  );
  await writeSecurityLog({
    actorType: actor.userType,
    actorId: actor.userId,
    eventType: "device_trusted",
    severity: "info",
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    success: true,
    metadata: { deviceLabel: payload.deviceLabel || "Current device" }
  });
  return { ok: true };
}

async function revokeTrustedDevice(actor, id) {
  await pool.query("UPDATE trusted_devices SET revoked_at = NOW() WHERE id = $1 AND user_id = $2", [id, actor.userId]);
  return { ok: true };
}

// Sign one device out. Three things were wrong with this before.
//
// It wrote to `active_sessions`, which nothing populates, while requireAuth
// validates against `sessions` — so even a successful call revoked nothing and
// the "signed out" token kept working. It matched `(id = $1 OR session_id = $1)`
// across a UUID column and a TEXT column, which made PostgreSQL raise
// "operator does not exist: text = uuid" and turned every single call into a
// 500 that the generic 5xx message hid. And it reported ok either way.
//
// Now it revokes the real session — the same statement logoutAll uses, narrowed
// to one row and scoped to the caller — and says whether it actually did.
async function remoteLogout(actor, sessionId) {
  const { rows } = await pool.query(
    `UPDATE sessions
        SET revoked_at = NOW(), revoked_reason = 'remote_logout'
      WHERE id = $1 AND user_id = $2 AND user_type = 'customer' AND revoked_at IS NULL
      RETURNING id`,
    [sessionId, actor.userId]
  );
  const revoked = rows.length > 0;
  await pool.query(
    `INSERT INTO remote_logout_events (id, user_id, session_id, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [uuidv4(), actor.userId, String(sessionId), actor.ipAddress, actor.userAgent]
  );
  // Nothing matched means the session is not this customer's, or was already
  // signed out. Say so rather than claiming success — the UI should not report
  // that it cut off a device it never touched.
  if (!revoked) throw new AppError(404, "That device session was not found");
  return { ok: true, revoked: true };
}

async function logPinAttempt(actor, payload = {}) {
  await pool.query(
    `INSERT INTO pin_attempts (id, user_id, success, ip_address, user_agent, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [uuidv4(), actor.userId, Boolean(payload.success), actor.ipAddress, actor.userAgent, JSON.stringify(payload.metadata || {})]
  );
  return { ok: true };
}

module.exports = {
  NOT_REGISTERED_MESSAGE,
  normalizeSouthAfricanPhone,
  recipientLookupValues,
  recipientPhoneLookupValues,
  verifyRecipient,
  resolveTitoPayUser,
  createInvite,
  trackInviteEvent,
  getSecurityCentre,
  trustCurrentDevice,
  revokeTrustedDevice,
  remoteLogout,
  logPinAttempt
};
