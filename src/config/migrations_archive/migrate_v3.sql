-- ============================================================
-- Migration v3: Fix missing columns
-- Run: psql -U postgres -d restaurant_db -f restaurant-app/backend/src/config/migrate_v3.sql
-- ============================================================

-- ── warehouse_items: add missing columns ─────────────────────────────────────
ALTER TABLE warehouse_items
  ADD COLUMN IF NOT EXISTS category        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sku_code        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS unit            VARCHAR(30),
  ADD COLUMN IF NOT EXISTS min_stock_level NUMERIC(10,2) DEFAULT 5,
  ADD COLUMN IF NOT EXISTS low_stock_alert NUMERIC(10,2) DEFAULT 5,
  ADD COLUMN IF NOT EXISTS cost_per_unit   NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_id     UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMP DEFAULT NOW();

-- Make sku_code unique only if not already (ignore error if constraint exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_items_sku_code_key'
  ) THEN
    ALTER TABLE warehouse_items ADD CONSTRAINT warehouse_items_sku_code_key UNIQUE (sku_code);
  END IF;
END $$;

-- ── restaurant_tables: add missing columns ────────────────────────────────────
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS name               VARCHAR(100),
  ADD COLUMN IF NOT EXISTS section            VARCHAR(50)  DEFAULT 'Indoor',
  ADD COLUMN IF NOT EXISTS shape              VARCHAR(20)  DEFAULT 'Square',
  ADD COLUMN IF NOT EXISTS guests_count       INT,
  ADD COLUMN IF NOT EXISTS reservation_guest  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reservation_phone  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS reservation_date   DATE,
  ADD COLUMN IF NOT EXISTS reservation_time   VARCHAR(10);

-- Extend tables status to include 'cleaning'
ALTER TABLE restaurant_tables
  DROP CONSTRAINT IF EXISTS restaurant_tables_status_check;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_status_check
  CHECK (status IN ('free', 'occupied', 'reserved', 'closed', 'cleaning'));

-- Backfill table names
UPDATE restaurant_tables
  SET name = 'Table ' || table_number
  WHERE name IS NULL;

-- ── stock_movements: add missing columns if any ───────────────────────────────
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS notes TEXT;

SELECT 'Migration v3 complete!' AS result;
