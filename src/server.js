const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const db      = require('./config/db');
require('dotenv').config();

const app = express();

// ── Auto-migrate on startup ───────────────────────────────────────────────────
async function runMigrations() {
  const migrations = ['migrate_v3.sql', 'migrate_v4.sql', 'migrate_v5.sql', 'migrate_v8_finance.sql'];
  for (const file of migrations) {
    const migrationFile = path.join(__dirname, 'config', file);
    if (!fs.existsSync(migrationFile)) continue;
    try {
      const sql = fs.readFileSync(migrationFile, 'utf8');
      await db.query(sql);
      console.log(`✅ ${file} applied`);
    } catch (err) {
      // Migrations are safe to re-run (IF NOT EXISTS) — log but don't crash
      console.warn(`⚠️  Migration warning (${file}):`, err.message);
    }
  }
}

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files — serve uploaded images ──────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/tables',        require('./routes/tables'));
app.use('/api/menu',          require('./routes/menu'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/inventory',     require('./routes/inventory'));
app.use('/api/warehouse',     require('./routes/warehouse'));
app.use('/api/procurement',   require('./routes/procurement'));
app.use('/api/suppliers',     require('./routes/suppliers'));
app.use('/api/accounting',    require('./routes/accounting'));
app.use('/api/shifts',         require('./routes/shifts'));
app.use('/api/staff-payments', require('./routes/staff-payments'));
app.use('/api/notifications',  require('./routes/notifications'));
app.use('/api/reports',       require('./routes/reports'));
app.use('/api/permissions',   require('./routes/permissions'));
app.use('/api/loans',         require('./routes/loans'));
app.use('/api/finance',       require('./routes/finance'));
app.use('/api/print',         require('./routes/print'));
app.use('/api/super-admin',   require('./routes/super-admin'));
app.use('/api/settings',      require('./routes/settings'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const PORT = process.env.PORT || 5000;

// Run migrations then start server
runMigrations().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
