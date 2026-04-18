/**
 * INCREMENTAL PATCH -- adds missing columns/tables WITHOUT dropping any data.
 * Run this instead of `migrate.js --fresh` to keep your existing data safe.
 *
 * Usage:  node src/config/patch.js
 */

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const patches = [
  // ── orders table ──
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS split_payments JSONB`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`,

  // ── order_items table ──
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS item_ready BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ`,

  // ── menu_items table ──
  `ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) DEFAULT 'food'`,

  // ── suppliers table ──
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name TEXT`,
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms TEXT`,
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category TEXT`,

  // ── warehouse_items table ──
  `ALTER TABLE warehouse_items ADD COLUMN IF NOT EXISTS purchase_unit VARCHAR(30)`,

  // ── stock_movements table ──
  `ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS cost_per_unit NUMERIC(12,4)`,

  // ── stock_batches table ──
  `ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,4)`,

  // ── supplier_deliveries table ──
  `ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS payment_note TEXT`,
  `ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS payment_due_date DATE`,

  // ── users table: phone uniqueness ──
  // (won't fail if it already exists -- wrapped in DO block)
  `DO $$ BEGIN
     ALTER TABLE users ADD CONSTRAINT users_restaurant_id_phone_key UNIQUE (restaurant_id, phone);
   EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
   END $$`,

  // ── inventory_audits table ──
  `CREATE TABLE IF NOT EXISTS inventory_audits (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    auditor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    status          VARCHAR(20) DEFAULT 'completed',
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── inventory_audit_items table ──
  `CREATE TABLE IF NOT EXISTS inventory_audit_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id        UUID NOT NULL REFERENCES inventory_audits(id) ON DELETE CASCADE,
    item_id         UUID REFERENCES warehouse_items(id) ON DELETE CASCADE,
    expected_qty    NUMERIC(10,2),
    actual_qty      NUMERIC(10,2),
    variance        NUMERIC(10,2),
    variance_reason TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── warehouse_valuation materialized view ──
  `CREATE MATERIALIZED VIEW IF NOT EXISTS warehouse_valuation AS
   SELECT
     wi.restaurant_id,
     wi.id AS item_id,
     wi.name,
     wi.quantity_in_stock,
     wi.cost_per_unit,
     (wi.quantity_in_stock * wi.cost_per_unit) AS total_value
   FROM warehouse_items wi
   WHERE wi.quantity_in_stock > 0`,
];

async function runPatch() {
  console.log('--- Incremental Patch (no data loss) ---\n');
  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const sql of patches) {
    // Extract a short label from the SQL
    const label = sql.trim().slice(0, 80).replace(/\s+/g, ' ');
    try {
      await pool.query(sql);
      ok++;
      console.log(`[OK] ${label}...`);
    } catch (err) {
      if (err.message.includes('already exists')) {
        skip++;
        console.log(`[--] ${label}... (already exists)`);
      } else {
        fail++;
        console.error(`[!!] ${label}...`);
        console.error(`     ${err.message}`);
      }
    }
  }

  console.log(`\n--- Patch complete: ${ok} applied, ${skip} skipped, ${fail} failed ---`);
  await pool.end();
}

runPatch();
