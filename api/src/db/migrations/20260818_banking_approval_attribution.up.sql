-- ---------------------------------------------------------------------------
-- Attributable, tamper-evident banking capability approvals.
--
-- WHY. Gate 6 asked the database whether a capability was approved, and the
-- database answered. That made anybody who could write to this table an
-- approver: a psql prompt, a restored backup, a migration run by mistake. The
-- table already carried `approved_by` and `approval_reference`, but nothing
-- checked them, so an approval with both left NULL passed exactly like one a
-- compliance officer had signed.
--
-- These columns let `banking-approval-contract.js` require three things the
-- database cannot supply on its own: attribution, a signature keyed by a secret
-- that lives in the SERVER environment and never in here, and for production a
-- second, different approver.
--
-- ADDITIVE ONLY. No column is dropped, no constraint on an existing column is
-- changed, and no row is rewritten. Existing approvals keep every value they
-- have; they simply stop satisfying gate 6 until they are signed, which is the
-- intended direction and affects nothing today because no approval exists on
-- any deployment.
--
-- NO SECRET IS STORED HERE. A signature is a digest of the approval's own
-- identifying facts. The key that produced it is not in this table, is not in
-- this database, and is never logged.
-- ---------------------------------------------------------------------------

-- The signature over (provider, capability, environment, approved_by,
-- approval_reference, approved_at). Hex HMAC-SHA256, 64 characters.
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS approval_signature TEXT;

-- Named rather than assumed, so an algorithm change is a visible migration
-- rather than a silent reinterpretation of old rows. An unrecognised value is
-- refused by the contract rather than attempted: "algorithm: none" has broken
-- more than one token format.
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS signature_algorithm TEXT;

-- The second person. Required by the contract for production approvals, and
-- required to differ from approved_by.
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS countersigned_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS countersigned_at TIMESTAMPTZ;
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS countersignature TEXT;

-- Tamper-evidence linkage: the append-only audit_logs row written when this
-- approval was granted. A row here with no matching audit event is visible as
-- an approval that appeared without anybody doing anything.
--
-- Deliberately NOT a foreign key. audit_logs is a retention-managed log and a
-- hard reference would either block its cleanup or cascade a delete into a
-- financial control. The linkage is for investigation, not for enforcement.
ALTER TABLE banking_capability_approvals
  ADD COLUMN IF NOT EXISTS audit_event_id UUID;

-- A production approval must name two DIFFERENT people. Enforced in the
-- database as well as in the contract, because a two-person rule that lives
-- only in application code is one bad query away from being one person.
-- Written as NOT (a = b) so a NULL countersigner does not fail here; the
-- contract refuses that case with its own reason.
ALTER TABLE banking_capability_approvals
  DROP CONSTRAINT IF EXISTS banking_approvals_two_person;
ALTER TABLE banking_capability_approvals
  ADD CONSTRAINT banking_approvals_two_person
  CHECK (countersigned_by IS NULL OR approved_by IS NULL OR countersigned_by <> approved_by);

CREATE INDEX IF NOT EXISTS idx_banking_approvals_unsigned
  ON banking_capability_approvals (provider, environment)
  WHERE approved AND revoked_at IS NULL AND approval_signature IS NULL;
