-- ============================================================
-- Migration v5: Add salary_type to users
-- Fixes bug where every employee defaulted to 'Monthly' on load
-- because salary_type was never persisted in the database.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS salary_type VARCHAR(20) DEFAULT 'monthly';

-- Backfill: existing rows that have no salary_type get 'monthly' (already the DEFAULT, but explicit)
UPDATE users SET salary_type = 'monthly' WHERE salary_type IS NULL;

SELECT 'Migration v5 complete!' AS result;
