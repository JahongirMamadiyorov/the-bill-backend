const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

// Build pool config.
// Prefer individual PG* env vars (avoids $ and special-char issues in DATABASE_URL).
// Fall back to DATABASE_URL for local development.
let poolConfig;

if (process.env.PGHOST) {
  poolConfig = {
    host:     process.env.PGHOST,
    port:     parseInt(process.env.PGPORT || '6543', 10),
    database: process.env.PGDATABASE || 'postgres',
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl:      process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };
  console.log(`DB config: host=${poolConfig.host}, port=${poolConfig.port}, user=${poolConfig.user}, db=${poolConfig.database}`);
} else {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };
  console.log('DB config: using DATABASE_URL');
}

// ── Session timezone (added 2026-08-09 after the full audit found a real bug) ──
// The database runs in UTC; the restaurants are in Uzbekistan (UTC+5). Every
// report in this backend buckets by LOCAL CALENDAR DAY using `paid_at::date`,
// `DATE(created_at)` or `CURRENT_DATE` — all of which resolve in the SESSION's
// timezone. With a UTC session, the business day rolled over at 05:00 Tashkent,
// so anything sold between local midnight and 5am was counted as the PREVIOUS
// day's revenue. Measured against live data: 62 orders already mis-attributed.
//
// Setting it per-connection fixes every one of those queries at once, rather
// than rewriting dozens of them and having the next new query get it wrong
// again. `timestamptz` values are still STORED as UTC — only the rendering and
// date-casting change, so no existing data is altered.
//
// NOTE: this hardcodes Uzbekistan because every restaurant is there today. If
// the product ever runs in a second timezone, this must become a per-restaurant
// setting — a single global value would then be wrong for someone.
const DB_TIMEZONE = process.env.DB_TIMEZONE || 'Asia/Tashkent';
poolConfig.options = `-c timezone=${DB_TIMEZONE}`;

const pool = new Pool(poolConfig);

let connLogged = false;
pool.on('connect', (client) => {
  // Belt and braces: some poolers ignore the startup `options` parameter, so set
  // it explicitly on each new connection too. Cheap, and a wrong timezone here
  // silently corrupts every financial report.
  client.query(`SET TIME ZONE '${DB_TIMEZONE}'`).catch((e) =>
    console.error('Failed to set session timezone:', e.message));
  if (!connLogged) { console.log(`Connected to PostgreSQL (timezone: ${DB_TIMEZONE})`); connLogged = true; }
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

module.exports = pool;
