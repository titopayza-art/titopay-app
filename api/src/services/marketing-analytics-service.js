"use strict";

// Marketing analytics, funnels and ROI.
//
// Performance is the design constraint here, not features. Every query in this
// file is either against a small marketing table, or against users/transactions
// bounded by an indexed date range — because the brief is explicit that opening
// a marketing dashboard must never be able to slow down a payment.
//
// Honesty is the other constraint. "Attributed revenue" is only ever the sum of
// revenue events we actually recorded against a campaign. Direct, assisted and
// estimated attribution are returned as separate numbers and never silently
// added together, so nobody reads a total that the underlying data does not
// support.

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { money } = require("./marketing-service");

const RANGES = {
  today: "1 day", "7d": "7 days", "30d": "30 days", month: "30 days",
  last_month: "60 days", quarter: "90 days", year: "365 days"
};

// Resolve a range key, or a custom from/to pair, into bounds. Everything is
// clamped so no caller can request an unbounded window.
function resolveRange({ range, from, to } = {}) {
  if (from || to) {
    const start = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    const end = to ? new Date(to) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError(400, "Enter valid from and to dates.");
    }
    if (end < start) throw new AppError(400, "The end date is before the start date.");
    const maxDays = 400;
    if ((end - start) / 86400000 > maxDays) {
      throw new AppError(400, `Choose a range of ${maxDays} days or less.`);
    }
    return { start, end, label: "custom" };
  }
  const key = RANGES[range] ? range : "30d";
  const days = Number(RANGES[key].split(" ")[0]);
  return { start: new Date(Date.now() - days * 86400000), end: new Date(), label: key };
}

// The Overview cards.
//
// Counts over users and merchants are date-bounded and hit created_at indexes;
// everything else is a small marketing table. There is no unbounded COUNT(*)
// over users anywhere in here.
async function overview(rangeInput) {
  const { start, end, label } = resolveRange(rangeInput);

  const [campaigns, leads, merchantsAcquired, referrals, spend, attributed, newUsers] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
              COUNT(*)::int AS total
         FROM marketing_campaigns`),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at BETWEEN $1 AND $2)::int AS new_leads,
              COUNT(*) FILTER (WHERE status IN ('qualified','demo','negotiation','kyc','approved','activated'))::int AS qualified,
              COUNT(*) FILTER (WHERE status='activated')::int AS activated
         FROM marketing_leads`, [start, end]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM merchants WHERE created_at BETWEEN $1 AND $2`, [start, end]),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('qualified','rewarded'))::int AS converted
         FROM marketing_referrals`),
    pool.query(
      `SELECT COALESCE(SUM(amount),0) AS spend FROM marketing_campaign_spend
        WHERE spent_on BETWEEN $1::date AND $2::date`, [start, end]),
    pool.query(
      `SELECT attribution, COALESCE(SUM(revenue_amount),0) AS revenue
         FROM marketing_campaign_events
        WHERE event_type='revenue' AND created_at BETWEEN $1 AND $2
        GROUP BY attribution`, [start, end]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE created_at BETWEEN $1 AND $2`, [start, end])
  ]);

  const revenueByAttribution = { direct: 0, assisted: 0, estimated: 0 };
  for (const row of attributed.rows) revenueByAttribution[row.attribution] = money(row.revenue);

  const marketingSpend = money(spend.rows[0].spend);
  const directRevenue = revenueByAttribution.direct;
  const leadRow = leads.rows[0];

  return {
    range: { label, from: start.toISOString(), to: end.toISOString() },
    cards: {
      activeCampaigns: campaigns.rows[0].active,
      totalCampaigns: campaigns.rows[0].total,
      totalLeads: leadRow.total,
      newLeads: leadRow.new_leads,
      qualifiedLeads: leadRow.qualified,
      merchantsAcquired: merchantsAcquired.rows[0].n,
      newUsers: newUsers.rows[0].n,
      referralConversions: referrals.rows[0].converted,
      campaignConversionRate: leadRow.total > 0
        ? Math.round((leadRow.activated / leadRow.total) * 1000) / 10 : 0,
      marketingSpend,
      // Only direct revenue is headlined. Assisted and estimated are alongside
      // it, never folded in, so nobody quotes a number the data cannot defend.
      revenueAttributed: directRevenue,
      revenueAssisted: revenueByAttribution.assisted,
      revenueEstimated: revenueByAttribution.estimated,
      marketingRoiPercent: marketingSpend > 0
        ? Math.round(((directRevenue - marketingSpend) / marketingSpend) * 1000) / 10 : null
    }
  };
}

// Daily series for the Overview charts. Grouped in the database rather than in
// Node so only the plotted points cross the wire.
async function timeseries(rangeInput) {
  const { start, end } = resolveRange(rangeInput);
  const [users, merchants, events] = await Promise.all([
    pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*)::int AS n
         FROM users WHERE created_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`, [start, end]),
    pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*)::int AS n
         FROM merchants WHERE created_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`, [start, end]),
    pool.query(
      `SELECT DATE(created_at) AS day,
              COUNT(*) FILTER (WHERE event_type='click')::int AS clicks,
              COUNT(*) FILTER (WHERE event_type='registration')::int AS registrations,
              COALESCE(SUM(revenue_amount) FILTER (WHERE event_type='revenue'),0) AS revenue
         FROM marketing_campaign_events WHERE created_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`, [start, end])
  ]);
  return {
    userAcquisition: users.rows.map((row) => ({ day: row.day, value: row.n })),
    merchantAcquisition: merchants.rows.map((row) => ({ day: row.day, value: row.n })),
    campaignActivity: events.rows.map((row) => ({
      day: row.day, clicks: row.clicks, registrations: row.registrations, revenue: money(row.revenue)
    }))
  };
}

// The two funnels the brief asks for. Customer steps come from recorded
// campaign events; merchant steps come from the leads table, which is the
// authoritative record of a sales journey.
async function funnels(rangeInput) {
  const { start, end } = resolveRange(rangeInput);
  const customer = await pool.query(
    `SELECT event_type, COUNT(*)::int AS n
       FROM marketing_campaign_events
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY event_type`, [start, end]);
  const byType = new Map(customer.rows.map((row) => [row.event_type, row.n]));

  const merchant = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM marketing_leads GROUP BY status`);
  const byStatus = new Map(merchant.rows.map((row) => [row.status, row.n]));
  // A lead that reached "approved" also passed through "qualified", so each
  // stage counts everyone at or beyond it. Counting only the current status
  // would draw a funnel that widens, which is nonsense.
  const order = ["new", "contacted", "qualified", "demo", "negotiation", "kyc", "approved", "activated"];
  const cumulative = (from) => order.slice(order.indexOf(from))
    .reduce((sum, stage) => sum + Number(byStatus.get(stage) || 0), 0);

  return {
    customer: [
      { step: "Impressions", value: byType.get("impression") || 0 },
      { step: "Clicks", value: byType.get("click") || 0 },
      { step: "Registrations", value: byType.get("registration") || 0 },
      { step: "KYC", value: byType.get("kyc_completed") || 0 },
      { step: "First deposit", value: byType.get("first_deposit") || 0 },
      { step: "First transaction", value: byType.get("first_transaction") || 0 }
    ],
    merchant: order.map((stage) => ({
      step: stage.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      value: cumulative(stage)
    }))
  };
}

// Per-campaign ROI. Cost and revenue come from two separate append-only tables,
// so neither can be quietly rewritten to flatter a number.
async function roi(rangeInput) {
  const { start, end } = resolveRange(rangeInput);
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.campaign_type, c.status, c.budget_allocated,
            COALESCE(s.spend, 0) AS spend,
            COALESCE(r.direct, 0) AS direct_revenue,
            COALESCE(r.assisted, 0) AS assisted_revenue,
            COALESCE(r.estimated, 0) AS estimated_revenue,
            COALESCE(r.conversions, 0) AS conversions
       FROM marketing_campaigns c
       LEFT JOIN LATERAL (
         SELECT SUM(amount) AS spend FROM marketing_campaign_spend
          WHERE campaign_id = c.id AND spent_on BETWEEN $1::date AND $2::date
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(revenue_amount) FILTER (WHERE attribution='direct') AS direct,
                SUM(revenue_amount) FILTER (WHERE attribution='assisted') AS assisted,
                SUM(revenue_amount) FILTER (WHERE attribution='estimated') AS estimated,
                COUNT(*) FILTER (WHERE event_type='revenue')::int AS conversions
           FROM marketing_campaign_events
          WHERE campaign_id = c.id AND created_at BETWEEN $1 AND $2
       ) r ON TRUE
      WHERE c.status <> 'archived'
      ORDER BY COALESCE(r.direct,0) DESC
      LIMIT 100`, [start, end]);

  return rows.map((row) => {
    const spend = money(row.spend);
    const direct = money(row.direct_revenue);
    return {
      campaignId: row.id,
      name: row.name,
      type: row.campaign_type,
      status: row.status,
      budgetAllocated: money(row.budget_allocated),
      marketingCost: spend,
      directRevenue: direct,
      assistedRevenue: money(row.assisted_revenue),
      estimatedRevenue: money(row.estimated_revenue),
      conversions: Number(row.conversions),
      grossReturn: direct,
      netReturn: money(direct - spend),
      roiPercent: spend > 0 ? Math.round(((direct - spend) / spend) * 1000) / 10 : null,
      // Say so rather than printing a confident 0%: a campaign with revenue and
      // no recorded cost has an ROI nobody can compute.
      note: spend === 0 && direct > 0 ? "No cost recorded, so ROI cannot be calculated" : null
    };
  });
}

// Acquisition cost. Deliberately reported as two separate numbers with their
// own denominators; a blended CAC across customers and merchants would be a
// number that means nothing.
async function acquisitionCost(rangeInput) {
  const { start, end } = resolveRange(rangeInput);
  const [spend, users, merchants, leadConversion] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS n FROM marketing_campaign_spend
                 WHERE spent_on BETWEEN $1::date AND $2::date`, [start, end]),
    pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at BETWEEN $1 AND $2`, [start, end]),
    pool.query(`SELECT COUNT(*)::int AS n FROM merchants WHERE created_at BETWEEN $1 AND $2`, [start, end]),
    pool.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status='activated')::int AS activated
                  FROM marketing_leads WHERE created_at BETWEEN $1 AND $2`, [start, end])
  ]);
  const totalSpend = money(spend.rows[0].n);
  const newUsers = users.rows[0].n;
  const newMerchants = merchants.rows[0].n;
  const leads = leadConversion.rows[0];
  return {
    marketingSpend: totalSpend,
    newUsers,
    newMerchants,
    customerAcquisitionCost: newUsers > 0 ? money(totalSpend / newUsers) : null,
    merchantAcquisitionCost: newMerchants > 0 ? money(totalSpend / newMerchants) : null,
    leadToMerchantConversion: leads.total > 0
      ? Math.round((leads.activated / leads.total) * 1000) / 10 : 0,
    caveat: "Acquisition cost divides all recorded marketing spend by everyone who joined in the period, "
      + "including people no campaign reached. Treat it as an upper bound, not a per-campaign figure."
  };
}

module.exports = { resolveRange, overview, timeseries, funnels, roi, acquisitionCost, RANGES };
