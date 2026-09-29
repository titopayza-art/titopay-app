"use strict";

// Marketing & Sales Command Centre — service layer.
//
// The boundary this file respects, and the reason it exists as its own service:
//
//   Existing TitoPay systems  ->  marketing DATA  ->  campaigns / sales  ->  analytics
//
// Everything flows in that direction. Marketing reads users, merchants and
// transactions; it never writes to them. There is no wallet write anywhere in
// this file and no import of wallet-service. A promotion records what a
// customer is ENTITLED to; turning that into money is a financial operation
// that belongs to the existing transaction code, and grantPromotion() stops at
// exactly that line — see the comment there.
//
// Delivery is the same story. Campaigns describe who and what; the announcement
// and SMS/email campaign endpoints that already exist, with their CEO/COO
// approval workflow, remain the only things that send a customer a message.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

const CAMPAIGN_TYPES = ["acquisition", "activation", "retention", "referral", "merchant_acquisition",
  "promotional", "product_launch", "re_engagement", "seasonal"];
const CAMPAIGN_STATUSES = ["draft", "scheduled", "active", "paused", "completed", "archived"];
const CHANNELS = ["push", "email", "sms", "in_app", "qr", "referral", "landing_page"];
const LEAD_STATUSES = ["new", "contacted", "qualified", "demo", "negotiation", "kyc",
  "approved", "activated", "lost"];
const PROMOTION_STATUSES = ["draft", "active", "paused", "expired", "exhausted", "archived"];
const BENEFIT_TYPES = ["fixed_discount", "percentage_discount", "cashback", "fee_waiver",
  "first_transaction", "referral_bonus", "merchant_specific", "service_specific"];

// Budget thresholds the campaign list warns at, per the brief.
const BUDGET_WARNING_LEVELS = [0.75, 0.9, 1];

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

/* ========================================================================== */
/* Audiences                                                                  */
/* ========================================================================== */

// Each preset is a SQL fragment against users, written once here rather than
// assembled from client input. Admin-supplied values only ever arrive as bound
// parameters, so a segment definition can never become an injection vector.
//
// Every one of them is bounded — by a date window, a count or a join — because
// the whole point of materialising audiences is that no marketing screen ever
// triggers an unbounded scan of a million-row users table.
const AUDIENCE_PRESETS = {
  new_users: {
    label: "New users",
    describe: (p) => `Registered in the last ${p.days || 7} days`,
    sql: `SELECT u.id FROM users u
           WHERE u.status = 'active' AND u.created_at >= NOW() - ($1 || ' days')::INTERVAL`,
    params: (p) => [String(Math.min(365, Math.max(1, Number(p.days) || 7)))]
  },
  inactive_users: {
    label: "Inactive users",
    describe: (p) => `No transaction in the last ${p.days || 30} days`,
    sql: `SELECT u.id FROM users u
           WHERE u.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM transactions t
                WHERE t.user_id = u.id
                  AND t.created_at >= NOW() - ($1 || ' days')::INTERVAL)`,
    params: (p) => [String(Math.min(365, Math.max(1, Number(p.days) || 30)))]
  },
  high_value_users: {
    label: "High-value users",
    describe: (p) => `Completed volume above R${Number(p.threshold) || 5000} in ${p.days || 90} days`,
    sql: `SELECT t.user_id AS id FROM transactions t
           WHERE t.status = 'completed'
             AND t.created_at >= NOW() - ($2 || ' days')::INTERVAL
           GROUP BY t.user_id HAVING SUM(t.amount) >= $1`,
    params: (p) => [Number(p.threshold) || 5000, String(Math.min(365, Math.max(1, Number(p.days) || 90)))]
  },
  first_transaction_pending: {
    label: "First transaction pending",
    describe: () => "Registered but has never completed a transaction",
    sql: `SELECT u.id FROM users u
           WHERE u.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM transactions t
                              WHERE t.user_id = u.id AND t.status = 'completed')`,
    params: () => []
  },
  qr_users: {
    label: "QR users",
    describe: () => "Has paid by QR",
    sql: `SELECT DISTINCT t.user_id AS id FROM transactions t
           WHERE t.service_code = 'qr_payment' AND t.status = 'completed'`,
    params: () => []
  },
  airtime_users: {
    label: "Airtime users",
    describe: (p) => `At least ${p.minCount || 2} completed airtime purchases`,
    sql: `SELECT t.user_id AS id FROM transactions t
           WHERE t.service_code IN ('airtime','airtime_data','data') AND t.status = 'completed'
           GROUP BY t.user_id HAVING COUNT(*) >= $1`,
    params: (p) => [Math.max(1, Number(p.minCount) || 2)]
  },
  ticket_users: {
    label: "Ticket buyers",
    describe: () => "Has bought an event ticket",
    sql: `SELECT DISTINCT o.buyer_user_id AS id FROM ticket_orders o
           WHERE o.buyer_user_id IS NOT NULL AND o.status = 'paid'`,
    params: () => []
  },
  merchant_users: {
    label: "Customers of merchants",
    describe: () => "Has transacted with a merchant",
    sql: `SELECT DISTINCT t.user_id AS id FROM transactions t WHERE t.merchant_id IS NOT NULL`,
    params: () => []
  }
};

function audiencePresetList() {
  return Object.entries(AUDIENCE_PRESETS).map(([key, preset]) => ({
    key, label: preset.label, description: preset.describe({})
  }));
}

async function listAudiences() {
  const { rows } = await pool.query(
    `SELECT a.*, admin_users.full_name AS created_by_name
       FROM marketing_audiences a
       LEFT JOIN admin_users ON admin_users.id = a.created_by
      WHERE a.status = 'active'
      ORDER BY a.created_at DESC
      LIMIT 200`);
  return rows.map(audienceResponse);
}

function audienceResponse(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    preset: row.preset,
    definition: row.definition,
    isDynamic: row.is_dynamic,
    size: Number(row.cached_size || 0),
    lastBuiltAt: row.last_built_at,
    buildStatus: row.build_status,
    buildError: row.build_error,
    createdByName: row.created_by_name || null,
    createdAt: row.created_at
  };
}

async function createAudience(actor, input) {
  const preset = String(input.preset || "").trim();
  if (!AUDIENCE_PRESETS[preset]) {
    throw new AppError(400, `Unknown audience type. Choose one of: ${Object.keys(AUDIENCE_PRESETS).join(", ")}`);
  }
  const definition = input.definition && typeof input.definition === "object" ? input.definition : {};
  const { rows } = await pool.query(
    `INSERT INTO marketing_audiences (name, description, preset, definition, is_dynamic, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
    [input.name, input.description || AUDIENCE_PRESETS[preset].describe(definition), preset,
      JSON.stringify(definition), input.isDynamic !== false, actor.adminId]);
  return audienceResponse(rows[0]);
}

// Materialise an audience.
//
// Deliberately not done inline on a dashboard request: at a million users the
// preset queries are the only expensive thing in this module, so a build is an
// explicit action, is marked `building` while it runs, and writes its result in
// one statement. Callers get an immediate response and poll build_status.
async function buildAudience(audienceId) {
  const { rows: found } = await pool.query("SELECT * FROM marketing_audiences WHERE id = $1", [audienceId]);
  const audience = found[0];
  if (!audience) throw new AppError(404, "Audience not found");
  const preset = AUDIENCE_PRESETS[audience.preset];
  if (!preset) throw new AppError(400, "This audience has no known rule and cannot be rebuilt");

  await pool.query(
    "UPDATE marketing_audiences SET build_status='building', build_error=NULL, updated_at=NOW() WHERE id=$1",
    [audienceId]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Keep the query off the busy pool path for as short a time as possible and
    // never let a runaway segment hold a connection: marketing must not be able
    // to slow down payments.
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("DELETE FROM marketing_audience_members WHERE audience_id = $1", [audienceId]);
    // The preset owns $1..$n for its own bound values, so the audience id goes
    // last as $n+1. Numbering it first would silently shift every placeholder
    // inside the preset and segment on the wrong value.
    const presetParams = preset.params(audience.definition || {});
    const inserted = await client.query(
      `INSERT INTO marketing_audience_members (audience_id, user_id)
       SELECT $${presetParams.length + 1}, s.id FROM (${preset.sql}) s
       ON CONFLICT DO NOTHING`,
      [...presetParams, audienceId]);
    await client.query(
      `UPDATE marketing_audiences
          SET cached_size = $2, last_built_at = NOW(), build_status = 'ready', updated_at = NOW()
        WHERE id = $1`,
      [audienceId, inserted.rowCount]);
    await client.query("COMMIT");
    return { audienceId, size: inserted.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    await pool.query(
      "UPDATE marketing_audiences SET build_status='failed', build_error=$2, updated_at=NOW() WHERE id=$1",
      [audienceId, String(error.message).slice(0, 300)]);
    throw new AppError(500, "The audience could not be built. The rule was rejected by the database.");
  } finally {
    client.release();
  }
}

/* ========================================================================== */
/* Campaigns                                                                  */
/* ========================================================================== */

function campaignResponse(row) {
  const allocated = money(row.budget_allocated);
  const spent = money(row.spent || 0);
  const attributed = money(row.attributed_revenue || 0);
  const used = allocated > 0 ? spent / allocated : 0;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.campaign_type,
    objective: row.objective,
    audienceId: row.audience_id,
    audienceName: row.audience_name || null,
    channels: row.channels || [],
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    ownerName: row.owner_name || null,
    budget: {
      allocated,
      spent,
      remaining: money(allocated - spent),
      usedPercent: Math.round(used * 1000) / 10,
      // Surfaced rather than enforced: the brief is explicit that this system
      // tracks spend and never spends money, so crossing a threshold warns.
      warning: allocated > 0
        ? (used >= 1 ? "Budget reached" : used >= 0.9 ? "90% of budget used" : used >= 0.75 ? "75% of budget used" : null)
        : null
    },
    attributedRevenue: attributed,
    roiPercent: spent > 0 ? Math.round(((attributed - spent) / spent) * 1000) / 10 : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const CAMPAIGN_SELECT = `
  SELECT c.*,
         a.name AS audience_name,
         au.full_name AS owner_name,
         COALESCE(s.spent, 0) AS spent,
         COALESCE(r.attributed_revenue, 0) AS attributed_revenue
    FROM marketing_campaigns c
    LEFT JOIN marketing_audiences a ON a.id = c.audience_id
    LEFT JOIN admin_users au ON au.id = c.owner_admin_id
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS spent FROM marketing_campaign_spend WHERE campaign_id = c.id
    ) s ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(revenue_amount) AS attributed_revenue
        FROM marketing_campaign_events
       WHERE campaign_id = c.id AND event_type = 'revenue' AND attribution = 'direct'
    ) r ON TRUE`;

async function listCampaigns({ status, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status && CAMPAIGN_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
  }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
  const { rows } = await pool.query(
    `${CAMPAIGN_SELECT} ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
     ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const total = await pool.query(
    `SELECT COUNT(*)::int n FROM marketing_campaigns c ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}`,
    params.slice(0, conditions.length));
  return { items: rows.map(campaignResponse), total: total.rows[0].n };
}

async function getCampaign(id) {
  const { rows } = await pool.query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new AppError(404, "Campaign not found");
  const spend = await pool.query(
    `SELECT s.*, a.full_name AS recorded_by_name
       FROM marketing_campaign_spend s
       LEFT JOIN admin_users a ON a.id = s.recorded_by
      WHERE s.campaign_id = $1 ORDER BY s.spent_on DESC LIMIT 100`, [id]);
  return {
    ...campaignResponse(rows[0]),
    spendEntries: spend.rows.map((row) => ({
      id: row.id, amount: money(row.amount), description: row.description,
      spentOn: row.spent_on, recordedByName: row.recorded_by_name || null
    }))
  };
}

async function createCampaign(actor, input) {
  const channels = Array.isArray(input.channels)
    ? input.channels.filter((channel) => CHANNELS.includes(channel)) : [];
  const { rows } = await pool.query(
    `INSERT INTO marketing_campaigns
       (name, description, campaign_type, objective, audience_id, channels,
        starts_at, ends_at, budget_allocated, status, owner_admin_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11) RETURNING id`,
    [input.name, input.description || "", input.type, input.objective || "",
      input.audienceId || null, channels, input.startsAt || null, input.endsAt || null,
      money(input.budget), input.ownerAdminId || actor.adminId, actor.adminId]);
  return getCampaign(rows[0].id);
}

// Status is a small state machine rather than a free field, so a completed
// campaign cannot silently go back to draft and rewrite its own history.
const CAMPAIGN_TRANSITIONS = {
  draft: ["scheduled", "active", "archived"],
  scheduled: ["active", "paused", "draft", "archived"],
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["archived"],
  archived: []
};

async function updateCampaign(actor, id, input) {
  const { rows: current } = await pool.query("SELECT * FROM marketing_campaigns WHERE id = $1", [id]);
  const campaign = current[0];
  if (!campaign) throw new AppError(404, "Campaign not found");

  if (input.status && input.status !== campaign.status) {
    const allowed = CAMPAIGN_TRANSITIONS[campaign.status] || [];
    if (!allowed.includes(input.status)) {
      throw new AppError(409,
        `A ${campaign.status} campaign cannot become ${input.status}. Allowed from here: ${allowed.join(", ") || "nothing"}.`);
    }
  }

  const channels = Array.isArray(input.channels)
    ? input.channels.filter((channel) => CHANNELS.includes(channel)) : null;
  await pool.query(
    `UPDATE marketing_campaigns SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       objective = COALESCE($4, objective),
       audience_id = COALESCE($5, audience_id),
       channels = COALESCE($6, channels),
       starts_at = COALESCE($7, starts_at),
       ends_at = COALESCE($8, ends_at),
       budget_allocated = COALESCE($9, budget_allocated),
       status = COALESCE($10, status),
       owner_admin_id = COALESCE($11, owner_admin_id),
       updated_at = NOW()
     WHERE id = $1`,
    [id, input.name ?? null, input.description ?? null, input.objective ?? null,
      input.audienceId ?? null, channels, input.startsAt ?? null, input.endsAt ?? null,
      input.budget === undefined ? null : money(input.budget), input.status ?? null,
      input.ownerAdminId ?? null]);
  return { before: campaign, after: await getCampaign(id) };
}

async function recordCampaignSpend(actor, campaignId, input) {
  const amount = money(input.amount);
  if (!(amount > 0)) throw new AppError(400, "Enter a spend amount greater than zero.");
  const { rows } = await pool.query(
    `INSERT INTO marketing_campaign_spend (campaign_id, amount, description, spent_on, recorded_by)
     VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5) RETURNING id`,
    [campaignId, amount, input.description || "", input.spentOn || null, actor.adminId]);
  return { id: rows[0].id, campaign: await getCampaign(campaignId) };
}

/* ========================================================================== */
/* Promotions and coupons                                                     */
/* ========================================================================== */

function promotionResponse(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    campaignId: row.campaign_id,
    benefitType: row.benefit_type,
    benefitValue: money(row.benefit_value),
    benefitPercentage: Number(row.benefit_percentage || 0),
    maxBenefit: row.max_benefit === null ? null : money(row.max_benefit),
    minTransaction: money(row.min_transaction),
    audienceId: row.audience_id,
    eligibleServices: row.eligible_services || [],
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    usageLimit: row.usage_limit,
    perUserLimit: row.per_user_limit,
    budgetTotal: row.budget_total === null ? null : money(row.budget_total),
    budgetSpent: money(row.budget_spent || 0),
    redemptions: Number(row.redemption_count || 0),
    status: row.status,
    createdAt: row.created_at
  };
}

const PROMOTION_SELECT = `
  SELECT p.*,
         COALESCE(r.redemption_count, 0) AS redemption_count,
         COALESCE(r.budget_spent, 0) AS budget_spent
    FROM marketing_promotions p
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS redemption_count, SUM(benefit_amount) AS budget_spent
        FROM marketing_promo_redemptions
       WHERE promotion_id = p.id AND status = 'granted'
    ) r ON TRUE`;

async function listPromotions({ status } = {}) {
  const params = [];
  let where = "";
  if (status && PROMOTION_STATUSES.includes(status)) {
    params.push(status);
    where = `WHERE p.status = $1`;
  }
  const { rows } = await pool.query(
    `${PROMOTION_SELECT} ${where} ORDER BY p.created_at DESC LIMIT 200`, params);
  return rows.map(promotionResponse);
}

async function createPromotion(actor, input) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    throw new AppError(400, "A coupon code must be 3–32 characters: letters, numbers, hyphen or underscore.");
  }
  if (!BENEFIT_TYPES.includes(input.benefitType)) throw new AppError(400, "Unknown benefit type.");

  // A percentage benefit with no ceiling is an unbounded liability. Refuse it
  // here rather than discover it after a customer redeems against R500,000.
  const percentage = Number(input.benefitPercentage || 0);
  if (percentage > 0 && !(Number(input.maxBenefit) > 0)) {
    throw new AppError(400, "A percentage promotion needs a maximum benefit, so its cost is capped.");
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO marketing_promotions
        (code, name, description, campaign_id, benefit_type, benefit_value, benefit_percentage,
         max_benefit, min_transaction, audience_id, eligible_services, merchant_id,
         starts_at, expires_at, usage_limit, per_user_limit, budget_total, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft',$18)
       RETURNING id`,
      [code, input.name, input.description || "", input.campaignId || null, input.benefitType,
        money(input.benefitValue), percentage,
        input.maxBenefit === undefined || input.maxBenefit === null ? null : money(input.maxBenefit),
        money(input.minTransaction), input.audienceId || null,
        Array.isArray(input.eligibleServices) ? input.eligibleServices : [],
        input.merchantId || null, input.startsAt || null, input.expiresAt || null,
        input.usageLimit ? Number(input.usageLimit) : null,
        Number(input.perUserLimit) > 0 ? Number(input.perUserLimit) : 1,
        input.budgetTotal === undefined || input.budgetTotal === null ? null : money(input.budgetTotal),
        actor.adminId]);
    const { rows: created } = await pool.query(`${PROMOTION_SELECT} WHERE p.id = $1`, [rows[0].id]);
    return promotionResponse(created[0]);
  } catch (error) {
    if (error.code === "23505") throw new AppError(409, `The coupon code ${code} is already in use.`);
    throw error;
  }
}

async function updatePromotionStatus(actor, id, status) {
  if (!PROMOTION_STATUSES.includes(status)) throw new AppError(400, "Unknown promotion status.");
  const { rows } = await pool.query(
    "UPDATE marketing_promotions SET status=$2, updated_at=NOW() WHERE id=$1 RETURNING *", [id, status]);
  if (!rows[0]) throw new AppError(404, "Promotion not found");
  return promotionResponse(rows[0]);
}

// What is this customer entitled to, and may they have it?
//
// Every rule is evaluated here, server-side, against the stored promotion —
// nothing about the benefit is taken from the caller except the transaction
// amount, and even that is re-read from the transactions table when a
// transaction id is supplied.
//
// The whole check-and-record runs inside one transaction behind an advisory
// lock on (promotion, user). That is what makes two simultaneous redemptions of
// a single-use coupon resolve to one grant and one refusal, rather than both
// reading "0 used" and both succeeding.
async function grantPromotion(actor, { code, userId, transactionId, transactionAmount, idempotencyKey }) {
  if (!idempotencyKey) throw new AppError(400, "An idempotency key is required to grant a promotion.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: promoRows } = await client.query(
      `SELECT * FROM marketing_promotions WHERE UPPER(code) = UPPER($1) FOR UPDATE`, [String(code || "")]);
    const promotion = promoRows[0];
    if (!promotion) throw new AppError(404, "That promotion code was not recognised.");

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",
      [`promo:${promotion.id}:${userId}`]);

    // A replay returns the original grant rather than making a second one.
    const { rows: replay } = await client.query(
      `SELECT * FROM marketing_promo_redemptions WHERE promotion_id=$1 AND idempotency_key=$2`,
      [promotion.id, idempotencyKey]);
    if (replay[0]) {
      await client.query("ROLLBACK");
      return { replay: true, benefitAmount: money(replay[0].benefit_amount), redemptionId: replay[0].id };
    }

    if (promotion.status !== "active") throw new AppError(409, "This promotion is not currently active.");
    const now = new Date();
    if (promotion.starts_at && new Date(promotion.starts_at) > now) {
      throw new AppError(409, "This promotion has not started yet.");
    }
    if (promotion.expires_at && new Date(promotion.expires_at) < now) {
      throw new AppError(409, "This promotion has expired.");
    }

    // The amount the benefit is calculated from is the one the ledger recorded,
    // never a number supplied by a caller, whenever a transaction is named.
    let baseAmount = money(transactionAmount);
    if (transactionId) {
      const { rows: txRows } = await client.query(
        "SELECT amount, user_id FROM transactions WHERE id = $1", [transactionId]);
      if (!txRows[0]) throw new AppError(404, "That transaction was not found.");
      if (txRows[0].user_id !== userId) throw new AppError(403, "That transaction belongs to another customer.");
      baseAmount = money(txRows[0].amount);
    }
    if (baseAmount < money(promotion.min_transaction)) {
      throw new AppError(409,
        `This promotion needs a transaction of at least R${money(promotion.min_transaction).toFixed(2)}.`);
    }

    const { rows: usage } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE user_id = $2)::int AS by_user,
              COALESCE(SUM(benefit_amount), 0) AS spent
         FROM marketing_promo_redemptions
        WHERE promotion_id = $1 AND status = 'granted'`, [promotion.id, userId]);
    const used = usage[0];
    if (promotion.usage_limit !== null && used.total >= promotion.usage_limit) {
      throw new AppError(409, "This promotion has been fully claimed.");
    }
    if (used.by_user >= promotion.per_user_limit) {
      throw new AppError(409, "You have already used this promotion.");
    }

    if (promotion.audience_id) {
      const { rows: member } = await client.query(
        "SELECT 1 FROM marketing_audience_members WHERE audience_id=$1 AND user_id=$2",
        [promotion.audience_id, userId]);
      if (!member[0]) throw new AppError(403, "This promotion is not available on your account.");
    }

    const benefitAmount = calculateBenefit(promotion, baseAmount);

    const remainingBudget = promotion.budget_total === null
      ? null : money(promotion.budget_total) - money(used.spent);
    if (remainingBudget !== null && benefitAmount > remainingBudget) {
      throw new AppError(409, "This promotion's budget has been used up.");
    }

    const { rows: granted } = await client.query(
      `INSERT INTO marketing_promo_redemptions
         (promotion_id, user_id, transaction_id, benefit_amount, idempotency_key, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [promotion.id, userId, transactionId || null, benefitAmount, idempotencyKey,
        JSON.stringify({ baseAmount, grantedBy: actor?.adminId || "system" })]);

    // Mark a fully-claimed promotion so it stops being offered.
    if (promotion.usage_limit !== null && used.total + 1 >= promotion.usage_limit) {
      await client.query("UPDATE marketing_promotions SET status='exhausted', updated_at=NOW() WHERE id=$1",
        [promotion.id]);
    }

    await client.query("COMMIT");

    // NOTE — this is the money boundary, and it is intentional.
    //
    // What has happened is that an ENTITLEMENT has been recorded: this customer
    // is owed this benefit, once, provably. No wallet has been touched and no
    // balance exists in any marketing table.
    //
    // Turning an entitlement into money is a financial operation and belongs to
    // the existing transaction/wallet code, which already has the atomic debit,
    // the idempotency guard and the reconciliation behind it. Wiring that up is
    // a separate, explicitly-approved change; doing it here would make this
    // module a second payment engine, which the brief forbids.
    return { replay: false, redemptionId: granted[0].id, benefitAmount, promotionId: promotion.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function calculateBenefit(promotion, baseAmount) {
  const percentage = Number(promotion.benefit_percentage || 0);
  let benefit = percentage > 0
    ? money(baseAmount * (percentage / 100))
    : money(promotion.benefit_value);
  if (promotion.max_benefit !== null) benefit = Math.min(benefit, money(promotion.max_benefit));
  // A benefit can never exceed what the transaction was worth.
  if (baseAmount > 0) benefit = Math.min(benefit, baseAmount);
  return money(benefit);
}

module.exports = {
  CAMPAIGN_TYPES, CAMPAIGN_STATUSES, CHANNELS, LEAD_STATUSES, PROMOTION_STATUSES, BENEFIT_TYPES,
  BUDGET_WARNING_LEVELS,
  audiencePresetList, listAudiences, createAudience, buildAudience,
  listCampaigns, getCampaign, createCampaign, updateCampaign, recordCampaignSpend,
  listPromotions, createPromotion, updatePromotionStatus, grantPromotion, calculateBenefit,
  money
};
