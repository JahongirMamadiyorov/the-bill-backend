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
const WIDTH = 48; // 80mm paper = 48 chars

const sep = () => '='.repeat(WIDTH) + '\n';

// Right-align amount with spaces: "Osh Kabob           2 dona"
function spaceFill(name, amountStr) {
  const spaces = Math.max(2, WIDTH - name.length - amountStr.length);
  return name + ' '.repeat(spaces) + amountStr;
}

// ── Build ESC/POS kitchen ticket ──────────────────────────────────────────────
function buildKitchenTicket({ orderNumber, tableName, orderType, items, stationLabel,
                               customerName, customerPhone, deliveryAddress }) {
  const isToGo = orderType === 'to_go' || orderType === 'takeaway';
  const isDeli = orderType === 'delivery';

  let d = '';
  d += CMD.INIT;

  // ── 1. Station header — double-height + double-width + bold, centered ────
  d += CMD.CENTER;
  d += CMD.DBL_ON;
  d += CMD.BOLD_ON;
  d += (stationLabel || 'KITCHEN') + '\n';
  d += CMD.NORMAL;
  d += CMD.BOLD_OFF;

  // ── 2. Table name — bold, centered (dine-in only) ─────────────────────────
  if (!isToGo && !isDeli && tableName) {
    d += CMD.CENTER;
    d += CMD.BOLD_ON;
    d += tableName + '\n';
    d += CMD.BOLD_OFF;
  }

  // ── 3. Order number + date + time ─────────────────────────────────────────
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh   = String(now.getHours()).padStart(2, '0');
  const min  = String(now.getMinutes()).padStart(2, '0');
  const datetimeStr = `${dd}.${mm}.${yyyy}  ${hh}:${min}`;

  d += CMD.CENTER;
  if (orderNumber) d += `#${orderNumber}   `;
  d += datetimeStr + '\n';

  // ── 4. Separator ──────────────────────────────────────────────────────────
  d += CMD.LEFT;
  d += sep();

  // ── 5. Items — double-height + bold, space-padded amount ──────────────────
  for (const item of items) {
    const qty       = item.quantity || 1;
    const name      = String(item.name || item.item_name || '—');
    const unit      = item.unit || 'piece';
    const amountStr = `${qty} ${unit}`;

    const maxNameLen = WIDTH - amountStr.length - 2;
    const safeName   = name.length > maxNameLen ? name.slice(0, maxNameLen) : name;

    d += CMD.BOLD_ON;
    // ESC ! 0x18 = double-height + bold
    d += ESC + '!\x18';
    d += spaceFill(safeName, amountStr) + '\n';
    d += CMD.NORMAL;
    d += CMD.BOLD_OFF;

    if (item.notes) {
      d += `  * ${item.notes}\n`;
    }
  }

  // ── 6. Separator ──────────────────────────────────────────────────────────
  d += sep();

  // ── 7. Order type — double-height + bold, centered ────────────────────────
  const typeLabel = isDeli ? 'DELIVERY' : isToGo ? 'TO GO' : 'DINE IN';
  d += CMD.CENTER;
  d += ESC + '!\x18'; // double-height + bold
  d += typeLabel + '\n';
  d += CMD.NORMAL;

  // ── 8. Delivery details ───────────────────────────────────────────────────
  if (isDeli) {
    d += CMD.LEFT;
    if (customerName) {
      d += CMD.BOLD_ON + customerName + '\n' + CMD.BOLD_OFF;
    }
    if (customerPhone) {
      d += ESC + '!\x10'; // double-height
      d += customerPhone + '\n';
      d += CMD.NORMAL;
    }
    if (deliveryAddress) {
      d += deliveryAddress + '\n';
    }
  }

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
    // 1. Load full settings (printers + show flags)
    const settingsRes = await db.query(
      `SELECT kitchen_printers,
              kitchen_show_table_name, kitchen_show_order_number,
              kitchen_show_customer_name, kitchen_show_notes,
              kitchen_show_timestamp, kitchen_show_order_type, kitchen_show_qty_unit
       FROM restaurant_settings WHERE restaurant_id=$1`,
      [restaurantId]
    );
    const row = settingsRes.rows[0] || {};
    const kitchenPrinters = row.kitchen_printers;
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

    // 3. Parse show flags (default all to true except item_price)
    const b = (v, def = true) => (v === undefined || v === null ? def : Boolean(v));
    const show = {
      tableName:    b(row.kitchen_show_table_name),
      orderNumber:  b(row.kitchen_show_order_number),
      customerName: b(row.kitchen_show_customer_name),
      notes:        b(row.kitchen_show_notes),
      orderType:    b(row.kitchen_show_order_type),
      qtyUnit:      b(row.kitchen_show_qty_unit),
    };

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
        orderNumber:     show.orderNumber  ? (order.daily_number || order.id?.slice(-4)) : null,
        tableName:       show.tableName    ? (order.table_name || (order.table_number ? `Table ${order.table_number}` : null)) : null,
        orderType:       show.orderType    ? (order.order_type || null) : null,
        customerName:    show.customerName ? (order.customer_name || null) : null,
        customerPhone:   order.customer_phone   || null,
        deliveryAddress: order.delivery_address || null,
        stationLabel,
        items: printerItems,
      });

      return sendToPrinter(printer.ip, printer.port || 9100, ticket)
        .catch(err => console.warn(`[kitchenPrint] ${printer.ip}:${printer.port} — ${err.message}`));
    }));

  } catch (err) {
    console.error('[kitchenPrint] sendKitchenPrintJobs error:', err.message);
  }
}

module.exports = { sendKitchenPrintJobs };
