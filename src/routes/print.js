// ── Receipt Printer Route ─────────────────────────────────────────────────────
// Sends ESC/POS formatted receipt directly to a network thermal printer via TCP.
// Typical setup: Epson/Star/Citizen thermal printer connected via Ethernet/WiFi.
// Default port: 9100 (raw TCP, used by virtually all network receipt printers).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const net     = require('net');
const router  = express.Router();

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

const RECEIPT_WIDTH = 32; // chars for 80mm paper at standard font

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
function buildEscPos(r) {
  let d = '';

  d += CMD.INIT;

  // Header — restaurant name (large bold centered)
  d += CMD.CENTER;
  d += CMD.BOLD_ON;
  d += CMD.DOUBLE_ON;
  d += (r.restaurantName || 'Restaurant') + '\n';
  d += CMD.NORMAL;
  d += CMD.BOLD_OFF;

  // Order info
  d += (r.orderNum || '') + '  ' + (r.tableName || '') + '\n';
  d += (r.dateTime || '') + '\n';
  d += CMD.LEFT;
  d += dashes();

  // Items
  if (Array.isArray(r.items) && r.items.length > 0) {
    r.items.forEach(item => {
      const name  = String(item.name || '—');
      const qty   = `x${item.qty || item.quantity || 1}`;
      const price = String(item.total || item.price || '');

      // Name line — truncate if long
      if (name.length <= RECEIPT_WIDTH - qty.length - price.length - 2) {
        d += pad(name, RECEIPT_WIDTH - qty.length - price.length - 1)
           + qty + ' '
           + rpad(price, price.length) + '\n';
      } else {
        // Name wraps to 2 lines
        d += name.substring(0, RECEIPT_WIDTH) + '\n';
        d += pad('', RECEIPT_WIDTH - qty.length - price.length - 1)
           + qty + ' '
           + rpad(price, price.length) + '\n';
      }
    });
  }

  d += dashes();

  // Subtotal / tax / service / discount
  if (r.subtotal && r.subtotal !== r.total) {
    d += pad('Subtotal', RECEIPT_WIDTH - String(r.subtotal).length)
       + r.subtotal + '\n';
  }
  if (r.tax) {
    d += pad(`Tax (${r.taxRate || ''}%)`, RECEIPT_WIDTH - String(r.tax).length)
       + r.tax + '\n';
  }
  if (r.service) {
    d += pad(`Service (${r.serviceRate || ''}%)`, RECEIPT_WIDTH - String(r.service).length)
       + r.service + '\n';
  }
  if (r.discount) {
    d += pad(`Discount${r.discountReason ? ' (' + r.discountReason + ')' : ''}`,
             RECEIPT_WIDTH - String(r.discount).length)
       + r.discount + '\n';
  }

  // Total (bold, double-height)
  d += dashes();
  d += CMD.BOLD_ON;
  d += CMD.DOUBLE_ON;
  d += pad('TOTAL', RECEIPT_WIDTH - String(r.total || '').length)
     + (r.total || '') + '\n';
  d += CMD.NORMAL;
  d += CMD.BOLD_OFF;
  d += dashes();

  // Payment info
  d += pad('Method', RECEIPT_WIDTH - String(r.method || '').length)
     + (r.method || '') + '\n';
  if (r.change && r.change !== '0') {
    d += pad('Change', RECEIPT_WIDTH - String(r.change).length)
       + r.change + '\n';
  }

  // Footer — centered
  d += dashes();
  d += CMD.CENTER;
  d += (r.footer || 'Thank you for dining with us!') + '\n';

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
