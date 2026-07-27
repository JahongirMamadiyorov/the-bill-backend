const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const { WebSocketServer } = require('ws');
const jwt        = require('jsonwebtoken');
const db         = require('./config/db');
const { register, unregister } = require('./utils/wsClients');
require('dotenv').config();

const app = express();

// Render (and most PaaS hosts) terminate TLS at their own edge proxy and talk
// to this process over plain HTTP internally, forwarding the real scheme via
// `X-Forwarded-Proto: https`. Express ignores that header by default, so
// `req.protocol` reports 'http' even for a request that arrived over HTTPS —
// this is the confirmed root cause of menu.js's `POST /menu/upload` building
// `fullUrl` as `http://the-bill-backend-pego.onrender.com/uploads/menu/...`
// instead of `https://...`, which then gets blocked by pos-app's Admin panel
// CSP (`img-src ... https://the-bill-backend-pego.onrender.com` — https only,
// on purpose) and would also silently trip browsers' mixed-content blocking
// on the website itself. `trust proxy` makes Express honor the forwarded
// header, so every fullUrl built from here on is correctly https://.
// Existing rows already saved with an http:// image_url are NOT retroactively
// fixed by this — see the client-side upgrade in pos-app's MenuScreen.jsx
// (resolveImgUrl) for the fix covering already-stored bad URLs.
app.set('trust proxy', 1);

// All schema changes are consolidated in src/config/schema.sql.
// Historical migration files have been archived to src/config/migrations_archive/.

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────────────────────
// maxAge so the POS/website don't re-download an unchanged menu photo on every
// screen load — free speed win, no functional change (uploaded filenames are
// already unique per upload, so a long cache lifetime can't ever serve stale
// content for a changed photo).
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), { maxAge: '7d', etag: true }));

// ── Routes ────────────────────────────────────────────────────────────────────
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── 404 + error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── HTTP server (wraps Express so we can attach WebSocket) ────────────────────
const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────
// Clients connect to  wss://the-bill-backend-pego.onrender.com/ws?token=JWT
// Vite proxies        ws://localhost:5173/ws  →  the above URL
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Extract token from query string: /ws?token=...
  const url    = new URL(req.url, 'http://localhost');
  const token  = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Unauthorized — token required');
    return;
  }

  let restaurantId;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    restaurantId  = payload.restaurant_id || payload.restaurantId;
    if (!restaurantId) throw new Error('No restaurantId in token');
  } catch {
    ws.close(4001, 'Unauthorized — invalid token');
    return;
  }

  register(restaurantId, ws);
  console.log(`[WS] Client connected — restaurant ${restaurantId} (total: ${wss.clients.size})`);

  // Keep-alive ping every 30 s so Render doesn't close idle connections
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30_000);

  ws.on('close', () => {
    clearInterval(pingInterval);
    unregister(restaurantId, ws);
    console.log(`[WS] Client disconnected — restaurant ${restaurantId}`);
  });

  ws.on('error', (err) => {
    console.warn('[WS] Socket error:', err.message);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => console.log(`Server running on port ${PORT} (HTTP + WebSocket)`));
