-- Reverses the additive business entity tables. Nothing else was changed by
-- the up migration, so nothing else has to be restored here.
--
-- This DOES destroy business profiles, their representative relationships and
-- their KYB history. It touches no user, wallet, transaction, merchant or
-- existing business account.

DROP TABLE IF EXISTS business_verifications;
DROP TABLE IF EXISTS business_representatives;
DROP TABLE IF EXISTS business_profiles;
