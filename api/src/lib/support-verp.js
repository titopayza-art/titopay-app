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

// The inverse, for the ingest layer: which ticket is this address about?
//
// Returns null for anything that does not carry a well-formed, correctly
// signed reference - including plain support@titopay.co.za, which is how mail
// that is NOT a reply to one of our emails falls through to being treated as a
// new request rather than being silently attached to ticket "SUPPORT".
function parseSupportReplyAddress(address, secret) {
  const parts = splitAddress(String(address || "").trim().toLowerCase());
  if (!parts || !secret) return null;
  const value = String(address).trim();
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const local = value.slice(0, at);
  const plus = local.indexOf("+");
  if (plus < 0) return null;
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
function findTicketRefInRecipients(addresses, secret) {
  for (const address of [].concat(addresses || [])) {
    const match = parseSupportReplyAddress(address, secret);
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
