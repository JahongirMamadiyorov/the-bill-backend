const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Pass --fresh to drop all tables first and start clean
const freshStart = process.argv.includes('--fresh');

async function migrate() {
  console.log('--- Multi-Restaurant Schema Migration ---\n');

  if (freshStart) {
    console.log('[..] Fresh start requested -- dropping all tables...');
    try {
      // Drop every table individually to avoid schema permission issues
      const tables = await pool.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `);
      if (tables.rows.length > 0) {
        const names = tables.rows.map(r => `"${r.tablename}"`).join(', ');
        await pool.query(`DROP TABLE IF EXISTS ${names} CASCADE`);
      }
      // Also drop types / enums if any
      await pool.query(`DROP TYPE IF EXISTS order_status CASCADE`);
      console.log(`[OK] Dropped ${tables.rows.length} table(s)\n`);
    } catch (err) {
      console.error('[!!] Drop failed:', err.message);
      // Fallback: try schema drop
      try {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;');
        console.log('[OK] Schema reset via fallback\n');
      } catch (e2) {
        console.error('[!!] Fallback drop also failed:', e2.message);
      }
    }
  }

  // 1. Apply the consolidated schema (tables + indexes + seed data)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
    console.log('[OK] Schema applied successfully');
  } catch (err) {
    if (err.message.includes('already exists') && !freshStart) {
      console.log('[OK] Schema already up to date');
    } else {
      console.error('[!!] Schema error:', err.message);
      console.error('     Detail:', err.detail || 'none');
      console.error('     Hint:', err.hint || 'none');
    }
  }

  // 2. Verify restaurants were seeded
  try {
    const res = await pool.query('SELECT id, name, slug FROM restaurants ORDER BY name');
    if (res.rows.length === 0) {
      console.warn('[!!] No restaurants found -- check schema.sql seed section');
    } else {
      console.log(`[OK] ${res.rows.length} restaurant(s) ready:`);
      res.rows.forEach(r => console.log(`     - ${r.name} (${r.slug})`));
    }
  } catch (e) {
    console.error('[!!] Could not verify restaurants:', e.message);
  }

  // 3. Verify super_admin exists
  try {
    const sa = await pool.query("SELECT id, name, email FROM users WHERE role = 'super_admin'");
    if (sa.rows.length > 0) {
      console.log(`[OK] Super admin: ${sa.rows[0].email}`);
    } else {
      console.warn('[!!] No super_admin user found');
    }
  } catch (e) {
    console.error('[!!] Super admin check:', e.message);
  }

  // 4. Verify core settings exist for each restaurant
  try {
    const settings = await pool.query('SELECT restaurant_id FROM restaurant_settings');
    const tax = await pool.query('SELECT restaurant_id FROM tax_settings');
    console.log(`[OK] ${settings.rows.length} restaurant_settings row(s), ${tax.rows.length} tax_settings row(s)`);
  } catch (e) {
    console.log('[!!] Settings check:', e.message);
  }

  console.log('\n--- Migration complete ---');
  await pool.end();
}

migrate();
