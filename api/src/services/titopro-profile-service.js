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
const { assertClearable, blocker, countReferences } = require("../lib/clearable");
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
        -- WHO THE CUSTOMER IS HIRING, IN THE NAME THEY TRADE UNDER.
        -- The account's own full_name is a FICA-verified legal name and is not
        -- always the name on the bakkie. A customer comparing three plumbers
        -- needs the name they will be told over the phone, so this is asked
        -- for rather than assumed - and required before a listing goes live.
        trading_name TEXT,
        -- The professional's own terms: call-out charges, deposits, guarantee,
        -- what they do not do. Shown on their page before a job is raised, so
        -- a customer agrees to them rather than discovering them afterwards.
        terms TEXT,
        -- Photographs of their work. Stored as validated data URLs, the same
        -- shape PUT /auth/me/photo already uses for a profile picture, so this
        -- needs no storage service that does not exist yet. Deliberately NOT
        -- returned by search - see searchProfessionals.
        photos TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        -- What "Other" actually is, in the professional's own words. Required
        -- when they pick it; see config/titopro-reference.js.
        other_service TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        -- WHAT WAS TRUE WHEN THIS WENT LIVE. Kept so a listing can be shown to
        -- have been published against a verified identity even after that
        -- identity is later revoked, which is the question asked afterwards.
        fica_verified_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        unpublished_reason TEXT,
        -- AN ADMIN DECISION THE PROFESSIONAL CANNOT UNDO.
        -- Without this, a takedown was undoable by the person taken down:
        -- publishProfile checked FICA, vetting and account standing, all of
        -- which still pass for somebody suspended for bad work, so pressing
        -- "Go live" put them straight back in front of customers.
        admin_action TEXT,
        admin_reason TEXT,
        admin_actioned_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        admin_actioned_at TIMESTAMPTZ,
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
          CHECK (status <> 'published' OR fica_verified_at IS NOT NULL),
        CONSTRAINT titopro_profiles_admin_action_check
          CHECK (admin_action IS NULL OR admin_action IN ('suspended','removed')),
        -- A listing under an admin action can never read as published. The
        -- database refuses the combination rather than trusting every path.
        CONSTRAINT titopro_profiles_admin_action_not_live
          CHECK (admin_action IS NULL OR status <> 'published')
      )
    `);
    for (const column of ["admin_action TEXT", "admin_reason TEXT",
      "admin_actioned_by UUID", "admin_actioned_at TIMESTAMPTZ",
      "trading_name TEXT", "terms TEXT", "other_service TEXT",
      "photos TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]"]) {
      await pool.query(`ALTER TABLE titopro_profiles ADD COLUMN IF NOT EXISTS ${column}`);
    }
    // THE CONSTRAINTS HAVE TO BE ADDED SEPARATELY, and this is the trap that
    // makes them worth spelling out. CREATE TABLE IF NOT EXISTS does NOTHING
    // to a table that already exists, so a database installed before these
    // columns would get them from the loop above and never get the rules that
    // make them mean anything - a takedown that could read as published, and
    // an admin_action nobody constrained. ADD CONSTRAINT has no IF NOT EXISTS
    // in PostgreSQL 16, so each one is tried and a duplicate is the expected
    // outcome on every run after the first.
    for (const [name, check] of [
      ["titopro_profiles_admin_action_check", "admin_action IS NULL OR admin_action IN ('suspended','removed')"],
      ["titopro_profiles_admin_action_not_live", "admin_action IS NULL OR status <> 'published'"]
    ]) {
      await pool.query(`ALTER TABLE titopro_profiles ADD CONSTRAINT ${name} CHECK (${check})`)
        .catch((error) => {
          // 42710 duplicate_object: already there, which is the normal case.
          if (error?.code !== "42710") throw error;
        });
    }
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
  // FICA IS IDENTITY, NOT A BACKGROUND CHECK. A cleaner, a tutor and a
  // locksmith need cleared checks on file as well, because being correctly
  // identified says nothing about being suitable to hold the keys to an empty
  // house or to sit alone with somebody's child.
  let vetting = { satisfied: true, missing: [], missingLabels: [], required: [] };
  if (Array.isArray(professions) && professions.length) {
    vetting = await require("./titopro-vetting-service").vettingShortfall(userId, professions);
    if (!vetting.satisfied) {
      blockers.push(`Before you can offer this work TitoPay needs: ${vetting.missingLabels.join(" and ")}. Contact TitoPay support to start the checks.`);
    }
  }
  return { eligible: blockers.length === 0, ficaVerified, blockers, vetting, fullName: user.full_name };
}

/* ------------------------------------------------------------- the photos */

// A PHOTOGRAPH OF THEIR WORK, VALIDATED THE WAY THE PLATFORM ALREADY DOES IT.
//
// PUT /auth/me/photo accepts a base64 data URL, checks the media type against
// a fixed allowlist and caps the size. That is TitoPay's storage answer today
// - there is no object store behind any of this - so a listing gallery uses
// the same one rather than inventing a second. The allowlist is a WHITELIST on
// purpose: an <img src> that accepts "data:image/svg+xml" accepts a script,
// and these are rendered on a page any customer can open.
const PHOTO_PATTERN = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 600 * 1024;

function normalisePhotos(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > MAX_PHOTOS) {
    throw new AppError(400, `Up to ${MAX_PHOTOS} photos. Take one off to add another.`, { code: "too_many_photos" });
  }
  return list.map((entry, index) => {
    const photo = String(entry || "").trim();
    if (!PHOTO_PATTERN.test(photo)) {
      throw new AppError(400, `Photo ${index + 1} is not a PNG, JPEG or WebP image.`, { code: "photo_type" });
    }
    if (Buffer.byteLength(photo, "utf8") > MAX_PHOTO_BYTES) {
      throw new AppError(413, `Photo ${index + 1} is too large. Choose a smaller one.`, { code: "photo_size" });
    }
    return photo;
  });
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

  // WHAT "OTHER" ACTUALLY IS, refused at the draft rather than at publish.
  // A professional who types childcare here should be told immediately, in the
  // box they typed it into - not after they have filled the whole form in and
  // pressed Go live.
  const wantsOther = professions.some((key) => reference.requiresOwnDescription(key));
  const otherService = payload.otherService
    ? boundedText(payload.otherService, "What your work is", { min: 0, max: 160 })
    : "";
  if (otherService) {
    const verdict = reference.otherServiceIsAllowed(otherService);
    if (!verdict.allowed) {
      throw new AppError(422, verdict.says, { code: "work_not_carried" });
    }
  }

  const photos = normalisePhotos(payload.photos);

  const { rows } = await pool.query(
    `INSERT INTO titopro_profiles
      (id, user_id, professions, headline, bio, suburb, city, province, service_radius_km,
       trading_name, terms, other_service, photos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id) DO UPDATE SET
       professions = EXCLUDED.professions,
       headline = EXCLUDED.headline,
       bio = EXCLUDED.bio,
       suburb = EXCLUDED.suburb,
       city = EXCLUDED.city,
       province = EXCLUDED.province,
       service_radius_km = EXCLUDED.service_radius_km,
       trading_name = EXCLUDED.trading_name,
       terms = EXCLUDED.terms,
       other_service = EXCLUDED.other_service,
       photos = EXCLUDED.photos,
       updated_at = NOW()
     RETURNING *`,
    [crypto.randomUUID(), actor.userId, professions,
      payload.headline ? boundedText(payload.headline, "Headline", { min: 0, max: 120 }) : null,
      payload.bio ? boundedText(payload.bio, "About your work", { min: 0, max: 2000 }) : null,
      payload.suburb ? boundedText(payload.suburb, "Suburb", { min: 0, max: 120 }) : null,
      payload.city ? boundedText(payload.city, "City", { min: 0, max: 120 }) : null,
      payload.province ? boundedText(payload.province, "Province", { min: 0, max: 120 }) : null,
      Math.round(radius),
      payload.tradingName ? boundedText(payload.tradingName, "Your name or business name", { min: 0, max: 120 }) : null,
      payload.terms ? boundedText(payload.terms, "Your terms", { min: 0, max: 4000 }) : null,
      // Kept only while "Other" is one of the chosen services, so removing it
      // does not leave an orphaned description on the record.
      wantsOther ? (otherService || null) : null,
      photos]
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
  // WITHDRAWING A PROFESSION MUST FAIL CLOSED.
  //
  // professions is a TEXT[] with no foreign key, so a listing saved before a
  // profession was withdrawn still carries that key. requiredChecksFor returns
  // an EMPTY list for a key it does not recognise - which means, without this,
  // withdrawing an enhanced profession would turn every stored listing
  // offering it into one that publishes with no background checks at all. The
  // removal would create the exact hole the vetting exists to close.
  //
  // Checked here rather than only for the profession withdrawn today, so the
  // next withdrawal is safe without anybody remembering this.
  const withdrawn = profile.professions.filter((key) => !reference.isProfession(key));
  if (withdrawn.length) {
    throw new AppError(409,
      `TitoPay no longer lists ${withdrawn.join(", ").replace(/_/g, " ")}. Remove it from your services to go live.`,
      { code: "profession_withdrawn", withdrawn });
  }
  if (!profile.city && !profile.suburb) {
    throw new AppError(400, "Add the area you work in before you go live.");
  }
  // A CUSTOMER HAS TO KNOW WHO THEY ARE HIRING.
  // The account's full_name is a FICA-verified legal name and is not always
  // the name on the bakkie, so the trading name is asked for rather than
  // inferred - and a listing with no name at all is not put in front of
  // anybody.
  if (!String(profile.trading_name || "").trim()) {
    throw new AppError(400, "Add your name or your business name before you go live.",
      { code: "trading_name_required" });
  }
  // "OTHER" MUST SAY WHAT IT IS. A listing offering an unnamed service is one
  // no customer can judge and nobody can vet.
  if (profile.professions.some((key) => reference.requiresOwnDescription(key))) {
    const described = String(profile.other_service || "").trim();
    if (!described) {
      throw new AppError(400, "You chose Other. Say what the work is before you go live.",
        { code: "other_service_required" });
    }
    // Checked again here, not only on save: the withdrawn list is policy and
    // can grow, and a listing saved before an entry was added must not stay
    // publishable because it slipped through on the day it was written.
    const verdict = reference.otherServiceIsAllowed(described);
    if (!verdict.allowed) {
      throw new AppError(422, verdict.says, { code: "work_not_carried" });
    }
  }

  // AN ADMIN TAKEDOWN IS NOT SOMETHING THE PROFESSIONAL CAN LIFT.
  // Checked before eligibility because a suspension for bad work leaves FICA,
  // vetting and account standing all perfectly intact - so every other gate
  // here would wave them straight back through.
  if (profile.admin_action) {
    throw new AppError(403, profile.admin_action === "removed"
      ? "This listing has been removed by TitoPay. Contact support."
      : "This listing is suspended by TitoPay. Contact support.",
      { code: `listing_${profile.admin_action}`, reason: profile.admin_reason || "" });
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

// CLEARING A LISTING THAT WAS NEVER PUBLISHED.
//
// Somebody starts a listing, picks two services, and thinks better of it. The
// draft then sits on their TitoPro screen forever, because pausing is for a
// listing that went live and there is nothing else to do with one that did
// not. This removes it.
//
// A PUBLISHED LISTING IS NOT A DRAFT, even if it is paused today. It has been
// in front of customers, it may have jobs and ratings against it, and
// published_at is the record of when TitoPay put it there. That case is
// pauseProfile's, and one taken down by an operator is admin_action's - never
// this. The three checks below are the difference.
async function clearDraftProfile(actor) {
  await ensureProfileSchema();
  if (!actor?.userId) throw new AppError(401, "Sign in to clear your TitoPro listing");
  const { rows } = await pool.query(
    "SELECT * FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [actor.userId]);
  const profile = rows[0];
  if (!profile) return { cleared: false, reason: "nothing to clear" };

  await require("./titopro-service").ensureTitoProSchema();
  const jobs = await countReferences(pool, "titopro_jobs", "professional_user_id", actor.userId);

  assertClearable("listing", [
    profile.published_at
      ? "it has been live on TitoPro before"
      : (profile.status === "published" ? "it is live on TitoPro" : null),
    // An admin takedown is not something the person taken down may tidy away.
    // Clearing the row would erase the reason it came down along with it.
    profile.admin_action ? "TitoPay has taken it down" : null,
    blocker(jobs, "a customer has sent you a job through it", "{count} customers have sent you jobs through it")
  ], "Pause it instead, which takes it off TitoPro and keeps your work.");

  await pool.query("DELETE FROM titopro_profiles WHERE user_id = $1", [actor.userId]);
  await writeAuditLog({
    actorType: "customer", actorId: actor.userId,
    action: "titopro_listing_draft_cleared", entityType: "titopro_profile", entityId: profile.id,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent,
    metadata: { professions: profile.professions }
  }).catch(() => null);
  return { cleared: true };
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
  const professions = profileRow[0]?.professions || [];
  const eligibility = await listingEligibility(userId, professions);
  // A live listing offering a profession that has since been withdrawn comes
  // down too. Its vetting requirements no longer resolve, so leaving it up
  // would be advertising work TitoPay has decided not to carry.
  const withdrawn = professions.filter((key) => !reference.isProfession(key));
  if (eligibility.eligible && !withdrawn.length) return { changed: false };
  if (withdrawn.length) {
    eligibility.blockers.push(`TitoPay no longer lists ${withdrawn.join(", ").replace(/_/g, " ")}.`);
  }

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

/* ------------------------------------------------------- the operator's hand */

// APPROVE, SUSPEND, REMOVE - AND WHAT EACH OF THEM ACTUALLY DOES.
//
// SUSPEND takes the listing off TitoPro and lets it come back. REMOVE takes it
// off and does not. Neither deletes anything: the profile row, the reports and
// the jobs all stay exactly where they are, because a takedown is the thing
// somebody asks about six months later and "we deleted it" is not an answer.
//
// APPROVE IS NOT PUBLISH. Clearing an action hands the listing back to the
// professional, who must still satisfy FICA, vetting and account standing to
// put it in front of customers. Nothing an operator does here can make a
// listing live that would not have been allowed to be live anyway - so a
// mis-click on this screen cannot put an unverified person in front of
// customers, which is the only mistake on it that would matter.
//
// WHY THE OPERATOR'S REASON DOES NOT REACH THE PROFESSIONAL. The reason is
// written for TitoPay and routinely names the customer who complained. Handing
// it to the person being suspended hands them the name of the person who
// reported them, and on a marketplace whose professionals have been inside the
// customer's house that is a safety question rather than a privacy one. The
// professional is told plainly that TitoPay suspended the listing and given
// support as the way to hear why - the same shape account restrictions use.
async function moderateListing(admin, userId, payload = {}) {
  await ensureProfileSchema();
  if (!admin?.userId) throw new AppError(401, "Authentication required");
  const action = String(payload.action || "").trim().toLowerCase();
  if (!reference.LISTING_ADMIN_ACTIONS.includes(action)) {
    throw new AppError(400, "Choose approve, suspend or remove");
  }
  // Required for all three. Approving is as much a decision as removing, and a
  // queue where rows can be cleared without a word is a queue nobody can audit.
  const reason = boundedText(payload.reason, "Reason", { min: 3, max: 2000 });

  const { rows: existing } = await pool.query(
    "SELECT * FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [userId]);
  if (!existing[0]) throw new AppError(404, "That listing was not found on TitoPro.");

  let rows;
  if (action === "approve") {
    // A live listing stays live: approving is not a reason to knock somebody
    // offline. Anything else lands on 'paused', which is the one state that
    // means "not in front of customers, and yours to publish again".
    rows = (await pool.query(
      `UPDATE titopro_profiles
          SET admin_action = NULL, admin_reason = NULL,
              admin_actioned_by = $2, admin_actioned_at = NOW(),
              status = CASE WHEN status = 'published' THEN status ELSE 'paused' END,
              unpublished_reason = NULL, updated_at = NOW()
        WHERE user_id = $1 RETURNING *`, [userId, admin.userId])).rows;
  } else {
    const state = action === "remove" ? "removed" : "suspended";
    rows = (await pool.query(
      `UPDATE titopro_profiles
          SET admin_action = $3, admin_reason = $4,
              admin_actioned_by = $2, admin_actioned_at = NOW(),
              status = 'suspended',
              unpublished_reason = $5, updated_at = NOW()
        WHERE user_id = $1 RETURNING *`,
      [userId, admin.userId, state, reason, ADMIN_ACTION_NOTICE[state]])).rows;
  }

  // The reports that prompted this are closed with the decision against them,
  // so the queue says what happened rather than being tidied by hand.
  const reputation = require("./titopro-reputation-service");
  const reportsClosed = await reputation.closeOpenReportsFor(admin, userId, {
    outcome: action,
    note: reason,
    status: action === "approve" ? "dismissed" : "actioned"
  }).catch(() => 0);

  await writeAuditLog({
    actorType: "admin", actorId: admin.userId,
    action: `titopro_listing_${action}`, entityType: "titopro_profile", entityId: rows[0].id,
    ipAddress: admin.ipAddress, userAgent: admin.userAgent,
    metadata: { userId, reason, reportsClosed }
  }).catch(() => null);
  return { profile: presentForAdmin(rows[0]), reportsClosed };
}

// What a suspended or removed professional is told. Fixed sentences chosen by
// state, never the operator's words - see moderateListing.
const ADMIN_ACTION_NOTICE = Object.freeze({
  suspended: "TitoPay has suspended this listing. Contact support.",
  removed: "TitoPay has removed this listing. Contact support."
});

// The listings an operator needs to see: everything under an action, plus
// anything that has been reported and not yet decided.
async function moderationListings({ state = "actioned", limit = 100 } = {}) {
  await ensureProfileSchema();
  await require("./titopro-reputation-service").ensureReputationSchema();
  const where = state === "all"
    ? "TRUE"
    : "p.admin_action IS NOT NULL";
  const { rows } = await pool.query(
    `SELECT p.*, u.full_name,
            (SELECT COUNT(*)::int FROM titopro_reports r
              WHERE r.professional_user_id = p.user_id AND r.status IN ('open','reviewing')) AS open_reports,
            a.email AS actioned_by_email
       FROM titopro_profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN admin_users a ON a.id = p.admin_actioned_by
      WHERE ${where}
      ORDER BY p.admin_actioned_at DESC NULLS LAST, p.updated_at DESC
      LIMIT $1`, [Math.max(1, Math.min(300, Number(limit) || 100))]);
  return rows.map((row) => presentForAdmin(row));
}

// One listing, everything an operator needs to decide about it: who they are,
// what state the listing is in, what has been said about them and by whom.
async function listingForAdmin(userId) {
  await ensureProfileSchema();
  const reputation = require("./titopro-reputation-service");
  const { rows } = await pool.query(
    `SELECT p.*, u.full_name, u.email, u.phone, a.email AS actioned_by_email
       FROM titopro_profiles p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN admin_users a ON a.id = p.admin_actioned_by
      WHERE p.user_id = $1 LIMIT 1`, [userId]);
  if (!rows[0]) throw new AppError(404, "That listing was not found on TitoPro.");
  const [reports, summary, vetting] = await Promise.all([
    reputation.reportsForProfessional(userId),
    reputation.ratingSummary(userId),
    require("./titopro-vetting-service").checksForUser(userId).catch(() => [])
  ]);
  return {
    listing: presentForAdmin(rows[0]),
    contact: { fullName: rows[0].full_name, email: rows[0].email, phone: rows[0].phone },
    reports,
    rating: summary,
    vetting
  };
}

// Built by hand like present(), and separately from it, so a field meant for
// an operator cannot reach a customer screen by being added in one place.
function presentForAdmin(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.full_name || null,
    status: row.status,
    adminAction: row.admin_action || null,
    // The one line a screen should show. 'suspended' on its own does not say
    // whether TitoPay did it or a verification lapsed, and those read very
    // differently to the person looking at the queue.
    statusLabel: row.admin_action
      ? (row.admin_action === "removed" ? "Removed by TitoPay" : "Suspended by TitoPay")
      : LISTING_STATUS_LABELS[row.status] || row.status,
    adminReason: row.admin_reason || "",
    adminActionedAt: row.admin_actioned_at,
    adminActionedBy: row.actioned_by_email || null,
    professions: row.professions,
    professionLabels: (row.professions || []).map((key) => reference.profession(key)?.label || key),
    headline: row.headline,
    suburb: row.suburb,
    city: row.city,
    publishedAt: row.published_at,
    unpublishedReason: row.unpublished_reason || "",
    openReports: typeof row.open_reports === "number" ? row.open_reports : undefined
  };
}

const LISTING_STATUS_LABELS = Object.freeze({
  draft: "Draft",
  published: "Live",
  paused: "Paused by the professional",
  suspended: "Off TitoPro"
});

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

// ONE PROFESSIONAL'S PAGE, as a customer deciding whether to hire them sees
// it. Published listings only - requirePublishedProfessional is the same gate
// that stops a job being raised against a listing that is not live, so a page
// cannot exist for somebody the job could not be sent to.
async function publicProfile(userId) {
  const row = await requirePublishedProfessional(userId);
  const reputation = require("./titopro-reputation-service");
  const [user, rating, reviews] = await Promise.all([
    pool.query("SELECT full_name FROM users WHERE id = $1 LIMIT 1", [userId]),
    reputation.ratingSummary(userId),
    reputation.ratingsForProfessional(userId, { limit: 20 })
  ]);
  return {
    userId: row.user_id,
    // THE TRADING NAME LEADS, THE VERIFIED NAME BACKS IT UP. A customer
    // recognises "Sipho's Plumbing"; what makes them comfortable is that
    // TitoPay has checked a legal identity behind it. Both are shown, and the
    // legal one is never silently replaced by the one the professional typed.
    name: row.trading_name || user.rows[0]?.full_name || "",
    verifiedName: user.rows[0]?.full_name || "",
    professions: row.professions,
    professionLabels: row.professions.map((key) => reference.profession(key)?.label || key),
    enhancedVettingProfessions: row.professions.filter((key) => reference.requiresEnhancedVetting(key)),
    headline: row.headline,
    bio: row.bio,
    // The professional's own terms, shown BEFORE a job is raised rather than
    // discovered after the work is done.
    terms: row.terms || "",
    otherService: row.other_service || "",
    photos: Array.isArray(row.photos) ? row.photos : [],
    suburb: row.suburb,
    city: row.city,
    serviceRadiusKm: row.service_radius_km,
    publishedAt: row.published_at,
    ficaVerified: true,
    rating: rating.average,
    ratingCount: rating.count,
    reviews
  };
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
  // THE COLUMNS THIS SURFACE NEEDS, NAMED - not p.*.
  //
  // p.* now drags the whole photo gallery out of the database for every row,
  // megabytes of base64 per professional, only for the mapping below to throw
  // it away. cardinality(p.photos) gets the one fact the list actually shows -
  // how many there are - without reading a single byte of the images.
  const { rows } = await pool.query(
    `SELECT p.user_id, p.professions, p.headline, p.suburb, p.city,
            p.service_radius_km, p.trading_name,
            cardinality(p.photos) AS photo_count,
            u.full_name
       FROM titopro_profiles p
       JOIN users u ON u.id = p.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.published_at DESC NULLS LAST
      LIMIT $${params.length}`, params);

  // THE SCORE IS FETCHED FOR THE WHOLE PAGE IN ONE QUERY, not joined into the
  // one above and not stored on the profile row. A join here would tie
  // discovery to the ratings table existing; a stored average is a number that
  // goes quietly wrong the first time a rating is withdrawn.
  const summaries = await require("./titopro-reputation-service")
    .ratingSummaries(rows.map((row) => row.user_id))
    .catch(() => new Map());

  return rows.map((row) => ({
    userId: row.user_id,
    name: row.trading_name || row.full_name,
    // NO PHOTO DATA ON THIS SURFACE, deliberately. The gallery is stored as
    // base64 data URLs, so six of them is a few megabytes on ONE professional;
    // fifty search results would be a payload nobody on a South African mobile
    // connection should be asked to download to read a list of names. The
    // count travels instead, so a row can say "6 photos", and the images
    // themselves load on the one profile a customer actually opens.
    photoCount: Number(row.photo_count) || 0,
    professions: row.professions,
    professionLabels: row.professions.map((key) => reference.profession(key)?.label || key),
    headline: row.headline,
    suburb: row.suburb,
    city: row.city,
    serviceRadiusKm: row.service_radius_km,
    // NULL rather than 0 for somebody nobody has rated yet. A new professional
    // showing "0.0" reads as terrible rather than as new, and that difference
    // decides whether anyone ever gives them a first job.
    rating: summaries.get(row.user_id)?.average ?? null,
    ratingCount: summaries.get(row.user_id)?.count || 0,
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
    tradingName: row.trading_name || "",
    headline: row.headline,
    bio: row.bio,
    terms: row.terms || "",
    otherService: row.other_service || "",
    photos: Array.isArray(row.photos) ? row.photos : [],
    suburb: row.suburb,
    city: row.city,
    province: row.province,
    serviceRadiusKm: row.service_radius_km,
    publishedAt: row.published_at,
    ficaVerifiedAt: row.fica_verified_at,
    unpublishedReason: row.unpublished_reason || "",
    // THE PROFESSIONAL IS TOLD THAT TITOPAY ACTED, AND NOT WHY.
    // The operator's reason names the customer who complained; see
    // moderateListing for why that does not travel to this surface.
    adminAction: row.admin_action || null,
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
  clearDraftProfile,
  enforceVerificationStillHolds,
  ensureProfileSchema,
  getMyProfile,
  listingEligibility,
  listingForAdmin,
  moderateListing,
  moderationListings,
  pauseProfile,
  publicProfile,
  publishProfile,
  requirePublishedProfessional,
  resetProfileSchemaCache,
  saveProfile,
  searchProfessionals
};
