-- Expense claims point at a real employee, not just a typed name.
--
-- Every other employee-linked HR table already carries an employee_id FK.
-- hr_expense_claims was the one exception: it had a free-text `employee`
-- column and nothing else, which is why a claim could be filed against "hh"
-- and why a claim survived the employee record it belonged to.
--
-- Additive only. The column is nullable, existing rows keep their text name,
-- and the backfill links the ones whose name matches exactly one employee.
-- Anything ambiguous is left alone for a person to resolve.

ALTER TABLE hr_expense_claims
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hr_expenses_employee_id
  ON hr_expense_claims (employee_id) WHERE deleted_at IS NULL;

-- Backfill by full name, and only where the name identifies exactly one
-- employee. A name shared by two people is not a link this migration can make.
UPDATE hr_expense_claims AS c
   SET employee_id = matched.id
  FROM (
    -- (ARRAY_AGG(id))[1] rather than MIN(id): there is no MIN for uuid, and the
    -- HAVING below means there is only ever one row to pick from anyway.
    SELECT LOWER(TRIM(first_name || ' ' || last_name)) AS full_name, (ARRAY_AGG(id))[1] AS id
      FROM hr_employees
     WHERE deleted_at IS NULL
     GROUP BY 1
    HAVING COUNT(*) = 1
  ) AS matched
 WHERE c.employee_id IS NULL
   AND LOWER(TRIM(c.employee)) = matched.full_name;
