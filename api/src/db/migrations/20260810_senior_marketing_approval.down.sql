-- Narrows the two constraints back and drops the six added columns.
--
-- NOT SAFE TO RUN BLINDLY: any announcement already rejected or escalated, and
-- any Senior Marketing approval already recorded, would violate the narrower
-- rules. The two DELETEs below remove exactly those rows first. Take a backup.
DELETE FROM announcement_approvals WHERE approval_role = 'senior_marketing';
UPDATE announcement_campaigns SET status = 'pending_approval'
 WHERE status IN ('rejected', 'escalated');

ALTER TABLE announcement_approvals DROP CONSTRAINT IF EXISTS announcement_approvals_approval_role_check;
ALTER TABLE announcement_approvals
  ADD CONSTRAINT announcement_approvals_approval_role_check CHECK (approval_role IN ('ceo', 'coo'));

ALTER TABLE announcement_campaigns DROP CONSTRAINT IF EXISTS announcement_campaigns_status_check;
ALTER TABLE announcement_campaigns
  ADD CONSTRAINT announcement_campaigns_status_check CHECK (status IN ('pending_approval', 'sent'));

ALTER TABLE announcement_campaigns DROP COLUMN IF EXISTS escalation_note;
ALTER TABLE announcement_campaigns DROP COLUMN IF EXISTS escalated_at;
ALTER TABLE announcement_campaigns DROP COLUMN IF EXISTS escalated_by;
ALTER TABLE announcement_campaigns DROP COLUMN IF EXISTS decided_at;
ALTER TABLE announcement_campaigns DROP COLUMN IF EXISTS decided_by;
ALTER TABLE announcement_campaigns DROP COLUMN IF EXISTS decision_reason;
