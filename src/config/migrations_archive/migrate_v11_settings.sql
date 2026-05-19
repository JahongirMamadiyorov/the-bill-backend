-- ============================================================
-- Migration v11: Extend restaurant_settings with full printer
-- config, receipt/kitchen toggles, and info fields
-- ============================================================

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS address                      TEXT,
  ADD COLUMN IF NOT EXISTS phone                        TEXT,
  ADD COLUMN IF NOT EXISTS logo_url                     TEXT,
  ADD COLUMN IF NOT EXISTS currency_symbol              TEXT DEFAULT 'so''m',
  ADD COLUMN IF NOT EXISTS receipt_footer               TEXT,
  ADD COLUMN IF NOT EXISTS tax_rate                     NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_enabled                  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS receipt_printers             JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS kitchen_printers             JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS receipt_show_logo            BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS receipt_show_tax             BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS receipt_show_service_charge  BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS receipt_show_footer          BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS receipt_show_order_number    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS receipt_show_table_name      BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_order_type      BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_table_name      BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_order_number    BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_customer_name   BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_qty_unit        BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_item_price      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS kitchen_show_notes           BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS kitchen_show_timestamp       BOOLEAN DEFAULT TRUE;

-- Ensure NULL printer arrays become empty arrays (not NULL)
UPDATE restaurant_settings
  SET receipt_printers = '[]'::jsonb WHERE receipt_printers IS NULL;
UPDATE restaurant_settings
  SET kitchen_printers = '[]'::jsonb WHERE kitchen_printers IS NULL;

SELECT 'Migration v11 complete — restaurant_settings fully extended' AS result;
