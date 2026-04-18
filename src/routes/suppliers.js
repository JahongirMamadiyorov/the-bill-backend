const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// Auto-migrate: add new columns if missing
(async () => {
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name TEXT DEFAULT ''`).catch(() => {});
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms TEXT DEFAULT ''`).catch(() => {});
  await db.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category TEXT DEFAULT ''`).catch(() => {});
})();

router.get('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const result = await db.query('SELECT * FROM suppliers WHERE restaurant_id=$1 ORDER BY name', [restaurant_id]);
  res.json(result.rows);
});

router.post('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const { name, phone, email, address, contact_name, payment_terms, category } = req.body;
  const result = await db.query(
    'INSERT INTO suppliers (name,phone,email,address,contact_name,payment_terms,category,restaurant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [name, phone, email, address, contact_name || '', payment_terms || '', category || '', restaurant_id]
  );
  res.status(201).json(result.rows[0]);
});

router.put('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const { name, phone, email, address, contact_name, payment_terms, category } = req.body;
  const result = await db.query(
    'UPDATE suppliers SET name=$1,phone=$2,email=$3,address=$4,contact_name=$5,payment_terms=$6,category=$7 WHERE id=$8 AND restaurant_id=$9 RETURNING *',
    [name, phone, email, address, contact_name || '', payment_terms || '', category || '', req.params.id, restaurant_id]
  );
  if (result.rows.length === 0) {
    return res.status(403).json({ error: 'Supplier not found or not authorized' });
  }
  res.json(result.rows[0]);
});

router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const result = await db.query('DELETE FROM suppliers WHERE id=$1 AND restaurant_id=$2 RETURNING id', [req.params.id, restaurant_id]);
  if (result.rows.length === 0) {
    return res.status(403).json({ error: 'Supplier not found or not authorized' });
  }
  res.json({ message: 'Supplier deleted' });
});

// Purchase Orders
router.get('/purchase-orders', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const result = await db.query(
    `SELECT po.*, s.name as supplier_name, u.name as created_by_name
     FROM purchase_orders po
     LEFT JOIN suppliers s ON po.supplier_id=s.id
     LEFT JOIN users u ON po.created_by=u.id
     WHERE po.restaurant_id=$1
     ORDER BY po.ordered_at DESC`,
    [restaurant_id]
  );
  res.json(result.rows);
});

router.post('/purchase-orders', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const { supplier_id, items, notes } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let total = 0;
    for (const item of items) total += item.quantity * item.unit_cost;
    const po = await client.query(
      'INSERT INTO purchase_orders (supplier_id,created_by,total_cost,notes,restaurant_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [supplier_id, req.user.id, total, notes, restaurant_id]
    );
    for (const item of items) {
      await client.query(
        'INSERT INTO purchase_order_items (purchase_order_id,ingredient_id,quantity,unit_cost) VALUES ($1,$2,$3,$4)',
        [po.rows[0].id, item.ingredient_id, item.quantity, item.unit_cost]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(po.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Mark purchase order as received — updates inventory
router.put('/purchase-orders/:id/receive', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurant_id = rid(req);
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verify PO belongs to this restaurant
    const poCheck = await client.query(
      'SELECT id FROM purchase_orders WHERE id=$1 AND restaurant_id=$2', [req.params.id, restaurant_id]
    );
    if (poCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Purchase order not found or not authorized' });
    }

    const items = await client.query(
      'SELECT * FROM purchase_order_items WHERE purchase_order_id=$1', [req.params.id]
    );
    for (const item of items.rows) {
      // Verify warehouse_item belongs to this restaurant
      await client.query(
        'UPDATE warehouse_items SET quantity_in_stock = quantity_in_stock + $1 WHERE id=$2 AND restaurant_id=$3',
        [item.quantity, item.ingredient_id, restaurant_id]
      );
    }
    await client.query(
      `UPDATE purchase_orders SET status='received', received_at=NOW() WHERE id=$1`, [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Purchase order received, stock updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
