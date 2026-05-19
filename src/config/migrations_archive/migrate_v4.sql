-- ============================================================
-- Migration v4: Staff Attendance Edit + Payroll Payments
-- Auto-applied on server startup (server.js reads migrate_v4.sql)
-- ============================================================

-- ── shifts: add note column ───────────────────────────────────────────────────
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS note TEXT;

-- ── shifts: add shift_date for manual entries where clock_in may be null ──────
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS shift_date DATE;

-- Backfill shift_date from existing clock_in values
UPDATE shifts SET shift_date = clock_in::date WHERE clock_in IS NOT NULL AND shift_date IS NULL;

-- ── shifts: make clock_in nullable (for manual absent/excused entries) ────────
ALTER TABLE shifts
  ALTER COLUMN clock_in DROP NOT NULL;

-- ── shifts: extend status to include 'excused' ───────────────────────────────
ALTER TABLE shifts
  DROP CONSTRAINT IF EXISTS shifts_status_check;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_status_check
  CHECK (status IN ('present', 'absent', 'late', 'excused'));

-- ── staff_payments: salary/bonus payment records per staff member ─────────────
CREATE TABLE IF NOT EXISTS staff_payments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  amount         NUMERIC(10,2) NOT NULL,
  payment_method VARCHAR(30) DEFAULT 'cash' CHECK (payment_method IN ('cash', 'bank_transfer', 'check', 'other')),
  payment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  note           TEXT,
  recorded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

SELECT 'Migration v4 complete!' AS result;
