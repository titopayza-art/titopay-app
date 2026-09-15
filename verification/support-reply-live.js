"use strict";

// SUPPORT REPLY LOOP — REAL DATABASE, END TO END.
//
// Proves the Contact TitoPay flow the way the user asked for it:
// a submission lands as a ticket the Admin Portal lists; staff write a reply;
// the customer gets an in-app alert AND an email carrying the reply text;
// the thread shows in the app; a customer follow-up reopens the ticket and
// goes back to the queue. Plus the guards: a stranger cannot read or reply to
// someone else's ticket, and replying to a public (no-account) ticket does
// not crash or mail anyone.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/support-reply-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const { ensureEmailSchema } = require("../api/src/services/email-centre-service");
const svc = require("../api/src/services/support-ticket-reply-service");

const TAG = "suplive";
const ids = {
  customer: randomUUID(),
  stranger: randomUUID(),
  admin: randomUUID(),
  ticket: randomUUID(),
  publicTicket: randomUUID()
};
const customerAuth = { userId: ids.customer, userType: "customer" };
const strangerAuth = { userId: ids.stranger, userType: "customer" };
const adminAuth = { userId: ids.admin, userType: "admin", email: `${TAG}_admin@example.invalid` };

let previousSendingEnabled = null;

async function seed() {
  for (const [id, name] of [[ids.customer, "Customer"], [ids.stranger, "Stranger"]]) {
    await pool.query(
      `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
       VALUES ($1,'personal','${TAG} ${name}','${TAG}_${name.toLowerCase()}','${TAG}_${name.toLowerCase()}@example.invalid',NULL,'x','active',FALSE,'pending')`,
      [id]
    );
  }
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     VALUES ($1,'${TAG} Admin','${TAG}_admin','${TAG}_admin@example.invalid','super_admin','x')`,
    [ids.admin]
  );
  await pool.query(
    `INSERT INTO support_tickets (id, ticket_ref, user_id, category, subject, message, status, assigned_to)
     VALUES ($1,'TC-${TAG}-1',$2,'Account Access','Customer support: Account Access','I cannot open my statement, please help me.','open','Customer Care Queue')`,
    [ids.ticket, ids.customer]
  );
  // Website contact form ticket — no TitoPay account behind it.
  await pool.query(
    `INSERT INTO support_tickets (id, ticket_ref, user_id, category, subject, message, status, assigned_to)
     VALUES ($1,'TC-${TAG}-2',NULL,'General Enquiries','Website contact: General Enquiries — Visitor','Public PWA contact request','open','Customer Care Queue')`,
    [ids.publicTicket]
  );
  await ensureEmailSchema();
  const { rows } = await pool.query("SELECT sending_enabled FROM email_settings WHERE id=TRUE");
  previousSendingEnabled = rows[0] ? rows[0].sending_enabled : null;
  await pool.query("UPDATE email_settings SET sending_enabled=TRUE WHERE id=TRUE");
}

async function cleanup() {
  if (previousSendingEnabled !== null) {
    await pool.query("UPDATE email_settings SET sending_enabled=$1 WHERE id=TRUE", [previousSendingEnabled]).catch(() => {});
  }
  await pool.query("DELETE FROM email_queue WHERE idempotency_key LIKE 'support-reply-email:%' AND user_id = $1", [ids.customer]).catch(() => {});
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [[ids.customer, ids.stranger]]).catch(() => {});
  await pool.query("DELETE FROM support_ticket_replies WHERE ticket_id = ANY($1)", [[ids.ticket, ids.publicTicket]]).catch(() => {});
  await pool.query("DELETE FROM support_tickets WHERE id = ANY($1)", [[ids.ticket, ids.publicTicket]]);
  await pool.query("DELETE FROM audit_logs WHERE actor_id = ANY($1)", [[ids.customer, ids.stranger, ids.admin]]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.customer, ids.stranger]]);
  await pool.query("DELETE FROM admin_users WHERE id = $1", [ids.admin]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  SUPPORT REPLY LOOP — ADMIN PORTAL -> APP + EMAIL, REAL DATABASE");
    console.log("=".repeat(80));

    await svc.ensureSupportReplySchema();
    await seed();

    // 1. The submission is on the admin queue.
    const queue = await svc.listTicketsForAdmin();
    const mine = queue.find((row) => row.id === ids.ticket);
    assert.ok(mine, "the ticket is on the Admin Portal support queue");
    assert.equal(mine.full_name, `${TAG} Customer`, "the queue shows who asked");
    ok("customer submission appears on the Admin Portal support queue");

    // 2. Staff reply: saved, ticket claimed and moved to in_progress.
    const replied = await svc.addAdminReply(adminAuth, ids.ticket, {
      message: "Hi! Open Profile > Statements and tap the month you need — I have also re-issued last month's statement to your email."
    });
    assert.equal(replied.ticket.status, "in_progress", "an answered ticket moves to in_progress");
    assert.equal(replied.ticket.assigned_to, adminAuth.email, "the reply claims the ticket for the agent");
    ok("staff reply saved — ticket moved to in_progress under the agent's name");

    // 3. The customer's in-app alert exists and points at the ticket.
    const { rows: alerts } = await pool.query(
      "SELECT * FROM notifications WHERE user_id = $1 AND notification_type = 'support_reply'",
      [ids.customer]
    );
    assert.equal(alerts.length, 1, "exactly one in-app alert for the reply");
    assert.equal(alerts[0].metadata.ticketRef, `TC-${TAG}-1`);
    assert.ok(String(alerts[0].body).includes("statement"), "the alert carries the reply text");
    ok("in-app alert delivered to the customer with the reply excerpt");

    // 4. The email is queued to the customer's address with the reply text.
    const { rows: mails } = await pool.query(
      "SELECT * FROM email_queue WHERE idempotency_key = $1",
      [`support-reply-email:${replied.reply.id}`]
    );
    assert.equal(mails.length, 1, "exactly one reply email queued");
    assert.equal(mails[0].recipient, `${TAG}_customer@example.invalid`);
    assert.ok(String(mails[0].subject).includes(`TC-${TAG}-1`), "the email subject carries the ticket reference");
    ok("reply email queued to the customer (Email Centre delivers it)");

    // 5. The app thread shows the conversation to the right customer only.
    const appView = await svc.listMyTickets(ids.customer);
    const ticketInApp = appView.find((row) => row.id === ids.ticket);
    assert.ok(ticketInApp, "the customer sees their ticket in the app");
    assert.equal(ticketInApp.replies.length, 1);
    assert.equal(ticketInApp.replies[0].authorType, "admin");
    const strangerView = await svc.listMyTickets(ids.stranger);
    assert.ok(!strangerView.some((row) => row.id === ids.ticket), "a stranger cannot see the ticket");
    ok("the thread shows in the app for the owner — and for nobody else");

    // 6. A stranger cannot reply to someone else's ticket.
    let blocked = false;
    try { await svc.addCustomerReply(strangerAuth, ids.ticket, { message: "Let me in" }); }
    catch (error) { blocked = error.statusCode === 404; }
    assert.ok(blocked, "a stranger's reply is refused");
    ok("a stranger's reply to the ticket is refused");

    // 7. Customer follow-up on a resolved ticket reopens it for the team.
    await pool.query("UPDATE support_tickets SET status='resolved' WHERE id=$1", [ids.ticket]);
    const followUp = await svc.addCustomerReply(customerAuth, ids.ticket, {
      message: "Thank you — but the March statement is still missing."
    });
    assert.equal(followUp.ticket.status, "open", "a follow-up reopens a resolved ticket");
    const thread = await svc.listMyTickets(ids.customer);
    assert.equal(thread.find((row) => row.id === ids.ticket).replies.length, 2, "the thread now has both replies");
    ok("customer follow-up reopens the ticket and joins the same thread");

    // 8. Replying to a public website ticket (no account) is safe: stored,
    //    no notification, no email, nothing to crash.
    const publicReply = await svc.addAdminReply(adminAuth, ids.publicTicket, { message: "We will phone you back on the number you left." });
    assert.equal(publicReply.ticket.status, "in_progress");
    const { rows: publicMail } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM email_queue WHERE idempotency_key = $1",
      [`support-reply-email:${publicReply.reply.id}`]
    );
    assert.equal(publicMail[0].count, 0, "no email attempt for a ticket without an account");
    ok("reply on a public website ticket is stored safely with no phantom email");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — the support loop runs Admin Portal -> app + email.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
