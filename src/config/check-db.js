const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const REQUIRED_TABLES = [
  'users','restaurant_tables','categories','menu_items','orders','order_items',
  'ingredients','menu_item_ingredients','shifts','tax_settings','expenses',
  'cash_flow','notifications'
];

async function check() {
  try {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema='public' ORDER BY table_name`
    );
    const existing = result.rows.map(r => r.table_name);
    console.log('\n=== DB TABLE CHECK ===');
    let missing = [];
    for (const t of REQUIRED_TABLES) {
      const ok = existing.includes(t);
      console.log(`  ${ok ? '✅' : '❌'} ${t}`);
      if (!ok) missing.push(t);
    }
    if (missing.length === 0) {
      console.log('\n✅ All tables present. DB is ready.');
    } else {
      console.log(`\n❌ Missing tables: ${missing.join(', ')}`);
      console.log('Run:  npm run migrate');
    }
  } catch (err) {
    console.error('❌ Cannot connect to DB:', err.message);
    console.log('Check DATABASE_URL in .env and make sure PostgreSQL is running.');
  }
  await pool.end();
}

check();
