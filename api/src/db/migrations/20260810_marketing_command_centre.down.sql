-- Removes the Marketing & Sales Command Centre and nothing else.
--
-- Every table here was created by the matching .up.sql. Nothing that existed
-- before it is referenced in this file, so running it cannot affect users,
-- merchants, transactions, wallets, invites or announcements — the marketing
-- tables point AT those, never the other way round.
DROP TABLE IF EXISTS marketing_experiment_assignments;
DROP TABLE IF EXISTS marketing_experiment_variants;
DROP TABLE IF EXISTS marketing_experiments;
DROP TABLE IF EXISTS marketing_link_events;
DROP TABLE IF EXISTS marketing_links;
DROP TABLE IF EXISTS marketing_lead_activities;
DROP TABLE IF EXISTS marketing_leads;
DROP TABLE IF EXISTS marketing_affiliates;
DROP TABLE IF EXISTS marketing_referrals;
DROP TABLE IF EXISTS marketing_promo_redemptions;
DROP TABLE IF EXISTS marketing_promotions;
DROP TABLE IF EXISTS marketing_campaign_events;
DROP TABLE IF EXISTS marketing_campaign_spend;
DROP TABLE IF EXISTS marketing_campaigns;
DROP TABLE IF EXISTS marketing_audience_members;
DROP TABLE IF EXISTS marketing_audiences;
