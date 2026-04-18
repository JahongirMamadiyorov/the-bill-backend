const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ── Auto-migration: add cost_per_unit to stock_movements if missing ──────────
;(async () => {
  try {
    await db.query(`
      ALTER TABLE stock_movements
      ADD COLUMN IF NOT EXISTS cost_per_unit NUMERIC(12,4) NOT NULL DEFAULT 0
    `);
  } catch (e) { /* column may already exist or table not yet created */ }
})();

// GET /api/warehouse
router.get('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
    try {
        const restaurantId = rid(req);
        const result = await db.query(`
      SELECT w.id, w.name, w.category, w.sku_code, w.unit,
             w.quantity_in_stock, w.min_stock_level, w.cost_per_unit, w.supplier_id,
             s.name as supplier_name,
             w.created_at, w.updated_at
      FROM warehouse_items w
      LEFT JOIN suppliers s ON w.supplier_id = s.id
      WHERE w.restaurant_id = $1
      ORDER BY w.name
    `, [restaurantId]);

        // Fetch batches for each item
        for (const row of result.rows) {
            const batches = await db.query('SELECT * FROM stock_batches WHERE item_id=$1 AND restaurant_id=$2 AND quantity_remaining > 0 ORDER BY expiry_date ASC NULLS LAST', [row.id, restaurantId]);
            row.batches = batches.rows;
        }

        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/warehouse/low-stock
router.get('/low-stock', authenticate, authorize('owner', 'admin'), async (req, res) => {
    try {
        const restaurantId = rid(req);
        const result = await db.query(`
      SELECT id, name, unit, quantity_in_stock, min_stock_level, cost_per_unit
      FROM warehouse_items
      WHERE restaurant_id = $1 AND quantity_in_stock <= min_stock_level
      ORDER BY quantity_in_stock ASC
    `, [restaurantId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/warehouse
// Create a new master item
router.post('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
    const { name, category, sku_code, unit, min_stock_level, cost_per_unit, supplier_id } = req.body;
    try {
        const restaurantId = rid(req);
        const result = await db.query(
            `INSERT INTO warehouse_items (name, category, sku_code, unit, min_stock_level, low_stock_alert, cost_per_unit, supplier_id, restaurant_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8) RETURNING *`,
            [name, category, sku_code, unit, min_stock_level || 5, cost_per_unit || 0, supplier_id, restaurantId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/warehouse/:id
router.put('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
    const { name, category, sku_code, unit, min_stock_level, cost_per_unit, supplier_id } = req.body;
    try {
        const restaurantId = rid(req);
        const result = await db.query(
            `UPDATE warehouse_items
       SET name=$1, category=$2, sku_code=$3, unit=$4, min_stock_level=$5, low_stock_alert=$5, cost_per_unit=$6, supplier_id=$7, updated_at=NOW()
       WHERE id=$8 AND restaurant_id=$9 RETURNING *`,
            [name, category, sku_code, unit, min_stock_level || 5, cost_per_unit || 0, supplier_id, req.params.id, restaurantId]
        );
        if (result.rows.length === 0) {
            return res.status(403).json({ error: 'Item not found or does not belong to this restaurant' });
        }
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/warehouse/:id
router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
    try {
        const restaurantId = rid(req);
        const result = await db.query('DELETE FROM warehouse_items WHERE id=$1 AND restaurant_id=$2 RETURNING id', [req.params.id, restaurantId]);
        if (result.rows.length === 0) {
            return res.status(403).json({ error: 'Item not found or does not belong to this restaurant' });
        }
        res.json({ message: 'Item deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/warehouse/receive
// Used when Goods Arrive
router.post('/receive', authenticate, authorize('owner', 'admin'), async (req, res) => {
    const { item_id, quantity, expiry_date, reason, cost_per_unit } = req.body;

    if (!item_id || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Valid item_id and quantity > 0 are required' });
    }

    try {
        const restaurantId = rid(req);
        await db.query('BEGIN'); // Start transaction

        // Verify item belongs to restaurant
        const itemCheck = await db.query('SELECT id FROM warehouse_items WHERE id=$1 AND restaurant_id=$2', [item_id, restaurantId]);
        if (itemCheck.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(403).json({ error: 'Item not found or does not belong to this restaurant' });
        }

        // 1. Update overall stock (and cost_per_unit if provided)
        if (cost_per_unit !== undefined && cost_per_unit !== null && parseFloat(cost_per_unit) > 0) {
            await db.query(
                'UPDATE warehouse_items SET quantity_in_stock = quantity_in_stock + $1, cost_per_unit = $3, updated_at=NOW() WHERE id=$2',
                [quantity, item_id, parseFloat(cost_per_unit)]
            );
        } else {
            await db.query(
                'UPDATE warehouse_items SET quantity_in_stock = quantity_in_stock + $1, updated_at=NOW() WHERE id=$2',
                [quantity, item_id]
            );
        }

        // 2. Log Movement (capture cost at time of receipt)
        const effectiveCost = (cost_per_unit !== undefined && parseFloat(cost_per_unit) > 0)
            ? parseFloat(cost_per_unit)
            : parseFloat((await db.query('SELECT cost_per_unit FROM warehouse_items WHERE id=$1', [item_id])).rows[0]?.cost_per_unit || 0);
        await db.query(
            `INSERT INTO stock_movements (item_id, type, quantity, user_id, reason, cost_per_unit, restaurant_id) VALUES ($1, 'IN', $2, $3, $4, $5, $6)`,
            [item_id, quantity, req.user.id, reason || 'Goods Arrival', effectiveCost, restaurantId]
        );

        // 3. Create stock batch (even if expiry_date is null)
        await db.query(
            `INSERT INTO stock_batches (item_id, quantity_remaining, expiry_date, restaurant_id) VALUES ($1, $2, $3, $4)`,
            [item_id, quantity, expiry_date || null, restaurantId]
        );

        await db.query('COMMIT');
        res.status(201).json({ message: 'Stock received successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// POST /api/warehouse/consume
// Manual kitchen request or daily deduction
router.post('/consume', authenticate, authorize('owner', 'admin'), async (req, res) => {
    const { item_id, quantity, reason } = req.body;

    if (!item_id || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'Valid item_id and quantity > 0 are required' });
    }

    try {
        const restaurantId = rid(req);
        await db.query('BEGIN');

        // 1. Check if sufficient stock exists overall
        const stockRes = await db.query('SELECT quantity_in_stock, cost_per_unit FROM warehouse_items WHERE id=$1 AND restaurant_id=$2 FOR UPDATE', [item_id, restaurantId]);
        if (stockRes.rows.length === 0) throw new Error('Item not found or does not belong to this restaurant');
        if (stockRes.rows[0].quantity_in_stock < quantity) throw new Error('Insufficient overall stock');

        // 2. FIFO Deduction across batches
        let remainingToDeduct = parseFloat(quantity);

        // Fetch available batches for this item, ordered by expiry date (oldest first)
        const batchesRes = await db.query(
            'SELECT id, quantity_remaining FROM stock_batches WHERE item_id=$1 AND restaurant_id=$2 AND quantity_remaining > 0 ORDER BY expiry_date ASC NULLS LAST FOR UPDATE',
            [item_id, restaurantId]
        );

        for (const batch of batchesRes.rows) {
            if (remainingToDeduct <= 0) break;

            const batchQty = parseFloat(batch.quantity_remaining);
            const deductFromBatch = Math.min(batchQty, remainingToDeduct);

            await db.query('UPDATE stock_batches SET quantity_remaining = quantity_remaining - $1 WHERE id=$2', [deductFromBatch, batch.id]);

            remainingToDeduct -= deductFromBatch;
        }

        // 3. Update master inventory record
        await db.query(
            'UPDATE warehouse_items SET quantity_in_stock = quantity_in_stock - $1, updated_at=NOW() WHERE id=$2',
            [parseFloat(quantity), item_id]
        );

        // 4. Log Movement (capture cost at time of consumption)
        const consumeCost = parseFloat(stockRes.rows[0].cost_per_unit || 0);
        await db.query(
            `INSERT INTO stock_movements (item_id, type, quantity, user_id, reason, cost_per_unit, restaurant_id) VALUES ($1, 'OUT', $2, $3, $4, $5, $6)`,
            [item_id, quantity, req.user.id, reason || 'Kitchen Issue / Consume', consumeCost, restaurantId]
        );

        await db.query('COMMIT');
        res.json({ message: 'Stock consumed successfully via FIFO' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// POST /api/warehouse/:id/adjust (Manual correction or Waste)
router.post('/:id/adjust', authenticate, authorize('owner', 'admin'), async (req, res) => {
    const { quantity, reason, is_waste } = req.body;
    // quantity in this context means "absolute amount removed/added"
    // For waste, it's typically negative or we treat it as an explicitly defined number to subtract.
    // We'll treat `quantity` as the amount to subtract by default if it's waste.
    const deductQty = parseFloat(quantity);

    if (!deductQty || deductQty <= 0) {
        return res.status(400).json({ error: 'Valid positive quantity required for adjustment/waste' });
    }

    try {
        const restaurantId = rid(req);
        await db.query('BEGIN');

        // Verify item belongs to restaurant
        const itemCheck = await db.query('SELECT id FROM warehouse_items WHERE id=$1 AND restaurant_id=$2 FOR UPDATE', [req.params.id, restaurantId]);
        if (itemCheck.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(403).json({ error: 'Item not found or does not belong to this restaurant' });
        }

        // Remove from total stock
        await db.query(
            'UPDATE warehouse_items SET quantity_in_stock = GREATEST(0, quantity_in_stock - $1), updated_at=NOW() WHERE id=$2',
            [deductQty, req.params.id]
        );

        const type = is_waste ? 'WASTE' : 'ADJUST';
        const adjustCostRes = await db.query('SELECT cost_per_unit FROM warehouse_items WHERE id=$1', [req.params.id]);
        const adjustCost = parseFloat(adjustCostRes.rows[0]?.cost_per_unit || 0);

        await db.query(
            `INSERT INTO stock_movements (item_id, type, quantity, user_id, reason, cost_per_unit, restaurant_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.params.id, type, deductQty, req.user.id, reason || 'Stock Adjustment', adjustCost, restaurantId]
        );

        // If it's waste, log expense
        if (is_waste) {
            await db.query(
                `INSERT INTO expenses (category, description, amount, expense_date, recorded_by, restaurant_id)
          VALUES ('waste', $1, 0, CURRENT_DATE, $2, $3)`,
                [reason || 'Stock waste/spoilage', req.user.id, restaurantId]
            );
        }

        // Naively deduct from random batches or oldest to sync up batches with total stock
        let remainingToDeduct = deductQty;
        const batchesRes = await db.query(
            'SELECT id, quantity_remaining FROM stock_batches WHERE item_id=$1 AND restaurant_id=$2 AND quantity_remaining > 0 ORDER BY expiry_date ASC NULLS LAST FOR UPDATE',
            [req.params.id, restaurantId]
        );
        for (const batch of batchesRes.rows) {
            if (remainingToDeduct <= 0) break;
            const batchQty = parseFloat(batch.quantity_remaining);
            const dec = Math.min(batchQty, remainingToDeduct);
            await db.query('UPDATE stock_batches SET quantity_remaining = quantity_remaining - $1 WHERE id=$2', [dec, batch.id]);
            remainingToDeduct -= dec;
        }

        await db.query('COMMIT');
        res.json({ message: 'Stock adjusted successfully' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// POST /api/warehouse/audit
// Receives an array of items with actual_qty, calculates variance, and adjusts stock
router.post('/audit', authenticate, authorize('owner', 'admin'), async (req, res) => {
    const { items } = req.body;
    // items should be [{ item_id, actual_qty, reason }]

    if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Valid array of items required' });
    }

    try {
        const restaurantId = rid(req);
        await db.query('BEGIN');

        // Create audit record
        const auditRes = await db.query(
            `INSERT INTO inventory_audits (auditor_id, status, restaurant_id) VALUES ($1, 'completed', $2) RETURNING id`,
            [req.user.id, restaurantId]
        );
        const auditId = auditRes.rows[0].id;

        for (const item of items) {
            const { item_id, actual_qty, reason } = item;

            // Get current stock and verify ownership
            const stockRes = await db.query('SELECT quantity_in_stock, cost_per_unit FROM warehouse_items WHERE id=$1 AND restaurant_id=$2 FOR UPDATE', [item_id, restaurantId]);
            if (stockRes.rows.length === 0) continue;

            const expectedQty = parseFloat(stockRes.rows[0].quantity_in_stock);
            const actual = parseFloat(actual_qty);
            const variance = actual - expectedQty;

            // Log audit item
            await db.query(
                `INSERT INTO inventory_audit_items (audit_id, item_id, expected_qty, actual_qty, variance, variance_reason)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [auditId, item_id, expectedQty, actual, variance, reason || 'Routine Audit']
            );

            if (variance !== 0) {
                const type = variance < 0 ? 'SHRINKAGE' : 'ADJUST'; // We treat shrinkage same as waste basically
                const absVariance = Math.abs(variance);

                await db.query(
                    'UPDATE warehouse_items SET quantity_in_stock = $1, updated_at=NOW() WHERE id=$2',
                    [actual, item_id]
                );

                const auditCost = parseFloat(stockRes.rows[0].cost_per_unit || 0);
                await db.query(
                    `INSERT INTO stock_movements (item_id, type, quantity, user_id, reason, cost_per_unit, restaurant_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [item_id, type === 'SHRINKAGE' ? 'WASTE' : 'ADJUST', absVariance, req.user.id, `Audit Variance: ${reason || ''}`, auditCost, restaurantId]
                );

                // If negative variance (shrinkage), logically deduct from batches
                // If positive variance, we technically should create a new batch with $0 cost, but for simplicity we'll just add to an existing open batch or leave it out of strict batches.
                // Let's handle just shrinkage (which is the most common use-case for audits)
                if (variance < 0) {
                    let remainingToDeduct = absVariance;
                    const batchesRes = await db.query(
                        'SELECT id, quantity_remaining FROM stock_batches WHERE item_id=$1 AND restaurant_id=$2 AND quantity_remaining > 0 ORDER BY expiry_date ASC NULLS LAST FOR UPDATE',
                        [item_id, restaurantId]
                    );
                    for (const batch of batchesRes.rows) {
                        if (remainingToDeduct <= 0) break;
                        const batchQty = parseFloat(batch.quantity_remaining);
                        const dec = Math.min(batchQty, remainingToDeduct);
                        await db.query('UPDATE stock_batches SET quantity_remaining = quantity_remaining - $1 WHERE id=$2', [dec, batch.id]);
                        remainingToDeduct -= dec;
                    }

                    // Log the financial loss of shrinkage
                    const lossValue = absVariance * parseFloat(stockRes.rows[0].cost_per_unit || 0);
                    if (lossValue > 0) {
                        await db.query(
                            `INSERT INTO expenses (category, description, amount, expense_date, recorded_by, restaurant_id)
                             VALUES ('shrinkage', $1, $2, CURRENT_DATE, $3, $4)`,
                            [`Audit Shrinkage for item ${item_id}`, lossValue, req.user.id, restaurantId]
                        );
                    }
                } else if (variance > 0) {
                    // Add a recovery batch
                    await db.query(
                        `INSERT INTO stock_batches (item_id, quantity_remaining, cost_price, restaurant_id) VALUES ($1, $2, $3, $4)`,
                        [item_id, absVariance, stockRes.rows[0].cost_per_unit || 0, restaurantId]
                    );
                }
            }
        }

        await db.query('REFRESH MATERIALIZED VIEW warehouse_valuation');

        await db.query('COMMIT');
        res.json({ message: 'Audit completed successfully, variances processed' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// GET /api/warehouse/expiry-alerts — find batches expiring within 14 days, notify admins
router.get('/expiry-alerts', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurantId = rid(req);
    const result = await db.query(`
      SELECT sb.id, sb.item_id, sb.expiry_date, sb.quantity_remaining,
             wi.name AS item_name, wi.unit,
             EXTRACT(DAY FROM sb.expiry_date - NOW())::int AS days_remaining
      FROM stock_batches sb
      JOIN warehouse_items wi ON sb.item_id = wi.id
      WHERE sb.restaurant_id = $1
        AND sb.quantity_remaining > 0
        AND sb.expiry_date IS NOT NULL
        AND sb.expiry_date <= NOW() + INTERVAL '14 days'
      ORDER BY sb.expiry_date ASC
    `, [restaurantId]);
    const expiring = result.rows;

    if (expiring.length > 0) {
      // Get all admin/owner users for this restaurant to notify
      const adminRes = await db.query(`SELECT id FROM users WHERE restaurant_id = $1 AND role IN ('admin', 'owner')`, [restaurantId]);
      const adminIds = adminRes.rows.map(r => r.id);

      // Group batches by item
      const itemMap = {};
      expiring.forEach(b => {
        if (!itemMap[b.item_id]) itemMap[b.item_id] = { name: b.item_name, unit: b.unit, batches: [] };
        itemMap[b.item_id].batches.push(b);
      });

      for (const [, data] of Object.entries(itemMap)) {
        const minDays = Math.min(...data.batches.map(b => parseInt(b.days_remaining, 10)));
        const totalQty = data.batches.reduce((s, b) => s + parseFloat(b.quantity_remaining), 0);
        const daysStr = minDays <= 0 ? 'today or already expired' : `in ${minDays} day${minDays !== 1 ? 's' : ''}`;
        const title = `Expiry Alert: ${data.name}`;
        const body = `${totalQty.toFixed(1)} ${data.unit} expires ${daysStr}. Use FIFO — check inventory batches.`;

        for (const adminId of adminIds) {
          // Only create one notification per item per day to avoid spam
          const existing = await db.query(
            `SELECT id FROM notifications WHERE user_id=$1 AND title=$2 AND restaurant_id=$3 AND created_at > NOW() - INTERVAL '24 hours'`,
            [adminId, title, restaurantId]
          );
          if (existing.rows.length === 0) {
            await db.query(
              `INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1, $2, $3, 'alert', $4)`,
              [adminId, title, body, restaurantId]
            );
          }
        }
      }
    }

    res.json({ expiring });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/warehouse/batches/:itemId — stock batches for one item sorted by expiry (FIFO order)
router.get('/batches/:itemId', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurantId = rid(req);
    const result = await db.query(
      `SELECT id, quantity_remaining, expiry_date, received_at,
              CASE WHEN expiry_date IS NULL THEN NULL
                   ELSE EXTRACT(DAY FROM expiry_date - NOW())::int
              END AS days_remaining
       FROM stock_batches
       WHERE item_id=$1 AND restaurant_id=$2 AND quantity_remaining > 0
       ORDER BY expiry_date ASC NULLS LAST`,
      [req.params.itemId, restaurantId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/warehouse/movements — stock movement log (OUT entries for Output tab)
router.get('/movements', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurantId = rid(req);
    const { from, to, type } = req.query;
    let query = `
      SELECT sm.id, sm.type, sm.quantity, sm.reason, sm.created_at,
             wi.id AS item_id, wi.name AS item_name, wi.unit,
             wi.cost_per_unit,
             u.name AS recorded_by
      FROM stock_movements sm
      JOIN warehouse_items wi ON sm.item_id = wi.id
      LEFT JOIN users u ON sm.user_id = u.id
      WHERE sm.restaurant_id = $1`;
    const params = [restaurantId];
    if (type) { params.push(type); query += ` AND sm.type = $${params.length}`; }
    if (from) { params.push(from); query += ` AND sm.created_at::date >= $${params.length}`; }
    if (to)   { params.push(to);   query += ` AND sm.created_at::date <= $${params.length}`; }
    query += ' ORDER BY sm.created_at DESC LIMIT 500';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;
