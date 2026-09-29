-- WHAT A BUSINESS DOES, AND WHERE ITS MONEY COMES FROM.
--
-- Four columns on business_profiles. Purely additive: nothing is dropped, no
-- constraint on an existing column changes, no row is rewritten, and a
-- deployment that never applies this keeps working exactly as it does.
--
-- SELF-DECLARED, AND NOT VERIFICATION. A business chooses these itself and
-- nothing here is evidence of anything. kyb_status is a separate axis and this
-- migration does not touch it, read it or affect it.
--
-- No CHECK constraint on the values, deliberately, for the same reason
-- business_type has none: the supported list is application configuration in
-- src/config/business-profile-reference.js, and adding an industry must be a
-- deploy rather than a migration.

-- One industry. The thing the business actually does.
ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS industry TEXT;

-- Where the money comes in from. An array because a real business usually has
-- more than one, ordered with the primary first so "mostly trading, sometimes a
-- grant" is distinguishable from the reverse. Capped in the service at five.
ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS sources_of_funds JSONB NOT NULL DEFAULT '[]'::JSONB;

-- The customer's own words, and ONLY ever when they picked "Something else".
-- Kept separate from the keys so a free-text answer can never be mistaken for a
-- selected option by anything reading this table.
ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS industry_other TEXT;
ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS source_of_funds_other TEXT;

-- When the business last told us. A commercial profile that has not been
-- touched in three years is not the same as one confirmed last month, and
-- without this there is no way to tell them apart.
ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS commercial_profile_updated_at TIMESTAMPTZ;

-- Answers the operational question this exists for: which businesses have not
-- told us yet.
CREATE INDEX IF NOT EXISTS idx_business_profiles_industry
  ON business_profiles (industry)
  WHERE industry IS NOT NULL;
