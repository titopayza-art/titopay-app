"use strict";

// WHY DID AN EMAIL TO support@titopay.co.za NOT BECOME A TICKET?
//
// There are seven links in that chain and a break in any one of them looks
// identical from the outside: nothing happens. Guessing which one is broken
// costs an afternoon, so this walks them in order, stops at the first that
// fails, and says what to do about it.
//
//     node scripts/diagnose-inbound-email.js
//
// Add --connect to also open the mailbox and count what is waiting. That is
// the only step that touches the mail server, and it still reads nothing: it
// uses BODY.PEEK nowhere because it fetches no bodies at all, so running it
// cannot consume a message or mark anything read.
//
// Everything here is read-only. It creates nothing, changes nothing, and is
// safe against production.

require("../src/config/env");
const { pool } = require("../src/db/pool");
const { API_BUILD } = require("../src/build-info");

const CONNECT = process.argv.includes("--connect");

let stopped = false;
const results = [];
function step(name, state, detail, fix) {
  results.push({ name, state, detail, fix });
  const mark = state === "ok" ? "  OK  " : state === "warn" ? " WARN " : " STOP ";
  console.log(`${mark} ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (fix) console.log(`       -> ${fix}`);
  if (state === "stop") stopped = true;
}

async function tableExists(name) {
  const { rows } = await pool.query("SELECT to_regclass($1) AS t", [`public.${name}`]);
  return Boolean(rows[0].t);
}

(async () => {
  console.log("\nINBOUND SUPPORT EMAIL - where the chain is broken\n");

  /* 1. Is the code even on this server? ---------------------------------- */
  let hasCode = true;
  try {
    require("../src/services/inbound-mailbox-service");
    require("../src/lib/imap-client");
  } catch (error) {
    hasCode = false;
    step("the inbound mail code is deployed", "stop",
      `src/services/inbound-mailbox-service.js could not be loaded: ${error.message}`,
      "This build predates the feature. Deploy the current api.zip, then run this again.");
  }
  if (hasCode) step("the inbound mail code is deployed", "ok", `API build ${API_BUILD}`);
  if (stopped) return finish();

  /* 2. Has anything ever created the tables? ----------------------------- */
  // They are created lazily on first use, so their absence is itself the
  // finding: nothing has run that would have created them.
  const settingsTable = await tableExists("inbound_mailbox_settings");
  if (!settingsTable) {
    step("the mailbox settings exist", "stop",
      "The table inbound_mailbox_settings does not exist.",
      "Nothing has opened the inbound settings yet. Open Email Centre > Settings in the "
      + "admin console as the platform owner, which creates it, then configure the mailbox.");
    return finish();
  }
  step("the mailbox settings exist", "ok");

  /* 3. Is it switched on, with somewhere to connect to? ------------------- */
  const { rows } = await pool.query("SELECT * FROM inbound_mailbox_settings WHERE id = TRUE");
  const s = rows[0];
  if (!s) {
    step("the settings row is present", "stop", "The table exists but holds no row.",
      "Restart the API so the settings row is seeded, then configure the mailbox.");
    return finish();
  }
  const missing = [];
  if (!s.host) missing.push("host");
  if (!s.username) missing.push("username");
  if (!s.password_encrypted) missing.push("password");
  if (missing.length) {
    step("the mailbox is configured", "stop", `Not set: ${missing.join(", ")}.`,
      "Email Centre > Settings > Inbound support mail, as the platform owner. "
      + "Use Test connection before switching collection on.");
    return finish();
  }
  step("the mailbox is configured", "ok",
    `${s.username} at ${s.host}:${s.port}, mailbox ${s.mailbox}`);

  if (!s.enabled) {
    step("collection is switched on", "stop", "enabled is false.",
      "This is the default - the feature ships off so that deploying it reads nobody's "
      + "mailbox. Tick 'Collect support mail' in Email Centre > Settings and save.");
    return finish();
  }
  step("collection is switched on", "ok", `checking every ${s.poll_seconds}s`);

  /* 4. Is the process that does the polling actually running the new code? */
  // The poller lives in the email worker, NOT the API. Restarting only
  // titopay-api leaves the worker on the previous build, and then the mailbox
  // is simply never read - which looks exactly like a mail problem.
  const beat = await pool.query(
    "SELECT value, updated_at FROM platform_settings WHERE key = 'email_worker_heartbeat' LIMIT 1"
  ).catch(() => ({ rows: [] }));
  if (!beat.rows[0]) {
    step("the email worker is running", "stop", "No worker heartbeat has ever been recorded.",
      "pm2 start src/email-worker.js --name titopay-email-worker");
    return finish();
  }
  const age = Math.round((Date.now() - new Date(beat.rows[0].updated_at).getTime()) / 1000);
  const workerBuild = beat.rows[0].value?.build ?? null;
  if (age > 180) {
    step("the email worker is running", "stop",
      `Last heartbeat was ${age}s ago (it beats every ~30s).`,
      "pm2 restart titopay-email-worker --update-env");
    return finish();
  }
  if (String(workerBuild) !== String(API_BUILD)) {
    step("the worker is on the current build", "stop",
      `Worker is on build ${workerBuild}, this code is build ${API_BUILD}.`,
      "The worker is running OLD code and does not know how to poll a mailbox. "
      + "pm2 restart titopay-email-worker --update-env");
    return finish();
  }
  step("the email worker is running the current build", "ok",
    `build ${workerBuild}, heartbeat ${age}s ago`);

  /* 5. Has a poll actually happened, and did it work? --------------------- */
  if (!s.last_polled_at) {
    step("a poll has run", "warn",
      "The mailbox has never been polled, though everything above is in place.",
      `Give it ${s.poll_seconds}s, or press 'Check for mail now' in the console, then re-run this.`);
  } else {
    const since = Math.round((Date.now() - new Date(s.last_polled_at).getTime()) / 1000);
    if (s.last_error) {
      step("the last poll succeeded", "stop",
        `${since}s ago it failed: ${s.last_error}`
        + (s.consecutive_failures > 1 ? ` (${s.consecutive_failures} failures in a row)` : ""),
        "This is the mail server's own answer. A rejected sign-in usually means the account "
        + "needs an app password, or IMAP is switched off for the mailbox.");
      return finish();
    }
    step("the last poll succeeded", "ok", `${since}s ago`);
  }

  /* 6. Did anything arrive, and what happened to it? --------------------- */
  if (await tableExists("inbound_emails")) {
    const counts = await pool.query(
      "SELECT status, COUNT(*)::int AS n FROM inbound_emails GROUP BY status ORDER BY status");
    if (!counts.rows.length) {
      step("mail has arrived", "warn", "No message has ever been collected.",
        "The polls are working but the mailbox had nothing unread. Note that only UNREAD "
        + "messages are collected - if something already opened the mailbox and marked your "
        + "test message read, it will be skipped. Send another and leave it unread.");
    } else {
      step("mail has arrived", "ok",
        counts.rows.map((row) => `${row.n} ${row.status}`).join(", "));
      const failed = await pool.query(
        `SELECT from_email, subject, failure_reason, received_at FROM inbound_emails
          WHERE status IN ('failed','received') ORDER BY received_at DESC LIMIT 5`);
      for (const row of failed.rows) {
        step(`  stuck: ${row.subject || "(no subject)"}`, "warn",
          `from ${row.from_email || "unknown"} - ${row.failure_reason || "not yet processed"}`,
          "Email Centre > Settings > Needs attention, then 'Try again'.");
      }
    }
  } else {
    step("mail has arrived", "warn", "The inbound_emails table does not exist yet.",
      "It is created on the first poll. If polls are running, none has collected anything.");
  }

  /* 7. Did it become a ticket a human can see? --------------------------- */
  const tickets = await pool.query(
    `SELECT ticket_ref, subject, status, contact_email, created_at
       FROM support_tickets WHERE channel = 'email'
      ORDER BY created_at DESC LIMIT 5`).catch(() => ({ rows: [] }));
  if (!tickets.rows.length) {
    step("tickets were created", "warn", "No ticket has been created from email yet.");
  } else {
    step("tickets were created", "ok", `${tickets.rows.length} most recent:`);
    for (const row of tickets.rows) {
      console.log(`       ${row.ticket_ref}  ${row.contact_email || "?"}  ${row.subject}`);
    }
    console.log("\n       These appear in the admin console under Support, marked as arriving");
    console.log("       by email and UNVERIFIED. They are not on the dashboard home page.");
  }

  /* Optional: prove the mailbox itself answers. -------------------------- */
  if (CONNECT) {
    console.log("\n--- opening the mailbox (reads nothing) ---");
    const mailbox = require("../src/services/inbound-mailbox-service");
    const result = await mailbox.testMailboxConnection();
    if (result.ok) {
      step("the mail server answers", "ok",
        `${result.messages} message(s) in ${result.mailbox}, ${result.waiting} unread`);
      if (result.waiting === 0) {
        console.log("       Nothing is unread. If you expected your test message here, either it");
        console.log("       was already collected, or it never reached this mailbox at all - check");
        console.log("       that support@titopay.co.za delivers to a real mailbox rather than");
        console.log("       forwarding elsewhere.");
      }
    } else {
      step("the mail server answers", "stop", result.error,
        "This is the mail server's own wording.");
    }
  } else {
    console.log("\n  Re-run with --connect to also open the mailbox and count what is waiting.");
  }

  finish();
})().catch((error) => {
  console.error("\nThe diagnosis itself failed:", error.message);
  finish(1);
});

function finish(code) {
  const blocker = results.find((row) => row.state === "stop");
  console.log("\n" + "-".repeat(70));
  if (blocker) {
    console.log(`BLOCKED AT: ${blocker.name}`);
    console.log(`DO THIS:    ${blocker.fix}`);
  } else {
    console.log("No blocker found in the chain.");
  }
  console.log("-".repeat(70) + "\n");
  pool.end().catch(() => {});
  process.exit(code || (blocker ? 1 : 0));
}
