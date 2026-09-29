"use strict";

// Marketing & Sales Command Centre — leads, pipeline, links, referrals,
// experiments, analytics and ROI.
//
// Split from marketing-service.js so neither file becomes the kind of
// thousands-of-lines module that nobody wants to change. Same rules apply: no
// wallet writes, no message delivery, no copies of users/merchants/transactions.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { money } = require("./marketing-service");

const LEAD_STATUSES = ["new", "contacted", "qualified", "demo", "negotiation", "kyc",
  "approved", "activated", "lost"];
// The pipeline order shown on the Kanban board. "lost" is deliberately not a
// column: a lost lead leaves the pipeline rather than sitting at the end of it.
const PIPELINE_STAGES = ["new", "contacted", "qualified", "demo", "negotiation", "kyc",
  "approved", "activated"];

const LINK_EVENT_TYPES = ["click", "registration", "kyc_completed", "first_transaction",
  "merchant_application", "merchant_activated", "revenue"];

/* ========================================================================== */
/* Trackable links                                                            */
/* ========================================================================== */

// Where a marketing link is allowed to send someone.
//
// An unvalidated destination on a TitoPay domain is an open redirect: an
// attacker generates a link that looks like TitoPay and lands the customer on a
// phishing page. Only https, only hosts we own, and the list is configurable so
// a genuine new property does not need a code change.
function allowedLinkHosts() {
  const configured = String(process.env.MARKETING_LINK_ALLOWED_HOSTS || "").trim();
  if (configured) return configured.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  return ["titopay.co.za", "www.titopay.co.za", "api.titopay.co.za", "admin.titopay.co.za"];
}

function validateDestination(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch (error) {
    throw new AppError(400, "Enter a full destination address, starting with https://");
  }
  if (parsed.protocol !== "https:") {
    throw new AppError(400, "A marketing link must point at an https address.");
  }
  // Credentials in a URL are never legitimate here and are a classic way to
  // disguise the real host (https://titopay.co.za@evil.example).
  if (parsed.username || parsed.password) {
    throw new AppError(400, "A destination address may not contain a username or password.");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = allowedLinkHosts();
  const permitted = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!permitted) {
    throw new AppError(400, `Links may only point at TitoPay addresses (${allowed.join(", ")}).`);
  }
  return parsed.toString();
}

function generateSlug() {
  // 8 characters from a 32-symbol alphabet, drawn from a cryptographic source
  // so a slug cannot be guessed and someone else's attribution hijacked.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function listLinks({ campaignId } = {}) {
  const params = [];
  let where = "";
  if (campaignId) {
    params.push(campaignId);
    where = "WHERE l.campaign_id = $1";
  }
  const { rows } = await pool.query(
    `SELECT l.*, c.name AS campaign_name, a.full_name AS salesperson_name,
            COALESCE(e.clicks,0) AS clicks, COALESCE(e.registrations,0) AS registrations,
            COALESCE(e.kyc,0) AS kyc_completions, COALESCE(e.first_transactions,0) AS first_transactions,
            COALESCE(e.merchants,0) AS merchants_activated, COALESCE(e.revenue,0) AS revenue
       FROM marketing_links l
       LEFT JOIN marketing_campaigns c ON c.id = l.campaign_id
       LEFT JOIN admin_users a ON a.id = l.salesperson_admin_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE event_type='click')::int AS clicks,
                COUNT(*) FILTER (WHERE event_type='registration')::int AS registrations,
                COUNT(*) FILTER (WHERE event_type='kyc_completed')::int AS kyc,
                COUNT(*) FILTER (WHERE event_type='first_transaction')::int AS first_transactions,
                COUNT(*) FILTER (WHERE event_type='merchant_activated')::int AS merchants,
                COALESCE(SUM(revenue_amount),0) AS revenue
           FROM marketing_link_events WHERE link_id = l.id
       ) e ON TRUE
       ${where}
      ORDER BY l.created_at DESC LIMIT 200`, params);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    label: row.label,
    url: `https://${allowedLinkHosts()[0]}/r/${row.slug}`,
    destinationUrl: row.destination_url,
    linkType: row.link_type,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name || null,
    source: row.source,
    medium: row.medium,
    content: row.content,
    salespersonName: row.salesperson_name || null,
    status: row.status,
    funnel: {
      clicks: Number(row.clicks),
      registrations: Number(row.registrations),
      kycCompletions: Number(row.kyc_completions),
      firstTransactions: Number(row.first_transactions),
      merchantsActivated: Number(row.merchants_activated),
      revenue: money(row.revenue)
    },
    createdAt: row.created_at
  }));
}

async function createLink(actor, input) {
  const destination = validateDestination(input.destinationUrl);
  // Retry on the astronomically unlikely slug collision rather than failing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = String(input.slug || "").trim().toLowerCase() || generateSlug();
    if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(slug)) {
      throw new AppError(400, "A link slug must be 3–40 characters: lowercase letters, numbers, hyphen or underscore.");
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO marketing_links
           (slug, label, campaign_id, source, medium, content, salesperson_admin_id,
            affiliate_id, destination_url, link_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [slug, input.label || "", input.campaignId || null, input.source || "", input.medium || "",
          input.content || "", input.salespersonAdminId || null, input.affiliateId || null,
          destination, input.linkType || "generic", actor.adminId]);
      const [created] = await listLinks({});
      return (await listLinks({})).find((link) => link.id === rows[0].id) || created;
    } catch (error) {
      if (error.code === "23505" && !input.slug) continue;
      if (error.code === "23505") throw new AppError(409, "That link slug is already in use.");
      throw error;
    }
  }
  throw new AppError(500, "A unique link could not be generated. Please try again.");
}

// Records a step of the funnel against a link. Called by the redirect handler
// for a click, and by attribution jobs for the later steps.
async function recordLinkEvent({ linkId, eventType, userId = null, merchantId = null,
  leadId = null, revenueAmount = 0, metadata = {} }) {
  if (!LINK_EVENT_TYPES.includes(eventType)) throw new AppError(400, "Unknown link event.");
  const { rows } = await pool.query(
    `INSERT INTO marketing_link_events
       (link_id, event_type, user_id, merchant_id, lead_id, revenue_amount, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
    [linkId, eventType, userId, merchantId, leadId, money(revenueAmount), JSON.stringify(metadata)]);
  return rows[0].id;
}

/* ========================================================================== */
/* Leads and pipeline                                                         */
/* ========================================================================== */

function leadResponse(row) {
  return {
    id: row.id,
    reference: row.reference,
    businessName: row.business_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    businessCategory: row.business_category,
    location: row.location,
    source: row.source,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name || null,
    assignedAdminId: row.assigned_admin_id,
    assignedTo: row.assigned_name || null,
    status: row.status,
    lostReason: row.lost_reason,
    expectedRevenue: money(row.expected_revenue),
    nextFollowUpAt: row.next_follow_up_at,
    merchantId: row.merchant_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const LEAD_SELECT = `
  SELECT l.*, a.full_name AS assigned_name, c.name AS campaign_name
    FROM marketing_leads l
    LEFT JOIN admin_users a ON a.id = l.assigned_admin_id
    LEFT JOIN marketing_campaigns c ON c.id = l.campaign_id`;

async function listLeads({ status, assignedAdminId, search, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status && LEAD_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (assignedAdminId) {
    params.push(assignedAdminId);
    conditions.push(`l.assigned_admin_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    conditions.push(`(LOWER(l.business_name) LIKE $${params.length}
                      OR LOWER(COALESCE(l.contact_name,'')) LIKE $${params.length}
                      OR LOWER(COALESCE(l.email,'')) LIKE $${params.length}
                      OR LOWER(l.reference) LIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await pool.query(
    `SELECT COUNT(*)::int n FROM marketing_leads l ${where}`, params);
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
  const { rows } = await pool.query(
    `${LEAD_SELECT} ${where} ORDER BY l.updated_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.map(leadResponse), total: countResult.rows[0].n };
}

async function getLead(id) {
  const { rows } = await pool.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
  if (!rows[0]) throw new AppError(404, "Lead not found");
  const activities = await pool.query(
    `SELECT ac.*, a.full_name AS admin_name
       FROM marketing_lead_activities ac
       LEFT JOIN admin_users a ON a.id = ac.admin_id
      WHERE ac.lead_id = $1 ORDER BY ac.created_at DESC LIMIT 200`, [id]);
  return {
    ...leadResponse(rows[0]),
    activities: activities.rows.map((row) => ({
      id: row.id,
      type: row.activity_type,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      note: row.note,
      adminName: row.admin_name || null,
      createdAt: row.created_at
    }))
  };
}

async function createLead(actor, input) {
  const businessName = String(input.businessName || "").trim();
  if (businessName.length < 2) throw new AppError(400, "Enter the business name.");
  const reference = `LEAD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO marketing_leads
        (reference, business_name, contact_name, email, phone, business_category, location,
         source, campaign_id, link_id, assigned_admin_id, expected_revenue, next_follow_up_at,
         notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [reference, businessName, input.contactName || "", input.email || null, input.phone || null,
        input.businessCategory || null, input.location || null, input.source || "manual",
        input.campaignId || null, input.linkId || null, input.assignedAdminId || null,
        money(input.expectedRevenue), input.nextFollowUpAt || null, input.notes || "", actor.adminId]);
    await client.query(
      `INSERT INTO marketing_lead_activities (lead_id, admin_id, activity_type, to_status, note)
       VALUES ($1,$2,'created','new',$3)`,
      [rows[0].id, actor.adminId, `Lead created from ${input.source || "manual"}`]);
    await client.query("COMMIT");
    return getLead(rows[0].id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Every change writes an activity row in the same transaction as the change, so
// the history cannot disagree with the lead. A status move that fails leaves
// neither behind.
async function updateLead(actor, id, input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: currentRows } = await client.query(
      "SELECT * FROM marketing_leads WHERE id = $1 FOR UPDATE", [id]);
    const current = currentRows[0];
    if (!current) throw new AppError(404, "Lead not found");

    if (input.status && !LEAD_STATUSES.includes(input.status)) {
      throw new AppError(400, "Unknown lead status.");
    }
    if (input.status === "lost" && !String(input.lostReason || "").trim()) {
      throw new AppError(400, "Give a reason when marking a lead lost.");
    }

    await client.query(
      `UPDATE marketing_leads SET
         business_name = COALESCE($2, business_name),
         contact_name = COALESCE($3, contact_name),
         email = COALESCE($4, email),
         phone = COALESCE($5, phone),
         business_category = COALESCE($6, business_category),
         location = COALESCE($7, location),
         assigned_admin_id = COALESCE($8, assigned_admin_id),
         status = COALESCE($9, status),
         lost_reason = COALESCE($10, lost_reason),
         expected_revenue = COALESCE($11, expected_revenue),
         next_follow_up_at = COALESCE($12, next_follow_up_at),
         notes = COALESCE($13, notes),
         merchant_id = COALESCE($14, merchant_id),
         updated_at = NOW()
       WHERE id = $1`,
      [id, input.businessName ?? null, input.contactName ?? null, input.email ?? null,
        input.phone ?? null, input.businessCategory ?? null, input.location ?? null,
        input.assignedAdminId ?? null, input.status ?? null, input.lostReason ?? null,
        input.expectedRevenue === undefined ? null : money(input.expectedRevenue),
        input.nextFollowUpAt ?? null, input.notes ?? null, input.merchantId ?? null]);

    if (input.status && input.status !== current.status) {
      await client.query(
        `INSERT INTO marketing_lead_activities
           (lead_id, admin_id, activity_type, from_status, to_status, note)
         VALUES ($1,$2,'status_change',$3,$4,$5)`,
        [id, actor.adminId, current.status, input.status, String(input.note || input.lostReason || "")]);
    }
    if (input.assignedAdminId && input.assignedAdminId !== current.assigned_admin_id) {
      await client.query(
        `INSERT INTO marketing_lead_activities (lead_id, admin_id, activity_type, note)
         VALUES ($1,$2,'assignment',$3)`,
        [id, actor.adminId, "Lead reassigned"]);
    }
    if (input.note && !input.status) {
      await client.query(
        `INSERT INTO marketing_lead_activities (lead_id, admin_id, activity_type, note)
         VALUES ($1,$2,'note',$3)`, [id, actor.adminId, String(input.note).slice(0, 2000)]);
    }

    await client.query("COMMIT");
    return { before: current, after: await getLead(id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Counts and value per stage. One grouped query over an indexed column, so the
// board stays cheap however many leads accumulate.
async function salesPipeline() {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(expected_revenue),0) AS value
       FROM marketing_leads WHERE status <> 'lost' GROUP BY status`);
  const byStatus = new Map(rows.map((row) => [row.status, row]));
  const lost = await pool.query(
    "SELECT COUNT(*)::int AS count FROM marketing_leads WHERE status = 'lost'");
  return {
    stages: PIPELINE_STAGES.map((stage) => ({
      stage,
      count: Number(byStatus.get(stage)?.count || 0),
      value: money(byStatus.get(stage)?.value || 0)
    })),
    lost: Number(lost.rows[0].count),
    totalPipelineValue: money(rows.reduce((sum, row) => sum + Number(row.value || 0), 0))
  };
}

// Sales team performance. Reuses admin_users — the brief is explicit that this
// must not become a second staff directory, so there is no employee table here
// and nothing is stored about a person beyond the leads they own.
async function salesTeam() {
  const { rows } = await pool.query(
    `SELECT a.id, a.full_name, a.role,
            COUNT(l.id)::int AS assigned,
            COUNT(*) FILTER (WHERE l.status = 'contacted')::int AS contacted,
            COUNT(*) FILTER (WHERE l.status = 'qualified')::int AS qualified,
            COUNT(*) FILTER (WHERE l.status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE l.status = 'activated')::int AS activated,
            COUNT(*) FILTER (WHERE l.status = 'lost')::int AS lost,
            COALESCE(SUM(l.expected_revenue) FILTER (WHERE l.status NOT IN ('lost','activated')),0) AS pipeline_value
       FROM admin_users a
       JOIN marketing_leads l ON l.assigned_admin_id = a.id
      GROUP BY a.id, a.full_name, a.role
      ORDER BY activated DESC, assigned DESC
      LIMIT 100`);
  return rows.map((row) => ({
    adminId: row.id,
    name: row.full_name,
    role: row.role,
    assigned: row.assigned,
    contacted: row.contacted,
    qualified: row.qualified,
    approved: row.approved,
    activated: row.activated,
    lost: row.lost,
    conversionRate: row.assigned > 0 ? Math.round((row.activated / row.assigned) * 1000) / 10 : 0,
    pipelineValue: money(row.pipeline_value)
  }));
}

/* ========================================================================== */
/* Referrals                                                                  */
/* ========================================================================== */

async function listReferrals({ status, limit = 100 } = {}) {
  const params = [];
  let where = "";
  if (status) {
    params.push(status);
    where = "WHERE r.status = $1";
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  const { rows } = await pool.query(
    `SELECT r.*,
            referrer.username AS referrer_username,
            referred.username AS referred_username,
            referred.created_at AS referred_registered_at
       FROM marketing_referrals r
       LEFT JOIN users referrer ON referrer.id = r.referrer_user_id
       LEFT JOIN users referred ON referred.id = r.referred_user_id
       ${where}
      ORDER BY r.created_at DESC LIMIT $${params.length}`, params);
  // Usernames only. A referral list is not a reason to expose an email address,
  // a phone number or an ID number to whoever holds a marketing login.
  return rows.map((row) => ({
    id: row.id,
    referrerUsername: row.referrer_username || null,
    referredUsername: row.referred_username || null,
    referralCode: row.referral_code,
    status: row.status,
    registeredAt: row.registered_at,
    kycCompletedAt: row.kyc_completed_at,
    firstTransactionAt: row.first_transaction_at,
    qualifyingVolume: money(row.qualifying_volume),
    revenueGenerated: money(row.revenue_generated),
    rewardAmount: money(row.reward_amount),
    rewarded: Boolean(row.reward_transaction_id),
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at
  }));
}

// Re-evaluate a referral against the live state of the referred customer.
//
// The rule the brief insists on: registration alone is never enough. A referral
// only becomes `qualified` once the referred customer has completed KYC AND
// completed a real transaction. Everything is read from the source tables, so a
// referral cannot be talked into qualifying by anything a client sends.
async function evaluateReferral(referralId) {
  const { rows } = await pool.query("SELECT * FROM marketing_referrals WHERE id = $1", [referralId]);
  const referral = rows[0];
  if (!referral) throw new AppError(404, "Referral not found");
  if (!referral.referred_user_id) return { status: referral.status, reason: "No referred customer yet" };
  if (referral.status === "rewarded") return { status: "rewarded", reason: "Already rewarded" };

  const { rows: facts } = await pool.query(
    `SELECT u.created_at AS registered_at,
            u.fica_status,
            (SELECT MIN(t.created_at) FROM transactions t
              WHERE t.user_id = u.id AND t.status = 'completed') AS first_transaction_at,
            (SELECT COALESCE(SUM(t.amount),0) FROM transactions t
              WHERE t.user_id = u.id AND t.status = 'completed') AS volume
       FROM users u WHERE u.id = $1`, [referral.referred_user_id]);
  const fact = facts[0];
  if (!fact) throw new AppError(404, "The referred customer no longer exists");

  const kycDone = String(fact.fica_status || "").toLowerCase() === "verified";
  const transacted = Boolean(fact.first_transaction_at);
  const qualified = kycDone && transacted;

  await pool.query(
    `UPDATE marketing_referrals
        SET registered_at = COALESCE(registered_at, $2),
            kyc_completed_at = CASE WHEN $3 THEN COALESCE(kyc_completed_at, NOW()) ELSE kyc_completed_at END,
            first_transaction_at = COALESCE(first_transaction_at, $4),
            qualifying_volume = $5,
            status = CASE WHEN status = 'rejected' THEN 'rejected'
                          WHEN $6 THEN 'qualified' ELSE 'pending' END,
            updated_at = NOW()
      WHERE id = $1`,
    [referralId, fact.registered_at, kycDone, fact.first_transaction_at, money(fact.volume), qualified]);

  return {
    status: qualified ? "qualified" : "pending",
    kycCompleted: kycDone,
    hasTransacted: transacted,
    reason: qualified ? "KYC complete and first transaction settled"
      : !kycDone ? "Waiting on KYC" : "Waiting on a first completed transaction"
  };
}

/* ========================================================================== */
/* Experiments                                                                */
/* ========================================================================== */

async function listExperiments() {
  const { rows } = await pool.query(
    `SELECT e.*, a.name AS audience_name
       FROM marketing_experiments e
       LEFT JOIN marketing_audiences a ON a.id = e.audience_id
      ORDER BY e.created_at DESC LIMIT 100`);
  const variants = await pool.query(
    `SELECT v.*,
            COALESCE(x.assigned,0) AS assigned,
            COALESCE(x.converted,0) AS converted,
            COALESCE(x.revenue,0) AS revenue
       FROM marketing_experiment_variants v
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS assigned,
                COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted,
                COALESCE(SUM(revenue_amount),0) AS revenue
           FROM marketing_experiment_assignments WHERE variant_id = v.id
       ) x ON TRUE`);
  const byExperiment = new Map();
  for (const variant of variants.rows) {
    if (!byExperiment.has(variant.experiment_id)) byExperiment.set(variant.experiment_id, []);
    byExperiment.get(variant.experiment_id).push({
      id: variant.id,
      name: variant.name,
      description: variant.description,
      allocationPercent: Number(variant.allocation_percent),
      cost: money(variant.cost),
      assigned: variant.assigned,
      converted: variant.converted,
      conversionRate: variant.assigned > 0
        ? Math.round((variant.converted / variant.assigned) * 1000) / 10 : 0,
      revenue: money(variant.revenue),
      netRevenue: money(Number(variant.revenue) - Number(variant.cost)),
      roiPercent: Number(variant.cost) > 0
        ? Math.round(((Number(variant.revenue) - Number(variant.cost)) / Number(variant.cost)) * 1000) / 10
        : null
    });
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hypothesis: row.hypothesis,
    audienceId: row.audience_id,
    audienceName: row.audience_name || null,
    successMetric: row.success_metric,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    variants: byExperiment.get(row.id) || [],
    createdAt: row.created_at
  }));
}

async function createExperiment(actor, input) {
  const variants = Array.isArray(input.variants) ? input.variants : [];
  if (variants.length < 2) throw new AppError(400, "An experiment needs at least two variants to compare.");
  const totalAllocation = variants.reduce((sum, v) => sum + Number(v.allocationPercent || 0), 0);
  if (Math.abs(totalAllocation - 100) > 0.01) {
    throw new AppError(400, `Variant allocations must add up to 100%. They currently add up to ${totalAllocation}%.`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO marketing_experiments
         (name, hypothesis, audience_id, success_metric, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.name, input.hypothesis || "", input.audienceId || null,
        input.successMetric || "conversion_rate", input.startsAt || null, input.endsAt || null,
        actor.adminId]);
    for (const variant of variants) {
      await client.query(
        `INSERT INTO marketing_experiment_variants
           (experiment_id, name, description, promotion_id, campaign_id, allocation_percent, cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [rows[0].id, variant.name, variant.description || "", variant.promotionId || null,
          variant.campaignId || null, Number(variant.allocationPercent), money(variant.cost)]);
    }
    await client.query("COMMIT");
    return (await listExperiments()).find((experiment) => experiment.id === rows[0].id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Assign a customer to a variant, once and permanently.
//
// The allocation is a deterministic hash of (experiment, user) rather than a
// random draw, so the same customer always lands in the same variant even if
// this is called twice, and the unique index makes a concurrent second call a
// no-op that returns the original assignment. Moving a live customer between
// two different offers mid-experiment is what the brief forbids.
async function assignExperimentVariant(experimentId, userId) {
  const { rows: existing } = await pool.query(
    `SELECT a.*, v.name AS variant_name FROM marketing_experiment_assignments a
       JOIN marketing_experiment_variants v ON v.id = a.variant_id
      WHERE a.experiment_id = $1 AND a.user_id = $2`, [experimentId, userId]);
  if (existing[0]) {
    return { variantId: existing[0].variant_id, variantName: existing[0].variant_name, existing: true };
  }

  const { rows: experiment } = await pool.query(
    "SELECT status FROM marketing_experiments WHERE id = $1", [experimentId]);
  if (!experiment[0]) throw new AppError(404, "Experiment not found");
  if (experiment[0].status !== "running") throw new AppError(409, "That experiment is not running.");

  const { rows: variants } = await pool.query(
    `SELECT id, name, allocation_percent FROM marketing_experiment_variants
      WHERE experiment_id = $1 ORDER BY created_at`, [experimentId]);
  if (!variants.length) throw new AppError(409, "That experiment has no variants.");

  const digest = crypto.createHash("sha256").update(`${experimentId}:${userId}`).digest();
  const point = (digest.readUInt32BE(0) / 0xffffffff) * 100;
  let cumulative = 0;
  let chosen = variants[variants.length - 1];
  for (const variant of variants) {
    cumulative += Number(variant.allocation_percent);
    if (point < cumulative) { chosen = variant; break; }
  }

  try {
    await pool.query(
      `INSERT INTO marketing_experiment_assignments (experiment_id, variant_id, user_id)
       VALUES ($1,$2,$3)`, [experimentId, chosen.id, userId]);
  } catch (error) {
    if (error.code !== "23505") throw error;
    return assignExperimentVariant(experimentId, userId);
  }
  return { variantId: chosen.id, variantName: chosen.name, existing: false };
}

module.exports = {
  LEAD_STATUSES, PIPELINE_STAGES, LINK_EVENT_TYPES,
  allowedLinkHosts, validateDestination, generateSlug,
  listLinks, createLink, recordLinkEvent,
  listLeads, getLead, createLead, updateLead, salesPipeline, salesTeam,
  listReferrals, evaluateReferral,
  listExperiments, createExperiment, assignExperimentVariant
};
