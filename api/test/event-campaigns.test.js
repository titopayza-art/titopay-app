"use strict";

// CAMPAIGN TOOLS: THE PRICE, THE AUDIENCE, AND THE LAW.
//
// Three things about this feature are not free to drift.
//
// The PRICE is a published commercial figure: R1 500 once per event for
// email, R0.60 per SMS sent. A silent change to either is a change to what
// TitoPay charges its customers.
//
// The AUDIENCE is the compliance boundary. An organiser may reach people who
// have bought a ticket from them. There must be no way to hand the service a
// list of strangers, because that is the difference between marketing to your
// own customers, which POPIA section 69 allows with an opt-out, and spam.
//
// The BILLING rule is "per SMS sent", so a failed message must cost nothing.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "campaign-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "campaign-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const campaigns = require("../src/services/event-campaign-service");
const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "event-campaign-service.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

test("the published prices are exactly what was agreed", () => {
  assert.equal(campaigns.EMAIL_PACK_PRICE, 1500, "email is R1 500 for the whole event");
  assert.equal(campaigns.SMS_UNIT_PRICE, 0.6, "SMS is R0.60 each");
});

test("the organiser sees both prices before anything is charged", () => {
  // The quote comes from the same constants the charge uses, so the screen
  // cannot advertise one price and the wallet be debited another.
  // The quote and the charge both read currentPricing(), which reads the
  // Pricing Engine rule and falls back to the constants above. One source.
  assert.match(SOURCE, /emailPackPrice: prices\.emailPackPrice/);
  assert.match(SOURCE, /smsUnitPrice: prices\.smsUnitPrice/);
  assert.match(SOURCE, /smsCost: money\(smsAudience\.length \* prices\.smsUnitPrice\)/);
  assert.match(SOURCE, /async function currentPricing\(\)/);
  assert.match(SOURCE, /'event_campaign_email', 'Event email campaign pack', 'FIXED', 1500, 1500/,
    "the R1 500 default is seeded into pricing_rules so admin can change it without a deploy");
  assert.match(SOURCE, /'event_campaign_sms', 'Event SMS campaign, per message', 'FIXED', 0\.6, 0\.6/);
  assert.match(APP, /data-action="campaign-buy-email-pack"/);
  assert.match(APP, /askToConfirm\(\{[\s\S]{0,400}?Unlock email campaigns/,
    "buying the pack must confirm in the app's own voice before taking money");
});

test("there is no way to send to a list the organiser supplies", () => {
  // The whole POPIA position rests on this. If a recipient list could ever be
  // passed in, the audience query would stop being the only door.
  assert.match(SOURCE, /FROM ticket_orders o/,
    "the audience is derived from ticket buyers");
  assert.match(SOURCE, /WHERE e\.business_user_id = \$1/,
    "and only from events this organiser runs");
  for (const smell of ["recipients", "recipientList", "payload.numbers", "payload.emails", "payload.audience"]) {
    assert.ok(!SOURCE.includes(smell),
      `sendCampaign must not read ${smell} from the request, or an organiser could message strangers`);
  }
  // sendCampaign takes a payload, and the only things it may read out of it
  // are the channel and the words.
  const send = SOURCE.slice(SOURCE.indexOf("async function sendCampaign"));
  const reads = [...send.matchAll(/payload\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)].sort(), ["body", "channel", "message", "subject"],
    "sendCampaign reads only the channel and the message from the caller");
});

test("an opt-out is honoured, permanent, and applies to every organiser", () => {
  assert.match(SOURCE, /NOT EXISTS \(SELECT 1 FROM event_campaign_optouts/,
    "the audience query excludes anyone who opted out");
  // The opt-out table is keyed on the person alone, not on organiser+person,
  // so saying stop once is saying it to everybody.
  assert.match(SOURCE, /CREATE TABLE IF NOT EXISTS event_campaign_optouts \(\s*user_id UUID PRIMARY KEY/);
  assert.match(SOURCE, /function optOutLine/, "every message carries a way out");
  assert.match(SOURCE, /Reply STOP to opt out/);
});

test("nobody is charged for a message that did not send", () => {
  const send = SOURCE.slice(SOURCE.indexOf("async function sendCampaign"));
  assert.match(send, /charged = money\(sent \* prices\.smsUnitPrice\)/,
    "SMS is billed on the count that sent, not the count attempted");
  assert.match(send, /if \(channel === "sms" && sent > 0\)/,
    "a campaign where everything failed must charge nothing");
  // And the balance is checked before the send starts, so TitoPay is never
  // left carrying the provider's bill for an organiser who cannot pay.
  assert.match(send, /const estimate = money\(audience\.length \* prices\.smsUnitPrice\)/);
  assert.match(send, /if \(balance < estimate\)/);
});

test("email campaigns need the pack, and the pack is bought once", () => {
  assert.match(SOURCE, /if \(!pack\.rows\[0\]\) \{[\s\S]{0,200}?402/,
    "sending email without the pack is refused with a price, not a shrug");
  assert.match(SOURCE, /UNIQUE \(event_id, channel\)/,
    "the pack table cannot hold two packs for one event");
  assert.match(SOURCE, /already paid for/i);
});

test("the charge goes through the ledger like every other TitoPay fee", () => {
  // Ledger truth: a debit, a matching revenue credit, and a revenue_ledger row.
  assert.match(SOURCE, /entryType: "debit"/);
  assert.match(SOURCE, /entryType: "credit"/);
  assert.match(SOURCE, /INSERT INTO revenue_ledger/);
  assert.match(SOURCE, /FOR UPDATE/, "the wallet is locked while it is being debited");
  assert.ok(!/\btoFixed\(2\) \* /.test(SOURCE), "money is never multiplied out of a formatted string");
});

test("Campaign Tools is a door on the ticketing hub, not another mega-sheet", () => {
  const sections = (APP.match(/const TICKETING_SECTIONS = \[[\s\S]*?\n\];/) || [""])[0];
  const keys = [...sections.matchAll(/key:\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["events", "sales", "vendors", "tags", "campaigns"]);
  assert.ok(keys.length <= 5, "a hub with more than five doors is a menu, not a simplification");
  assert.match(APP, /function ticketingCampaignsSection\(/);
  // The marketing promise the organiser was made, in the product.
  assert.match(APP, /increase ticket sales by helping you attract the right people in the right volumes/);
});
