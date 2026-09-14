"use strict";

// PER-TICKET SUPPORT REPLY ADDRESSES.
//
// Today support@titopay.co.za is the Reply-To on every TitoPay email and
// nothing reads that mailbox, so a customer pressing Reply on a Customer Care
// answer is writing into a void. Step one of fixing that is making a reply
// ROUTABLE: put the ticket number in the address, signed, so the ingest layer
// can tell which thread an inbound message belongs to.
//
// What these tests hold:
//
//   it round-trips            an address built for a ticket parses back to it
//   it survives real mail     case folding and display-name wrappers are what
//                             mail clients actually do to addresses
//   a forged tag is refused   the reference space is a million wide, and a
//                             support thread carries personal details, so
//                             guessing a number must not reach one
//   it fails soft, never hard a support email must go out even when no reply
//                             address can be built
//   it is off by default      the shipped configuration must not change a
//                             single outbound email until an operator turns
//                             it on deliberately
process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "support-verp-access-secret-with-len!!";
process.env.JWT_REFRESH_SECRET ||= "support-verp-refresh-secret-with-len";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  supportReplyAddress,
  parseSupportReplyAddress,
  findTicketRefInRecipients,
  signTicketRef
} = require("../src/lib/support-verp");

const SECRET = "a-support-reply-secret-for-tests-only";
const BASE = "support@titopay.co.za";

/* ------------------------------------------------------- the round trip */

test("an address built for a ticket parses back to that ticket", () => {
  const address = supportReplyAddress("TP123456", BASE, SECRET);
  assert.match(address, /^support\+TP123456\.[0-9a-f]{8}@titopay\.co\.za$/);
  assert.deepEqual(parseSupportReplyAddress(address, SECRET, BASE), { ticketRef: "TP123456" });
});

test("the same ticket always gets the same address, so a thread stays one thread", () => {
  assert.equal(
    supportReplyAddress("TP123456", BASE, SECRET),
    supportReplyAddress("TP123456", BASE, SECRET)
  );
});

test("different tickets get different signatures", () => {
  assert.notEqual(signTicketRef("TP123456", SECRET), signTicketRef("TP123457", SECRET));
});

test("a lower-cased address still parses, because mail servers fold case", () => {
  const address = supportReplyAddress("TP654321", BASE, SECRET);
  assert.deepEqual(parseSupportReplyAddress(address.toLowerCase(), SECRET, BASE), { ticketRef: "TP654321" });
});

/* ------------------------------------------------ a guess must not land */

test("A FORGED SIGNATURE IS REFUSED", () => {
  // The whole reason the reference is signed. TP000001..TP999999 is a small
  // space and a support thread can carry a customer's personal details, so an
  // address somebody made up must not reach one.
  assert.equal(parseSupportReplyAddress("support+TP123456.deadbeef@titopay.co.za", SECRET, BASE), null);
  assert.equal(parseSupportReplyAddress("support+TP123456.0@titopay.co.za", SECRET, BASE), null);
  assert.equal(parseSupportReplyAddress("support+TP123456.@titopay.co.za", SECRET, BASE), null);
  assert.equal(parseSupportReplyAddress("support+TP123456@titopay.co.za", SECRET, BASE), null);
});

test("a signature from a different secret is refused", () => {
  const address = supportReplyAddress("TP123456", BASE, SECRET);
  assert.equal(parseSupportReplyAddress(address, "a-different-secret-entirely", BASE), null);
});

test("a signature lifted from another ticket is refused", () => {
  const other = supportReplyAddress("TP999999", BASE, SECRET);
  const stolenTag = other.split(".")[1].split("@")[0];
  assert.equal(parseSupportReplyAddress(`support+TP123456.${stolenTag}@titopay.co.za`, SECRET, BASE), null);
});

test("the plain support address carries no ticket, so it is NOT attached to one", () => {
  // This is what makes a genuinely new email become a new request rather than
  // being silently appended to whatever ticket the parser fell back on.
  assert.equal(parseSupportReplyAddress(BASE, SECRET, BASE), null);
  assert.equal(parseSupportReplyAddress("support+@titopay.co.za", SECRET, BASE), null);
  assert.equal(parseSupportReplyAddress("", SECRET, BASE), null);
  assert.equal(parseSupportReplyAddress(null, SECRET, BASE), null);
});

test("a malformed reference is refused even when correctly signed for itself", () => {
  for (const bad of ["TP12345", "TP1234567", "T123456", "tp123456!", "../../etc"]) {
    assert.equal(supportReplyAddress(bad, BASE, SECRET), null, `${bad} must not build an address`);
  }
});

/* ------------------------------- the address has to be OURS, not merely
                                    well-formed and correctly signed        */

test("A LOOKALIKE DOMAIN IS REFUSED", () => {
  // FOUND BY ATTACKING THE PARSER, NOT BY READING IT.
  //
  // The first version checked the tag and never checked the domain, so
  // support+TP123456.<valid tag>@titopay.co.za.evil.com routed straight to
  // ticket TP123456. The HMAC was never broken - the address simply did not
  // have to be ours.
  //
  // It matters because the caller scans To, Cc AND Delivered-To, and all three
  // are written by whoever sent the message. Anyone who had ever received one
  // legitimate reply address could put a lookalike in Cc on mail sent anywhere
  // and have it filed into that customer's support thread.
  const tag = signTicketRef("TP123456", SECRET);
  for (const forged of [
    `support+TP123456.${tag}@titopay.co.za.evil.com`,
    `support+TP123456.${tag}@titopay-co-za.com`,
    `support+TP123456.${tag}@evil.com`,
    `support+TP123456.${tag}@evil.com@titopay.co.za`
  ]) {
    assert.equal(parseSupportReplyAddress(forged, SECRET, BASE), null, `${forged} must not route`);
  }
});

test("a different mailbox on the right domain is refused", () => {
  // billing+TP123456.tag@titopay.co.za is not the support desk. Accepting it
  // would let any forwarding rule anywhere on the domain inject into a thread.
  const tag = signTicketRef("TP123456", SECRET);
  assert.equal(parseSupportReplyAddress(`billing+TP123456.${tag}@titopay.co.za`, SECRET, BASE), null);
});

test("with no configured support address, nothing routes", () => {
  // An address that cannot be checked against anything must not be trusted.
  const address = supportReplyAddress("TP123456", BASE, SECRET);
  assert.equal(parseSupportReplyAddress(address, SECRET, ""), null);
  assert.equal(parseSupportReplyAddress(address, SECRET, undefined), null);
});

test("a real mail header parses: display name, angle brackets, folded case", () => {
  // Headers do not contain bare addresses. This worked by accident before;
  // now it is deliberate, and pinned.
  const tag = signTicketRef("TP123456", SECRET);
  for (const header of [
    `"TitoPay Care" <support+TP123456.${tag}@titopay.co.za>`,
    `<support+TP123456.${tag}@titopay.co.za>`,
    `support+TP123456.${tag}@TITOPAY.CO.ZA`,
    `  support+TP123456.${tag}@titopay.co.za  `
  ]) {
    assert.deepEqual(parseSupportReplyAddress(header, SECRET, BASE), { ticketRef: "TP123456" },
      `${header} should parse`);
  }
});

test("header injection and control characters are refused", () => {
  // A CR or LF inside an address is where header injection starts.
  const tag = signTicketRef("TP123456", SECRET);
  for (const nasty of [
    `support+TP123456.${tag}@titopay.co.za\r\nBcc: evil@example.com`,
    `support+TP123456.${tag}@titopay.co.za\nBcc: evil@example.com`,
    `support+TP123456.${tag} @titopay.co.za`,
    `support+TP123456.${tag}\t@titopay.co.za`
  ]) {
    assert.equal(parseSupportReplyAddress(nasty, SECRET, BASE), null);
  }
});

test("an absurdly long address is refused rather than processed", () => {
  const tag = signTicketRef("TP123456", SECRET);
  const huge = `support+${"A".repeat(200000)}.${tag}@titopay.co.za`;
  const started = process.hrtime.bigint();
  assert.equal(parseSupportReplyAddress(huge, SECRET, BASE), null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `refusing an oversized address took ${ms.toFixed(1)}ms`);
});

test("a message carrying thousands of recipients is bounded", () => {
  // An inbound message's Cc list is attacker-controlled and can be enormous.
  const flood = Array.from({ length: 20000 }, (_, i) => `filler${i}@example.com`);
  const started = process.hrtime.bigint();
  assert.equal(findTicketRefInRecipients(flood, SECRET, BASE), null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `scanning a flooded recipient list took ${ms.toFixed(1)}ms`);
});

/* ------------------------------------ it must never break a support email */

test("it returns nothing rather than throwing when it cannot build an address", () => {
  // A support reply that fails to send is a worse outcome than one a customer
  // cannot thread, so every unusable input degrades to the plain address.
  assert.equal(supportReplyAddress("TP123456", BASE, ""), null, "no secret");
  assert.equal(supportReplyAddress("TP123456", "not-an-address", SECRET), null);
  assert.equal(supportReplyAddress("TP123456", "", SECRET), null);
  assert.equal(supportReplyAddress(null, BASE, SECRET), null);
});

test("a base address that already carries a tag does not stack a second one", () => {
  // support+desk@... would otherwise become support+desk+TP123456.tag@...,
  // which routes somewhere nobody intended.
  const address = supportReplyAddress("TP123456", "support+desk@titopay.co.za", SECRET);
  assert.equal(address, `support+TP123456.${signTicketRef("TP123456", SECRET)}@titopay.co.za`);
  assert.deepEqual(parseSupportReplyAddress(address, SECRET, BASE), { ticketRef: "TP123456" });
});

/* ------------------------------------------------- what ingest will read */

test("the ticket is found across To, Cc and Delivered-To", () => {
  // A forwarded thread often keeps the tagged address in Cc rather than To,
  // which is exactly the case subject-line matching gets wrong.
  const address = supportReplyAddress("TP246810", BASE, SECRET);
  assert.deepEqual(
    findTicketRefInRecipients(["someone@example.com", address, "cc@example.com"], SECRET, BASE),
    { ticketRef: "TP246810" }
  );
  assert.equal(findTicketRefInRecipients(["someone@example.com"], SECRET, BASE), null);
  assert.equal(findTicketRefInRecipients([], SECRET, BASE), null);
  assert.equal(findTicketRefInRecipients(null, SECRET, BASE), null);
});

/* --------------------------------------------- the shipped configuration */

test("PER-TICKET REPLY ADDRESSING IS OFF IN THE SHIPPED CONFIGURATION", () => {
  // It changes the Reply-To on real customer email, and whether a mail server
  // accepts plus-addressing is a fact about somebody's hosting that this
  // repository cannot know. Off until an operator confirms it and switches it
  // on, because a bounced reply is worse than an unread one.
  const env = fs.readFileSync(path.join(__dirname, "..", "src", "config", "env.js"), "utf8");
  // Explicitly NOT booleanFromEnv. That helper reads `process.env[name] ??
  // fallback`, and an empty string is not nullish - so a bare
  // SUPPORT_REPLY_ADDRESSING= line in a .env file, which is how people write
  // "fill this in later", would evaluate to true and switch this on. Measured,
  // not assumed: booleanFromEnv("X", false) returns false when X is unset and
  // TRUE when X is "".
  assert.match(env, /supportReplyAddressing: \["true", "1", "yes", "on"\]/);
  assert.ok(!/booleanFromEnv\("SUPPORT_REPLY_ADDRESSING"/.test(env),
    "this flag must not read through booleanFromEnv");
});

test("an empty or junk value leaves it off; only a real yes turns it on", () => {
  const decide = (raw) => ["true", "1", "yes", "on"]
    .includes(String(raw || "").trim().toLowerCase());
  for (const off of [undefined, "", "   ", "false", "0", "no", "off", "maybe", "TRUE-ish"]) {
    assert.equal(decide(off), false, `${JSON.stringify(off)} must leave it off`);
  }
  for (const on of ["true", "TRUE", " yes ", "1", "on"]) {
    assert.equal(decide(on), true, `${JSON.stringify(on)} must turn it on`);
  }
});

test("the support reply email records which ticket it belongs to", () => {
  // The other half of threading: email_queue already stores the provider's
  // message id, and an inbound reply quotes that id in In-Reply-To. Recording
  // the reference against the same row is what will let the two be matched.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "support-ticket-reply-service.js"), "utf8");
  assert.match(source, /ticketRef: ticket\.ticket_ref/);
  // And the reply address is only attached when one was built, so the default
  // path sends exactly the email it always did.
  assert.match(source, /\.\.\.\(supportReplyTo \? \{ replyTo: supportReplyTo \} : \{\}\)/);
});

test("the send path already honours a per-email reply address", () => {
  // Nothing in the delivery code needed changing: email-centre-service has
  // taken job.metadata.replyTo since the HR desk needed its own address. This
  // pins that, because if it were removed the support address would silently
  // stop being applied and every reply would go back to the global mailbox.
  const centre = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "email-centre-service.js"), "utf8");
  assert.match(centre, /job\.metadata\.replyTo/);
  assert.match(centre, /provider\.replyTo = jobReplyTo/);
});
