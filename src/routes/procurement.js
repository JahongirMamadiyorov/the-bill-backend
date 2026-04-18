const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// Helper: local date string (avoids UTC shift from .toISOString())
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// GET /api/procurement/suggested-order
router.get('/suggested-order', authenticate, authorize('owner', 'admin'), async (req, res) => {
    try {
        const restaurantId = rid(req);
        const result = await db.query(`
      SELECT
        w.id as item_id, w.name as item_name, w.sku_code, w.purchase_unit,
        w.quantity_in_stock, w.min_stock_level, w.cost_per_unit, w.supplier_id,
        s.name as supplier_name, s.email as supplier_email, s.phone as supplier_phone,
        (w.min_stock_level * 1.5 - w.quantity_in_stock) as suggested_order_qty
      FROM warehouse_items w
      LEFT JOIN suppliers s ON w.supplier_id = s.id
      WHERE w.restaurant_id = $1 AND w.quantity_in_stock <= w.min_stock_level
      ORDER BY s.name ASC, w.name ASC
    `, [restaurantId]);
        const grouped = result.rows.reduce((acc, row) => {
            const suppId = row.supplier_id || 'unknown';
            if (!acc[suppId]) {
                acc[suppId] = {
                    supplier: { id: row.supplier_id, name: row.supplier_name || 'No Supplier', email: row.supplier_email, phone: row.supplier_phone },
                    items: []
                };
            }
            const qtyToOrder = Math.max(1, Math.ceil(row.suggested_order_qty));
            acc[suppId].items.push({
                item_id: row.item_id, name: row.item_name, sku_code: row.sku_code,
                purchase_unit: row.purchase_unit, current_stock: parseFloat(row.quantity_in_stock),
                min_stock: parseFloat(row.min_stock_level), suggested_qty: qtyToOrder,
                estimated_cost: qtyToOrder * parseFloat(row.cost_per_unit || 0)
            });
            return acc;
        }, {});
        res.json(Object.values(grouped));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Supplier Deliveries ─────────────────────────────────────────────────────

async function ensureDeliveriesTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS supplier_deliveries (
      id             TEXT          PRIMARY KEY,
      restaurant_id  UUID          NOT NULL,
      supplier_name  TEXT          NOT NULL DEFAULT '',
      supplier_id    INTEGER,
      total          NUMERIC(14,2) NOT NULL DEFAULT 0,
      status         TEXT          NOT NULL DEFAULT 'Delivered',
      payment_status TEXT          NOT NULL DEFAULT 'unpaid',
      notes          TEXT          DEFAULT '',
      timestamp      DATE          NOT NULL DEFAULT CURRENT_DATE,
      paid_at        TIMESTAMPTZ,
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
  await db.query(`ALTER TABLE supplier_deliveries DROP CONSTRAINT IF EXISTS supplier_deliveries_supplier_id_fkey;`).catch(() => {});
  await db.query(`ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS restaurant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'`).catch(() => {});
  await db.query(`ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT ''`).catch(() => {});
  await db.query(`ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS payment_note TEXT DEFAULT ''`).catch(() => {});
  await db.query(`ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS payment_due_date DATE`).catch(() => {});
}

async function ensureDeliveryItemsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS delivery_items (
      id             SERIAL        PRIMARY KEY,
      delivery_id    TEXT          NOT NULL,
      item_name      TEXT          NOT NULL DEFAULT '',
      qty            NUMERIC(12,2) NOT NULL DEFAULT 0,
      unit           TEXT          NOT NULL DEFAULT 'piece',
      unit_price     NUMERIC(14,2) NOT NULL DEFAULT 0,
      expiry_date    DATE,
      removed        BOOLEAN       NOT NULL DEFAULT FALSE,
      remove_reason  TEXT          DEFAULT '',
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `).catch(() => {});
  await db.query(`ALTER TABLE delivery_items ADD COLUMN IF NOT EXISTS removed BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE delivery_items ADD COLUMN IF NOT EXISTS remove_reason TEXT DEFAULT ''`).catch(() => {});
}

ensureDeliveriesTable();
ensureDeliveryItemsTable();
console.log('[procurement] ✅ Routes loaded: GET/POST/PATCH/DELETE deliveries, GET/:id, PATCH/:id/status, PATCH/:id/pay, delivery-items');

// GET /api/procurement/deliveries — list all deliveries (with item_count)
router.get('/deliveries', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    await ensureDeliveryItemsTable();
    const restaurantId = rid(req);
    const result = await db.query(`
      SELECT sd.*,
             COALESCE(di.cnt, 0)::int AS item_count
      FROM supplier_deliveries sd
      LEFT JOIN (
        SELECT delivery_id, COUNT(*)::int AS cnt
        FROM delivery_items
        WHERE removed = FALSE
        GROUP BY delivery_id
      ) di ON di.delivery_id = sd.id
      WHERE sd.restaurant_id = $1
      ORDER BY sd.timestamp DESC, sd.created_at DESC
    `, [restaurantId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/procurement/deliveries/debt — total unpaid supplier debt
// NOTE: static routes MUST come before :id parameter routes
router.get('/deliveries/debt', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    const restaurantId = rid(req);
    const result = await db.query(`
      SELECT COALESCE(SUM(total), 0) AS total_debt, COUNT(*)::int AS count
      FROM supplier_deliveries
      WHERE restaurant_id = $1 AND payment_status != 'paid' AND status IN ('Delivered', 'Partial')
    `, [restaurantId]);
    res.json({ total_debt: parseFloat(result.rows[0].total_debt), count: result.rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/procurement/deliveries/unpaid-summary
router.get('/deliveries/unpaid-summary', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    const restaurantId = rid(req);
    const result = await db.query(`
      SELECT id, supplier_name, supplier_id, total, status, payment_due_date, timestamp, notes
      FROM supplier_deliveries
      WHERE restaurant_id = $1 AND payment_status != 'paid' AND status IN ('Delivered', 'Partial')
      ORDER BY payment_due_date ASC NULLS LAST, timestamp DESC
    `, [restaurantId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/procurement/deliveries/:id — single delivery with its line items
// NOTE: this MUST come after all static /deliveries/* routes
router.get('/deliveries/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    await ensureDeliveryItemsTable();
    const restaurantId = rid(req);
    const deliv = await db.query(`SELECT * FROM supplier_deliveries WHERE id = $1 AND restaurant_id = $2`, [req.params.id, restaurantId]);
    if (!deliv.rows.length) return res.status(404).json({ error: 'Delivery not found' });
    const items = await db.query(
      `SELECT * FROM delivery_items WHERE delivery_id = $1 ORDER BY id ASC`, [req.params.id]
    );
    res.json({ ...deliv.rows[0], items: items.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/procurement/deliveries — create delivery + save line items
router.post('/deliveries', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    await ensureDeliveryItemsTable();
    const restaurantId = rid(req);
    const { id, supplier_name, supplier_id, total, status, payment_status, notes, timestamp, payment_due_date, items } = req.body;
    const delivId = id || `deliv-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const params = [
      delivId,
      restaurantId,
      supplier_name || '',
      supplier_id ? parseInt(supplier_id, 10) || null : null,
      parseFloat(total) || 0,
      status || 'Delivered',
      payment_status || 'unpaid',
      notes || '',
      timestamp || localDate(),
      payment_due_date || null,
    ];
    const result = await db.query(`
      INSERT INTO supplier_deliveries (id, restaurant_id, supplier_name, supplier_id, total, status, payment_status, notes, timestamp, payment_due_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        supplier_name = EXCLUDED.supplier_name, supplier_id = EXCLUDED.supplier_id,
        total = EXCLUDED.total, status = EXCLUDED.status, notes = EXCLUDED.notes,
        timestamp = EXCLUDED.timestamp, payment_due_date = EXCLUDED.payment_due_date,
        updated_at = NOW()
      RETURNING *
    `, params);

    // Save line items (if provided)
    if (Array.isArray(items) && items.length > 0) {
      // Clear old items for this delivery (in case of upsert)
      await db.query(`DELETE FROM delivery_items WHERE delivery_id = $1`, [delivId]);
      for (const it of items) {
        await db.query(`
          INSERT INTO delivery_items (delivery_id, item_name, qty, unit, unit_price, expiry_date)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          delivId,
          it.item_name || '',
          parseFloat(it.qty) || 0,
          it.unit || 'piece',
          parseFloat(it.unit_price) || 0,
          it.expiry_date || null,
        ]);
      }
    }

    // Return delivery with items
    const savedItems = await db.query(`SELECT * FROM delivery_items WHERE delivery_id = $1 ORDER BY id ASC`, [delivId]);
    res.json({ ...result.rows[0], items: savedItems.rows });
  } catch (err) {
    console.error('[POST /deliveries] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/procurement/deliveries/:id/status — update delivery status
router.patch('/deliveries/:id/status', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    const restaurantId = rid(req);
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const result = await db.query(`
      UPDATE supplier_deliveries SET status = $2, updated_at = NOW() WHERE id = $1 AND restaurant_id = $3 RETURNING *
    `, [req.params.id, status, restaurantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Delivery not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/procurement/deliveries/:id/pay — mark delivery as paid
router.patch('/deliveries/:id/pay', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    const restaurantId = rid(req);
    const { payment_method, payment_note, paid_at } = req.body || {};
    const result = await db.query(`
      UPDATE supplier_deliveries
      SET payment_status = 'paid', paid_at = COALESCE($4::timestamptz, NOW()), updated_at = NOW(),
          payment_method = COALESCE($2, ''), payment_note = COALESCE($3, '')
      WHERE id = $1 AND restaurant_id = $5 RETURNING *
    `, [req.params.id, payment_method || '', payment_note || '', paid_at || null, restaurantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Delivery not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/procurement/delivery-items/:itemId/remove — mark a line item as removed (damaged/short)
router.patch('/delivery-items/:itemId/remove', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveryItemsTable();
    const { remove_reason } = req.body || {};
    const result = await db.query(`
      UPDATE delivery_items SET removed = TRUE, remove_reason = $2 WHERE id = $1 RETURNING *
    `, [req.params.itemId, remove_reason || '']);
    if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
    // Recalculate delivery total from non-removed items
    const item = result.rows[0];
    const totals = await db.query(`
      SELECT COALESCE(SUM(qty * unit_price), 0) AS new_total FROM delivery_items
      WHERE delivery_id = $1 AND removed = FALSE
    `, [item.delivery_id]);
    await db.query(`UPDATE supplier_deliveries SET total = $2, updated_at = NOW() WHERE id = $1`,
      [item.delivery_id, parseFloat(totals.rows[0].new_total)]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/procurement/delivery-items/:itemId/update-qty — adjust qty of a line item (short delivery)
router.patch('/delivery-items/:itemId/update-qty', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveryItemsTable();
    const { qty } = req.body;
    if (qty === undefined) return res.status(400).json({ error: 'qty is required' });
    const result = await db.query(`
      UPDATE delivery_items SET qty = $2 WHERE id = $1 RETURNING *
    `, [req.params.itemId, parseFloat(qty) || 0]);
    if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
    // Recalculate delivery total
    const item = result.rows[0];
    const totals = await db.query(`
      SELECT COALESCE(SUM(qty * unit_price), 0) AS new_total FROM delivery_items
      WHERE delivery_id = $1 AND removed = FALSE
    `, [item.delivery_id]);
    await db.query(`UPDATE supplier_deliveries SET total = $2, updated_at = NOW() WHERE id = $1`,
      [item.delivery_id, parseFloat(totals.rows[0].new_total)]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/procurement/deliveries/bulk-sync
router.post('/deliveries/bulk-sync', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    const restaurantId = rid(req);
    const deliveries = req.body;
    if (!Array.isArray(deliveries) || deliveries.length === 0) return res.json({ synced: 0 });
    let synced = 0;
    for (const d of deliveries) {
      const delivId = String(d.id || Date.now());
      const total = parseFloat(d.total) || 0;
      const ts = d.date || d.timestamp || localDate();
      await db.query(`
        INSERT INTO supplier_deliveries (id, restaurant_id, supplier_name, supplier_id, total, status, payment_status, notes, timestamp, payment_due_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          supplier_name = EXCLUDED.supplier_name, total = EXCLUDED.total, status = EXCLUDED.status,
          payment_status = EXCLUDED.payment_status,
          notes = EXCLUDED.notes, timestamp = EXCLUDED.timestamp, payment_due_date = EXCLUDED.payment_due_date,
          updated_at = NOW()
      `, [delivId, restaurantId, d.supplierName || d.supplier_name || '', null, total,
          d.status || 'Delivered', d.paymentStatus || d.payment_status || 'unpaid',
          d.notes || '', ts, d.paymentDueDate || d.payment_due_date || null]).catch(() => {});
      synced++;
    }
    res.json({ synced });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/procurement/deliveries/:id
router.delete('/deliveries/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureDeliveriesTable();
    await ensureDeliveryItemsTable();
    const restaurantId = rid(req);
    const deliv = await db.query(`SELECT id FROM supplier_deliveries WHERE id = $1 AND restaurant_id = $2`, [req.params.id, restaurantId]);
    if (!deliv.rows.length) return res.status(404).json({ error: 'Delivery not found' });
    await db.query(`DELETE FROM delivery_items WHERE delivery_id = $1`, [req.params.id]);
    await db.query(`DELETE FROM supplier_deliveries WHERE id = $1 AND restaurant_id = $2`, [req.params.id, restaurantId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
