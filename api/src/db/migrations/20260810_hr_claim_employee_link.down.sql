-- Reverses 20260810_hr_claim_employee_link.
--
-- Dropping the column discards the links the backfill made. The `employee`
-- text column is untouched by that migration, so no claim is lost.

DROP INDEX IF EXISTS idx_hr_expenses_employee_id;
ALTER TABLE hr_expense_claims DROP COLUMN IF EXISTS employee_id;
