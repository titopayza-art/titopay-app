-- Senior Marketing joins the announcement approval workflow, and an
-- announcement can now be rejected or escalated instead of only approved.
--
-- TWO EXISTING CONSTRAINTS ARE WIDENED. Nothing is dropped, renamed or deleted,
-- and no existing row can violate either new rule, because every current value
-- stays legal. They are widened rather than replaced because a CHECK cannot be
-- extended in place in PostgreSQL.
--
--   announcement_approvals.approval_role : ('ceo','coo')
--                                       -> ('ceo','coo','senior_marketing')
--     Without this a Senior Marketing approval cannot be recorded at all — the
--     insert would fail the constraint.
--
--   announcement_campaigns.status : ('pending_approval','sent')
--                                -> (… ,'rejected','escalated')
--     Without this there is nowhere to record a rejection or an escalation, so
--     a rejected announcement would have to keep saying "pending approval".

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcement_approvals_approval_role_check') THEN
    ALTER TABLE announcement_approvals DROP CONSTRAINT announcement_approvals_approval_role_check;
  END IF;
  ALTER TABLE announcement_approvals
    ADD CONSTRAINT announcement_approvals_approval_role_check
    CHECK (approval_role IN ('ceo', 'coo', 'senior_marketing'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcement_campaigns_status_check') THEN
    ALTER TABLE announcement_campaigns DROP CONSTRAINT announcement_campaigns_status_check;
  END IF;
  ALTER TABLE announcement_campaigns
    ADD CONSTRAINT announcement_campaigns_status_check
    CHECK (status IN ('pending_approval', 'sent', 'rejected', 'escalated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Why a decision was taken, and by whom. Additive columns only.
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS decision_reason TEXT;
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS escalated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE announcement_campaigns ADD COLUMN IF NOT EXISTS escalation_note TEXT;

CREATE INDEX IF NOT EXISTS idx_announcement_campaigns_status
  ON announcement_campaigns (status, created_at DESC);
