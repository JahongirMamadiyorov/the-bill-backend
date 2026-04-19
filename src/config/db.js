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

const pool = new Pool(poolConfig);

let connLogged = false;
pool.on('connect', () => {
  if (!connLogged) { console.log('Connected to PostgreSQL'); connLogged = true; }
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

module.exports = pool;
