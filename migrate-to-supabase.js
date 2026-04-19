/**
 * migrate-to-supabase.js
 *
 * Reads ALL data from your local PostgreSQL and inserts it into Supabase.
 *
 * Usage:
 *   node migrate-to-supabase.js
 *
 * Before running, make sure:
 *   1. Your local PostgreSQL is running
 *   2. npm install pg (already installed)
 */

const { Pool } = require('pg');

// ── CONFIG ──────────────────────────────────────────────────
// LOCAL database (your machine)
const LOCAL_DB = {
  host: 'localhost',
  port: 5432,
  database: 'restaurant_db',  // Change this if your DB name is different
  user: 'postgres',
  password: 'postgres',       // Change this if your local password is different
};

// SUPABASE database (production) - using pooler for IPv4 compatibility
const SUPABASE_DB = {
  host: 'aws-1-ap-northeast-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.uubfvjcwrumfijjqtjjb',
  password: 'TheBill2026SecurePass',
  ssl: { rejectUnauthorized: false },
};

// Tables in dependency order (parents first, children after)
const TABLES_IN_ORDER = [
  'restaurants',
  'subscription_history',
  'users',
  'waitress_permissions',
  'categories',
  'custom_stations',
  'table_sections',
  'restaurant_tables',
  'menu_items',
  'menu_item_ingredients',
  'warehouse_items',
  'stock_batches',
  'stock_movements',
  'suppliers',
  'purchase_orders',
  'purchase_order_items',
  'supplier_deliveries',
  'delivery_items',
  'orders',
  'order_items',
  'customers',
  'loans',
  'expenses',
  'cash_flow',
  'tax_settings',
  'restaurant_settings',
  'notifications',
  'shifts',
  'staff_payments',
  'finance_expenses',
  'finance_loans',
  'finance_loan_payments',
  'finance_budgets',
  'finance_manual_income',
  'inventory_audits',
  'inventory_audit_items',
  'audit_logs',
];

async function migrate() {
  const localPool = new Pool(LOCAL_DB);
  const supaPool = new Pool(SUPABASE_DB);

  try {
    // Test connections
    console.log('Testing local database connection...');
    await localPool.query('SELECT 1');
    console.log('[OK] Local database connected');

    console.log('Testing Supabase connection...');
    await supaPool.query('SELECT 1');
    console.log('[OK] Supabase connected');

    // Clear Supabase data in reverse order (children first)
    console.log('\n--- Clearing existing Supabase data ---');
    for (const table of [...TABLES_IN_ORDER].reverse()) {
      try {
        await supaPool.query(`DELETE FROM public.${table}`);
        console.log(`  Cleared: ${table}`);
      } catch (e) {
        console.log(`  Skip clear ${table}: ${e.message}`);
      }
    }

    // Migrate each table
    console.log('\n--- Migrating data ---');
    let totalRows = 0;

    for (const table of TABLES_IN_ORDER) {
      try {
        // Get all rows from local
        const { rows } = await localPool.query(`SELECT * FROM public.${table}`);

        if (rows.length === 0) {
          console.log(`  ${table}: 0 rows (empty)`);
          continue;
        }

        // Insert in batches of 50
        const batchSize = 50;
        let inserted = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);

          for (const row of batch) {
            const columns = Object.keys(row);
            const values = Object.values(row);
            const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');
            const colNames = columns.map(c => `"${c}"`).join(', ');

            try {
              await supaPool.query(
                `INSERT INTO public.${table} (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
                values
              );
              inserted++;
            } catch (e) {
              console.error(`    Error inserting into ${table}: ${e.message}`);
              // Log the problematic row for debugging
              if (inserted === 0) {
                console.error(`    First row keys: ${columns.join(', ')}`);
              }
            }
          }
        }

        console.log(`  ${table}: ${inserted}/${rows.length} rows migrated`);
        totalRows += inserted;
      } catch (e) {
        console.log(`  ${table}: SKIPPED (${e.message})`);
      }
    }

    // Reset sequences so new inserts get correct IDs
    console.log('\n--- Resetting sequences ---');
    const seqResult = await supaPool.query(`
      SELECT sequence_name FROM information_schema.sequences
      WHERE sequence_schema = 'public'
    `);

    for (const seq of seqResult.rows) {
      try {
        // Find the table and column this sequence belongs to
        const depResult = await supaPool.query(`
          SELECT d.refobjid::regclass AS table_name, a.attname AS column_name
          FROM pg_depend d
          JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
          WHERE d.objid = '${seq.sequence_name}'::regclass
          LIMIT 1
        `);

        if (depResult.rows.length > 0) {
          const { table_name, column_name } = depResult.rows[0];
          await supaPool.query(`
            SELECT setval('${seq.sequence_name}', COALESCE((SELECT MAX("${column_name}") FROM ${table_name}), 1))
          `);
        }
      } catch (e) {
        // Sequence might not be linked to a table, skip
      }
    }

    console.log(`\n=== Migration complete! ${totalRows} total rows migrated ===`);

  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await localPool.end();
    await supaPool.end();
  }
}

migrate();
