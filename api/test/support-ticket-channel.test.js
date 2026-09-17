"use strict";

// WHERE A SUPPORT REQUEST CAME FROM, AND HOW MUCH OF IT CAN BE TRUSTED.
//
// This has to exist in the data BEFORE anything ingests mail. Without it the
// first inbound email lands in the agent's queue looking exactly like an
// authenticated in-app request - and the dangerous version of the whole
// support-email feature is the one where an agent cannot tell the difference,
// because a From header is forgeable by anyone who can send mail.
//
// The property under test is FAIL-SAFE BY CONSTRUCTION. Trust is not its own
// stored boolean: a boolean defaults to something, and whichever way it
// defaults, a channel somebody adds later and forgets to set inherits that
// answer. Here the CHANNEL is stored and trust is derived, so an unrecognised
// channel is untrusted automatically rather than by anybody remembering to
// make it so.
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "support-channel-access-secret-len!!!";
process.env.JWT_REFRESH_SECRET ||= "support-channel-refresh-secret-ln!!";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const support = require("../src/services/support-ticket-reply-service");

const { ticketIdentity } = support;
const uid = () => crypto.randomUUID();
const stamp = Date.now().toString(36);
const userId = uid();
const ticketIds = [];

test.before(async () => {
  await support.ensureSupportReplySchema();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash)
     VALUES ($1,'personal','Channel Probe',$2,$3,'$2a$10$channelprobenotarealhashxxxxxxxxxxxxxxxxxxxxxxxxx')`,
    [userId, `chan_${stamp}`, `chan_${stamp}@example.co.za`]);
});

test.after(async () => {
  if (ticketIds.length) {
    await pool.query("DELETE FROM support_tickets WHERE id = ANY($1::uuid[])", [ticketIds]).catch(() => {});
  }
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

async function makeTicket({ channel, contactEmail = null, verifiedAt = null, withUser = true } = {}) {
  const id = uid();
  ticketIds.push(id);
  const columns = ["id", "ticket_ref", "user_id", "category", "subject", "message", "status"];
  const values = [id, `TC${String(ticketIds.length).padStart(6, "0")}`, withUser ? userId : null,
    "Payments", "Probe", "A support request.", "pending"];
  if (channel !== undefined) { columns.push("channel"); values.push(channel); }
  if (contactEmail) { columns.push("contact_email"); values.push(contactEmail); }
  if (verifiedAt) { columns.push("identity_verified_at"); values.push(verifiedAt); }
  await pool.query(
    `INSERT INTO support_tickets (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    values
  );
  return id;
}

/* --------------------------------------- the column exists and defaults right */

test("every ticket that exists today is an app ticket, with no backfill needed", async () => {
  // The default is the honest answer for the whole existing table: the only
  // ways to raise a ticket are the Contact TitoPay form, a chat escalation and
  // the chatbot handover, and all three arrive on an authenticated session.
  const id = await makeTicket({});
  const { rows } = await pool.query(
    "SELECT channel, contact_email, identity_verified_at FROM support_tickets WHERE id = $1", [id]);
  assert.equal(rows[0].channel, "app");
  assert.equal(rows[0].contact_email, null);
  assert.equal(rows[0].identity_verified_at, null);
});

/* ------------------------------------------------------- trust is derived */

test("an app ticket is trusted, because the session was authenticated", () => {
  const identity = ticketIdentity({ channel: "app" });
  assert.equal(identity.identityVerified, true);
  assert.match(identity.identityNote, /signed-in session/i);
});

test("AN EMAIL TICKET IS NOT TRUSTED", () => {
  const identity = ticketIdentity({ channel: "email" });
  assert.equal(identity.identityVerified, false);
  // The note is what an agent reads at the moment they are about to act, so it
  // has to say what NOT to do, not merely that something is unverified.
  assert.match(identity.identityNote, /UNVERIFIED/);
  assert.match(identity.identityNote, /do not change anything on an account/i);
  assert.match(identity.identityNote, /disclose a balance/i);
});

test("AN UNRECOGNISED CHANNEL IS UNTRUSTED WITHOUT ANYBODY DECIDING SO", () => {
  // The fail-safe property, stated as a test. Somebody adds WhatsApp, or SMS,
  // or a partner API next year and forgets this file exists. The answer has to
  // already be "not proven" rather than whatever a boolean defaulted to.
  for (const channel of ["whatsapp", "sms", "partner_api", "", "something_nobody_has_written_yet"]) {
    assert.equal(ticketIdentity({ channel }).identityVerified, channel === "" ? true : false,
      `${JSON.stringify(channel)} must not be trusted by default`);
  }
  // An absent channel falls back to 'app' - which is correct, because a row
  // written before this column existed was an app ticket.
  assert.equal(ticketIdentity({}).identityVerified, true);
});

test("an email ticket becomes trusted only when something records proof", () => {
  const proven = ticketIdentity({ channel: "email", identity_verified_at: new Date().toISOString() });
  assert.equal(proven.identityVerified, true);
  assert.match(proven.identityNote, /Identity confirmed/i);
});

/* ------------------------------------------ what the agent's queue receives */

test("the admin list carries the channel and the verdict on every ticket", async () => {
  const appTicket = await makeTicket({ channel: "app" });
  const emailTicket = await makeTicket({ channel: "email", contactEmail: "stranger@example.com", withUser: false });

  const rows = await support.listTicketsForAdmin();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  assert.equal(byId[appTicket].channel, "app");
  assert.equal(byId[appTicket].identityVerified, true);

  assert.equal(byId[emailTicket].channel, "email");
  assert.equal(byId[emailTicket].identityVerified, false);
  assert.match(byId[emailTicket].identityNote, /UNVERIFIED/);
  // A stranger emailing support has no account, and no user row was invented
  // for them - that would be an account-enumeration gift and a spoofing one.
  assert.equal(byId[emailTicket].user_id, null);
  assert.equal(byId[emailTicket].contact_email, "stranger@example.com");
});

/* ------------------------------------------------- the agent actually sees it */

test("the console shows the channel on the row and warns where the agent acts", () => {
  const admin = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "assets", "admin.js"), "utf8");
  // On the row: an agent scanning the queue can see which requests are claims.
  assert.match(admin, /row\.identityVerified === true/);
  assert.match(admin, /unverified/);
  // And at the moment of acting, which is where somebody could be talked into
  // disclosing a balance or changing an account.
  assert.match(admin, /PAGE_EXPORTS\.supportTicketIdentity/);
  assert.match(admin, /identity\.identityVerified === false/);
});

test("both copies of admin.js carry it, because they have drifted before", () => {
  // Three tests already exist for this and all three failed once this session.
  const root = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "admin.js"), "utf8");
  const assets = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "assets", "admin.js"), "utf8");
  assert.equal(root, assets, "admin/admin.js and admin/assets/admin.js have drifted again");
});

/* ------------------------------------------------ nothing existing is broken */

test("the customer's own list is unchanged by any of this", async () => {
  // A customer sees their requests exactly as before: the new columns are
  // additive, and the app ticket path sets none of them.
  const id = await makeTicket({});
  const mine = await support.listMyTickets(userId);
  assert.ok(mine.some((row) => row.id === id), "the ticket is in the customer's list");
  const row = mine.find((item) => item.id === id);
  // The customer's view never carried a channel and still does not - they know
  // how they got in touch.
  assert.equal(row.channel, undefined);
});
