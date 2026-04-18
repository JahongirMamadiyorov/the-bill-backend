const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ── Auto-migration: item_ready per-item readiness tracking ────────────────────
;(async () => {
  try {
    await db.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS item_ready BOOLEAN DEFAULT FALSE`);
    // Fix any legacy NULL values that slipped in before DEFAULT was applied
    await db.query(`UPDATE order_items SET item_ready = FALSE WHERE item_ready IS NULL`);
  } catch (_) {}
})();

// ── Auto-migration: daily_number column ────────────────────────────────────────
;(async () => {
  try {
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS daily_number INTEGER`);
    // Backfill existing rows that have no daily_number
    await db.query(`
      UPDATE orders SET daily_number = sub.rn
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY DATE(created_at) ORDER BY created_at ASC) AS rn
        FROM orders WHERE daily_number IS NULL
      ) sub
      WHERE orders.id = sub.id
    `);
  } catch (_) {}
})();

// ── Auto-migration: extra columns ──────────────────────────────────────────────
;(async () => {
  try {
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_count INTEGER`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100)`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30)`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) DEFAULT 'pending'`);
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES users(id) ON DELETE SET NULL`);
  } catch (_) {}
})();

// ── Auto-migration: add bill_requested to orders status CHECK constraint ───────
;(async () => {
  try {
    // Drop the old constraint (name may vary) and re-add it with bill_requested included
    await db.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check`);
    await db.query(`
      ALTER TABLE orders ADD CONSTRAINT orders_status_check
        CHECK (status IN ('pending','sent_to_kitchen','preparing','ready','served','paid','cancelled','bill_requested'))
    `);
  } catch (_) {}
})();

// ── Auto-migration: add 'to_go' to order_type CHECK constraint ────────────────
;(async () => {
  try {
    await db.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check`);
    await db.query(`
      ALTER TABLE orders ADD CONSTRAINT orders_order_type_check
        CHECK (order_type IN ('dine_in', 'to_go', 'takeaway', 'delivery'))
    `);
  } catch (_) {}
})();

// ── Auto-migration: fix payment_method CHECK constraint to include all methods ─
;(async () => {
  try {
    await db.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check`);
    await db.query(`
      ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
        CHECK (payment_method IN ('cash','card','online','split','qr_code','loan','Cash','Card','QR Code','Loan','Split'))
    `);
  } catch (_) {}
})();

// ── Auto-migration: split_payments JSONB column ─────────────────────────────
;(async () => {
  try {
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS split_payments JSONB`);
  } catch (_) {}
})();

// ── Auto-migration: cancellation_reason column ──────────────────────────────
;(async () => {
  try {
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`);
  } catch (_) {}
})();

// GET /api/orders
router.get('/', authenticate, async (req, res) => {
  try {
    let query = `
      SELECT o.*,
             t.table_number,
             t.name  as table_name,
             u.name  as waitress_name,
             c.name  as collected_by_name,
             COALESCE(ic.cnt, 0) as item_count,
             o.order_type,
             o.customer_name,
             o.customer_phone,
             o.delivery_address,
             o.delivery_status,
             l.status       AS loan_status,
             l.paid_at      AS loan_paid_at,
             l.due_date     AS loan_due_date,
             l.customer_name  AS loan_customer_name,
             l.customer_phone AS loan_customer_phone,
             l.amount       AS loan_amount,
             l.notes        AS loan_notes
      FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id AND t.restaurant_id = (SELECT restaurant_id FROM orders WHERE id = o.id)
      LEFT JOIN users u ON o.waitress_id = u.id
      LEFT JOIN users c ON o.paid_by = c.id
      LEFT JOIN (
        SELECT order_id, COUNT(*) as cnt FROM order_items GROUP BY order_id
      ) ic ON ic.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT status, paid_at, due_date, customer_name, customer_phone, amount, notes
        FROM loans WHERE order_id = o.id AND restaurant_id = o.restaurant_id ORDER BY created_at DESC LIMIT 1
      ) l ON true
      WHERE 1=1
    `;
    const params = [];
    // Multi-restaurant filter
    params.push(rid(req));
    query += ` AND o.restaurant_id=$${params.length}`;
    // Scope waitresses to their own orders UNLESS they are looking up a specific table
    // or filtering by order_type (e.g. they see all delivery/to_go)
    if (req.user.role === 'waitress' && !req.query.table_id && (!req.query.order_type || req.query.order_type === 'dine_in')) { params.push(req.user.id); query += ` AND o.waitress_id=$${params.length}`; }
    if (req.query.status) {
      const statuses = req.query.status.split(',');
      params.push(statuses);
      query += ` AND o.status = ANY($${params.length}::text[])`;
    }
    if (req.query.order_type) { params.push(req.query.order_type); query += ` AND o.order_type=$${params.length}`; }
    if (req.query.table_id) { params.push(req.query.table_id); query += ` AND o.table_id=$${params.length}`; }
    if (req.query.from)       { params.push(req.query.from);       query += ` AND o.created_at >= $${params.length}::date`; }
    if (req.query.to)         { params.push(req.query.to);         query += ` AND o.created_at <  ($${params.length}::date + interval '1 day')`; }
    if (req.query.paid_by)    { params.push(req.query.paid_by);    query += ` AND o.paid_by=$${params.length}`; }
    if (req.query.waitress_id){ params.push(req.query.waitress_id);query += ` AND o.waitress_id=$${params.length}`; }
    query += ' ORDER BY o.created_at DESC';
    if (req.query.limit) query += ` LIMIT ${parseInt(req.query.limit)}`;
    const result = await db.query(query, params);
    const orders = result.rows;

    // Optionally attach order items in one batch (used by table detail view)
    if (req.query.include_items === 'true' && orders.length > 0) {
      const ids = orders.map(o => o.id);
      const itemsRes = await db.query(
        `SELECT oi.id, oi.order_id, oi.menu_item_id, oi.quantity, oi.unit_price,
                COALESCE(m.name, 'Unknown item') AS name,
                COALESCE(m.name, 'Unknown item') AS item_name
         FROM order_items oi
         LEFT JOIN menu_items m ON oi.menu_item_id = m.id
         WHERE oi.order_id = ANY($1::uuid[])`,
        [ids]
      );
      const itemMap = {};
      itemsRes.rows.forEach(r => {
        if (!itemMap[r.order_id]) itemMap[r.order_id] = [];
        itemMap[r.order_id].push(r);
      });
      orders.forEach(o => { o.items = itemMap[o.id] || []; });
    }

    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/orders/mine
// Returns ALL restaurant orders visible to this waitress:
//   - All active orders (any status except cancelled)
//   - Today's paid orders (for "Done Today" tab)
router.get('/mine', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.*,
              t.table_number,
              t.name         AS table_name,
              u.name         AS waitress_name,
              COALESCE(ic.cnt, 0) AS item_count
       FROM orders o
       LEFT JOIN restaurant_tables t ON o.table_id = t.id AND t.restaurant_id = o.restaurant_id
       LEFT JOIN users u              ON o.waitress_id = u.id
       LEFT JOIN (
         SELECT order_id, COUNT(*) AS cnt FROM order_items GROUP BY order_id
       ) ic ON ic.order_id = o.id
       WHERE o.restaurant_id = $1
         AND o.status != 'cancelled'
         AND (
           o.status != 'paid'
           OR DATE(COALESCE(o.paid_at, o.updated_at)) = CURRENT_DATE
         )
       ORDER BY o.created_at DESC`,
      [rid(req)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /orders/mine error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/kitchen
// Station-based filtering:
//   • User with NULL kitchen_station  → sees ALL orders
//   • User with specific station       → sees only orders that have at least one item
//     belonging to their station (or items with NULL station = shown to everyone)
router.get('/kitchen', authenticate, authorize('owner', 'admin', 'kitchen'), async (req, res) => {
  try {
    const userStation = req.user.kitchen_station || null;

    const ordersResult = await db.query(
      `SELECT o.*, t.table_number, u.name as waitress_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON o.table_id=t.id AND t.restaurant_id = o.restaurant_id
       LEFT JOIN users u ON o.waitress_id=u.id
       WHERE o.restaurant_id = $1
         AND o.status IN ('pending', 'sent_to_kitchen', 'preparing')
       ORDER BY o.created_at ASC`,
      [rid(req)]
    );

    if (ordersResult.rows.length === 0) {
      return res.json([]);
    }

    const orderIds = ordersResult.rows.map(o => o.id);

    let itemsResult;
    if (userStation) {
      // Only fetch items that belong to this station OR have no station assigned
      itemsResult = await db.query(
        `SELECT oi.*, COALESCE(m.name, 'Unknown item') as name, COALESCE(m.name, 'Unknown item') as item_name, m.kitchen_station, oi.item_ready
         FROM order_items oi
         LEFT JOIN menu_items m ON oi.menu_item_id = m.id
         WHERE oi.order_id = ANY($1::uuid[])
           AND (m.kitchen_station = $2 OR m.kitchen_station IS NULL)`,
        [orderIds, userStation]
      );
    } else {
      // No station filter — return all items
      itemsResult = await db.query(
        `SELECT oi.*, COALESCE(m.name, 'Unknown item') as name, COALESCE(m.name, 'Unknown item') as item_name, m.kitchen_station, oi.item_ready
         FROM order_items oi
         LEFT JOIN menu_items m ON oi.menu_item_id = m.id
         WHERE oi.order_id = ANY($1::uuid[])`,
        [orderIds]
      );
    }

    // Group items by order and filter out orders with no relevant items
    const ordersWithItems = ordersResult.rows
      .map(order => ({
        ...order,
        items: itemsResult.rows.filter(item => item.order_id === order.id),
      }))
      .filter(order => order.items.length > 0);

    res.json(ordersWithItems);
  } catch (err) {
    console.error('GET /orders/kitchen error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/kitchen/stats  — today's KDS summary counters
router.get('/kitchen/stats', authenticate, authorize('owner', 'admin', 'kitchen'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [active, completed, avgRes] = await Promise.all([
      // Active orders (pending / sent_to_kitchen / preparing)
      db.query(`SELECT COUNT(*) FROM orders WHERE restaurant_id = $1 AND status IN ('pending','sent_to_kitchen','preparing')`, [rid(req)]),
      // Completed today (ready + served + paid)
      db.query(`SELECT COUNT(*) FROM orders WHERE restaurant_id = $1 AND status IN ('ready','served','paid') AND updated_at >= $2`, [rid(req), today]),
      // Avg cook time today (preparing → ready), in seconds
      db.query(`
        SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds
        FROM orders
        WHERE restaurant_id = $1
          AND status IN ('ready','served','paid')
          AND updated_at >= $2
      `, [rid(req), today]),
    ]);

    const avgSec = parseFloat(avgRes.rows[0]?.avg_seconds || 0);
    res.json({
      active:    parseInt(active.rows[0].count),
      completed: parseInt(completed.rows[0].count),
      avg_cook_minutes: avgSec > 0 ? Math.round(avgSec / 60) : null,
    });
  } catch (err) {
    console.error('GET /orders/kitchen/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/kitchen/completed
// Query params:
//   from=ISO_DATE  (default: start of today)
//   to=ISO_DATE    (default: now)
//   mine=1         (filter to orders that had items from caller's station)
router.get('/kitchen/completed', authenticate, authorize('owner', 'admin', 'kitchen'), async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const from = req.query.from ? new Date(req.query.from) : today;
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const mine = req.query.mine === '1';
    const userStation = req.user.kitchen_station || null;

    let ordersResult;
    if (mine && userStation) {
      // Only orders that contain at least one item matching this station
      ordersResult = await db.query(
        `SELECT DISTINCT o.*, t.table_number, u.name as waitress_name
         FROM orders o
         LEFT JOIN restaurant_tables t ON o.table_id = t.id AND t.restaurant_id = o.restaurant_id
         LEFT JOIN users u ON o.waitress_id = u.id
         INNER JOIN order_items oi ON oi.order_id = o.id
         INNER JOIN menu_items m ON m.id = oi.menu_item_id AND m.restaurant_id = o.restaurant_id
         WHERE o.restaurant_id = $1
           AND o.status IN ('ready','served','paid')
           AND o.updated_at >= $2 AND o.updated_at <= $3
           AND (m.kitchen_station = $4 OR m.kitchen_station IS NULL)
         ORDER BY o.updated_at DESC
         LIMIT 100`,
        [rid(req), from, to, userStation]
      );
    } else {
      ordersResult = await db.query(
        `SELECT o.*, t.table_number, u.name as waitress_name
         FROM orders o
         LEFT JOIN restaurant_tables t ON o.table_id = t.id AND t.restaurant_id = o.restaurant_id
         LEFT JOIN users u ON o.waitress_id = u.id
         WHERE o.restaurant_id = $1
           AND o.status IN ('ready','served','paid')
           AND o.updated_at >= $2 AND o.updated_at <= $3
         ORDER BY o.updated_at DESC
         LIMIT 100`,
        [rid(req), from, to]
      );
    }

    if (ordersResult.rows.length === 0) return res.json([]);

    const orderIds = ordersResult.rows.map(o => o.id);
    const itemsResult = await db.query(
      `SELECT oi.*, m.name as item_name, m.kitchen_station
       FROM order_items oi
       LEFT JOIN menu_items m ON oi.menu_item_id = m.id
       WHERE oi.order_id = ANY($1::uuid[])`,
      [orderIds]
    );

    const result = ordersResult.rows.map(order => ({
      ...order,
      items: itemsResult.rows.filter(i => i.order_id === order.id),
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /orders/kitchen/completed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/orders/:id/items/:itemId/ready  — toggle one item's ready flag
// When all items are ready → auto-advance order to 'ready'
router.put('/:id/items/:itemId/ready', authenticate, authorize('owner', 'admin', 'kitchen'), async (req, res) => {
  const { id: orderId, itemId } = req.params;
  const { ready = true } = req.body;   // default: mark as ready
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verify order belongs to this restaurant
    const orderCheck = await client.query(
      `SELECT restaurant_id FROM orders WHERE id=$1`,
      [orderId]
    );
    if (!orderCheck.rows[0] || String(orderCheck.rows[0].restaurant_id) !== String(rid(req))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update this item's ready flag
    const itemRes = await client.query(
      `UPDATE order_items SET item_ready=$1
       WHERE id=$2 AND order_id=$3 RETURNING *`,
      [ready, itemId, orderId]
    );
    if (!itemRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found' });
    }

    // Check if ALL items in this order are now ready
    // Use IS NOT TRUE so NULL values (legacy rows) are treated as not-ready
    const pendingRes = await client.query(
      `SELECT COUNT(*) FROM order_items WHERE order_id=$1 AND item_ready IS NOT TRUE`,
      [orderId]
    );
    const pendingCount = parseInt(pendingRes.rows[0].count);

    let newOrderStatus = null;
    if (pendingCount === 0) {
      // All items ready — advance order to 'ready'
      const orderRes = await client.query(
        `UPDATE orders SET status='ready', updated_at=NOW()
         WHERE id=$1 AND status IN ('pending','sent_to_kitchen','preparing') RETURNING *`,
        [orderId]
      );
      if (orderRes.rows[0]) {
        newOrderStatus = 'ready';
        // Notify waitress (fire-and-forget, outside transaction)
        const notifyOrder = { ...orderRes.rows[0] };
        setImmediate(async () => {
          try {
            if (notifyOrder.waitress_id) {
              const tableRes = await db.query("SELECT table_number FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2", [notifyOrder.table_id, notifyOrder.restaurant_id]);
              const tNum = tableRes.rows[0]?.table_number || 'Walk-in';
              await db.query(
                "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
                [notifyOrder.waitress_id, "Order Ready", `Table ${tNum} order is ready to serve!`, "order_ready", notifyOrder.restaurant_id]
              );
            }
          } catch (_) {}
        });
      }
    } else if (ready) {
      // At least one item done — ensure order is in 'preparing' state
      await client.query(
        `UPDATE orders SET status='preparing', updated_at=NOW()
         WHERE id=$1 AND status IN ('pending','sent_to_kitchen')`,
        [orderId]
      );
    }

    // Get all items count INSIDE the transaction (before COMMIT) to avoid post-commit errors
    const allItems = await client.query(
      `SELECT id, item_ready FROM order_items WHERE order_id=$1`,
      [orderId]
    );

    await client.query('COMMIT');

    // Build response after successful commit
    res.json({
      item: itemRes.rows[0],
      order_status: newOrderStatus,
      all_ready: pendingCount === 0,
      ready_count: allItems.rows.filter(i => i.item_ready).length,
      total_count: allItems.rows.length,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('PUT /orders/:id/items/:itemId/ready error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/orders/:id with items
router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await db.query(
      `SELECT o.*, t.table_number, u.name as waitress_name, c.name as collected_by_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON o.table_id=t.id AND t.restaurant_id = o.restaurant_id
       LEFT JOIN users u ON o.waitress_id=u.id
       LEFT JOIN users c ON o.paid_by = c.id
       WHERE o.id=$1 AND o.restaurant_id=$2`, [req.params.id, rid(req)]
    );
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });
    const items = await db.query(
      `SELECT oi.*, COALESCE(m.name, 'Unknown item') as name, COALESCE(m.name, 'Unknown item') as item_name
       FROM order_items oi LEFT JOIN menu_items m ON oi.menu_item_id=m.id AND m.restaurant_id = (SELECT restaurant_id FROM orders WHERE id=$2)
       WHERE oi.order_id=$1`, [req.params.id, req.params.id]
    );
    // Fetch loan details if payment method is loan
    let loanData = null;
    try {
      const loanRes = await db.query(
        `SELECT customer_name, customer_phone, due_date, amount, status, paid_at, notes
         FROM loans WHERE order_id=$1 AND restaurant_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [req.params.id, rid(req)]
      );
      if (loanRes.rows[0]) loanData = loanRes.rows[0];
    } catch (_) { /* loans table may not exist yet */ }
    res.json({ ...order.rows[0], items: items.rows, loanDetails: loanData });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id — update order details (table, waitress, notes, items, payment_method)
router.put('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { table_id, waitress_id, guest_count, notes, items, payment_method } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verify order exists and belongs to this restaurant
    const existing = await client.query('SELECT * FROM orders WHERE id=$1 AND restaurant_id=$2', [req.params.id, rid(req)]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Build dynamic SET clause
    const sets = ['updated_at=NOW()'];
    const vals = [];

    if (table_id        !== undefined) { vals.push(table_id);        sets.push(`table_id=$${vals.length}`); }
    if (waitress_id     !== undefined) { vals.push(waitress_id);     sets.push(`waitress_id=$${vals.length}`); }
    if (notes           !== undefined) { vals.push(notes);           sets.push(`notes=$${vals.length}`); }
    if (payment_method  !== undefined) { vals.push(payment_method);  sets.push(`payment_method=$${vals.length}`); }
    if (guest_count     !== undefined) { vals.push(guest_count);     sets.push(`guest_count=$${vals.length}`); }
    if (req.body.order_type       !== undefined) { vals.push(req.body.order_type);       sets.push(`order_type=$${vals.length}`); }
    if (req.body.customer_name    !== undefined) { vals.push(req.body.customer_name);    sets.push(`customer_name=$${vals.length}`); }
    if (req.body.customer_phone   !== undefined) { vals.push(req.body.customer_phone);   sets.push(`customer_phone=$${vals.length}`); }
    if (req.body.delivery_address !== undefined) { vals.push(req.body.delivery_address); sets.push(`delivery_address=$${vals.length}`); }
    if (req.body.delivery_status  !== undefined) { vals.push(req.body.delivery_status);  sets.push(`delivery_status=$${vals.length}`); }

    // If items provided, replace order_items and recalculate totals
    if (Array.isArray(items) && items.length > 0) {
      await client.query('DELETE FROM order_items WHERE order_id=$1', [req.params.id]);

      let subtotal = 0;
      for (const item of items) {
        const menuItemId = item.menu_item_id || null;
        let unitPrice = Number(item.unit_price || 0);
        const qty = Number(item.quantity || 1);
        // Look up current menu price if menu_item_id exists
        if (menuItemId) {
          const priceRes = await client.query('SELECT price FROM menu_items WHERE id=$1 AND restaurant_id=$2', [menuItemId, rid(req)]);
          if (priceRes.rows[0]) unitPrice = Number(priceRes.rows[0].price);
        }
        subtotal += unitPrice * qty;
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`,
          [req.params.id, menuItemId, qty, unitPrice]
        );
      }

      // Recalculate tax + total
      let taxRate = 0;
      try {
        const taxRes = await client.query('SELECT rate FROM tax_settings WHERE restaurant_id=$1 AND is_active=true LIMIT 1', [rid(req)]);
        taxRate = parseFloat(taxRes.rows[0]?.rate || 0);
      } catch (_) {}
      const taxAmount = (subtotal * taxRate) / 100;
      const total     = subtotal + taxAmount;

      vals.push(taxAmount); sets.push(`tax_amount=$${vals.length}`);
      vals.push(total);     sets.push(`total_amount=$${vals.length}`);
    }

    // Always run the UPDATE (at minimum touches updated_at)
    vals.push(req.params.id);
    await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);

    // ── Update table statuses when table_id changes ──
    if (table_id !== undefined && existing.rows[0].table_id !== table_id) {
      const oldTableId = existing.rows[0].table_id;
      const newTableId = table_id;

      // Mark the new table as occupied
      if (newTableId) {
        await client.query(
          `UPDATE restaurant_tables SET status='occupied' WHERE id=$1 AND restaurant_id=$2`,
          [newTableId, rid(req)]
        );
      }

      // Free the old table ONLY if no other active orders reference it
      if (oldTableId) {
        const otherOrders = await client.query(
          `SELECT id FROM orders WHERE table_id=$1 AND restaurant_id=$3 AND id != $2 AND status NOT IN ('paid','cancelled') LIMIT 1`,
          [oldTableId, req.params.id, rid(req)]
        );
        if (otherOrders.rows.length === 0) {
          await client.query(
            `UPDATE restaurant_tables SET status='free', assigned_to=NULL WHERE id=$1 AND restaurant_id=$2`,
            [oldTableId, rid(req)]
          );
        }
      }
    }

    await client.query('COMMIT');

    // Return fresh order + items
    const updatedOrder = await db.query(
      `SELECT o.*, t.table_number, t.name as table_name, u.name as waitress_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON o.table_id=t.id AND t.restaurant_id = o.restaurant_id
       LEFT JOIN users u ON o.waitress_id=u.id
       WHERE o.id=$1 AND o.restaurant_id=$2`, [req.params.id, rid(req)]
    );
    const updatedItems = await db.query(
      `SELECT oi.*, COALESCE(m.name, 'Unknown item') as name, COALESCE(m.name, 'Unknown item') as item_name
       FROM order_items oi LEFT JOIN menu_items m ON oi.menu_item_id=m.id AND m.restaurant_id = (SELECT restaurant_id FROM orders WHERE id=$2)
       WHERE oi.order_id=$1`, [req.params.id, req.params.id]
    );
    res.json({ ...updatedOrder.rows[0], items: updatedItems.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/orders — create new order
router.post('/', authenticate, async (req, res) => {
  const { table_id, items, notes, order_type = 'dine_in', customer_name, customer_phone, delivery_address, guest_count } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let taxRate = 0;
    try {
      const taxResult = await client.query('SELECT rate FROM tax_settings WHERE restaurant_id=$1 AND is_active=true LIMIT 1', [rid(req)]);
      taxRate = parseFloat(taxResult.rows[0]?.rate || 0);
    } catch (_) { taxRate = 0; }

    // Resolve unit prices + names — fetch from menu_items for any item missing a price
    const menuItemIds = [...new Set(items.map(i => i.menu_item_id))];
    const menuPriceRows = menuItemIds.length
      ? (await client.query(`SELECT id, price, name FROM menu_items WHERE id = ANY($1) AND restaurant_id=$2`, [menuItemIds, rid(req)])).rows
      : [];
    const menuPriceMap = Object.fromEntries(menuPriceRows.map(r => [r.id, parseFloat(r.price || 0)]));
    const menuNameMap  = Object.fromEntries(menuPriceRows.map(r => [r.id, r.name || r.id]));

    let subtotal = 0;
    for (const item of items) {
      const price = item.custom_price || item.unit_price || menuPriceMap[item.menu_item_id] || 0;
      subtotal += item.is_free ? 0 : price * item.quantity;
    }
    const taxAmount = (subtotal * taxRate) / 100;
    const total = subtotal + taxAmount;

    // Assign today's sequential order number (scoped to this restaurant)
    const dnRes = await client.query(
      `SELECT COALESCE(MAX(daily_number), 0) + 1 AS next_num FROM orders WHERE restaurant_id=$1 AND DATE(created_at) = CURRENT_DATE`,
      [rid(req)]
    );
    const dailyNumber = dnRes.rows[0].next_num;

    const orderResult = await client.query(
      `INSERT INTO orders (table_id, waitress_id, notes, tax_amount, total_amount, order_type, customer_name, customer_phone, delivery_address, daily_number, guest_count, restaurant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [table_id, req.user.id, notes, taxAmount, total, order_type, customer_name, customer_phone, delivery_address, dailyNumber, guest_count || null, rid(req)]
    );
    const order = orderResult.rows[0];

    // Mark table as occupied
    if (table_id) {
      await client.query(
        `UPDATE restaurant_tables SET status='occupied', assigned_to=$1, opened_at=COALESCE(opened_at, NOW()) WHERE id=$2 AND restaurant_id=$3`,
        [req.user.id, table_id, rid(req)]
      );
    }

    let totalIngredientCost = 0;
    for (const item of items) {
      // Resolve unit_price — use provided value or fall back to menu_items lookup done above
      const unitPrice = item.custom_price || item.unit_price || menuPriceMap[item.menu_item_id] || 0;

      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, custom_price, is_free, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, item.menu_item_id, item.quantity, unitPrice, item.custom_price || null, item.is_free || false, item.notes || null]
      );

      // Deduct stock using SAVEPOINT so a failure here never aborts the outer transaction
      try {
        await client.query('SAVEPOINT ingredient_deduction');
        const bom = await client.query(
          `SELECT mii.ingredient_id, mii.quantity_used, i.cost_per_unit, i.name AS ingredient_name
           FROM menu_item_ingredients mii
           JOIN warehouse_items i ON mii.ingredient_id = i.id
           WHERE mii.menu_item_id=$1`, [item.menu_item_id]
        );
        for (const ing of bom.rows) {
          const qtyUsed = ing.quantity_used * item.quantity;
          await client.query(
            'UPDATE warehouse_items SET quantity_in_stock = GREATEST(0, quantity_in_stock - $1), updated_at=NOW() WHERE id=$2',
            [qtyUsed, ing.ingredient_id]
          );
          // Log movement so it appears in Output tab (capture cost at deduction time)
          const ingCost = parseFloat(ing.cost_per_unit || 0);
          await client.query(
            `INSERT INTO stock_movements (item_id, type, quantity, user_id, reason, cost_per_unit, restaurant_id)
             VALUES ($1, 'OUT', $2, $3, $4, $5, $6)`,
            [ing.ingredient_id, qtyUsed, req.user.id,
             `Auto: Order #${order.daily_number || order.id.slice(0,8)} — ${item.quantity}x ${menuNameMap[item.menu_item_id] || item.menu_item_id}`,
             ingCost, rid(req)]
          );
          totalIngredientCost += qtyUsed * ingCost;
        }
        await client.query('RELEASE SAVEPOINT ingredient_deduction');
      } catch (ingErr) {
        await client.query('ROLLBACK TO SAVEPOINT ingredient_deduction');
        console.warn('Ingredient deduction skipped:', ingErr.message);
      }
    }

    // Record ingredient cost as expense (safe — expenses table is optional)
    if (totalIngredientCost > 0) {
      try {
        await client.query(
          `INSERT INTO expenses (category, description, amount, expense_date, recorded_by, restaurant_id)
           VALUES ('cost_of_goods', $1, $2, CURRENT_DATE, $3, $4)`,
          [`Ingredients for order #${order.id.slice(0, 8)}`, totalIngredientCost, req.user.id, rid(req)]
        );
      } catch (_) { /* skip if expenses table not available */ }
    }

    await client.query('COMMIT');

    // Create notifications for kitchen users asynchronously
    (async () => {
      try {
        const kitchenUsers = await db.query("SELECT id FROM users WHERE role='kitchen'");

        let notifTitle, notifBody;
        if (order_type === 'to_go') {
          notifTitle = '📦 To Go Order!';
          notifBody  = `New To Go order for ${customer_name || 'customer'} — please package when ready!`;
        } else if (order_type === 'delivery') {
          notifTitle = '🚚 Delivery Order!';
          notifBody  = `Delivery for ${customer_name || 'customer'} — ${delivery_address || 'address on file'}. Package & hand to driver!`;
        } else {
          notifTitle = '🔥 New Dine-In Order!';
          notifBody  = `Table ${table_id ? (await db.query('SELECT name, table_number FROM restaurant_tables WHERE id=$1', [table_id])).rows[0]?.name || table_id : 'Walk-in'} just placed a new order!`;
        }

        for (const u of kitchenUsers.rows) {
          await db.query(
            "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
            [u.id, notifTitle, notifBody, "new_order", rid(req)]
          );
        }
      } catch (e) { console.error('Kitchen notification error:', e.message); }
    })();

    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Auto-migration: add served_at to order_items for per-item delivery tracking
;(async () => {
  try {
    await db.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS served_at TIMESTAMP`);
  } catch (_) {}
})();

// PUT /api/orders/:id/status
router.put('/:id/status', authenticate, async (req, res) => {
  const { status, cancellation_reason } = req.body;
  const validStatuses = ['pending', 'sent_to_kitchen', 'preparing', 'ready', 'served', 'bill_requested', 'paid', 'cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let updateSql = `UPDATE orders SET status=$1, updated_at=NOW()`;
    if (status === 'paid') updateSql += `, paid_at=NOW()`;
    if (status === 'cancelled' && cancellation_reason) updateSql += `, cancellation_reason=$3`;
    updateSql += ` WHERE id=$2 AND restaurant_id=$${cancellation_reason ? 4 : 3} RETURNING *`;
    const params = [status, req.params.id];
    if (status === 'cancelled' && cancellation_reason) params.push(cancellation_reason);
    params.push(rid(req));
    const result = await client.query(updateSql, params);
    const order = result.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // --- PRO WOS: AUTO-DEPLETION ENGINE ---
    // When order is fulfilled (served or paid), mathematically deplete stock if it hasn't been depleted yet.
    // In our existing logic, stock was depleted instantly on order creation. For Pro, we might leave it there or move it here.
    // Since the prompt asks to trigger it when *Delivered/Served*, we should ideally move it. But to prevent double-dipping 
    // from the POST /orders creation, we'll assume the user wants it here. Since POST /orders still deducts overall stock,
    // let's ensure we update the *batches* (FIFO) here to track financial P&L accurately.
    if (status === 'served' || status === 'paid') {
      try {
        const orderItems = await client.query('SELECT menu_item_id, quantity FROM order_items WHERE order_id=$1', [order.id]);

        for (const item of orderItems.rows) {
          // Fetch BOM (safe — table may not exist yet)
          let bom;
          try {
            bom = await client.query(
              `SELECT ingredient_id, quantity_used FROM menu_item_ingredients WHERE menu_item_id=$1`,
              [item.menu_item_id]
            );
          } catch (_) { continue; }

          for (const recipe of bom.rows) {
            const totalQtyToDeduct = parseFloat(recipe.quantity_used) * parseInt(item.quantity);
            let remainingToDeduct = totalQtyToDeduct;

            // Fetch batches FIFO (stock_batches may not exist — skip gracefully)
            try {
              const batches = await client.query(
                `SELECT id, quantity_remaining FROM stock_batches
                 WHERE item_id=$1 AND quantity_remaining > 0
                 ORDER BY expiry_date ASC NULLS LAST FOR UPDATE`,
                [recipe.ingredient_id]
              );
              for (const batch of batches.rows) {
                if (remainingToDeduct <= 0) break;
                const bQty = parseFloat(batch.quantity_remaining);
                const deduct = Math.min(bQty, remainingToDeduct);
                await client.query('UPDATE stock_batches SET quantity_remaining = quantity_remaining - $1 WHERE id=$2', [deduct, batch.id]);
                remainingToDeduct -= deduct;
              }
            } catch (_) { /* stock_batches not used — skip */ }
          }
        }

        // Refresh materialized view only if it exists
        try { await client.query('REFRESH MATERIALIZED VIEW warehouse_valuation'); } catch (_) {}
      } catch (depletionErr) { console.warn('Auto-depletion skipped:', depletionErr.message); }
    }
    // --- END AUTO-DEPLETION ---

    // Free table when paid or cancelled
    if ((status === 'paid' || status === 'cancelled') && order.table_id) {
      // Only free if no other active orders on this table
      const activeOrders = await client.query(
        `SELECT COUNT(*) FROM orders WHERE table_id=$1 AND restaurant_id=$3 AND id!=$2 AND status NOT IN ('paid','cancelled')`,
        [order.table_id, order.id, rid(req)]
      );
      if (parseInt(activeOrders.rows[0].count) === 0) {
        await client.query(
          `UPDATE restaurant_tables SET status='free', assigned_to=NULL, opened_at=NULL WHERE id=$1 AND restaurant_id=$2`,
          [order.table_id, rid(req)]
        );
      }
    }
    await client.query('COMMIT');

    // Notify waitress if order is ready
    if (status === 'ready' && order.waitress_id) {
      (async () => {
        try {
          const tableRes = await db.query(
            "SELECT table_number FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2",
            [order.table_id, order.restaurant_id]
          );
          const tNum = tableRes.rows[0]?.table_number || 'Walk-in';
          await db.query(
            "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
            [order.waitress_id, "Order Ready", `Table ${tNum} order is ready to serve!`, "order_ready", order.restaurant_id]
          );
        } catch (e) { console.error('Waitress notification error:', e.message); }
      })();
    }

    // Notify cashiers when bill is requested; fall back to admins/owners if no cashiers exist
    if (status === 'bill_requested') {
      (async () => {
        try {
          const tableRes   = await db.query("SELECT table_number FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2", [order.table_id, order.restaurant_id]);
          const waitressRes= await db.query("SELECT name FROM users WHERE id=$1", [order.waitress_id]);
          const tNum       = tableRes.rows[0]?.table_number || '?';
          const waitress   = waitressRes.rows[0]?.name || 'Waitress';
          const total      = parseFloat(order.total_amount || 0).toLocaleString('uz-UZ');
          const now        = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
          const body       = `Table ${tNum} · ${total} so'm · ${waitress} · ${now}`;

          // Primary: send to cashiers
          let recipients = await db.query(
            "SELECT id FROM users WHERE role='cashier' AND is_active IS NOT FALSE"
          );
          // Fallback: if no cashiers, send to admins/owners
          if (recipients.rows.length === 0) {
            recipients = await db.query(
              "SELECT id FROM users WHERE role IN ('admin','owner') AND is_active IS NOT FALSE"
            );
          }
          for (const u of recipients.rows) {
            await db.query(
              "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
              [u.id, "Bill Requested", body, "bill_requested", order.restaurant_id]
            );
          }
        } catch (e) { console.error('Bill notification error:', e.message); }
      })();
    }

    res.json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PUT /api/orders/:id/pay
router.put('/:id/pay', authenticate, async (req, res) => {
  // Accept both snake_case and camelCase field names from any frontend
  const discount_amount  = req.body.discount_amount  ?? req.body.discountAmount  ?? 0;
  const split_payments   = req.body.split_payments   ?? req.body.splitPayments   ?? null;
  const loan_customer_name  = req.body.loan_customer_name  || req.body.loanCustomerName  || null;
  const loan_customer_phone = req.body.loan_customer_phone || req.body.loanCustomerPhone || null;
  const loan_due_date       = req.body.loan_due_date       || req.body.loanDueDate       || null;
  const loan_notes          = req.body.notes               || req.body.loan_notes        || req.body.loanNotes || null;
  // Normalize payment method to DB-safe value (accepts both camelCase and snake_case key)
  const METHOD_MAP = { 'Cash': 'cash', 'Card': 'card', 'QR Code': 'qr_code', 'Loan': 'loan', 'Split': 'split', 'Online': 'online' };
  const rawMethod  = req.body.payment_method || req.body.paymentMethod || '';
  const payment_method = METHOD_MAP[rawMethod] || rawMethod.toLowerCase() || null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Ensure loans table exists before attempting insert
    await client.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,
        customer_name  TEXT NOT NULL,
        customer_phone TEXT,
        due_date       DATE NOT NULL,
        amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid')),
        paid_at        TIMESTAMPTZ,
        notes          TEXT,
        restaurant_id  UUID NOT NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE loans ADD COLUMN IF NOT EXISTS notes TEXT`);
    await client.query(`ALTER TABLE loans ADD COLUMN IF NOT EXISTS restaurant_id UUID`);

    // Normalize split payment methods
    const normalizedSplitPayments = Array.isArray(split_payments)
      ? split_payments.map(sp => ({
          ...sp,
          method: ({ 'Cash': 'cash', 'Card': 'card', 'QR Code': 'qr_code', 'Loan': 'loan' }[sp.method] || (sp.method || '').toLowerCase() || sp.method),
        }))
      : null;

    const result = await client.query(
      `UPDATE orders
       SET status='paid', payment_method=$1,
           discount_amount=COALESCE($2,0),
           total_amount = GREATEST(0, total_amount - COALESCE($2,0)),
           split_payments=COALESCE($5::jsonb, split_payments),
           paid_at=NOW(), updated_at=NOW(), paid_by=$4
       WHERE id=$3 AND restaurant_id=$6 RETURNING *`,
      [payment_method, discount_amount || 0, req.params.id, req.user.id,
       normalizedSplitPayments ? JSON.stringify(normalizedSplitPayments) : null, rid(req)]
    );
    const order = result.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Record cash inflow (not for loans — money has not arrived yet)
    if (payment_method === 'cash') {
      await client.query(
        `INSERT INTO cash_flow (type, amount, description, recorded_by, restaurant_id)
         VALUES ('in', $1, $2, $3, $4)`,
        [order.total_amount, `Payment for order #${order.id.slice(0, 8)}`, req.user.id, rid(req)]
      );
    } else if (payment_method === 'split' && Array.isArray(normalizedSplitPayments)) {
      for (const sp of normalizedSplitPayments) {
        if (sp.method === 'cash') {
          await client.query(
            `INSERT INTO cash_flow (type, amount, description, recorded_by, restaurant_id)
             VALUES ('in', $1, $2, $3, $4)`,
            [sp.amount, `Partial split payment for order #${order.id.slice(0, 8)}`, req.user.id, rid(req)]
          );
        }
        // Create a loan record for each loan part in a split (accept camelCase or snake_case)
        const spName  = sp.loan_customer_name  || sp.loanCustomerName;
        const spPhone = sp.loan_customer_phone || sp.loanCustomerPhone || null;
        const spDate  = sp.loan_due_date       || sp.loanDueDate;
        if (sp.method === 'loan' && spName && spDate) {
          await client.query(
            `INSERT INTO loans (order_id, customer_name, customer_phone, due_date, amount, notes, restaurant_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [order.id, spName, spPhone, spDate, sp.amount, loan_notes, rid(req)]
          );
        }
      }
    } else if (payment_method === 'loan') {
      // Create a loan record for the unpaid debt
      if (!loan_customer_name || !loan_due_date) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'loan_customer_name and loan_due_date are required for loan payments' });
      }
      await client.query(
        `INSERT INTO loans (order_id, customer_name, customer_phone, due_date, amount, notes, restaurant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, loan_customer_name, loan_customer_phone || null, loan_due_date, order.total_amount, loan_notes, rid(req)]
      );
    }

    // Free the table if no other active orders
    if (order.table_id) {
      const activeOrders = await client.query(
        `SELECT COUNT(*) FROM orders WHERE table_id=$1 AND restaurant_id=$3 AND id!=$2 AND status NOT IN ('paid','cancelled')`,
        [order.table_id, order.id, rid(req)]
      );
      if (parseInt(activeOrders.rows[0].count) === 0) {
        await client.query(
          `UPDATE restaurant_tables SET status='free', assigned_to=NULL, opened_at=NULL WHERE id=$1 AND restaurant_id=$2`,
          [order.table_id, rid(req)]
        );
      }
    }

    // ── Ingredient deduction at payment time ────────────────────────────────
    // Handles orders that were placed before ingredients were linked to menu items.
    // Uses a SAVEPOINT so any failure here never aborts the payment transaction.
    // Skips if stock was already deducted at order-creation time.
    try {
      await client.query('SAVEPOINT pay_ingredient_deduction');
      const orderNum = order.daily_number || order.id.slice(0, 8);

      // Check if we already logged movements for this order at creation time
      const alreadyDone = await client.query(
        `SELECT id FROM stock_movements WHERE reason LIKE $1 LIMIT 1`,
        [`Auto: Order #${orderNum}%`]
      );

      if (alreadyDone.rows.length === 0) {
        // Not yet deducted — do it now
        const orderItemsRes = await client.query(
          `SELECT oi.menu_item_id, oi.quantity FROM order_items oi WHERE oi.order_id=$1`,
          [order.id]
        );
        let totalIngCost = 0;
        for (const item of orderItemsRes.rows) {
          const bom = await client.query(
            `SELECT mii.ingredient_id, mii.quantity_used, i.cost_per_unit
             FROM menu_item_ingredients mii
             JOIN warehouse_items i ON mii.ingredient_id = i.id
             WHERE mii.menu_item_id=$1`, [item.menu_item_id]
          );
          for (const ing of bom.rows) {
            const qtyUsed = parseFloat(ing.quantity_used) * parseInt(item.quantity);
            await client.query(
              'UPDATE warehouse_items SET quantity_in_stock = GREATEST(0, quantity_in_stock - $1), updated_at=NOW() WHERE id=$2',
              [qtyUsed, ing.ingredient_id]
            );
            const payCost = parseFloat(ing.cost_per_unit || 0);
            await client.query(
              `INSERT INTO stock_movements (item_id, type, quantity, user_id, reason, cost_per_unit, restaurant_id)
               VALUES ($1, 'OUT', $2, $3, $4, $5, $6)`,
              [ing.ingredient_id, qtyUsed, req.user.id,
               `Auto: Order #${orderNum} — ${item.quantity}x (paid)`,
               payCost, rid(req)]
            );
            totalIngCost += qtyUsed * payCost;
          }
        }
        if (totalIngCost > 0) {
          try {
            await client.query(
              `INSERT INTO expenses (category, description, amount, expense_date, recorded_by, restaurant_id)
               VALUES ('cost_of_goods', $1, $2, CURRENT_DATE, $3, $4)`,
              [`Ingredients for order #${order.id.slice(0, 8)}`, totalIngCost, req.user.id, rid(req)]
            );
          } catch (_) { /* expenses table optional */ }
        }
      }
      await client.query('RELEASE SAVEPOINT pay_ingredient_deduction');
    } catch (depErr) {
      await client.query('ROLLBACK TO SAVEPOINT pay_ingredient_deduction');
      console.warn('Pay-time ingredient deduction skipped:', depErr.message);
    }
    // ── End ingredient deduction ─────────────────────────────────────────────

    await client.query('COMMIT');
    res.json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// DELETE /api/orders/:id
router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const result = await db.query(`UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1 AND restaurant_id=$2 RETURNING id`, [req.params.id, rid(req)]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json({ message: 'Order cancelled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders/:id/items — waitress appends new items to an existing order
// Does NOT replace existing items — only adds new ones and recalculates the total.
router.post('/:id/items', authenticate, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'items array required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verify order exists and belongs to this restaurant
    const existing = await client.query('SELECT * FROM orders WHERE id=$1 AND restaurant_id=$2', [req.params.id, rid(req)]);
    if (!existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = existing.rows[0];
    if (order.status === 'bill_requested' || order.status === 'paid' || order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot add items to an order with status: ${order.status}` });
    }

    // Look up prices and insert new items
    let addedSubtotal = 0;
    for (const item of items) {
      const priceRes = await client.query('SELECT price FROM menu_items WHERE id=$1 AND restaurant_id=$2', [item.menu_item_id, rid(req)]);
      const unitPrice = priceRes.rows[0] ? Number(priceRes.rows[0].price) : 0;
      const qty = Number(item.quantity || 1);
      addedSubtotal += unitPrice * qty;
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
         VALUES ($1,$2,$3,$4)`,
        [req.params.id, item.menu_item_id, qty, unitPrice]
      );
    }

    // Recalculate total from all items
    const totals = await client.query(
      `SELECT COALESCE(SUM(unit_price * quantity), 0) as subtotal FROM order_items WHERE order_id=$1`,
      [req.params.id]
    );
    let taxRate = 0;
    try {
      const taxRes = await client.query('SELECT rate FROM tax_settings WHERE restaurant_id=$1 AND is_active=true LIMIT 1', [rid(req)]);
      taxRate = parseFloat(taxRes.rows[0]?.rate || 0);
    } catch (_) {}
    const subtotal   = parseFloat(totals.rows[0].subtotal);
    const taxAmount  = (subtotal * taxRate) / 100;
    const total      = subtotal + taxAmount;
    await client.query(
      `UPDATE orders SET total_amount=$1, tax_amount=$2, updated_at=NOW() WHERE id=$3`,
      [total, taxAmount, req.params.id]
    );

    // Reset to pending so kitchen sees the new items
    await client.query(
      `UPDATE orders SET status='pending', updated_at=NOW() WHERE id=$1 AND status IN ('ready','served')`,
      [req.params.id]
    );

    await client.query('COMMIT');

    // Return updated order + all items
    const updatedOrder = await db.query(
      `SELECT o.*, t.table_number, u.name as waitress_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON o.table_id=t.id AND t.restaurant_id = o.restaurant_id
       LEFT JOIN users u ON o.waitress_id=u.id
       WHERE o.id=$1 AND o.restaurant_id=$2`, [req.params.id, rid(req)]
    );
    const updatedItems = await db.query(
      `SELECT oi.*, COALESCE(m.name, 'Unknown item') as name, COALESCE(m.name, 'Unknown item') as item_name
       FROM order_items oi LEFT JOIN menu_items m ON oi.menu_item_id=m.id AND m.restaurant_id = (SELECT restaurant_id FROM orders WHERE id=$2)
       WHERE oi.order_id=$1 ORDER BY oi.created_at ASC`, [req.params.id, req.params.id]
    );

    // Notify kitchen of updated order
    (async () => {
      try {
        const kitchenUsers = await db.query("SELECT id FROM users WHERE role='kitchen'");
        for (const u of kitchenUsers.rows) {
          await db.query(
            "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
            [u.id, "Order Updated", `New items added to order at Table ${updatedOrder.rows[0]?.table_number || '?'}`, "new_order", rid(req)]
          );
        }
      } catch (e) { console.error('Kitchen add-items notification error:', e.message); }
    })();

    res.json({ ...updatedOrder.rows[0], items: updatedItems.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PUT /api/orders/:id/items/:itemId/serve — waitress marks one item as delivered
// NOTE: Does NOT auto-advance the order to 'served'. The order stays at 'ready'
// until the waitress/admin explicitly advances it via the status endpoint.
router.put('/:id/items/:itemId/serve', authenticate, async (req, res) => {
  try {
    // Verify order belongs to this restaurant
    const orderCheck = await db.query(
      `SELECT restaurant_id FROM orders WHERE id=$1`,
      [req.params.id]
    );
    if (!orderCheck.rows[0] || orderCheck.rows[0].restaurant_id !== rid(req)) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const result = await db.query(
      `UPDATE order_items SET served_at=NOW()
       WHERE id=$1 AND order_id=$2 RETURNING *`,
      [req.params.itemId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orders/:id/loan/pay — mark the loan for this order as paid
// Works whether or not a loan record already exists.
router.put('/:id/loan/pay', authenticate, authorize('owner', 'admin', 'cashier'), async (req, res) => {
  try {
    // Try to find an existing loan record for this order
    const loanRes = await db.query(
      `SELECT id FROM loans WHERE order_id = $1 AND restaurant_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [req.params.id, rid(req)]
    );

    if (loanRes.rows[0]) {
      // Mark the existing loan as paid
      const updated = await db.query(
        `UPDATE loans SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
        [loanRes.rows[0].id]
      );
      return res.json(updated.rows[0]);
    }

    // No loan record found — create one from the order data and mark it as paid
    const orderRes = await db.query(
      `SELECT id, total_amount, customer_name, customer_phone FROM orders WHERE id=$1 AND restaurant_id=$2`,
      [req.params.id, rid(req)]
    );
    if (!orderRes.rows[0]) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];

    const created = await db.query(
      `INSERT INTO loans (order_id, customer_name, customer_phone, due_date, amount, status, paid_at, restaurant_id)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, 'paid', NOW(), $5)
       RETURNING *`,
      [
        req.params.id,
        req.body.customer_name || req.body.customerName || order.customer_name || 'Unknown',
        req.body.customer_phone || req.body.customerPhone || order.customer_phone || null,
        order.total_amount,
        rid(req)
      ]
    );
    return res.json(created.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
