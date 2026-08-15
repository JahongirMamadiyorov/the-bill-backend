// ── Receipt Printer Route ─────────────────────────────────────────────────────
// Sends ESC/POS formatted receipt directly to a network thermal printer via TCP.
// Typical setup: Epson/Star/Citizen thermal printer connected via Ethernet/WiFi.
// Default port: 9100 (raw TCP, used by virtually all network receipt printers).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const net     = require('net');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');

// ── SECURITY (fixed 2026-08-09, found by the full audit) ─────────────────────
// This router had NO authentication of any kind while being mounted publicly at
// /api/print. Combined with the route below taking `printerIp` and `printerPort`
// straight from the request body and opening a TCP connection to them, that was
// an UNAUTHENTICATED SERVER-SIDE REQUEST FORGERY vector: anyone on the internet
// could make this server connect to any host:port and write arbitrary bytes to
// it — useful for probing internal services from inside the hosting network.
//
// Every legitimate caller (the website's printAPI) already sends a Bearer token
// via its axios interceptor, so requiring auth breaks nothing. Roles mirror who
// is allowed to take a payment, since that is when a receipt is printed.
// pos-app does NOT use this route at all — it prints over the LAN itself.
router.use(authenticate, authorize('owner', 'admin', 'cashier', 'new_cashier'));

// ── ESC/POS byte constants ────────────────────────────────────────────────────
const ESC = '\x1b';
const GS  = '\x1d';

const CMD = {
  INIT:         ESC + '@',          // Initialize printer
  CENTER:       ESC + 'a\x01',     // Align center
  LEFT:         ESC + 'a\x00',     // Align left
  RIGHT:        ESC + 'a\x02',     // Align right
  BOLD_ON:      ESC + 'E\x01',     // Bold on
  BOLD_OFF:     ESC + 'E\x00',     // Bold off
  DOUBLE_ON:    ESC + '!\x10',     // Double height on
  NORMAL:       ESC + '!\x00',     // Normal font
  FEED:  (n)  => ESC + 'd' + String.fromCharCode(n),  // Feed n lines
  CUT:          GS  + 'V\x41\x05', // Partial cut
};

const RECEIPT_WIDTH = 48; // chars for 80mm paper at standard font

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad = (str, len) => {
  const s = String(str || '').substring(0, len);
  return s + ' '.repeat(Math.max(0, len - s.length));
};

const rpad = (str, len) => {
  const s = String(str || '').substring(0, len);
  return ' '.repeat(Math.max(0, len - s.length)) + s;
};

const dashes = () => '-'.repeat(RECEIPT_WIDTH) + '\n';

// ── Format receipt as ESC/POS string ─────────────────────────────────────────
// r.show flags (all default true if absent):
//   show.logo, show.orderNumber, show.tableName,
//   show.tax, show.serviceCharge, show.footer
function buildEscPos(r) {
  const show = {
    logo:          r.show?.logo          !== false,
    orderNumber:   r.show?.orderNumber   !== false,
    tableName:     r.show?.tableName     !== false,
    tax:           r.show?.tax           !== false,
    serviceCharge: r.show?.serviceCharge !== false,
    footer:        r.show?.footer        !== false,
  };

  let d = '';
  d += CMD.INIT;

  // ── Header — restaurant name (large bold centered) ────────────────────────
  if (show.logo) {
    d += CMD.CENTER;
    d += CMD.BOLD_ON;
    d += CMD.DOUBLE_ON;
    d += (r.restaurantName || 'Restaurant') + '\n';
    d += CMD.NORMAL;
    d += CMD.BOLD_OFF;
  }

  // ── Header text (tagline / receipt_header) ────────────────────────────────
  if (r.headerText) {
    d += CMD.CENTER;
    d += r.headerText + '\n';
  }

  // ── Order info ────────────────────────────────────────────────────────────
  d += CMD.CENTER;
  d += CMD.BOLD_ON;
  const metaLine = [
    show.orderNumber && r.orderNum ? r.orderNum : '',
    show.tableName   && r.tableName ? r.tableName : '',
  ].filter(Boolean).join('  ');
  if (metaLine) d += metaLine + '\n';
  d += (r.dateTime || '') + '\n';
  d += CMD.BOLD_OFF;

  d += CMD.LEFT;
  d += dashes();

  // ── Items ──────────────────────────────────────────────────────────────────
  if (Array.isArray(r.items) && r.items.length > 0) {
    r.items.forEach(item => {
      const name    = String(item.name || '—');
      const rawQty  = parseFloat(item.qty ?? item.quantity) || 1;
      const u       = String(item.unit || 'piece').toLowerCase();
      const weighed = u === 'kg' || u === 'l' || u === 'g' || u === 'ml';
      const qtyStr  = Number.isInteger(rawQty) ? String(rawQty) : parseFloat(rawQty.toFixed(3)).toString();
      const qty     = weighed ? `${qtyStr} ${u}` : `x${qtyStr}`;
      const price   = String(item.total || item.price || '');

      if (name.length <= RECEIPT_WIDTH - qty.length - price.length - 2) {
        d += pad(name, RECEIPT_WIDTH - qty.length - price.length - 1)
           + qty + ' '
           + rpad(price, price.length) + '\n';
      } else {
        d += name.substring(0, RECEIPT_WIDTH) + '\n';
        d += pad('', RECEIPT_WIDTH - qty.length - price.length - 1)
           + qty + ' '
           + rpad(price, price.length) + '\n';
      }
    });
  }

  d += dashes();

  // ── Subtotal / tax / service / discount ───────────────────────────────────
  if (r.subtotal && r.subtotal !== r.total) {
    d += pad('Subtotal', RECEIPT_WIDTH - String(r.subtotal).length) + r.subtotal + '\n';
  }
  if (show.tax && r.tax) {
    d += pad(`Tax (${r.taxRate || ''}%)`, RECEIPT_WIDTH - String(r.tax).length) + r.tax + '\n';
  }
  if (show.serviceCharge && r.service) {
    d += pad(`Service (${r.serviceRate || ''}%)`, RECEIPT_WIDTH - String(r.service).length) + r.service + '\n';
  }
  if (r.discount) {
    d += pad(`Discount${r.discountReason ? ' (' + r.discountReason + ')' : ''}`,
             RECEIPT_WIDTH - String(r.discount).length)
       + r.discount + '\n';
  }

  // ── Total — bold, double-height ────────────────────────────────────────────
  d += dashes();
  d += CMD.BOLD_ON;
  d += CMD.DOUBLE_ON;
  d += pad('TOTAL', RECEIPT_WIDTH - String(r.total || '').length) + (r.total || '') + '\n';
  d += CMD.NORMAL;
  d += CMD.BOLD_OFF;
  d += dashes();

  // ── Payment method / change ───────────────────────────────────────────────
  d += CMD.BOLD_ON;
  d += pad('Method', RECEIPT_WIDTH - String(r.method || '').length) + (r.method || '') + '\n';
  if (r.change && r.change !== '0') {
    d += pad('Change', RECEIPT_WIDTH - String(r.change).length) + r.change + '\n';
  }
  d += CMD.BOLD_OFF;

  // ── Footer ─────────────────────────────────────────────────────────────────
  if (show.footer) {
    const footerText = r.footer || 'Thank you for dining with us!';
    d += dashes();
    d += CMD.CENTER;
    d += CMD.BOLD_ON;
    d += footerText + '\n';
    d += CMD.BOLD_OFF;
  }

  // Feed + cut
  d += CMD.FEED(4);
  d += CMD.CUT;

  return d;
}

// ── POST /api/print/receipt ───────────────────────────────────────────────────
// Body: { printerIp, printerPort?, receipt: { restaurantName, orderNum,
//         tableName, dateTime, items, subtotal, tax, service, discount,
//         total, method, change, footer } }
router.post('/receipt', (req, res) => {
  const { printerIp, printerPort = 9100, receipt } = req.body;

  if (!printerIp) {
    return res.status(400).json({ error: 'printerIp is required' });
  }
  if (!receipt) {
    return res.status(400).json({ error: 'receipt data is required' });
  }

  const escposData = buildEscPos(receipt);
  const buffer     = Buffer.from(escposData, 'binary');

  const client = new net.Socket();
  let responded = false;

  const fail = (msg) => {
    if (!responded) {
      responded = true;
      client.destroy();
      res.status(500).json({ error: msg });
    }
  };

  client.setTimeout(5000); // 5-second connection timeout

  client.connect(Number(printerPort), printerIp, () => {
    client.write(buffer, 'binary', (err) => {
      if (err) return fail('Write error: ' + err.message);
      if (!responded) {
        responded = true;
        client.end();
        res.json({ success: true, message: 'Receipt sent to printer' });
      }
    });
  });

  client.on('timeout', () => fail('Connection timed out — check printer IP and that it is online'));
  client.on('error',   (err) => fail('Printer connection error: ' + err.message));
});

module.exports = router;
