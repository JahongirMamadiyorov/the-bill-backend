/**
 * wsClients.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Maintains a registry of authenticated WebSocket connections, scoped by
 * restaurantId. Provides a broadcast() helper used by route handlers.
 *
 * Usage in routes:
 *   const { broadcast } = require('../utils/wsClients');
 *   broadcast(restaurantId, { type: 'new_order', order, items });
 */

// Map<restaurantId, Set<WebSocket>>
const clients = new Map();

function register(restaurantId, ws) {
  if (!clients.has(restaurantId)) clients.set(restaurantId, new Set());
  clients.get(restaurantId).add(ws);
}

function unregister(restaurantId, ws) {
  const set = clients.get(restaurantId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) clients.delete(restaurantId);
}

/**
 * Broadcast a JSON-serialisable message to all open connections for a
 * given restaurant. Silently skips closed sockets.
 */
function broadcast(restaurantId, data) {
  const set = clients.get(restaurantId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(msg); } catch (_) {}
    }
  }
}

module.exports = { register, unregister, broadcast };
