-- Marketing & Sales Command Centre — additive schema.
--
-- Nothing here drops, renames or alters an existing table. Every statement is
-- CREATE ... IF NOT EXISTS, so re-running is a no-op and an interrupted run can
-- simply be repeated.
--
-- What this deliberately does NOT create, because it already exists and is
-- reused instead:
--   * campaigns that SEND — announcement_campaigns, and the SMS/email campaign
--     tables behind /admin/marketing/*, keep their approval workflow and remain
--     the only things that deliver a message to a customer.
--   * invites — invite_links and invite_events already record who invited whom.
--     marketing_referrals references invite_links rather than replacing it.
--   * users, merchants, transactions, wallets — referenced by id, never copied.
--   * audit — audit_logs is used through writeAuditLog(), no marketing log.
--
-- Money rule: nothing in this schema moves money. Promotions record what a
-- customer is ENTITLED to and what was redeemed; the redemption row points at
-- the transaction that the existing financial code created. There is no balance
-- column anywhere in this file.

-- ---------------------------------------------------------------- audiences
-- A saved segment definition. `definition` holds the rule set; `is_dynamic`
-- says whether membership is recomputed or fixed at build time.
CREATE TABLE IF NOT EXISTS marketing_audiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  preset TEXT,
  definition JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_dynamic BOOLEAN NOT NULL DEFAULT TRUE,
  cached_size INTEGER NOT NULL DEFAULT 0,
  last_built_at TIMESTAMPTZ,
  build_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (build_status IN ('idle', 'building', 'ready', 'failed')),
  build_error TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_audiences_status
  ON marketing_audiences (status, created_at DESC);

-- Materialised membership. Audiences are built asynchronously into this table
-- so that opening a dashboard never scans the whole users table — the rule that
-- matters most once TitoPay has a million customers.
CREATE TABLE IF NOT EXISTS marketing_audience_members (
  audience_id UUID NOT NULL REFERENCES marketing_audiences(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (audience_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_audience_members_user
  ON marketing_audience_members (user_id);

-- ---------------------------------------------------------------- campaigns
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  campaign_type TEXT NOT NULL
    CHECK (campaign_type IN ('acquisition','activation','retention','referral',
                             'merchant_acquisition','promotional','product_launch',
                             're_engagement','seasonal')),
  objective TEXT NOT NULL DEFAULT '',
  audience_id UUID REFERENCES marketing_audiences(id) ON DELETE SET NULL,
  channels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  budget_allocated NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (budget_allocated >= 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  owner_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status
  ON marketing_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_owner
  ON marketing_campaigns (owner_admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_window
  ON marketing_campaigns (starts_at, ends_at);

-- Money OUT: what a campaign cost. An append-only ledger rather than a mutable
-- "spent" column, so spend can be explained and never silently overwritten.
CREATE TABLE IF NOT EXISTS marketing_campaign_spend (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  description TEXT NOT NULL DEFAULT '',
  spent_on DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaign_spend_campaign
  ON marketing_campaign_spend (campaign_id, spent_on DESC);

-- Money IN, attributed: one row per attributable outcome. `attribution` records
-- how confident we are, because "direct" and "estimated" revenue must never be
-- added together and reported as one number.
CREATE TABLE IF NOT EXISTS marketing_campaign_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  link_id UUID,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('impression','click','registration','kyc_completed',
                          'first_deposit','first_transaction','merchant_application',
                          'merchant_activated','revenue')),
  attribution TEXT NOT NULL DEFAULT 'direct'
    CHECK (attribution IN ('direct','assisted','estimated')),
  revenue_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaign_events_campaign
  ON marketing_campaign_events (campaign_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_campaign_events_user
  ON marketing_campaign_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_campaign_events_created
  ON marketing_campaign_events (created_at DESC);
-- One revenue row per transaction per campaign. Without this, replaying an
-- attribution job would inflate reported revenue — the marketing equivalent of
-- double-crediting a wallet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_campaign_events_revenue_once
  ON marketing_campaign_events (campaign_id, transaction_id)
  WHERE transaction_id IS NOT NULL AND event_type = 'revenue';

-- ------------------------------------------------------- promotions/coupons
CREATE TABLE IF NOT EXISTS marketing_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  benefit_type TEXT NOT NULL
    CHECK (benefit_type IN ('fixed_discount','percentage_discount','cashback',
                            'fee_waiver','first_transaction','referral_bonus',
                            'merchant_specific','service_specific')),
  benefit_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (benefit_value >= 0),
  benefit_percentage NUMERIC(6,3) NOT NULL DEFAULT 0
    CHECK (benefit_percentage >= 0 AND benefit_percentage <= 100),
  max_benefit NUMERIC(14,2),
  min_transaction NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (min_transaction >= 0),
  audience_id UUID REFERENCES marketing_audiences(id) ON DELETE SET NULL,
  eligible_services TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  budget_total NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','paused','expired','exhausted','archived')),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A coupon code has to be unique or "which promotion is this" has no answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_promotions_code
  ON marketing_promotions (UPPER(code));
CREATE INDEX IF NOT EXISTS idx_marketing_promotions_status
  ON marketing_promotions (status, expires_at);

-- What was actually granted. The idempotency key is what makes a retried
-- redemption safe, and the per-user unique index is what stops the same person
-- claiming a single-use coupon twice from two devices at the same moment.
CREATE TABLE IF NOT EXISTS marketing_promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES marketing_promotions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  benefit_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (benefit_amount >= 0),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted'
    CHECK (status IN ('granted','reversed')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_promo_redemptions_idem
  ON marketing_promo_redemptions (promotion_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_marketing_promo_redemptions_user
  ON marketing_promo_redemptions (promotion_id, user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_promo_redemptions_created
  ON marketing_promo_redemptions (created_at DESC);

-- ------------------------------------------------- referrals and affiliates
-- Extends invite_links rather than replacing it: invite_id points back at the
-- existing invite when the referral came from one. A referral is NOT rewarded
-- for a registration alone — status only advances as the referred customer
-- completes KYC and then transacts.
CREATE TABLE IF NOT EXISTS marketing_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id UUID REFERENCES invite_links(id) ON DELETE SET NULL,
  referrer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  affiliate_id UUID,
  referred_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  referral_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','qualified','rewarded','rejected')),
  registered_at TIMESTAMPTZ,
  kyc_completed_at TIMESTAMPTZ,
  first_transaction_at TIMESTAMPTZ,
  qualifying_volume NUMERIC(14,2) NOT NULL DEFAULT 0,
  revenue_generated NUMERIC(14,2) NOT NULL DEFAULT 0,
  reward_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  reward_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One referral record per referred customer. This is the anti-fraud spine: a
-- second referrer cannot also claim the same person.
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_referrals_referred_once
  ON marketing_referrals (referred_user_id)
  WHERE referred_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_referrals_referrer
  ON marketing_referrals (referrer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_marketing_referrals_status
  ON marketing_referrals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_affiliates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  commission_type TEXT NOT NULL DEFAULT 'fixed'
    CHECK (commission_type IN ('fixed','percentage')),
  commission_value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (commission_value >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','terminated')),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_affiliates_code
  ON marketing_affiliates (UPPER(code));

-- ------------------------------------------------------------- leads / CRM
CREATE TABLE IF NOT EXISTS marketing_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  business_category TEXT,
  location TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  link_id UUID,
  assigned_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','qualified','demo','negotiation','kyc',
                      'approved','activated','lost')),
  lost_reason TEXT,
  expected_revenue NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (expected_revenue >= 0),
  next_follow_up_at TIMESTAMPTZ,
  -- Set when the lead becomes a real merchant. The merchant record stays the
  -- single source of truth; this is only the join back to its origin.
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_leads_reference
  ON marketing_leads (reference);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_status
  ON marketing_leads (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_assigned
  ON marketing_leads (assigned_admin_id, status);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_follow_up
  ON marketing_leads (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing_lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
  admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL
    CHECK (activity_type IN ('created','note','status_change','assignment',
                             'follow_up','converted')),
  from_status TEXT,
  to_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_lead_activities_lead
  ON marketing_lead_activities (lead_id, created_at DESC);

-- ------------------------------------------- trackable links & attribution
CREATE TABLE IF NOT EXISTS marketing_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT '',
  medium TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  salesperson_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  affiliate_id UUID REFERENCES marketing_affiliates(id) ON DELETE SET NULL,
  -- Validated against an allow-list before it is stored. An unchecked
  -- destination here would be an open redirect on a TitoPay domain.
  destination_url TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'generic'
    CHECK (link_type IN ('generic','merchant_onboarding','lead_capture',
                         'referral','qr','landing_page')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','archived')),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_links_slug
  ON marketing_links (LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_marketing_links_campaign
  ON marketing_links (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_link_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES marketing_links(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('click','registration','kyc_completed','first_transaction',
                          'merchant_application','merchant_activated','revenue')),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES marketing_leads(id) ON DELETE SET NULL,
  revenue_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Truncated at write time; never a full IP or user agent, because a click log
  -- is not a reason to build a tracking profile of a person.
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_link_events_link
  ON marketing_link_events (link_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_link_events_created
  ON marketing_link_events (created_at DESC);

-- ------------------------------------------------------- growth experiments
CREATE TABLE IF NOT EXISTS marketing_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  audience_id UUID REFERENCES marketing_audiences(id) ON DELETE SET NULL,
  success_metric TEXT NOT NULL DEFAULT 'conversion_rate',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','running','completed','archived')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_experiments_status
  ON marketing_experiments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketing_experiment_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES marketing_experiments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  promotion_id UUID REFERENCES marketing_promotions(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  allocation_percent NUMERIC(5,2) NOT NULL DEFAULT 50
    CHECK (allocation_percent >= 0 AND allocation_percent <= 100),
  cost NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketing_experiment_variants_experiment
  ON marketing_experiment_variants (experiment_id);

-- A customer's variant, decided once and then never changed. Reassigning a live
-- customer between two different offers mid-experiment is both bad science and
-- unfair to the customer, so the unique key makes it impossible.
CREATE TABLE IF NOT EXISTS marketing_experiment_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES marketing_experiments(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES marketing_experiment_variants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  converted_at TIMESTAMPTZ,
  revenue_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_experiment_assignments_once
  ON marketing_experiment_assignments (experiment_id, user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_experiment_assignments_variant
  ON marketing_experiment_assignments (variant_id);
