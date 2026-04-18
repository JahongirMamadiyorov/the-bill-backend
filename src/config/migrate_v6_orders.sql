-- ============================================================
-- Migration v6: Add Order Management fields for Cashier upgrade
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(20) DEFAULT 'dine_in',
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20);

-- Backfill: existing rows that have no order_type get 'dine_in'
UPDATE orders SET order_type = 'dine_in' WHERE order_type IS NULL;

SELECT 'Migration v6 (Order Management) complete!' AS result;
