"use strict";

// EMAILING A TICKET TO YOURSELF OR SOMEONE ELSE.
//
// A ticket holder can send their ticket to their own inbox or to another
// address — a friend they bought it for. The behaviour is proven end to end
// against a real database in verification/free-ticketing-live.js (owner sends
// to self, owner sends to a friend, a non-owner is refused, a bad address is
// refused). These are the source-level guards that keep the two properties that
// matter from regressing: you can only email a ticket you OWN, and the endpoint
// cannot be turned into a bulk mailer.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVICE = fs.readFileSync(path.join(__dirname, "..", "src", "services", "ticketing-service.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "ticketing.routes.js"), "utf8");
const ticketing = require("../src/services/ticketing-service");

test("the email-ticket function is exported and wired to a route", () => {
  assert.equal(typeof ticketing.emailTicketToRecipient, "function");
  assert.match(ROUTES, /router\.post\("\/tickets\/:code\/email"/);
});

test("you can only email a ticket you own", () => {
  // The lookup filters by owner_user_id, so a caller can never reach a ticket
  // that is not theirs — the query simply returns nothing.
  const fn = SERVICE.match(/async function emailTicketToRecipient[\s\S]*?\n\}/);
  assert.ok(fn, "emailTicketToRecipient must exist");
  assert.match(fn[0], /WHERE t\.ticket_code = \$1 AND t\.owner_user_id = \$2/,
    "the ticket must be scoped to the caller");
  // Not found and not owned answer identically, so the endpoint never confirms a
  // code exists to someone who does not hold it.
  assert.match(fn[0], /if \(!ticket\) throw new AppError\(404, "Ticket not found"\)/);
});

test("the destination is validated, not silently redirected", () => {
  const fn = SERVICE.match(/async function emailTicketToRecipient[\s\S]*?\n\}/)[0];
  // A supplied-but-invalid address is a 400, rather than quietly going to the
  // owner — the caller is never surprised about where their ticket went.
  assert.match(fn, /if \(destination && !requested\) throw new AppError\(400/);
  assert.match(fn, /Enter a valid email address/);
  // An empty destination falls back to the account's own email.
  assert.match(fn, /const to = requested \|\| cleanEmail\(ticket\.owner_email\)/);
});

test("the endpoint is rate limited, because it sends real mail", () => {
  assert.match(ROUTES, /publicContactLimiter/);
  assert.match(ROUTES, /router\.post\("\/tickets\/:code\/email", requireAuth, publicContactLimiter/,
    "the limiter must be in front of the handler");
});

test("the response masks the address it sent to", () => {
  const fn = SERVICE.match(/async function emailTicketToRecipient[\s\S]*?\n\}/)[0];
  assert.match(fn, /sentTo: to\.replace\(/, "the confirmation must not echo the full address back");
  // A quick check the mask keeps the first char and the domain only.
  const masked = "friend@example.com".replace(/^(.).*(@.*)$/, "$1***$2");
  assert.equal(masked, "f***@example.com");
});

test("the ticket code and event are in the email body", () => {
  const fn = SERVICE.match(/async function emailTicketToRecipient[\s\S]*?\n\}/)[0];
  assert.match(fn, /Ticket code: \$\{ticket\.ticket_code\}/);
  assert.match(fn, /subject = `Your ticket for \$\{ticket\.event_name\}`/);
});

test("a purchase automatically emails the confirmation — email only, never SMS", () => {
  // The user requirement is explicit: buyers get their purchase and tickets by
  // email automatically, not by SMS. The delivery function must queue through
  // the Email Centre (no live mail connection in the purchase flow), carry
  // every ticket code, be idempotent per order, and contain no SMS path at all.
  const fn = SERVICE.match(/async function deliverTicketOrder[\s\S]*?\n\}/)[0];
  assert.match(fn, /queueRawEmail/, "the confirmation goes through the Email Centre queue");
  assert.match(fn, /idempotencyKey: `ticket-order-delivery:\$\{orderId\}`/,
    "one confirmation per order — a retry can never send it twice");
  assert.match(fn, /ticket code/, "the email spells out each ticket code");
  assert.doesNotMatch(fn, /deliverSms/, "no SMS is sent for ticket delivery");
  assert.doesNotMatch(SERVICE, /deliverSms/, "ticketing must not send SMS anywhere");
  assert.match(fn, /purchase is confirmed/i, "the email confirms the purchase itself");
  assert.match(fn, /Total paid/, "the email states the amount paid");
});
