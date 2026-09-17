"use strict";

// A SUPPORT REPLY ADDRESS THAT CARRIES ITS OWN TICKET NUMBER.
//
// Today every TitoPay email goes out with Reply-To: support@titopay.co.za and
// nothing in the platform reads that mailbox. So when a customer presses Reply
// on a Customer Care answer, the reply lands somewhere no screen in the Admin
// Portal can see. Their ticket sits there looking answered.
//
// Putting the ticket number in the ADDRESS rather than the subject is what
// makes an inbound reply routable:
//
//     support+TP123456.9f2c1ab4@titopay.co.za
//             ^^^^^^^^ ^^^^^^^^
//             ticket   signature
//
// It survives everything a subject line does not. People edit subjects, strip
// "Re:", forward a thread to a colleague, or use a client that mangles
// headers - the envelope address is what the mail server routed on, so it is
// still there. This is the standard VERP trick, and the reason it is worth the
// small complexity is that subject-scanning fails precisely when a customer is
// most frustrated: on the long forwarded thread.
//
// WHY IT IS SIGNED, AND WHAT THE SIGNATURE IS NOT.
//
// The tag is an HMAC of the ticket reference under a server secret. That stops
// somebody guessing TP000001..TP999999 and posting messages into strangers'
// support threads - the reference space is only a million wide and a support
// thread can contain a customer's personal details.
//
// It is NOT proof of who sent the mail. A From header is forgeable and this
// changes nothing about that: anyone who can read one of our emails can reuse
// its reply address. So a message arriving on a valid address is routed to the
// right ticket and is still UNVERIFIED - it may be read and answered, and it
// must never on its own authorise anything on an account. That rule belongs to
// the ingest layer; this module only decides which ticket a mail belongs to.

const crypto = require("crypto");

// Long enough that guessing one is hopeless, short enough that the address
// stays readable to a human debugging a mail log. 8 hex characters is 32 bits:
// a forger who can make a million attempts still expects to fail.
const TAG_LENGTH = 8;
const TICKET_REF_PATTERN = /^[A-Z]{2}[0-9]{6}$/;

function normalizeTicketRef(ticketRef) {
  return String(ticketRef || "").trim().toUpperCase();
}

function signTicketRef(ticketRef, secret) {
  if (!secret) throw new Error("A support reply secret is required");
  return crypto.createHmac("sha256", String(secret))
    .update(`support-reply:${normalizeTicketRef(ticketRef)}`)
    .digest("hex")
    .slice(0, TAG_LENGTH);
}

// Splits "support@titopay.co.za" into its parts so the tag can be inserted
// without assuming a domain anywhere else in the codebase.
function splitAddress(baseAddress) {
  const value = String(baseAddress || "").trim();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  // A base address that ALREADY carries a plus tag would otherwise produce
  // support+old+TP123456.tag@..., which routes to the wrong place. The
  // existing tag is dropped rather than stacked.
  const local = value.slice(0, at).split("+")[0];
  const domain = value.slice(at + 1);
  if (!local || !domain.includes(".")) return null;
  return { local, domain };
}

// The address to put in Reply-To on an email about this ticket.
// Returns null rather than throwing when it cannot build one, so a caller can
// fall back to the plain support address and still send the mail. A reply
// address is an improvement to a support email, never a reason not to send it.
function supportReplyAddress(ticketRef, baseAddress, secret) {
  const ref = normalizeTicketRef(ticketRef);
  if (!TICKET_REF_PATTERN.test(ref)) return null;
  const parts = splitAddress(baseAddress);
  if (!parts || !secret) return null;
  return `${parts.local}+${ref}.${signTicketRef(ref, secret)}@${parts.domain}`;
}

// Mail headers do not contain bare addresses. They contain things like
//   "TitoPay Care" <support+TP123456.9f2c1ab4@titopay.co.za>
// so the address is lifted out of the angle brackets DELIBERATELY rather than
// by luck. Anything carrying a control character, whitespace inside the
// address, or an absurd length is refused outright: a header line is
// attacker-controlled, and a CR or LF inside one is how header injection
// starts.
const MAX_ADDRESS_LENGTH = 320; // RFC 5321: 64-octet local part + 255 domain.

function extractAddress(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > MAX_ADDRESS_LENGTH) return "";
  const opened = value.lastIndexOf("<");
  const closed = value.lastIndexOf(">");
  const inner = opened >= 0 && closed > opened ? value.slice(opened + 1, closed).trim() : value;
  // No spaces, no tabs, no CR/LF, no control characters, exactly one @.
  if (!inner || /[\s\u0000-\u001F\u007F]/.test(inner)) return "";
  if (inner.split("@").length !== 2) return "";
  return inner;
}

// The inverse, for the ingest layer: which ticket is this address about?
//
// THE DOMAIN IS CHECKED, AND THE FIRST VERSION OF THIS DID NOT CHECK IT.
//
// Without that check, support+TP123456.<valid tag>@titopay.co.za.evil.com
// parsed happily and routed to ticket TP123456. That matters because the
// caller scans To, Cc AND Delivered-To, and every one of those is written by
// whoever sent the mail. So anybody who had ever received one legitimate reply
// address could drop a lookalike into Cc on a message sent anywhere and have
// it filed into that customer's support thread. The HMAC was never broken -
// the address simply did not have to be ours.
//
// Returns null for anything that does not carry a well-formed, correctly
// signed reference on the RIGHT DOMAIN - including plain
// support@titopay.co.za, which is how mail that is NOT a reply to one of our
// emails falls through to being treated as a new request rather than being
// silently attached to ticket "SUPPORT".
function parseSupportReplyAddress(address, secret, baseAddress) {
  if (!secret) return null;
  const expectedDomain = splitAddress(baseAddress);
  // No configured support address means nothing can be verified as ours, and
  // an unverifiable address must not route.
  if (!expectedDomain) return null;
  const clean = extractAddress(address);
  if (!clean) return null;
  const at = clean.lastIndexOf("@");
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  if (domain.toLowerCase() !== expectedDomain.domain.toLowerCase()) return null;
  const plus = local.indexOf("+");
  if (plus < 0) return null;
  // The mailbox before the tag has to be ours too: nobody+TP123456.tag@ours
  // is a different mailbox, and treating it as the support desk would let a
  // forwarding rule anywhere on the domain inject into a thread.
  if (local.slice(0, plus).toLowerCase() !== expectedDomain.local.toLowerCase()) return null;
  const tagged = local.slice(plus + 1);
  const dot = tagged.lastIndexOf(".");
  if (dot <= 0) return null;
  const ref = normalizeTicketRef(tagged.slice(0, dot));
  const presented = tagged.slice(dot + 1).toLowerCase();
  if (!TICKET_REF_PATTERN.test(ref)) return null;
  const expected = signTicketRef(ref, secret);
  // Constant time, so the comparison cannot be used to recover a valid tag one
  // character at a time. The lengths are checked first because timingSafeEqual
  // throws on a mismatch, and that throw would itself be the leak.
  if (presented.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) return null;
  return { ticketRef: ref };
}

// Every address an inbound message might have been delivered to - To, Cc and
// Delivered-To all matter, because a forwarded thread often keeps the original
// recipient in Cc rather than To.
//
// All three are attacker-controlled, which is exactly why the domain check
// above exists. Capped, so a message carrying ten thousand Cc addresses costs
// ten thousand cheap string checks and not an open-ended loop.
const MAX_RECIPIENTS_SCANNED = 100;

function findTicketRefInRecipients(addresses, secret, baseAddress) {
  const list = [].concat(addresses || []).slice(0, MAX_RECIPIENTS_SCANNED);
  for (const address of list) {
    const match = parseSupportReplyAddress(address, secret, baseAddress);
    if (match) return match;
  }
  return null;
}

module.exports = {
  supportReplyAddress,
  parseSupportReplyAddress,
  findTicketRefInRecipients,
  signTicketRef,
  TAG_LENGTH
};
