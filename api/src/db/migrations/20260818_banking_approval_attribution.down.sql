-- ---------------------------------------------------------------------------
-- Reverse the approval attribution columns.
--
-- WHAT THIS COSTS, BEFORE YOU RUN IT: reversing this REMOVES a financial
-- control. Without these columns, gate 6 is back to trusting any row in
-- `banking_capability_approvals`, and database write access is enough to
-- approve a bank rail again. Do not run it to "clean up"; run it only to undo
-- the migration on a deployment where the banking layer was never used.
--
-- Signatures and countersignatures are DESTROYED by this, and cannot be
-- recomputed from anything left behind, because the material includes
-- `approved_at` to the millisecond. Export the table first if any approval has
-- ever been granted.
--
-- Nothing outside this table is touched, and no financial table is read or
-- written, so reversing cannot alter a balance.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_banking_approvals_unsigned;

ALTER TABLE banking_capability_approvals
  DROP CONSTRAINT IF EXISTS banking_approvals_two_person;

ALTER TABLE banking_capability_approvals DROP COLUMN IF EXISTS audit_event_id;
ALTER TABLE banking_capability_approvals DROP COLUMN IF EXISTS countersignature;
ALTER TABLE banking_capability_approvals DROP COLUMN IF EXISTS countersigned_at;
ALTER TABLE banking_capability_approvals DROP COLUMN IF EXISTS countersigned_by;
ALTER TABLE banking_capability_approvals DROP COLUMN IF EXISTS signature_algorithm;
ALTER TABLE banking_capability_approvals DROP COLUMN IF EXISTS approval_signature;
