-- BUSINESS ENTITY, AUTHORISED PERSON, AND THE RELATIONSHIP BETWEEN THEM.
--
-- Purely additive. It creates three tables and touches nothing that exists:
-- no column is dropped, no constraint is changed, no row is rewritten, and no
-- existing user, wallet, transaction, merchant or business account is altered
-- in any way. An installation that never runs this keeps working exactly as it
-- does today, which is why the service also creates these tables on demand.
--
-- WHY: a business account was a person. The FICA pack carried the owner's ID
-- number, and the identity check refuses a document already anchoring another
-- account, so the platform quietly asserted that one person may own one
-- business. The entity now has an identity of its own, the person keeps the
-- single canonical identity they already have, and who they are to the
-- business is a third thing, recorded as a relationship.

CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID PRIMARY KEY,
  -- The TitoPay account the business trades under today. Kept so nothing about
  -- existing wallets, merchants or payouts has to move.
  account_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  business_name TEXT NOT NULL,
  trading_name TEXT,
  -- sole_proprietor, partnership, informal_trader, private_company,
  -- public_company, close_corporation, non_profit, cooperative, trust, other.
  -- Deliberately not a CHECK constraint: the supported list is application
  -- configuration and adding a type must not need a migration.
  business_type TEXT NOT NULL DEFAULT 'sole_proprietor',
  -- NULL is correct and common. A sole proprietor, an informal trader and a
  -- partnership have no registration number and are never asked for one.
  registration_number TEXT,
  registration_country TEXT NOT NULL DEFAULT 'ZA',
  -- KYB is its own axis, separate from the person's KYC, from AML screening,
  -- from risk status and from account status.
  kyb_status TEXT NOT NULL DEFAULT 'unverified',
  kyb_reviewed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE BUSINESS'S UNIQUE KEY IS THE BUSINESS'S OWN NUMBER, in the country that
-- issued it. A person's identity document is deliberately no part of it, which
-- is what lets one verified person hold Business A, B and C.
CREATE UNIQUE INDEX IF NOT EXISTS business_profiles_registration_idx
  ON business_profiles (registration_country, UPPER(registration_number))
  WHERE registration_number IS NOT NULL AND status <> 'closed';

CREATE INDEX IF NOT EXISTS business_profiles_account_idx
  ON business_profiles (account_user_id);

-- WHO A PERSON IS TO A BUSINESS. An authorisation concept, not an identity:
-- many people to one business, many businesses to one person.
CREATE TABLE IF NOT EXISTS business_representatives (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  person_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- owner, director, beneficial_owner, authorised_representative, partner,
  -- trustee, member.
  role TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_representatives_unique_idx
  ON business_representatives (business_id, person_user_id, role);

CREATE INDEX IF NOT EXISTS business_representatives_person_idx
  ON business_representatives (person_user_id);

-- Every KYB attempt and what it returned. No credential, no raw document
-- number, and no provider's own vocabulary: `status` is a TitoPay status.
CREATE TABLE IF NOT EXISTS business_verifications (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  assurance TEXT,
  provider_reference TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS business_verifications_business_idx
  ON business_verifications (business_id, created_at DESC);
