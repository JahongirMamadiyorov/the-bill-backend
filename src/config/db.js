const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

// Force IPv4 resolution — Render free tier cannot reach IPv6 addresses
dns.setDefaultResultOrder('ipv4first');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let connLogged = false;
pool.on('connect', () => {
  if (!connLogged) { console.log('✅ Connected to PostgreSQL'); connLogged = true; }
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

module.exports = pool;
