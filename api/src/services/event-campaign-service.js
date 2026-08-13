"use strict";

/* CAMPAIGN TOOLS FOR EVENT ORGANISERS
 * ===================================
 *
 * "Let your target audience know, loud and clear, about your event."
 *
 * An organiser can reach the people who have bought tickets to their events,
 * by email and by SMS, and pay TitoPay for it:
 *
 *   Email   R1 500.00 once per event. Buy the pack, then send as many email
 *           campaigns for that event as you like.
 *   SMS     R0.60 per SMS actually sent. Not per recipient chosen, not per
 *           attempt: per message the provider accepted.
 *
 * THREE RULES THIS SERVICE EXISTS TO KEEP
 *
 * 1. The audience is derived on the server, never uploaded. An organiser can
 *    only reach people who have bought a ticket to one of their own events.
 *    That is the difference between marketing to your own customers, which
 *    POPIA section 69 permits with an opt-out, and cold-blasting a purchased
 *    list, which it does not. There is deliberately no way to paste a list in.
 *
 * 2. Nobody is charged for a message that did not go. SMS is billed on the
 *    count the provider accepted, after the send, in one debit. The balance is
 *    checked against the estimate first so a send cannot start that the
 *    organiser cannot pay for.
 *
 * 3. Every message carries a way out, and an opt-out is permanent and applies
 *    across every organiser on the platform. A patron who has said stop is
 *    removed from the audience before the cost is even quoted.
 */

const { randomUUID } = require("node:crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

// The published launch prices: R1 500 once per event for email, R0.60 per SMS
// sent. They are seeded into pricing_rules, which is where every other TitoPay
// fee lives, so the Pricing Engine in the admin console can change them without
// a deploy. These constants are the defaults and the fallback, never a second
// source of truth: currentPricing() reads the live rule.
const EMAIL_PACK_PRICE = 1500;
const SMS_UNIT_PRICE = 0.6;
const EMAIL_SERVICE_CODE = "event_campaign_email";
const SMS_SERVICE_CODE = "event_campaign_sms";

const MAX_SMS_LENGTH = 320;      // two segments; the cost is per message, not per segment
const MAX_EMAIL_SUBJECT = 150;
const MAX_EMAIL_BODY = 5000;

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

let schemaReady = null;
function ensureCampaignSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS event_campaign_packs (
        id UUID PRIMARY KEY,
        event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        amount NUMERIC(18,2) NOT NULL,
        transaction_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (event_id, channel)
      );
      CREATE TABLE IF NOT EXISTS event_campaigns (
        id UUID PRIMARY KEY,
        event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        audience_size INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        amount_charged NUMERIC(18,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'sending'
          CHECK (status IN ('sending','sent','partially_sent','failed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_event_campaigns_event
        ON event_campaigns (event_id, created_at DESC);
      -- An opt-out belongs to the person, not to one organiser. Somebody who
      -- says stop has said it to TitoPay, and every organiser is bound by it.
      CREATE TABLE IF NOT EXISTS event_campaign_optouts (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO pricing_rules (id, service_code, service_name, fee_type, fee_value, flat_fee)
      VALUES (gen_random_uuid(), 'event_campaign_email', 'Event email campaign pack', 'FIXED', 1500, 1500)
      ON CONFLICT (service_code) DO NOTHING;
      INSERT INTO pricing_rules (id, service_code, service_name, fee_type, fee_value, flat_fee)
      VALUES (gen_random_uuid(), 'event_campaign_sms', 'Event SMS campaign, per message', 'FIXED', 0.6, 0.6)
      ON CONFLICT (service_code) DO NOTHING;
    `).catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

// The live prices, from the Pricing Engine, falling back to the published
// launch prices if a rule has been removed. A campaign is never priced from a
// number the organiser was not shown.
async function currentPricing() {
  const { rows } = await pool.query(
    "SELECT service_code, flat_fee, fee_value FROM pricing_rules WHERE service_code = ANY($1) AND enabled = TRUE",
    [[EMAIL_SERVICE_CODE, SMS_SERVICE_CODE]]);
  const priceOf = (code, fallback) => {
    const rule = rows.find((row) => row.service_code === code);
    if (!rule) return fallback;
    const value = Number(rule.flat_fee) || Number(rule.fee_value) || 0;
    return value > 0 ? money(value) : fallback;
  };
  return {
    emailPackPrice: priceOf(EMAIL_SERVICE_CODE, EMAIL_PACK_PRICE),
    smsUnitPrice: priceOf(SMS_SERVICE_CODE, SMS_UNIT_PRICE)
  };
}

// The organiser's own event, or nothing. Every entry point goes through this.
async function loadOwnEvent(businessUserId, eventId) {
  const { rows } = await pool.query(
    `SELECT id, event_name, slug, status, business_user_id
       FROM events WHERE id = $1 AND business_user_id = $2 LIMIT 1`,
    [eventId, businessUserId]);
  if (!rows[0]) throw new AppError(404, "Event not found");
  return rows[0];
}

/* The audience: everyone who has bought a ticket to any event run by this
   organiser, minus anyone who has opted out. Derived here and nowhere else,
   so there is no code path that can reach a person the organiser has no
   relationship with. */
async function audienceRows(businessUserId, channel) {
  const contactColumn = channel === "sms" ? "u.phone" : "u.email";
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id, u.full_name, u.email, u.phone
       FROM ticket_orders o
       JOIN events e ON e.id = o.event_id
       JOIN users u ON u.id = o.buyer_user_id
      WHERE e.business_user_id = $1
        AND o.status = 'paid'
        AND u.status = 'active'
        AND ${contactColumn} IS NOT NULL
        AND ${contactColumn} <> ''
        AND NOT EXISTS (SELECT 1 FROM event_campaign_optouts x WHERE x.user_id = u.id)`,
    [businessUserId]);
  return rows;
}

async function campaignOverview(businessUserId, eventId) {
  await ensureCampaignSchema();
  const event = await loadOwnEvent(businessUserId, eventId);
  const [emailAudience, smsAudience, packs, history] = await Promise.all([
    audienceRows(businessUserId, "email"),
    audienceRows(businessUserId, "sms"),
    pool.query("SELECT channel FROM event_campaign_packs WHERE event_id = $1", [eventId]),
    pool.query(
      `SELECT id, channel, subject, audience_size, sent_count, failed_count,
              amount_charged, status, created_at
         FROM event_campaigns WHERE event_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [eventId])
  ]);
  const emailPackOwned = packs.rows.some((row) => row.channel === "email");
  const prices = await currentPricing();
  return {
    eventId: event.id,
    eventName: event.event_name,
    eventStatus: event.status,
    pricing: {
      emailPackPrice: prices.emailPackPrice,
      smsUnitPrice: prices.smsUnitPrice,
      emailPackOwned
    },
    audience: {
      email: emailAudience.length,
      sms: smsAudience.length,
      // Quoted before anything is bought, so an organiser with no patrons yet
      // is told that rather than sold a pack that can reach nobody.
      smsCost: money(smsAudience.length * prices.smsUnitPrice)
    },
    campaigns: history.rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      subject: row.subject,
      audienceSize: row.audience_size,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      amountCharged: money(row.amount_charged),
      status: row.status,
      createdAt: row.created_at
    }))
  };
}

/* Charging the organiser. One debit from their wallet, one credit to the
   TitoPay revenue wallet, recorded in revenue_ledger like every other fee. */
async function chargeOrganiser(client, { businessUserId, amount, reference, metadata }) {
  const { applyWalletMovement, getRevenueWallet } = require("./wallet-service");
  const { rows } = await client.query(
    `SELECT * FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
    [businessUserId]);
  const wallet = rows[0];
  if (!wallet) throw new AppError(404, "Business wallet not found");
  if (Number(wallet.available_balance || 0) < amount) {
    throw new AppError(400, `Not enough in your wallet. This costs R${amount.toFixed(2)} and you have R${Number(wallet.available_balance || 0).toFixed(2)}.`);
  }
  const txId = randomUUID();
  await client.query(
    `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total,
                               status, direction, reference, metadata)
     VALUES ($1,$2,$3,$4,$5,0,$5,'success','debit',$6,$7::JSONB)`,
    [txId, businessUserId, wallet.id, metadata.serviceCode, amount, reference, JSON.stringify(metadata)]);
  await applyWalletMovement(client, {
    walletId: wallet.id, transactionId: txId, entryType: "debit", amount, reference, metadata
  });
  // The fee lands in the revenue wallet and the revenue ledger, exactly like
  // every other TitoPay fee, so campaign income is reportable beside the rest.
  const revenueWallet = await getRevenueWallet(client).catch(() => null);
  if (revenueWallet) {
    await applyWalletMovement(client, {
      walletId: revenueWallet.id, transactionId: txId, entryType: "credit",
      amount, reference, metadata: { ...metadata, source: "event_campaign" }
    });
    await client.query(
      `INSERT INTO revenue_ledger (id, transaction_id, service_code, fee_collected, revenue_wallet_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), txId, metadata.serviceCode, amount, revenueWallet.id]);
  }
  return txId;
}

async function buyEmailPack(businessUserId, eventId, meta = {}) {
  await ensureCampaignSchema();
  const event = await loadOwnEvent(businessUserId, eventId);
  const existing = await pool.query(
    "SELECT id FROM event_campaign_packs WHERE event_id = $1 AND channel = 'email'", [eventId]);
  if (existing.rows[0]) throw new AppError(409, "The email campaign pack for this event is already paid for.");
  const { emailPackPrice: packPrice } = await currentPricing();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txId = await chargeOrganiser(client, {
      businessUserId, amount: packPrice,
      reference: `CAMPAIGN-EMAIL-${event.slug}`.slice(0, 60),
      metadata: { serviceCode: EMAIL_SERVICE_CODE, eventId, eventName: event.event_name }
    });
    await client.query(
      `INSERT INTO event_campaign_packs (id, event_id, business_user_id, channel, amount, transaction_id)
       VALUES ($1,$2,$3,'email',$4,$5)`,
      [randomUUID(), eventId, businessUserId, packPrice, txId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, amount: packPrice, message: `Email campaigns are unlocked for ${event.event_name}. Send as many as you need.` };
}

// Appended to every message. A campaign a person cannot escape is not a
// campaign, it is spam, and POPIA agrees.
function optOutLine(channel) {
  return channel === "sms"
    ? " Reply STOP to opt out."
    : "\n\nYou are receiving this because you bought a ticket from this organiser on TitoPay. To stop event marketing, open TitoPay and turn off event updates in your notification settings.";
}

async function sendCampaign(businessUserId, eventId, payload = {}, meta = {}) {
  await ensureCampaignSchema();
  const event = await loadOwnEvent(businessUserId, eventId);
  const channel = payload.channel === "sms" ? "sms" : "email";
  const body = clean(payload.message || payload.body, channel === "sms" ? MAX_SMS_LENGTH : MAX_EMAIL_BODY);
  const subject = channel === "email" ? clean(payload.subject, MAX_EMAIL_SUBJECT) : "";
  if (!body) throw new AppError(400, "Write the message you want to send.");
  if (channel === "email" && !subject) throw new AppError(400, "An email campaign needs a subject line.");

  const prices = await currentPricing();
  if (channel === "email") {
    const pack = await pool.query(
      "SELECT id FROM event_campaign_packs WHERE event_id = $1 AND channel = 'email'", [eventId]);
    if (!pack.rows[0]) {
      throw new AppError(402, `Buy the email campaign pack for this event first. It is R${prices.emailPackPrice.toFixed(2)} once, and then email campaigns for ${event.event_name} are unlimited.`);
    }
  }

  const audience = await audienceRows(businessUserId, channel);
  if (!audience.length) {
    throw new AppError(409, channel === "sms"
      ? "None of your patrons have a mobile number we can reach, or they have all opted out."
      : "None of your patrons have an email address we can reach, or they have all opted out.");
  }

  // SMS is charged on what is sent, but the balance is checked against the
  // estimate first: starting a send the organiser cannot pay for would leave
  // TitoPay carrying the provider's bill.
  if (channel === "sms") {
    const estimate = money(audience.length * prices.smsUnitPrice);
    const { rows: balanceRows } = await pool.query(
      "SELECT available_balance FROM wallets WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [businessUserId]);
    const balance = Number(balanceRows[0]?.available_balance || 0);
    if (balance < estimate) {
      throw new AppError(400, `This campaign reaches ${audience.length} patrons and costs R${estimate.toFixed(2)}. Your wallet has R${balance.toFixed(2)}.`);
    }
  }

  const campaignId = randomUUID();
  await pool.query(
    `INSERT INTO event_campaigns (id, event_id, business_user_id, channel, subject, body, audience_size, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'sending')`,
    [campaignId, eventId, businessUserId, channel, subject, body, audience.length]);

  const notifications = require("./notification-service");
  const emailCentre = require("./email-centre-service");
  let sent = 0;
  let failed = 0;

  for (const person of audience) {
    try {
      if (channel === "sms") {
        await notifications.deliverSms({
          recipient: person.phone,
          message: `${body}${optOutLine("sms")}`.slice(0, MAX_SMS_LENGTH + 40)
        });
      } else {
        const result = await emailCentre.queueRawEmail({
          recipient: person.email,
          subject,
          textBody: `Hi ${person.full_name || "there"},\n\n${body}${optOutLine("email")}`,
          userId: person.id,
          idempotencyKey: `event-campaign:${campaignId}:${person.id}`,
          metadata: { campaignId, eventId, purpose: "event_campaign" }
        });
        if (result && result.skipped) throw new AppError(503, "Email sending is switched off");
      }
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error("[event-campaign] delivery failed", { campaignId, channel, message: error.message });
    }
  }

  // Charged now, on the count that actually went. An organiser whose whole
  // campaign failed pays nothing.
  let charged = 0;
  if (channel === "sms" && sent > 0) {
    charged = money(sent * prices.smsUnitPrice);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await chargeOrganiser(client, {
        businessUserId, amount: charged,
        reference: `CAMPAIGN-SMS-${event.slug}`.slice(0, 60),
        metadata: { serviceCode: SMS_SERVICE_CODE, eventId, campaignId, sent }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[event-campaign] charge failed after sending", { campaignId, message: error.message });
    } finally {
      client.release();
    }
  }

  const status = sent === 0 ? "failed" : failed > 0 ? "partially_sent" : "sent";
  await pool.query(
    `UPDATE event_campaigns SET sent_count = $2, failed_count = $3, amount_charged = $4, status = $5
      WHERE id = $1`,
    [campaignId, sent, failed, charged, status]);

  return {
    campaignId,
    channel,
    audienceSize: audience.length,
    sent,
    failed,
    amountCharged: charged,
    status,
    message: channel === "sms"
      ? `${sent} SMS sent. You were charged R${charged.toFixed(2)} at R${prices.smsUnitPrice.toFixed(2)} each${failed ? `, and ${failed} could not be delivered, which you were not charged for` : ""}.`
      : `${sent} emails queued to your patrons${failed ? `, and ${failed} could not be queued` : ""}. Email campaigns for this event are already paid for.`
  };
}

async function optOut(userId) {
  await ensureCampaignSchema();
  await pool.query(
    "INSERT INTO event_campaign_optouts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId]);
  return { ok: true, message: "You will not receive event marketing from TitoPay organisers again." };
}

module.exports = {
  ensureCampaignSchema,
  campaignOverview,
  buyEmailPack,
  sendCampaign,
  optOut,
  EMAIL_PACK_PRICE,
  SMS_UNIT_PRICE,
  MAX_SMS_LENGTH
};
