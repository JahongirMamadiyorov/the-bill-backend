// Run once: node add-owner.js
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const hash = await bcrypt.hash('qwe', 10);
  const res  = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role          = 'owner',
           name          = EXCLUDED.name
     RETURNING id, name, email, role`,
    ['owner', 'qwe', hash]
  );
  console.log('✅ Owner account ready:', res.rows[0]);
  await pool.end();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
