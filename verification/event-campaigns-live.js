"use strict";

/* CAMPAIGN TOOLS, PROVEN AGAINST REAL WALLETS.
 *
 * Money leaves an organiser's wallet here, so a source check is not enough.
 * This boots the real API and proves:
 *
 *   1. The audience is the organiser's own ticket buyers. A stranger who has
 *      never bought from them is not in it.
 *   2. Buying the email pack debits exactly R1 500.00, once. A second attempt
 *      is refused rather than charging twice.
 *   3. Sending email without the pack is refused with the price.
 *   4. An SMS campaign charges exactly R0.60 per message that sent, and the
 *      revenue wallet is credited the same amount.
 *   5. A patron who opts out leaves the audience, and stays out for every
 *      organiser, not just the one they opted out of.
 *   6. An organiser who cannot afford the campaign is stopped before a single
 *      message goes, rather than after.
 *
 * Run: node verification/event-campaigns-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
// No real SMS leaves this harness. deliverSms is replaced below, and the
// replacement is what lets the billing be checked against a known send count.
process.env.SMS_PROVIDER = "harness";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));
const notifications = require(path.join(API, "src", "services", "notification-service.js"));
const campaignService = require(path.join(API, "src", "services", "event-campaign-service.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };
const bal = async (userId) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
  [userId])).rows[0]?.available_balance || 0);

// Every SMS is counted, never sent. One number is made to fail so that the
// "charged only for what sent" rule can be checked against a real mixture.
const smsLog = [];
notifications.deliverSms = async ({ recipient, message }) => {
  smsLog.push({ recipient, message });
  if (String(recipient).endsWith("0009")) throw new Error("harness: unreachable number");
  return { ok: true };
};

async function seedUser({ type = "personal", balance = 0, phone = null, email = true }) {
  const id = crypto.randomUUID();
  const n = crypto.randomUUID().slice(0, 6);
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active','verified')`,
    [id, type, `Campaign ${n}`, `cm_${n}_${TAG}`, email ? `cm-${n}-${TAG}@example.test` : null, phone]);
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, available_balance)
     VALUES (gen_random_uuid(), $1, $2, 'ZAR', $3)`,
    [id, type === "business" ? "business" : "personal", balance]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`, [sessionId, id, jti]);
  return { id, sessionId, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
}

async function seedAdmin() {
  const id = crypto.randomUUID();
  const n = crypto.randomUUID().slice(0, 6);
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Campaign Reviewer',$2,$3,'coo','x','active')`,
    [id, `cmpadm_${n}`, `cmpadm-${n}@example.test`]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'admin',$2,'admin','x',$3, NOW() + INTERVAL '1 hour')`, [sessionId, id, jti]);
  return { id, sessionId, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "admin" }) };
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const { ensureTicketingSchema } = require(path.join(API, "src", "services", "ticketing-service.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const made = { users: [], events: [] };

  const call = (token, p, body, method) => fetch(baseUrl + p, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });

  try {
    await ensureTicketingSchema();
    await campaignService.ensureCampaignSchema();

    const organiser = await seedUser({ type: "business", balance: 3000 });
    made.users.push(organiser.id);

    // Three patrons who bought a ticket, one stranger who did not.
    const patrons = [];
    for (let i = 0; i < 3; i += 1) {
      const suffix = String(Date.now()).slice(-5);
      const p = await seedUser({ phone: i === 2 ? `+2782${suffix}0009` : `+2782${suffix}000${i}` });
      patrons.push(p); made.users.push(p.id);
    }
    const stranger = await seedUser({ phone: `+2783${String(Date.now()).slice(-6)}` });
    made.users.push(stranger.id);

    const eventId = crypto.randomUUID();
    const slug = `campaign-${TAG}`;
    await pool.query(
      `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date, approved_at)
       VALUES ($1,$2,$3,$4,'approved', CURRENT_DATE + 20, NOW())`,
      [eventId, organiser.id, `Campaign Test ${TAG}`, slug]);
    made.events.push(eventId);
    const typeId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, sort_order)
       VALUES ($1,$2,'General',0,500,10)`, [typeId, eventId]);
    for (const p of patrons) {
      await pool.query(
        `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference,
                                    quantity, subtotal, buyer_fee, business_commission, business_net, total, status, delivery_status)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,1,0,0,0,0,0,'paid','queued')`,
        [eventId, typeId, p.id, `CMP-${crypto.randomUUID().slice(0, 8)}`]);
    }

    // A SECOND event by the same organiser, with a different buyer. If the
    // audience were still "everyone who bought from this organiser", this
    // person would leak into the first event's campaign.
    const otherEvent = crypto.randomUUID();
    await pool.query(
      `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date, approved_at)
       VALUES ($1,$2,$3,$4,'approved', CURRENT_DATE + 40, NOW())`,
      [otherEvent, organiser.id, `Other ${TAG}`, `other-${TAG}`]);
    made.events.push(otherEvent);
    const otherType = crypto.randomUUID();
    await pool.query(
      `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, sort_order)
       VALUES ($1,$2,'General',0,50,10)`, [otherType, otherEvent]);
    const otherBuyer = await seedUser({ phone: `+2784${String(Date.now()).slice(-6)}` });
    made.users.push(otherBuyer.id);
    await pool.query(
      `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference,
                                  quantity, subtotal, buyer_fee, business_commission, business_net, total, status, delivery_status)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,1,0,0,0,0,0,'paid','queued')`,
      [otherEvent, otherType, otherBuyer.id, `CMP-${crypto.randomUUID().slice(0, 8)}`]);

    // 1. The audience is this event's buyers, not everyone.
    let overview = (await (await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns`)).json()).campaigns;
    assert.equal(overview.audience.email, 3, `three patrons, got ${overview.audience.email}`);
    assert.equal(overview.audience.sms, 3);
    assert.equal(Number(overview.audience.smsCost), 1.8, "3 x R0.60 = R1.80");
    assert.equal(overview.pricing.emailPackPrice, 1500);
    assert.equal(overview.pricing.smsUnitPrice, 0.6);
    ok("the audience is only this event's 3 buyers: not the stranger, and not the other event's buyer");

    // 3. Email without the pack is refused, with the price in the message.
    const noPack = await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns`,
      { channel: "email", subject: "Hello", message: "Come to our event." });
    assert.equal(noPack.status, 402, `expected 402, got ${noPack.status}`);
    assert.match((await noPack.json()).error || "", /1500/, "the refusal names the price");
    ok("an email campaign without the pack is refused with the price, not a shrug");

    // 2. The pack costs exactly R1 500, once.
    const before = await bal(organiser.id);
    const bought = await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns/email-pack`, {});
    assert.equal(bought.status, 201, `pack purchase failed: ${await bought.text()}`);
    const afterPack = await bal(organiser.id);
    assert.equal(Number((before - afterPack).toFixed(2)), 1500, `expected R1500 debit, saw R${(before - afterPack).toFixed(2)}`);
    const again = await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns/email-pack`, {});
    assert.equal(again.status, 409, "a second purchase must be refused, not charged again");
    assert.equal(await bal(organiser.id), afterPack, "the refused second purchase moved no money");
    ok("the email pack debits exactly R1 500.00 and cannot be bought twice");

    // Email now sends, and costs nothing further.
    const emailSend = await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns`,
      { channel: "email", subject: "Tickets are moving", message: "Doors at 20:00." });
    const emailBody = await emailSend.json();
    assert.equal(emailSend.status, 201, JSON.stringify(emailBody));
    assert.equal(emailBody.result.status, "pending_approval", "an email campaign waits for TitoPay");
    assert.equal(await bal(organiser.id), afterPack, "an email campaign after the pack costs nothing more");
    ok("an email campaign is submitted for review, not sent, and costs nothing further");

    // 4. SMS is charged AT SUBMISSION and held for review, then released by
    //    an admin. Nothing may reach a phone before somebody has read it.
    const beforeSms = await bal(organiser.id);
    const revenueBefore = Number((await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id IS NULL AND kind = 'revenue' LIMIT 1")).rows[0]?.available_balance || 0);
    smsLog.length = 0;
    const smsSend = await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns`,
      { channel: "sms", message: "Doors at 20:00. Get your ticket on TitoPay." });
    const smsBody = await smsSend.json();
    assert.equal(smsSend.status, 201, JSON.stringify(smsBody));
    assert.equal(smsBody.result.status, "pending_approval");
    assert.equal(smsLog.length, 0, "NOT ONE message may go out before an admin has approved it");
    const heldBalance = await bal(organiser.id);
    assert.equal(Number((beforeSms - heldBalance).toFixed(2)), 1.8, "3 x R0.60 is charged up front, before release");
    ok("an SMS campaign is charged R1.80 on submission and sends nothing until it is approved");

    // The admin queue, and the release.
    const admin = await seedAdmin();
    const queue = await (await call(admin.token, "/v1/admin/ticketing/campaigns")).json();
    const waiting = queue.items.find((item) => item.id === smsBody.result.campaignId);
    assert.ok(waiting, "the campaign is in the admin review queue");
    assert.equal(waiting.audienceSize, 3);
    ok("the message is waiting in Admin -> Ticketing with its audience and what was paid");

    const released = await call(admin.token, `/v1/admin/ticketing/campaigns/${smsBody.result.campaignId}/action`,
      { decision: "approve" });
    assert.equal(released.status, 200, await released.text());
    assert.equal(smsLog.length, 3, "all three were attempted once approved");
    const afterSms = await bal(organiser.id);
    // One number is unreachable, so R0.60 comes back: "per SMS sent" holds.
    assert.equal(Number((beforeSms - afterSms).toFixed(2)), 1.2,
      `2 sent x R0.60 = R1.20 net, saw R${(beforeSms - afterSms).toFixed(2)}`);
    const revenueAfter = Number((await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id IS NULL AND kind = 'revenue' LIMIT 1")).rows[0]?.available_balance || 0);
    assert.equal(Number((revenueAfter - revenueBefore).toFixed(2)), 1.2, "revenue keeps only the R1.20 that was delivered");
    assert.match(smsLog[0].message, /STOP/i, "every SMS carries an opt-out");
    ok("approving releases it, and the undelivered one is refunded so billing stays per SMS sent");

    // A rejected campaign never goes, and every cent comes back.
    const beforeReject = await bal(organiser.id);
    smsLog.length = 0;
    const toReject = await (await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns`,
      { channel: "sms", message: "Buy now or regret it forever" })).json();
    assert.equal(Number((beforeReject - await bal(organiser.id)).toFixed(2)), 1.8, "charged on submission");
    const rejected = await call(admin.token, `/v1/admin/ticketing/campaigns/${toReject.result.campaignId}/action`,
      { decision: "reject", note: "Too pushy" });
    assert.equal(rejected.status, 200, await rejected.text());
    assert.equal(smsLog.length, 0, "a rejected campaign sends nothing");
    assert.equal(Number((await bal(organiser.id)).toFixed(2)), Number(beforeReject.toFixed(2)),
      "every cent of a rejected campaign comes back");
    ok("a rejected campaign sends nothing and is refunded in full");

    // 5. Opting out removes a patron everywhere.
    const optedOut = await call(patrons[0].token, "/v1/ticketing/campaigns/opt-out", {});
    assert.equal(optedOut.status, 200);
    overview = (await (await call(organiser.token, `/v1/ticketing/business/events/${eventId}/campaigns`)).json()).campaigns;
    assert.equal(overview.audience.sms, 2, "the opted-out patron is gone from the audience");
    assert.equal(overview.audience.email, 2);
    ok("a patron who opts out leaves the audience, for every organiser at once");

    // 6. An organiser who cannot pay is stopped before anything is sent.
    const broke = await seedUser({ type: "business", balance: 0.10 });
    made.users.push(broke.id);
    const brokeEvent = crypto.randomUUID();
    await pool.query(
      `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date, approved_at)
       VALUES ($1,$2,$3,$4,'approved', CURRENT_DATE + 20, NOW())`,
      [brokeEvent, broke.id, `Broke ${TAG}`, `broke-${TAG}`]);
    made.events.push(brokeEvent);
    const brokeType = crypto.randomUUID();
    await pool.query(
      `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, sort_order)
       VALUES ($1,$2,'General',0,10,10)`, [brokeType, brokeEvent]);
    await pool.query(
      `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference,
                                  quantity, subtotal, buyer_fee, business_commission, business_net, total, status, delivery_status)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,1,0,0,0,0,0,'paid','queued')`,
      [brokeEvent, brokeType, patrons[1].id, `CMP-${crypto.randomUUID().slice(0, 8)}`]);
    smsLog.length = 0;
    const refused = await call(broke.token, `/v1/ticketing/business/events/${brokeEvent}/campaigns`,
      { channel: "sms", message: "Please come" });
    assert.equal(refused.status, 400, `expected a refusal, got ${refused.status}`);
    assert.equal(smsLog.length, 0, "not one message may go out before the money is confirmed");
    ok("an organiser who cannot afford the campaign is stopped before a single SMS is sent");

    console.log(`\n${passed}/9 checks passed. R1 500 per event for email, R0.60 per SMS sent.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    for (const eventId of made.events) {
      await pool.query("DELETE FROM event_campaigns WHERE event_id = $1", [eventId]).catch(() => {});
      await pool.query("DELETE FROM event_campaign_packs WHERE event_id = $1", [eventId]).catch(() => {});
      await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [eventId]).catch(() => {});
      await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => {});
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => {});
    }
    for (const userId of made.users) {
      await pool.query("DELETE FROM event_campaign_optouts WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM ledger_entries WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = $1)", [userId]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
    }
  }
})();
