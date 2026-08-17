-- Reverse the commercial profile columns.
--
-- WHAT THIS COSTS: every business's declared industry and sources of funds are
-- destroyed, and nothing else holds a copy. They are self-declared answers that
-- can only be recovered by asking every business again. Export first if any
-- business has completed the screen.
--
-- Nothing outside business_profiles is touched and no financial table is read
-- or written, so reversing cannot alter a balance.

DROP INDEX IF EXISTS idx_business_profiles_industry;

ALTER TABLE business_profiles DROP COLUMN IF EXISTS commercial_profile_updated_at;
ALTER TABLE business_profiles DROP COLUMN IF EXISTS source_of_funds_other;
ALTER TABLE business_profiles DROP COLUMN IF EXISTS industry_other;
ALTER TABLE business_profiles DROP COLUMN IF EXISTS sources_of_funds;
ALTER TABLE business_profiles DROP COLUMN IF EXISTS industry;
