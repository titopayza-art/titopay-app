const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");

// Admin-published offers shown on the customer Rewards screen: promotions,
// discounts, coupon codes, adverts and notices. Publications go through the
// same approval seats as in-app announcements (CEO / COO / Senior Marketing),
// so nothing reaches every customer's phone on one person's say-so. Nothing
// here moves money: a coupon is a display code redeemed through the rails that
// already price it, and a withdrawn or expired publication simply stops being
// served. The shape (runtime-ensured schema, pending -> decided workflow,
// decide-once status transitions) mirrors account_closure_requests beside it.

const REWARD_KINDS = ["promotion", "discount", "coupon", "advert", "notice"];
const REWARD_AUDIENCES = ["personal", "business", "both"];

let rewardsSchemaReady = false;

async function ensureRewardsSchema(queryable = pool) {
  if (rewardsSchemaReady && queryable === pool) return;
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS reward_publications (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('promotion', 'discount', 'coupon', 'advert', 'notice')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      coupon_code TEXT,
      audience TEXT NOT NULL DEFAULT 'both' CHECK (audience IN ('personal', 'business', 'both')),
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('pending_approval', 'live', 'rejected', 'withdrawn')),
      copy_count INTEGER NOT NULL DEFAULT 0,
      created_by UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
      decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS idx_reward_publications_status ON reward_publications (status, created_at DESC)"
  );
  // Ad image (build 91): a poster-style banner shown in the Rewards carousel
  // and on the Services screen's Rewards banner. Metadata-only migration.
  await queryable.query(
    "ALTER TABLE reward_publications ADD COLUMN IF NOT EXISTS image_url TEXT"
  );
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS reward_publication_reads (
      publication_id UUID NOT NULL REFERENCES reward_publications(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (publication_id, user_id)
    )
  `);
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS idx_reward_publication_reads_user ON reward_publication_reads (user_id, seen_at DESC)"
  );
  if (queryable === pool) rewardsSchemaReady = true;
}

function customerAudience(accountType) {
  return String(accountType || "").toLowerCase() === "business" ? "business" : "personal";
}

// The ad image, exactly the event-poster contract: an uploaded image arrives
// as a base64 data URL (the admin console resizes first, this is the
// backstop), a plain http(s) URL stays working, anything else is dropped.
function cleanRewardImage(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)) {
    if (Buffer.byteLength(raw, "utf8") > 700 * 1024) {
      throw new AppError(413, "The ad image is too large. Choose a smaller image.");
    }
    return raw;
  }
  if (/^https?:\/\//i.test(raw)) return raw.slice(0, 800);
  throw new AppError(400, "The ad image must be an uploaded JPG, PNG or WebP");
}

function publicPublication(row = {}) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    imageUrl: row.image_url || "",
    couponCode: row.coupon_code || "",
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    publishedAt: row.decided_at || row.created_at,
    seen: Boolean(row.seen)
  };
}

// The one WHERE clause that decides what a customer may ever see. Live,
// inside its window, and aimed at their account type — everything else
// (pending, rejected, withdrawn, expired, scheduled) simply does not exist
// from the customer's side.
const CUSTOMER_VISIBLE_SQL = `
      p.status = 'live'
  AND (p.starts_at IS NULL OR p.starts_at <= NOW())
  AND (p.ends_at IS NULL OR p.ends_at > NOW())
  AND (p.audience = 'both' OR p.audience = $2)
`;

async function listRewardsForCustomer(userId, accountType) {
  await ensureRewardsSchema();
  const { rows } = await pool.query(
    `SELECT p.*, (r.user_id IS NOT NULL) AS seen
       FROM reward_publications p
       LEFT JOIN reward_publication_reads r
         ON r.publication_id = p.id AND r.user_id = $1
      WHERE ${CUSTOMER_VISIBLE_SQL}
      ORDER BY p.decided_at DESC NULLS LAST, p.created_at DESC
      LIMIT 50`,
    [userId, customerAudience(accountType)]
  );
  const items = rows.map(publicPublication);
  return {
    items,
    unseenCount: items.filter((item) => !item.seen).length
  };
}

async function markRewardsSeen(userId, accountType) {
  await ensureRewardsSchema();
  await pool.query(
    `INSERT INTO reward_publication_reads (publication_id, user_id)
     SELECT p.id, $1 FROM reward_publications p
      WHERE ${CUSTOMER_VISIBLE_SQL}
     ON CONFLICT (publication_id, user_id) DO NOTHING`,
    [userId, customerAudience(accountType)]
  );
  return { unseenCount: 0 };
}

// Engagement, not entitlement: the counter only ever informs the marketing
// dashboard, so a miss here must never fail the customer's copy action.
async function recordCouponCopy(publicationId) {
  await ensureRewardsSchema();
  await pool.query(
    "UPDATE reward_publications SET copy_count = copy_count + 1, updated_at = NOW() WHERE id = $1 AND status = 'live'",
    [publicationId]
  );
  return { ok: true };
}

function boundedText(value, label, { min, max, required = true } = {}) {
  const text = String(value || "").trim();
  if (!text) {
    if (required) throw new AppError(400, `${label} is required`);
    return "";
  }
  if (min && text.length < min) throw new AppError(400, `${label} must be at least ${min} characters`);
  if (max && text.length > max) throw new AppError(400, `${label} must be at most ${max} characters`);
  return text;
}

function optionalDate(value, label) {
  if (value == null || String(value).trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(400, `${label} is not a valid date`);
  return date;
}

async function createPublication(payload = {}, adminId, meta = {}) {
  await ensureRewardsSchema();
  const kind = String(payload.kind || "").trim().toLowerCase();
  if (!REWARD_KINDS.includes(kind)) {
    throw new AppError(400, `Kind must be one of: ${REWARD_KINDS.join(", ")}`);
  }
  const audience = String(payload.audience || "both").trim().toLowerCase();
  if (!REWARD_AUDIENCES.includes(audience)) {
    throw new AppError(400, "Audience must be personal, business or both");
  }
  const title = boundedText(payload.title, "Title", { min: 3, max: 80 });
  const body = boundedText(payload.body, "Body", { min: 10, max: 600 });
  const couponCode = boundedText(payload.couponCode ?? payload.coupon_code, "Coupon code", {
    min: 3, max: 40, required: kind === "coupon"
  }).toUpperCase();
  const startsAt = optionalDate(payload.startsAt ?? payload.starts_at, "Start date");
  const endsAt = optionalDate(payload.endsAt ?? payload.ends_at, "End date");
  if (endsAt && endsAt.getTime() <= Date.now()) {
    throw new AppError(400, "The end date is already in the past");
  }
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new AppError(400, "The end date must come after the start date");
  }
  const imageUrl = cleanRewardImage(payload.imageUrl ?? payload.imageData ?? payload.image_url);
  const { rows } = await pool.query(
    `INSERT INTO reward_publications (id, kind, title, body, coupon_code, audience, starts_at, ends_at, image_url, created_by)
     VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, NULLIF($9, ''), $10)
     RETURNING *`,
    [uuidv4(), kind, title, body, couponCode, audience, startsAt, endsAt, imageUrl, adminId]
  );
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "reward_publication_submitted", entityType: "reward_publication", entityId: rows[0].id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { kind, title, audience }
  });
  return rows[0];
}

async function approvePublication(publicationId, adminId, approvalRole, meta = {}) {
  await ensureRewardsSchema();
  const { rows } = await pool.query(
    `UPDATE reward_publications
        SET status = 'live', decided_by = $2, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending_approval'
      RETURNING *`,
    [publicationId, adminId]
  );
  if (!rows[0]) throw new AppError(409, "That publication is not awaiting approval.");
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "reward_publication_approved", entityType: "reward_publication", entityId: publicationId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { approvalRole, title: rows[0].title, audience: rows[0].audience }
  });
  return rows[0];
}

async function rejectPublication(publicationId, adminId, reason, meta = {}) {
  await ensureRewardsSchema();
  const note = boundedText(reason, "A rejection reason", { min: 3, max: 300 });
  const { rows } = await pool.query(
    `UPDATE reward_publications
        SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'pending_approval'
      RETURNING *`,
    [publicationId, adminId, note]
  );
  if (!rows[0]) throw new AppError(409, "That publication is not awaiting approval.");
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "reward_publication_rejected", entityType: "reward_publication", entityId: publicationId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { reason: note, title: rows[0].title }
  });
  return rows[0];
}

// The kill switch. Any marketing admin may pull a live publication instantly —
// a wrong price on every customer's screen must not wait for an approval seat.
async function withdrawPublication(publicationId, adminId, reason, meta = {}) {
  await ensureRewardsSchema();
  const note = boundedText(reason, "Reason", { min: 0, max: 300, required: false });
  const { rows } = await pool.query(
    `UPDATE reward_publications
        SET status = 'withdrawn', decision_reason = COALESCE(NULLIF($2, ''), decision_reason), updated_at = NOW()
      WHERE id = $1 AND status = 'live'
      RETURNING *`,
    [publicationId, note]
  );
  if (!rows[0]) throw new AppError(409, "That publication is not live.");
  await writeAuditLog({
    actorType: "admin", actorId: adminId,
    action: "reward_publication_withdrawn", entityType: "reward_publication", entityId: publicationId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent,
    metadata: { reason: note, title: rows[0].title }
  });
  return rows[0];
}

function adminLiveState(row) {
  if (row.status !== "live") return row.status;
  if (row.starts_at && new Date(row.starts_at).getTime() > Date.now()) return "scheduled";
  if (row.ends_at && new Date(row.ends_at).getTime() <= Date.now()) return "ended";
  return "live";
}

async function listPublicationsForAdmin() {
  await ensureRewardsSchema();
  const { rows } = await pool.query(
    `SELECT p.*,
            creator.full_name AS created_by_name,
            decider.full_name AS decided_by_name,
            (SELECT COUNT(*)::INT FROM reward_publication_reads r WHERE r.publication_id = p.id) AS view_count
       FROM reward_publications p
       LEFT JOIN admin_users creator ON creator.id = p.created_by
       LEFT JOIN admin_users decider ON decider.id = p.decided_by
      ORDER BY (p.status = 'pending_approval') DESC, p.created_at DESC
      LIMIT 200`
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    imageUrl: row.image_url || "",
    couponCode: row.coupon_code || "",
    audience: row.audience,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    liveState: adminLiveState(row),
    viewCount: row.view_count || 0,
    copyCount: row.copy_count || 0,
    createdBy: row.created_by_name || "",
    decidedBy: row.decided_by_name || "",
    decisionReason: row.decision_reason || "",
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }));
}

module.exports = {
  REWARD_KINDS,
  REWARD_AUDIENCES,
  ensureRewardsSchema,
  listRewardsForCustomer,
  markRewardsSeen,
  recordCouponCopy,
  createPublication,
  approvePublication,
  rejectPublication,
  withdrawPublication,
  listPublicationsForAdmin
};
