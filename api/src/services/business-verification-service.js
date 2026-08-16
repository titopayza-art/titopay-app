"use strict";

// A BUSINESS IS NOT A PERSON, AND A PERSON IS NOT ONE BUSINESS.
//
// TitoPay verified businesses by verifying the human who signed up: a business
// account was a `users` row with account_type 'business', its FICA pack carried
// that person's ID number, and the identity check refuses a document that
// already anchors another account. Follow those three facts to their
// conclusion and the platform says, out loud, that one person may own one
// business. That is wrong about ordinary South African life, where the same
// person runs a spaza, a transport business and a stokvel administration
// company, and it is wrong about the law, which treats the entity and its
// officers as separate parties with separate obligations.
//
// So this separates the two things that were fused:
//
//   PERSON        one canonical identity per human being, already on `users`:
//                 the salted document hash, the document type, the issuing
//                 country, the verification history. Verified ONCE, ever.
//   BUSINESS      its own entity with its own name, its own registration
//                 number (where its type has one), its own KYB status, its own
//                 profile and its own audit trail.
//   RELATIONSHIP  who a person IS to a business — owner, director, beneficial
//                 owner, authorised representative — held as its own record,
//                 because that is what it is. One person may hold a
//                 relationship with many businesses, and one business may have
//                 many people.
//
// FOUR RULES THIS FILE EXISTS TO ENFORCE:
//
//   1. A person's ID number is NEVER a business identifier. The unique key on
//      a business is its registration number in its country of registration.
//      Nothing here reads or writes users.id_number_hash.
//   2. A business type that has no registration number is not asked for one. A
//      spaza owner, a hawker, a freelance plumber — sole proprietors are not
//      registered at CIPC and never will be. They are verified through the
//      owner's identity plus a business profile of their own.
//   3. Verifying a second business NEVER re-verifies the person. The person's
//      identity is looked up, not collected again, so no duplicate personal
//      KYC identity is created and the duplicate-document refusal that exists
//      to catch impersonation is not tripped by honest entrepreneurship.
//   4. Business verification is NEVER auto-passed. TitoPay has no register
//      lookup, so a submission goes to the compliance team through the KYB
//      capability, which is provider-agnostic and returns review_required.
//      Nothing here fabricates a verified business.
//
// WHAT IT DOES NOT DO. It does not move a limit, change a fee, alter an
// existing wallet, migrate an existing business account, or touch personal
// KYC. Everything is additive. An existing business account keeps working
// exactly as it does today and gains the option of a business profile.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
// Business assurance is asked of the KYC capability, never of a company.
const { verifyBusiness, normalizeVerificationStatus } = require("../providers/kyc-provider");

// Which entity types TitoPay supports, and whether the type HAS a registration
// number at all. This is the table that stops a sole proprietor being asked
// for a CIPC number they can never produce.
const BUSINESS_TYPES = {
  sole_proprietor: { label: "Sole proprietor", registered: false },
  partnership: { label: "Partnership", registered: false },
  informal_trader: { label: "Informal trader", registered: false },
  private_company: { label: "Private company (Pty) Ltd", registered: true },
  public_company: { label: "Public company Ltd", registered: true },
  close_corporation: { label: "Close corporation (CC)", registered: true },
  non_profit: { label: "Non profit organisation", registered: true },
  cooperative: { label: "Co-operative", registered: true },
  trust: { label: "Trust", registered: true },
  other: { label: "Other", registered: false }
};

// What a person can BE to a business. A role is an authorisation concept, not
// an identity: the same person holds different roles at different businesses.
const REPRESENTATIVE_ROLES = {
  owner: "Owner",
  director: "Director",
  beneficial_owner: "Beneficial owner",
  authorised_representative: "Authorised representative",
  partner: "Partner",
  trustee: "Trustee",
  member: "Member"
};

// KYB is its own axis. It is not KYC, not AML screening, not risk status and
// not account status, and it is never displayed as any of them.
const KYB_STATUSES = ["unverified", "pending", "review_required", "verified", "rejected"];

let schemaReady = null;
function ensureBusinessSchema() {
  schemaReady ||= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_profiles (
        id UUID PRIMARY KEY,
        account_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
        business_name TEXT NOT NULL,
        trading_name TEXT,
        business_type TEXT NOT NULL DEFAULT 'sole_proprietor',
        registration_number TEXT,
        registration_country TEXT NOT NULL DEFAULT 'ZA',
        kyb_status TEXT NOT NULL DEFAULT 'unverified',
        kyb_reviewed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // A registration number identifies ONE entity in one country. This is the
    // business's unique key, and a person's identity document is deliberately
    // not part of it.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS business_profiles_registration_idx
        ON business_profiles (registration_country, UPPER(registration_number))
        WHERE registration_number IS NOT NULL AND status <> 'closed'`);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS business_profiles_account_idx ON business_profiles (account_user_id)");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_representatives (
        id UUID PRIMARY KEY,
        business_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
        person_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS business_representatives_unique_idx
        ON business_representatives (business_id, person_user_id, role)`);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS business_representatives_person_idx ON business_representatives (person_user_id)");

    // Every attempt, whatever it returned, and which capability answered.
    // Never a credential and never a raw document number.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_verifications (
        id UUID PRIMARY KEY,
        business_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
        submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        assurance TEXT,
        provider_reference TEXT,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS business_verifications_business_idx ON business_verifications (business_id, created_at DESC)");
  })().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// A registration number is a reference issued by a register. It is not free
// text and it is never a 13 digit South African ID: accepting one here is
// exactly the confusion this whole file exists to end.
function normalizeRegistrationNumber(value) {
  const text = cleanText(value, 40).toUpperCase();
  if (!text) return "";
  if (!/^[0-9A-Z][0-9A-Z/\- ]{3,39}$/.test(text)) {
    throw new AppError(400, "Enter the registration number as it appears on the registration certificate.");
  }
  if (/^\d{13}$/.test(text.replace(/\D/g, "")) && !/[/-]/.test(text)) {
    throw new AppError(400,
      "That looks like a personal identity number. A business registration number identifies the business itself, not a person.");
  }
  return text;
}

function businessTypeInfo(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!BUSINESS_TYPES[key]) throw new AppError(400, "Choose the type of business you are registering.");
  return { key, ...BUSINESS_TYPES[key] };
}

function shapeBusiness(row, role = null) {
  return {
    id: row.id,
    businessName: row.business_name,
    tradingName: row.trading_name || null,
    businessType: row.business_type,
    businessTypeLabel: BUSINESS_TYPES[row.business_type]?.label || "Business",
    // The number is reference data the owner typed, not a secret, but it is
    // only ever returned to someone the relationship table already authorises.
    registrationNumber: row.registration_number || null,
    registrationCountry: row.registration_country,
    requiresRegistrationNumber: Boolean(BUSINESS_TYPES[row.business_type]?.registered),
    verificationStatus: row.kyb_status,
    verificationLabel: kybLabel(row.kyb_status),
    verifiedAt: row.kyb_reviewed_at || null,
    status: row.status,
    yourRole: role,
    yourRoleLabel: role ? REPRESENTATIVE_ROLES[role] || "Representative" : null,
    createdAt: row.created_at
  };
}

// Customer-safe wording. It never says who is checking, never quotes a
// provider's vocabulary, and never leaks a risk rating.
function kybLabel(status) {
  return {
    unverified: "Not verified yet",
    pending: "Verification in progress",
    review_required: "Under review",
    verified: "✓ Business verified",
    rejected: "Verification unsuccessful"
  }[status] || "Not verified yet";
}

// Everything a person is authorised on. This is the answer to "one verified
// person, several legitimate businesses": it is a list, and it always was.
async function listMyBusinesses(userId) {
  await ensureBusinessSchema();
  const { rows } = await pool.query(
    `SELECT b.*, r.role
       FROM business_representatives r
       JOIN business_profiles b ON b.id = r.business_id
      WHERE r.person_user_id = $1
        AND r.status = 'active'
        AND b.status <> 'closed'
      ORDER BY b.created_at ASC`,
    [userId]
  );
  return rows.map((row) => shapeBusiness(row, row.role));
}

async function loadAuthorisedBusiness(userId, businessId) {
  const { rows } = await pool.query(
    `SELECT b.*, r.role
       FROM business_representatives r
       JOIN business_profiles b ON b.id = r.business_id
      WHERE r.person_user_id = $1 AND r.business_id = $2 AND r.status = 'active'
      LIMIT 1`,
    [userId, businessId]
  );
  if (!rows[0]) throw new AppError(404, "That business was not found on your account.");
  return rows[0];
}

// THE PERSON IS LOOKED UP, NEVER RE-COLLECTED. A second, third or tenth
// business reuses the identity already verified on the account, which is why
// adding one cannot create a duplicate personal KYC record and cannot trip the
// duplicate-document refusal.
async function loadPerson(userId) {
  const { rows } = await pool.query(
    "SELECT id, full_name, basic_verified_at, kyc_document_type, kyc_issuing_country FROM users WHERE id = $1",
    [userId]
  );
  const person = rows[0];
  if (!person) throw new AppError(404, "Account not found.");
  return person;
}

// VERIFYING the entity still needs a verified person, and that has not moved.
// CAPTURING the entity does not, and used to: a business owner could not so
// much as type their company registration number until they had verified
// themselves, which meant the only screen they could reach asked for an ID
// number and nothing else. Recording a name and a registration number verifies
// nothing on its own, so there is nothing to protect by refusing it.
async function requireVerifiedPerson(userId) {
  const person = await loadPerson(userId);
  if (!person.basic_verified_at) {
    throw new AppError(409,
      "Verify your own identity first. A business is registered by a verified person, and you only ever do that once.");
  }
  return person;
}

// Registering the ENTITY. The authorised person is attached as a relationship,
// with the role they hold. No personal document is asked for here: either the
// person is already verified, in which case asking again would create a second
// identity for the same human being, or they are not yet, in which case this
// row waits as unverified until they are.
async function createBusinessProfile(auth, payload = {}) {
  await ensureBusinessSchema();
  const person = await loadPerson(auth.userId);

  const type = businessTypeInfo(payload.businessType);
  const businessName = cleanText(payload.businessName, 160);
  if (businessName.length < 2) throw new AppError(400, "Enter the name of the business.");
  const tradingName = cleanText(payload.tradingName, 160) || null;

  let registrationNumber = null;
  if (type.registered) {
    registrationNumber = normalizeRegistrationNumber(payload.registrationNumber);
    if (!registrationNumber) {
      throw new AppError(400, `A ${type.label} has a registration number. Enter it exactly as it appears on the registration certificate.`);
    }
  } else if (payload.registrationNumber) {
    // Supplying one anyway is fine and is kept; it is simply not required.
    registrationNumber = normalizeRegistrationNumber(payload.registrationNumber) || null;
  }

  const role = String(payload.role || "owner").trim().toLowerCase();
  if (!REPRESENTATIVE_ROLES[role]) throw new AppError(400, "Choose the role you hold at this business.");

  const registrationCountry = cleanText(payload.registrationCountry || "ZA", 2).toUpperCase() || "ZA";
  const businessId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO business_profiles
           (id, account_user_id, business_name, trading_name, business_type,
            registration_number, registration_country, kyb_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified',$2)`,
        [businessId, auth.userId, businessName, tradingName, type.key, registrationNumber, registrationCountry]
      );
    } catch (error) {
      // The unique index on (country, registration number) is the business's
      // identity. Report it as a business collision, never as anything about
      // the person who submitted it.
      if (error && error.code === "23505") {
        throw new AppError(409,
          "A business with this registration number is already on TitoPay. If it is yours, ask the person who registered it to add you as a representative, or contact Support.");
      }
      throw error;
    }
    await client.query(
      `INSERT INTO business_representatives (id, business_id, person_user_id, role, is_primary)
       VALUES ($1,$2,$3,$4,TRUE)`,
      [crypto.randomUUID(), businessId, auth.userId, role]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await writeAuditLog({
    actorType: "customer",
    actorId: auth.userId,
    action: "business_profile_created",
    entityType: "business_profile",
    entityId: businessId,
    ipAddress: auth.ipAddress,
    userAgent: auth.userAgent,
    metadata: { businessType: type.key, hasRegistrationNumber: Boolean(registrationNumber), role }
  });

  return {
    business: shapeBusiness({
      id: businessId,
      business_name: businessName,
      trading_name: tradingName,
      business_type: type.key,
      registration_number: registrationNumber,
      registration_country: registrationCountry,
      kyb_status: "unverified",
      kyb_reviewed_at: null,
      status: "active",
      created_at: new Date().toISOString()
    }, role),
    // Stated so the app never has to imply the person was re-verified.
    authorisedPerson: { name: person.full_name, identityVerified: true }
  };
}

// Submitting the ENTITY for verification. The person is not re-verified; their
// verified identity is attached as the authorised person on the submission.
async function submitBusinessVerification(auth, businessId) {
  await ensureBusinessSchema();
  const person = await requireVerifiedPerson(auth.userId);
  const business = await loadAuthorisedBusiness(auth.userId, businessId);
  if (business.kyb_status === "verified") {
    return { business: shapeBusiness(business, business.role), alreadyVerified: true };
  }

  const type = businessTypeInfo(business.business_type);
  if (type.registered && !business.registration_number) {
    throw new AppError(400, "Add the business registration number before submitting for verification.");
  }

  // The capability, never a company. The internal adapter answers
  // review_required because TitoPay has no register lookup, and it says so
  // rather than passing a business it did not check.
  const outcome = await verifyBusiness({
    businessId: business.id,
    businessName: business.business_name,
    businessType: business.business_type,
    registrationNumber: business.registration_number,
    registrationCountry: business.registration_country,
    // The authorised person is identified by their TitoPay account, NOT by a
    // document number. Their identity was verified once, on their own record.
    authorisedPerson: { userId: person.id, role: business.role }
  });
  const status = normalizeVerificationStatus(outcome && outcome.status);
  // A submission can only move KYB to a state the check actually reached.
  const kybStatus = KYB_STATUSES.includes(status) ? status : "review_required";

  await pool.query(
    `INSERT INTO business_verifications (id, business_id, submitted_by, status, assurance, provider_reference, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB)`,
    [crypto.randomUUID(), business.id, auth.userId, kybStatus,
      outcome?.assurance || null, outcome?.reference || null,
      JSON.stringify({ businessType: business.business_type, role: business.role })]
  );
  await pool.query(
    `UPDATE business_profiles
        SET kyb_status = $2,
            kyb_reviewed_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE kyb_reviewed_at END,
            updated_at = NOW()
      WHERE id = $1`,
    [business.id, kybStatus]
  );
  await writeAuditLog({
    actorType: "customer",
    actorId: auth.userId,
    action: "business_verification_submitted",
    entityType: "business_profile",
    entityId: business.id,
    ipAddress: auth.ipAddress,
    userAgent: auth.userAgent,
    metadata: { status: kybStatus, businessType: business.business_type }
  });

  return {
    business: shapeBusiness({ ...business, kyb_status: kybStatus }, business.role),
    authorisedPerson: { name: person.full_name, identityVerified: true }
  };
}

// What the app needs to draw the business verification screen. It reports the
// person's identity state and the businesses separately, because they ARE
// separate, and never merges them into one badge.
async function businessVerificationOverview(auth) {
  await ensureBusinessSchema();
  const { rows } = await pool.query(
    "SELECT full_name, basic_verified_at FROM users WHERE id = $1", [auth.userId]);
  const person = rows[0] || {};
  return {
    person: {
      name: person.full_name || "",
      identityVerified: Boolean(person.basic_verified_at),
      // Said plainly so the app never has to imply a second check is coming.
      note: person.basic_verified_at
        ? "Your identity is verified. You do not need to verify it again for any business you add."
        : "Add your business and its registration number now if you like. It waits here until you verify your own identity, which you only ever do once, whatever the business."
    },
    businesses: await listMyBusinesses(auth.userId),
    businessTypes: Object.entries(BUSINESS_TYPES).map(([key, info]) => ({
      key, label: info.label, requiresRegistrationNumber: info.registered
    })),
    roles: Object.entries(REPRESENTATIVE_ROLES).map(([key, label]) => ({ key, label })),
    // Never presented as automatic, and never as a statutory figure.
    limitsNote: "Business limits follow the business's own verification, its risk profile and TitoPay's applicable compliance requirements."
  };
}

module.exports = {
  BUSINESS_TYPES,
  REPRESENTATIVE_ROLES,
  KYB_STATUSES,
  ensureBusinessSchema,
  normalizeRegistrationNumber,
  listMyBusinesses,
  createBusinessProfile,
  submitBusinessVerification,
  businessVerificationOverview
};
