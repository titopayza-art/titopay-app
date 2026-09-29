"use strict";

// THE MAILBOX END OF SUPPORT EMAIL.
//
// inbound-email-service turns a raw message into a ticket and knows nothing
// about where the message came from. This is the half that goes and gets it:
// it holds the mailbox credentials, polls over IMAP, and hands each message
// across. Splitting it this way is what let the ticketing half be written and
// fully tested before a mailbox existed at all.
//
// WHY IMAP HERE AND WEBHOOKS FOR MONEY.
//
// A webhook is pushed, signed, and verifiable against the sender. Email is
// pulled, and a From header is a claim anybody can make. So the rule this
// platform follows is that email may OPEN a conversation and never SETTLE
// anything: every ticket created from this path is channel 'email', which
// support-ticket-reply-service marks unverified, and an agent is told in the
// reply prompt not to act on an account from it until the person confirms in
// the app. Nothing in this file can move money, and nothing downstream of it
// treats a mailbox as a source of truth about a payment.
//
// THE ONE INVARIANT THAT MAKES POLLING SAFE.
//
// \Seen means "this is safely in our database", and nothing else. The fetch
// uses BODY.PEEK so reading never sets it; it is set only after the message is
// stored. Every failure in between - a dropped connection, a database error, a
// process restart - therefore leaves the message unread and it is collected on
// the next pass. The cost of that is fetching a message twice, which is free,
// because inbound_emails carries a unique index on Message-ID.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { connectImap, ImapError } = require("../lib/imap-client");
const { ingestInboundEmail, recordUnprocessable, MAX_RAW_BYTES } = require("./inbound-email-service");
const { integrationEncryptionKey } = require("../lib/integration-secret-key");
const { AppError } = require("../lib/errors");

// A lock id for pg_try_advisory_lock. The email worker is a single process
// today, so this is belt and braces - but "there is only ever one worker" is
// exactly the assumption that stops being true the day someone scales it, and
// two pollers racing the same mailbox would double-fetch every message.
// Deduplication would still hold the line; this simply stops the waste.
const POLL_LOCK_ID = 774_3102;

const DEFAULTS = {
  enabled: false,
  host: "",
  port: 993,
  username: "",
  mailbox: "INBOX",
  poll_seconds: 60,
  max_messages_per_poll: 25,
  max_message_bytes: MAX_RAW_BYTES
};

/* ---------------------------------------------------------------- secrets */

// The same vault the Email Centre and the Integrations store use. Deriving a
// key locally is what broke every stored credential on 20 August 2026, and a
// test now bans it, so this asks lib/integration-secret-key and nothing else.
function cryptoKey() {
  return integrationEncryptionKey(process.env.EMAIL_ENCRYPTION_KEY);
}
function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}
function decryptSecret(value) {
  if (!value || !String(value).startsWith("enc:")) return "";
  const [, iv, tag, body] = String(value).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", cryptoKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

const MASK = "••••••••";

/* ----------------------------------------------------------------- schema */

let schemaReady = null;
function ensureInboundMailboxSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS inbound_mailbox_settings (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          host TEXT NOT NULL DEFAULT '',
          port INTEGER NOT NULL DEFAULT 993,
          username TEXT NOT NULL DEFAULT '',
          password_encrypted TEXT NOT NULL DEFAULT '',
          mailbox TEXT NOT NULL DEFAULT 'INBOX',
          poll_seconds INTEGER NOT NULL DEFAULT 60,
          max_messages_per_poll INTEGER NOT NULL DEFAULT 25,
          max_message_bytes INTEGER NOT NULL DEFAULT ${MAX_RAW_BYTES},
          last_polled_at TIMESTAMPTZ,
          last_success_at TIMESTAMPTZ,
          last_error TEXT,
          last_error_at TIMESTAMPTZ,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          updated_by UUID,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      // Ships DISABLED with no credentials. Turning it on is a deliberate act
      // by an operator, so deploying this code changes nothing by itself.
      await pool.query(
        "INSERT INTO inbound_mailbox_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING");
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/* --------------------------------------------------------------- settings */

async function getMailboxSettings({ masked = true } = {}) {
  await ensureInboundMailboxSchema();
  const { rows } = await pool.query("SELECT * FROM inbound_mailbox_settings WHERE id = TRUE");
  const row = rows[0] || { ...DEFAULTS };
  const shaped = {
    enabled: Boolean(row.enabled),
    host: row.host || "",
    port: Number(row.port) || 993,
    username: row.username || "",
    mailbox: row.mailbox || "INBOX",
    pollSeconds: Number(row.poll_seconds) || 60,
    maxMessagesPerPoll: Number(row.max_messages_per_poll) || 25,
    maxMessageBytes: Number(row.max_message_bytes) || MAX_RAW_BYTES,
    lastPolledAt: row.last_polled_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastError: row.last_error || null,
    lastErrorAt: row.last_error_at || null,
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    hasPassword: Boolean(row.password_encrypted)
  };
  // The password is never returned, masked or otherwise, to any caller that
  // asks for the masked form - which is every caller except the poller.
  if (!masked) shaped.password = decryptSecret(row.password_encrypted);
  else shaped.password = row.password_encrypted ? MASK : "";
  return shaped;
}

function positiveInteger(value, field, { min, max, fallback }) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return number;
}

async function updateMailboxSettings(values = {}, actor = {}) {
  await ensureInboundMailboxSchema();
  const current = await getMailboxSettings({ masked: true });

  const host = String(values.host ?? current.host).trim();
  const username = String(values.username ?? current.username).trim();
  const mailbox = String(values.mailbox ?? current.mailbox).trim() || "INBOX";
  const enabled = values.enabled === undefined ? current.enabled : Boolean(values.enabled);

  // A newline in any of these would end one IMAP command and begin another.
  // The client refuses them too; refusing them here as well means a bad value
  // can never be SAVED, rather than being stored and failing every poll.
  for (const [field, value] of Object.entries({ host, username, mailbox })) {
    if (/[\r\n\0]/.test(value)) throw new AppError(400, `${field} may not contain line breaks`);
    if (value.length > 255) throw new AppError(400, `${field} is too long`);
  }
  if (host && !/^[a-z0-9.-]+$/i.test(host)) {
    throw new AppError(400, "host must be a hostname, for example imap.titopay.co.za");
  }
  if (enabled && (!host || !username)) {
    throw new AppError(400, "A host and username are required before the mailbox can be switched on");
  }

  const port = positiveInteger(values.port, "port", { min: 1, max: 65535, fallback: current.port });
  const pollSeconds = positiveInteger(values.pollSeconds, "pollSeconds",
    { min: 15, max: 3600, fallback: current.pollSeconds });
  const maxMessages = positiveInteger(values.maxMessagesPerPoll, "maxMessagesPerPoll",
    { min: 1, max: 200, fallback: current.maxMessagesPerPoll });
  const maxBytes = positiveInteger(values.maxMessageBytes, "maxMessageBytes",
    { min: 8 * 1024, max: MAX_RAW_BYTES, fallback: current.maxMessageBytes });

  // An unchanged password arrives back as the mask. Writing that would replace
  // the real credential with eight bullet characters and lock the mailbox out
  // on the next poll, so the mask means "leave it alone".
  const incoming = values.password;
  const changingPassword = incoming !== undefined && incoming !== null
    && String(incoming) !== "" && !String(incoming).startsWith("••");

  if (enabled && !changingPassword && !current.hasPassword) {
    throw new AppError(400, "A mailbox password is required before the mailbox can be switched on");
  }

  const { rows } = await pool.query(
    `UPDATE inbound_mailbox_settings
        SET enabled = $1, host = $2, port = $3, username = $4, mailbox = $5,
            poll_seconds = $6, max_messages_per_poll = $7, max_message_bytes = $8,
            password_encrypted = CASE WHEN $9::BOOLEAN THEN $10 ELSE password_encrypted END,
            updated_by = $11, updated_at = NOW()
      WHERE id = TRUE
      RETURNING id`,
    [enabled, host, port, username, mailbox, pollSeconds, maxMessages, maxBytes,
      changingPassword, changingPassword ? encryptSecret(String(incoming)) : null,
      actor.adminId || actor.userId || null]
  );
  if (!rows[0]) throw new AppError(500, "Mailbox settings could not be saved");

  await require("./audit-service").writeAuditLog({
    actorType: "admin",
    actorId: actor.adminId || actor.userId || null,
    action: "inbound_mailbox_settings_updated",
    entityType: "inbound_mailbox_settings",
    entityId: null,
    // Deliberately records THAT the password changed and never the value.
    metadata: { enabled, host, port, username, mailbox, pollSeconds,
      passwordChanged: changingPassword }
  }).catch(() => null);

  return getMailboxSettings({ masked: true });
}

/* ------------------------------------------------------------ connection */

async function openConnection(settings) {
  return connectImap({
    host: settings.host,
    port: settings.port,
    user: settings.username,
    password: settings.password,
    // Present for tests, which run against a server holding a certificate they
    // generated. Never populated from stored settings, so no operator can
    // weaken verification through the console.
    ...(settings.ca ? { ca: settings.ca, servername: settings.servername } : {})
  });
}

// "Does this actually work" as one button, before anything is switched on.
// Reads nothing and changes nothing: it connects, opens the mailbox, counts
// what is waiting and leaves.
async function testMailboxConnection(overrides = {}) {
  const settings = { ...(await getMailboxSettings({ masked: false })), ...overrides };
  if (!settings.host || !settings.username) {
    return { ok: false, error: "A host and username are needed first." };
  }
  let connection = null;
  try {
    connection = await openConnection(settings);
    const { exists } = await connection.select(settings.mailbox);
    const unseen = await connection.searchUnseen();
    await connection.logout();
    return { ok: true, mailbox: settings.mailbox, messages: exists, waiting: unseen.length };
  } catch (error) {
    return { ok: false, error: friendlyError(error) };
  } finally {
    if (connection) connection.destroy();
  }
}

// The server's own wording is the most useful thing an operator can be given,
// but it is echoed rather than interpreted, and the command echo in ImapError
// never carries the password.
function friendlyError(error) {
  if (error instanceof ImapError) {
    if (error.code === "rejected" && /AUTHENTICATIONFAILED|LOGIN/i.test(error.message)) {
      return `The mail server rejected the sign-in. ${error.message}`;
    }
    if (error.code === "timeout") return "The mail server did not answer in time.";
    if (error.code === "connect_failed") return `Could not reach the mail server. ${error.message}`;
    return error.message;
  }
  return String(error?.message || "Unknown error").slice(0, 300);
}

/* ---------------------------------------------------------------- polling */

async function recordPollResult({ ok, error }) {
  await pool.query(
    `UPDATE inbound_mailbox_settings
        SET last_polled_at = NOW(),
            last_success_at = CASE WHEN $1::BOOLEAN THEN NOW() ELSE last_success_at END,
            last_error = CASE WHEN $1::BOOLEAN THEN NULL ELSE $2 END,
            last_error_at = CASE WHEN $1::BOOLEAN THEN last_error_at ELSE NOW() END,
            consecutive_failures = CASE WHEN $1::BOOLEAN THEN 0 ELSE consecutive_failures + 1 END
      WHERE id = TRUE`,
    [Boolean(ok), error ? String(error).slice(0, 500) : null]
  ).catch(() => null);
}

// One pass over the mailbox. Returns a summary rather than throwing, because
// the caller is a worker loop that must survive a mail outage: a mailbox being
// down is not a reason to stop sending mail or to stop the money integrity
// sweep that shares the same process.
// `overrides` is a test seam and nothing else: it lets the suite point a poll
// at a server whose certificate it generated. It is never populated from
// stored settings or from an admin request, so there is no path by which an
// operator - or anyone reaching the console - can use it to redirect the
// mailbox or weaken certificate verification.
async function pollMailbox({ force = false, overrides = {} } = {}) {
  await ensureInboundMailboxSchema();
  const settings = { ...(await getMailboxSettings({ masked: false })), ...overrides };
  if (!settings.enabled && !force) return { skipped: "disabled" };
  if (!settings.host || !settings.username) return { skipped: "not_configured" };

  // Single-flight. A session-level advisory lock is released when the
  // connection returns to the pool, and taking it without waiting means a
  // second poller simply does nothing rather than queueing up behind this one.
  const lockClient = await pool.connect();
  let holdsLock = false;
  try {
    const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [POLL_LOCK_ID]);
    holdsLock = Boolean(rows[0]?.locked);
    if (!holdsLock) return { skipped: "already_running" };

    return await runPoll(settings);
  } finally {
    if (holdsLock) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [POLL_LOCK_ID]).catch(() => null);
    }
    lockClient.release();
  }
}

async function runPoll(settings) {
  const summary = { polled: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0, tickets: [] };
  let connection = null;
  try {
    connection = await openConnection(settings);
    await connection.select(settings.mailbox);
    const unseen = await connection.searchUnseen();
    // Oldest first: a customer who wrote twice should have their first message
    // open the ticket and the second thread onto it, not the other way round.
    const batch = unseen.sort((a, b) => a - b).slice(0, settings.maxMessagesPerPoll);
    if (!batch.length) {
      await connection.logout();
      await recordPollResult({ ok: true });
      return { ...summary, waiting: 0 };
    }

    const sizes = await connection.fetchSizes(batch);

    for (const uid of batch) {
      summary.polled += 1;
      const size = sizes.get(uid);
      try {
        // TOO BIG TO READ, BUT NOT TOO BIG TO NOTICE. The body is never
        // fetched; the headers are, so the failed-queue row says who wrote.
        if (size && size > settings.maxMessageBytes) {
          const headers = await connection.fetchHeaders(uid).catch(() => null);
          const text = headers ? headers.toString("utf8") : "";
          await recordUnprocessable({
            messageId: (/^message-id:\s*<([^>]+)>/im.exec(text) || [])[1] || null,
            fromEmail: (/^from:.*?<([^>]+)>/im.exec(text) || [])[1]
              || (/^from:\s*(\S+@\S+)/im.exec(text) || [])[1] || null,
            subject: (/^subject:\s*(.*)$/im.exec(text) || [])[1] || null,
            reason: "too_large",
            note: `This email was ${size} bytes, over the ${settings.maxMessageBytes} byte limit, so it was not accepted. It is still in the mailbox.`
          });
          // Marked read so it does not fill every future poll. The record
          // above is what stops it being a silent disappearance.
          await connection.markSeen(uid);
          summary.skipped += 1;
          continue;
        }

        const raw = await connection.fetchMessage(uid);
        if (!raw || !raw.length) {
          summary.failed += 1;
          continue;  // left unread deliberately, so the next poll retries it
        }

        const result = await ingestInboundEmail(raw.toString("utf8"), { source: "imap" });

        // THE ONLY PLACE \Seen IS SET, AND ONLY AFTER THE MESSAGE IS STORED.
        // A duplicate counts as stored - it is already in the database from an
        // earlier pass, and leaving it unread would make every poll refetch it
        // forever. An empty message counts too: there is nothing to come back
        // for, and it would otherwise block the batch every time.
        if (result.stored || result.duplicate || result.reason === "empty") {
          await connection.markSeen(uid);
        }

        if (result.stored) {
          summary.ingested += 1;
          if (result.ticketId) summary.tickets.push(result.ticketId);
        } else if (result.duplicate) {
          summary.duplicates += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        // One bad message must not end the pass. It stays unread and is tried
        // again next time; the rest of the batch still gets through.
        summary.failed += 1;
        console.error("[inbound-mailbox] message failed", { uid, message: error.message });
      }
    }

    await connection.logout();
    await recordPollResult({ ok: true });
    return { ...summary, waiting: unseen.length - batch.length };
  } catch (error) {
    const message = friendlyError(error);
    await recordPollResult({ ok: false, error: message });
    console.error("[inbound-mailbox] poll failed", { message });
    return { ...summary, error: message };
  } finally {
    if (connection) connection.destroy();
  }
}

module.exports = {
  ensureInboundMailboxSchema,
  getMailboxSettings,
  updateMailboxSettings,
  testMailboxConnection,
  pollMailbox,
  // Exported for tests.
  encryptSecret,
  decryptSecret,
  POLL_LOCK_ID,
  MASK
};
