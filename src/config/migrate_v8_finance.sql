-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration v8 — Finance Module Tables
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS finance_expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  category      VARCHAR(50) NOT NULL,
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  description   TEXT,
  recurring     BOOLEAN DEFAULT FALSE,
  frequency     VARCHAR(20),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_loans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  lender_name   VARCHAR(150) NOT NULL,
  total_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid   NUMERIC(12,2) NOT NULL DEFAULT 0,
  interest_rate NUMERIC(5,2) DEFAULT 0,
  due_date      DATE,
  notes         TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paid','overdue')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_loan_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id       UUID NOT NULL REFERENCES finance_loans(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  payment_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  method        VARCHAR(30) DEFAULT 'cash',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_budgets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  category      VARCHAR(50) NOT NULL,
  monthly_budget NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (restaurant_id, category)
);

CREATE TABLE IF NOT EXISTS finance_manual_income (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  category      VARCHAR(50) DEFAULT 'Sales',
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_fin_expenses_rest_date    ON finance_expenses (restaurant_id, date);
CREATE INDEX IF NOT EXISTS idx_fin_loans_rest            ON finance_loans (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_fin_loan_pay_loan         ON finance_loan_payments (loan_id);
CREATE INDEX IF NOT EXISTS idx_fin_budgets_rest          ON finance_budgets (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_fin_manual_inc_rest_date  ON finance_manual_income (restaurant_id, date);
