/**
 * kitchenPrint.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-prints kitchen tickets to the correct thermal printer(s) based on each
 * order item's kitchen_station.
 *
 * Flow:
 *  1. Load kitchen_printers from restaurant_settings (JSONB array)
 *  2. For every item in the order, look up its kitchen_station
 *  3. Group items by which kitchen printer handles their station
 *     – A printer with an empty stations array receives ALL items
 *     – Items whose station matches NO printer are sent to any printer
 *       that has an empty stations array, or skipped if none exists
 *  4. Fire TCP ESC/POS jobs (fire-and-forget — never blocks the request)
 */

const net = require('net');

// ── ESC/POS constants ─────────────────────────────────────────────────────────
const ESC = '\x1b';
const GS  = '\x1d';
const CMD = {
  INIT:     ESC + '@',
  CENTER:   ESC + 'a\x01',
  LEFT:     ESC + 'a\x00',
  BOLD_ON:  ESC + 'E\x01',
  BOLD_OFF: ESC + 'E\x00',
  DBL_ON:   ESC + '!\x30',   // double height + double width
  NORMAL:   ESC + '!\x00',
  FEED: (n) => ESC + 'd' + String.fromCharCode(n),
  CUT:      GS  + 'V\x41\x05',
};
const WIDTH = 32; // chars for 58mm; use 42 for 80mm — kept at 32 for max compat

const dashes = () => '-'.repeat(WIDTH) + '\n';

// ── Build ESC/POS kitchen ticket ──────────────────────────────────────────────
function buildKitchenTicket({ orderNumber, tableName, orderType, items, stationLabel, timestamp }) {
  let d = '';
  d += CMD.INIT;

  // Header: station name in big text
  d += CMD.CENTER;
  d += CMD.BOLD_ON;
  d += CMD.DBL_ON;
  d += (stationLabel || 'KITCHEN') + '\n';
  d += CMD.NORMAL;
  d += CMD.BOLD_OFF;

  // Order meta
  d += CMD.BOLD_ON;
  d += `#${orderNumber || '?'}`;
  if (tableName) d += `  ${tableName}`;
  d += '\n';
  d += CMD.BOLD_OFF;
  if (orderType && orderType !== 'dine_in') {
    d += orderType.toUpperCase() + '\n';
  }
  d += (timestamp || new Date().toLocaleTimeString()) + '\n';

  d += CMD.LEFT;
  d += dashes();

  // Items
  for (const item of items) {
    const qty  = item.quantity || 1;
    const name = String(item.name || item.item_name || '—');
    d += CMD.BOLD_ON;
    d += `x${qty}  ${name}\n`;
    d += CMD.BOLD_OFF;
    if (item.notes) {
      d += `     * ${item.notes}\n`;
    }
  }

  d += dashes();
  d += CMD.FEED(4);
  d += CMD.CUT;
  return d;
}

// ── Send raw ESC/POS string to a TCP thermal printer ─────────────────────────
function sendToPrinter(ip, port, escposStr) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const buf    = Buffer.from(escposStr, 'binary');
    let done     = false;
    const finish = (err) => { if (!done) { done = true; client.destroy(); err ? reject(err) : resolve(); } };

    client.setTimeout(5000);
    client.connect(Number(port) || 9100, ip, () => {
      client.write(buf, 'binary', (err) => { if (err) return finish(err); finish(null); });
    });
    client.on('timeout', () => finish(new Error('Printer connection timed out')));
    client.on('error',   (err) => finish(err));
  });
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * sendKitchenPrintJobs
 * @param {object} opts
 * @param {object} opts.db          - pg Pool/client with .query()
 * @param {string} opts.restaurantId
 * @param {object} opts.order       - order row (id, daily_number, order_type, table_number/tableName)
 * @param {Array}  opts.items       - array of { menu_item_id, quantity, notes, kitchen_station?, name? }
 *
 * Always resolves — errors are logged but never thrown (fire-and-forget).
 */
async function sendKitchenPrintJobs({ db, restaurantId, order, items }) {
  try {
    // 1. Load kitchen printers config
    const settingsRes = await db.query(
      'SELECT kitchen_printers FROM restaurant_settings WHERE restaurant_id=$1',
      [restaurantId]
    );
    const kitchenPrinters = settingsRes.rows[0]?.kitchen_printers;
    if (!Array.isArray(kitchenPrinters) || kitchenPrinters.length === 0) return;

    // 2. Fetch kitchen_station for any items that don't already have it
    const missingStation = items.filter(i => !i.kitchen_station && i.menu_item_id);
    if (missingStation.length > 0) {
      const ids = [...new Set(missingStation.map(i => i.menu_item_id))];
      const stationRes = await db.query(
        'SELECT id, kitchen_station, name FROM menu_items WHERE id = ANY($1)',
        [ids]
      );
      const stationMap = Object.fromEntries(stationRes.rows.map(r => [r.id, { station: r.kitchen_station, name: r.name }]));
      items = items.map(i => ({
        ...i,
        kitchen_station: i.kitchen_station ?? stationMap[i.menu_item_id]?.station ?? null,
        name: i.name || i.item_name || stationMap[i.menu_item_id]?.name || '—',
      }));
    }

    // 3. For each kitchen printer, collect the items it should print
    const timestamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    const jobs = kitchenPrinters
      .filter(p => p && p.ip)  // must have an IP to print
      .map(printer => {
        const assignedStations = Array.isArray(printer.stations) ? printer.stations : [];
        const catchAll = assignedStations.length === 0;

        const printerItems = items.filter(item => {
          if (catchAll) return true;                          // printer handles everything
          const station = (item.kitchen_station || '').trim();
          if (!station) return true;                          // unassigned item → all printers
          return assignedStations.some(s => s.toLowerCase() === station.toLowerCase());
        });

        return { printer, printerItems };
      })
      .filter(j => j.printerItems.length > 0);

    if (jobs.length === 0) return;

    // 4. Fire print jobs concurrently (fire-and-forget errors)
    await Promise.allSettled(jobs.map(({ printer, printerItems }) => {
      // Determine label: if printer handles specific stations, use first station name
      const stationLabel = Array.isArray(printer.stations) && printer.stations.length > 0
        ? printer.stations.join(' / ')
        : (printer.name || 'KITCHEN');

      const ticket = buildKitchenTicket({
        orderNumber: order.daily_number || order.id?.slice(-4),
        tableName:   order.table_number || order.tableName || null,
        orderType:   order.order_type   || null,
        stationLabel,
        items: printerItems,
        timestamp,
      });

      return sendToPrinter(printer.ip, printer.port || 9100, ticket)
        .catch(err => console.warn(`[kitchenPrint] ${printer.ip}:${printer.port} — ${err.message}`));
    }));

  } catch (err) {
    console.error('[kitchenPrint] sendKitchenPrintJobs error:', err.message);
  }
}

module.exports = { sendKitchenPrintJobs };
