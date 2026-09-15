"use strict";

// TITOPRO: THE LISTING, AND WHO IS ALLOWED TO HAVE ONE.
//
// A professional builds a profile freely and publishes it only once FICA
// verification is complete. Anyone can type a bio; only a verified identity
// gets put in front of customers and paid by them.
//
// WHY FICA AND NOT THE CHAT CHECK. lib/chat-policy.js exports
// isVerifiedTitoPayUser, which looks like exactly the helper for this and is
// the wrong one. It treats a user as verified if they merely HAVE A WALLET
// NUMBER:
//
//     Boolean(user.wallet_id || user.walletId || user.wallet_number || ...)
//
// Every TitoPay customer has one, so that check would admit the entire user
// base. It is correct for what it was written for - deciding who may use
// chat - and a silent hole here. This file uses compliance-service's
// tierForUserRow instead, where tier 2 IS the FICA-verified tier, so TitoPro
// and the compliance engine cannot drift apart about what "verified" means.
//
// WHY THE PROFESSIONAL RATHER THAN THE CUSTOMER. The professional is the side
// RECEIVING money from strangers, repeatedly, for services. That is the side
// the FIC Act cares about, and the side where an unverified identity turns a
// marketplace into a laundering channel.
//
// VERIFICATION IS NOT FOREVER. A listing published while verified is taken
// down the moment that verification stops being true - an admin rejecting a
// FICA review, an account suspended, a restriction applied. Publishing checks
// at the moment of publishing; enforceVerificationStillHolds is what keeps it
// honest afterwards.

const crypto = require("node:crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { writeAuditLog } = require("./audit-service");
const reference = require("../config/titopro-reference");
const { tierForUserRow } = require("./compliance-service");

// Tier 2 is the FICA-verified tier in compliance-service. Named here so the
// intent is readable at the call site rather than being a bare number.
const FICA_VERIFIED_TIER = 2;

const PROFILE_STATUSES = Object.freeze(["draft", "published", "paused", "suspended"]);

let schemaReady = null;
async function ensureProfileSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS titopro_profiles (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        professions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        headline TEXT,
        bio TEXT,
        suburb TEXT,
        city TEXT,
        province TEXT,
        service_radius_km INTEGER NOT NULL DEFAULT 20,
        status TEXT NOT NULL DEFAULT 'draft',
        -- WHAT WAS TRUE WHEN THIS WENT LIVE. Kept so a listing can be shown to
        -- have been published against a verified identity even after that
        -- identity is later revoked, which is the question asked afterwards.
        fica_verified_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        unpublished_reason TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT titopro_profiles_status_check
          CHECK (status IN ('draft','published','paused','suspended')),
        CONSTRAINT titopro_profiles_radius_check
          CHECK (service_radius_km > 0 AND service_radius_km <= 200),
        -- A published listing must always carry the verification it was
        -- published against. The database refuses the combination rather than
        -- trusting every future code path to remember.
        CONSTRAINT titopro_profiles_published_is_verified
          CHECK (status <> 'published' OR fica_verified_at IS NOT NULL)
      )
    `);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_titopro_profiles_user ON titopro_profiles (user_id)");
    // Discovery: who is live, where. Mirrors idx_book_venues_discovery.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_profiles_discovery
      ON titopro_profiles (city, suburb) WHERE status = 'published'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_profiles_professions
      ON titopro_profiles USING GIN (professions) WHERE status = 'published'`);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function resetProfileSchemaCache() {
  schemaReady = null;
}

/* ------------------------------------------------------- the verification */

// THE ONE PLACE THAT DECIDES WHETHER SOMEBODY MAY BE LISTED.
//
// Returns the reasons it is refused rather than a bare false, because a
// professional who cannot publish has to be told what to go and do.
// `professions` is optional: without it this answers only the account-level
// questions, which is what a profile screen needs before any service is
// chosen. With it, the background checks those particular services require are
// included - see titopro-vetting-service.js.
async function listingEligibility(userId, professions = null) {
  const { rows } = await pool.query(
    `SELECT id, status, fica_status, basic_verified_at, full_name
       FROM users WHERE id = $1 LIMIT 1`, [userId]);
  const user = rows[0];
  if (!user) return { eligible: false, ficaVerified: false, blockers: ["This account does not exist."] };

  const blockers = [];
  const ficaVerified = tierForUserRow(user) >= FICA_VERIFIED_TIER;
  if (!ficaVerified) {
    blockers.push(String(user.fica_status || "pending").toLowerCase() === "rejected"
      ? "Your FICA verification was not approved. Contact TitoPay support before listing."
      : "Complete your FICA verification before you can be listed. Go to Verify my identity.");
  }
  // A restricted account cannot be advertised to customers whatever its FICA
  // state - being verified is not the same as being in good standing.
  if (String(user.status || "").toLowerCase() !== "active") {
    blockers.push("Your TitoPay account is not active, so your listing cannot go live.");
  }
  // FICA IS IDENTITY, NOT A BACKGROUND CHECK. A day nanny, a cleaner, a tutor
  // and a locksmith need cleared checks on file as well, because being
  // correctly identified says nothing about being suitable to be alone with a
  // child or to hold the keys to an empty house.
  let vetting = { satisfied: true, missing: [], missingLabels: [], required: [] };
  if (Array.isArray(professions) && professions.length) {
    vetting = await require("./titopro-vetting-service").vettingShortfall(userId, professions);
    if (!vetting.satisfied) {
      blockers.push(`Before you can offer this work TitoPay needs: ${vetting.missingLabels.join(" and ")}. Contact TitoPay support to start the checks.`);
    }
  }
  return { eligible: blockers.length === 0, ficaVerified, blockers, vetting, fullName: user.full_name };
}

/* -------------------------------------------------------------- the draft */

// Drafting needs no verification. Somebody should be able to write their
// profile while their FICA documents are still being reviewed - it is the
// PUBLISHING that is gated, and a draft is visible to nobody.
async function saveProfile(actor, payload = {}) {
  await ensureProfileSchema();
  if (!actor?.userId) throw new AppError(401, "Sign in to set up your TitoPro listing");

  const professions = Array.from(new Set(
    (Array.isArray(payload.professions) ? payload.professions : [])
      .map((value) => String(value || "").trim())
  ));
  for (const key of professions) {
    if (!reference.isProfession(key)) throw new AppError(400, `"${key}" is not a TitoPro profession`);
  }
  if (professions.length > 6) throw new AppError(400, "Choose up to six services. A listing that claims everything convinces nobody.");

  const radius = Number(payload.serviceRadiusKm || 20);
  if (!Number.isFinite(radius) || radius < 1 || radius > 200) {
    throw new AppError(400, "Service area must be between 1 and 200 km");
  }

  const { rows } = await pool.query(
    `INSERT INTO titopro_profiles
      (id, user_id, professions, headline, bio, suburb, city, province, service_radius_km)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id) DO UPDATE SET
       professions = EXCLUDED.professions,
       headline = EXCLUDED.headline,
       bio = EXCLUDED.bio,
       suburb = EXCLUDED.suburb,
       city = EXCLUDED.city,
       province = EXCLUDED.province,
       service_radius_km = EXCLUDED.service_radius_km,
       updated_at = NOW()
     RETURNING *`,
    [crypto.randomUUID(), actor.userId, professions,
      payload.headline ? boundedText(payload.headline, "Headline", { min: 0, max: 120 }) : null,
      payload.bio ? boundedText(payload.bio, "About your work", { min: 0, max: 2000 }) : null,
      payload.suburb ? boundedText(payload.suburb, "Suburb", { min: 0, max: 120 }) : null,
      payload.city ? boundedText(payload.city, "City", { min: 0, max: 120 }) : null,
      payload.province ? boundedText(payload.province, "Province", { min: 0, max: 120 }) : null,
      Math.round(radius)]
  );
  return present(rows[0], await listingEligibility(actor.userId, rows[0].professions));
}

/* ------------------------------------------------------------ publishing */

async function publishProfile(actor) {
  await ensureProfileSchema();
  if (!actor?.userId) throw new AppError(401, "Sign in to publish your TitoPro listing");

  const profile = await requireProfile(actor.userId);
  if (!profile.professions.length) {
    throw new AppError(400, "Choose at least one service before you go live.");
  }
  if (!profile.city && !profile.suburb) {
    throw new AppError(400, "Add the area you work in before you go live.");
  }

  const eligibility = await listingEligibility(actor.userId, profile.professions);
  if (!eligibility.eligible) {
    // 403 rather than 400: nothing is wrong with the request, the account is
    // not permitted to do it yet.
    throw new AppError(403, eligibility.blockers[0], {
      code: eligibility.ficaVerified ? "vetting_required" : "fica_required",
      blockers: eligibility.blockers,
      ficaVerified: eligibility.ficaVerified
    });
  }

  const { rows } = await pool.query(
    `UPDATE titopro_profiles
        SET status = 'published', published_at = NOW(), fica_verified_at = NOW(),
            unpublished_reason = NULL, updated_at = NOW()
      WHERE user_id = $1 RETURNING *`,
    [actor.userId]);
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId,
    action: "titopro_listing_published", entityType: "titopro_profile", entityId: rows[0].id,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent,
    metadata: { professions: rows[0].professions, city: rows[0].city }
  }).catch(() => null);
  return present(rows[0], eligibility);
}

// The professional taking themselves off the list - on holiday, fully booked.
// Their own choice, so it needs no verification and no reason.
async function pauseProfile(actor) {
  await ensureProfileSchema();
  await requireProfile(actor.userId);
  const { rows } = await pool.query(
    "UPDATE titopro_profiles SET status = 'paused', updated_at = NOW() WHERE user_id = $1 RETURNING *",
    [actor.userId]);
  return present(rows[0], await listingEligibility(actor.userId));
}

// VERIFICATION STOPPING BEING TRUE TAKES THE LISTING DOWN.
//
// Publishing checks at the moment of publishing. Nothing about that stops an
// admin rejecting a FICA review the next morning, or a restriction being
// applied for suspected fraud - and a listing that stays up through either is
// TitoPay advertising somebody it no longer vouches for.
//
// Safe to call often and from anywhere: it does nothing to a listing that is
// still entitled to be up.
async function enforceVerificationStillHolds(userId, { reason = "" } = {}) {
  await ensureProfileSchema();
  const { rows: current } = await pool.query(
    "SELECT id, status FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [userId]);
  if (!current[0] || current[0].status !== "published") return { changed: false };

  const { rows: profileRow } = await pool.query(
    "SELECT professions FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [userId]);
  // The professions are passed so an EXPIRED background check counts as a
  // lapse exactly as a withdrawn FICA verification does. A clearance that ran
  // out is not a smaller problem than one that was never obtained.
  const eligibility = await listingEligibility(userId, profileRow[0]?.professions || []);
  if (eligibility.eligible) return { changed: false };

  const { rows } = await pool.query(
    `UPDATE titopro_profiles
        SET status = 'suspended', unpublished_reason = $2, updated_at = NOW()
      WHERE user_id = $1 RETURNING *`,
    [userId, reason || eligibility.blockers[0] || "Verification is no longer current."]);
  await writeAuditLog({
    actorType: "system", actorId: null,
    action: "titopro_listing_suspended", entityType: "titopro_profile", entityId: rows[0].id,
    metadata: { userId, blockers: eligibility.blockers }
  }).catch(() => null);
  return { changed: true, profile: present(rows[0], eligibility) };
}

/* -------------------------------------------------------------- read paths */

// A published listing is the only kind a customer can find or hire. This is
// also what closes the back door: without it somebody could be sent work
// directly while their listing was never verified or has been taken down.
async function requirePublishedProfessional(userId) {
  await ensureProfileSchema();
  const { rows } = await pool.query(
    "SELECT * FROM titopro_profiles WHERE user_id = $1 AND status = 'published' LIMIT 1", [userId]);
  if (!rows[0]) {
    throw new AppError(409, "That professional is not currently listed on TitoPro.", { code: "not_listed" });
  }
  return rows[0];
}

async function getMyProfile(actor) {
  await ensureProfileSchema();
  const { rows } = await pool.query("SELECT * FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [actor.userId]);
  const eligibility = await listingEligibility(actor.userId, rows[0]?.professions || []);
  if (!rows[0]) return { profile: null, eligibility };
  return { profile: present(rows[0], eligibility), eligibility };
}

// Discovery. Published listings only, and nothing on this surface identifies
// anybody who is not live.
async function searchProfessionals({ profession = null, city = null, limit = 50 } = {}) {
  await ensureProfileSchema();
  const where = ["p.status = 'published'"];
  const params = [];
  if (profession) { params.push(profession); where.push(`$${params.length} = ANY(p.professions)`); }
  if (city) { params.push(city); where.push(`LOWER(p.city) = LOWER($${params.length})`); }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const { rows } = await pool.query(
    `SELECT p.*, u.full_name
       FROM titopro_profiles p
       JOIN users u ON u.id = p.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.published_at DESC NULLS LAST
      LIMIT $${params.length}`, params);
  return rows.map((row) => ({
    userId: row.user_id,
    name: row.full_name,
    professions: row.professions,
    professionLabels: row.professions.map((key) => reference.profession(key)?.label || key),
    headline: row.headline,
    suburb: row.suburb,
    city: row.city,
    serviceRadiusKm: row.service_radius_km,
    // Every listing a customer can see is verified by construction, and saying
    // so is most of what makes somebody comfortable hiring a stranger.
    ficaVerified: true
  }));
}

/* ----------------------------------------------------------------- helpers */

async function requireProfile(userId) {
  const { rows } = await pool.query("SELECT * FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [userId]);
  if (!rows[0]) throw new AppError(404, "Set up your TitoPro listing first");
  return rows[0];
}

function present(row, eligibility = null) {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    professions: row.professions,
    professionLabels: row.professions.map((key) => reference.profession(key)?.label || key),
    // Which of the chosen services need more than an identity check before a
    // customer lets this person into their home or near their child.
    enhancedVettingProfessions: row.professions.filter((key) => reference.requiresEnhancedVetting(key)),
    headline: row.headline,
    bio: row.bio,
    suburb: row.suburb,
    city: row.city,
    province: row.province,
    serviceRadiusKm: row.service_radius_km,
    publishedAt: row.published_at,
    ficaVerifiedAt: row.fica_verified_at,
    unpublishedReason: row.unpublished_reason || "",
    ...(eligibility ? {
      canPublish: eligibility.eligible,
      ficaVerified: eligibility.ficaVerified,
      vettingSatisfied: eligibility.vetting ? eligibility.vetting.satisfied : true,
      outstandingChecks: eligibility.vetting ? eligibility.vetting.missingLabels || [] : [],
      blockers: eligibility.blockers
    } : {})
  };
}

module.exports = {
  FICA_VERIFIED_TIER,
  PROFILE_STATUSES,
  enforceVerificationStillHolds,
  ensureProfileSchema,
  getMyProfile,
  listingEligibility,
  pauseProfile,
  publishProfile,
  requirePublishedProfessional,
  resetProfileSchemaCache,
  saveProfile,
  searchProfessionals
};
