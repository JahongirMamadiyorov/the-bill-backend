const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// Helper: local date string (avoids UTC shift from .toISOString())
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function localFirstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

// GET /api/reports/dashboard
router.get('/dashboard', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const today = localToday();
    const restaurantId = rid(req);
    const [todaySales, tables, topItems] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='paid' AND paid_at::date=$1)  AS today_orders,
          COALESCE(SUM(total_amount) FILTER (WHERE status='paid' AND paid_at::date=$1), 0) AS today_revenue,
          COUNT(*) FILTER (WHERE status NOT IN ('paid','cancelled'))   AS active_orders
        FROM orders
        WHERE restaurant_id=$2`, [today, restaurantId]),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='free')     AS free_tables,
          COUNT(*) FILTER (WHERE status='occupied') AS occupied_tables,
          COUNT(*)                                  AS total_tables
        FROM restaurant_tables
        WHERE restaurant_id=$1`, [restaurantId]),
      db.query(`
        SELECT m.name, SUM(oi.quantity) as total_sold,
               ROUND(SUM(oi.quantity * oi.unit_price)::numeric, 2) as total_revenue
        FROM order_items oi
        JOIN menu_items m ON oi.menu_item_id=m.id
        JOIN orders o ON oi.order_id=o.id
        WHERE o.status='paid' AND o.paid_at >= NOW() - INTERVAL '30 days'
          AND m.restaurant_id=$1
          AND o.restaurant_id=$1
        GROUP BY m.name ORDER BY total_sold DESC LIMIT 5`, [restaurantId]),
    ]);

    const s = todaySales.rows[0];
    const t = tables.rows[0];
    res.json({
      today_revenue: parseFloat(s.today_revenue),
      today_orders: parseInt(s.today_orders),
      active_orders: parseInt(s.active_orders),
      open_tables: parseInt(t.occupied_tables),
      free_tables: parseInt(t.free_tables),
      total_tables: parseInt(t.total_tables),
      best_sellers: topItems.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/admin-daily-summary
router.get('/admin-daily-summary', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const today = localToday();
    const restaurantId = rid(req);

    const [
      salesOverviewRes,
      goodsSoldRes,
      currentOrdersRes,
      inflowRes,
      outflowRes,
      consumedRes,
      arrivedRes,
      statusRes,
      staffRes,
      trendRes,
      perfRes
    ] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total_amount), 0) as total_sales, COUNT(*)::int as today_orders FROM orders WHERE status = 'paid' AND paid_at::date = $1 AND restaurant_id = $2`, [today, restaurantId]),
      db.query(`
        SELECT m.name, c.name as category, SUM(oi.quantity) as quantity
        FROM order_items oi
        JOIN menu_items m ON oi.menu_item_id = m.id
        LEFT JOIN categories c ON m.category_id = c.id
        JOIN orders o ON oi.order_id = o.id
        WHERE o.status = 'paid' AND o.paid_at::date = $1 AND m.restaurant_id = $2 AND o.restaurant_id = $2
        GROUP BY m.name, c.name ORDER BY quantity DESC
      `, [today, restaurantId]),
      db.query(`
        SELECT order_type, COUNT(*) as count
        FROM orders
        WHERE status NOT IN ('paid', 'cancelled') AND restaurant_id = $1
        GROUP BY order_type
      `, [restaurantId]),
      db.query(`
        SELECT COALESCE(NULLIF(payment_method, ''), 'cash') AS payment_method,
               COALESCE(SUM(total_amount), 0) as amount
        FROM orders
        WHERE status = 'paid' AND paid_at::date = $1 AND restaurant_id = $2
        GROUP BY COALESCE(NULLIF(payment_method, ''), 'cash')
      `, [today, restaurantId]),
      db.query(`
        SELECT
          COALESCE((SELECT SUM(amount) FROM expenses
                    WHERE expense_date = $1
                      AND category != 'cost_of_goods'
                      AND restaurant_id = $2), 0) AS expenses,
          COALESCE((SELECT SUM(amount) FROM staff_payments WHERE payment_date = $1 AND restaurant_id = $2), 0) AS salaries,
          COALESCE((SELECT SUM(total) FROM supplier_deliveries
                    WHERE payment_status = 'paid' AND paid_at::date = $1 AND restaurant_id = $2), 0) AS delivery_payments
      `, [today, restaurantId]),
      // goodsConsumed: only order-based consumption (reason starts with 'Auto:').
      // This excludes old manual/test entries from inflating the figure and matches
      // the Kitchen Usage Summary shown in the Inventory Output tab.
      db.query(`
        SELECT COALESCE(SUM(sm.quantity * wi.cost_per_unit), 0) as total_value
        FROM stock_movements sm
        JOIN warehouse_items wi ON sm.item_id = wi.id
        WHERE sm.type IN ('OUT', 'WASTE')
          AND sm.reason LIKE 'Auto:%'
          AND sm.created_at::date = $1
          AND wi.restaurant_id = $2
      `, [today, restaurantId]).catch(() => ({ rows: [{ total_value: 0 }] })),
      // goodsArrived: use IN movements with cost captured at receipt time
      db.query(`
        SELECT COALESCE(SUM(sm.quantity * COALESCE(NULLIF(sm.cost_per_unit, 0), wi.cost_per_unit)), 0) as total_value
        FROM stock_movements sm
        JOIN warehouse_items wi ON sm.item_id = wi.id
        WHERE sm.type = 'IN' AND sm.created_at::date = $1 AND wi.restaurant_id = $2
      `, [today, restaurantId]).catch(() => ({ rows: [{ total_value: 0 }] })),
      db.query(`SELECT COUNT(*) as item_count, COALESCE(SUM(quantity_in_stock * cost_per_unit), 0) as total_value FROM warehouse_items WHERE restaurant_id = $1`, [restaurantId]),
      db.query(`
        SELECT u.name,
               ROUND(COALESCE(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, CURRENT_TIMESTAMP) - s.clock_in))/3600, 0)::numeric, 1) as hours_worked,
               COUNT(o.id) as orders_handled
        FROM users u
        JOIN shifts s ON s.user_id = u.id AND s.clock_in::date = $1 AND s.restaurant_id = $2
        LEFT JOIN orders o ON o.waitress_id = u.id AND o.created_at::date = $1 AND o.restaurant_id = $2
        WHERE u.role = 'waitress'
        GROUP BY u.name, s.clock_in, s.clock_out
      `, [today, restaurantId]),
      db.query(`
        SELECT to_char(date_trunc('hour', paid_at), 'HH24:00') as time, COALESCE(SUM(total_amount), 0) as sales
        FROM orders
        WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '24 HOURS' AND restaurant_id = $1
        GROUP BY time ORDER BY time
      `, [restaurantId]),
      db.query(`
        SELECT m.name, SUM(oi.quantity) as total_sold
        FROM order_items oi
        JOIN menu_items m ON oi.menu_item_id = m.id
        JOIN orders o ON oi.order_id = o.id
        WHERE o.status = 'paid' AND o.paid_at >= NOW() - INTERVAL '7 days' AND m.restaurant_id = $1 AND o.restaurant_id = $1
        GROUP BY m.name ORDER BY total_sold DESC LIMIT 5
      `, [restaurantId])
    ]);

    const activeOrdersMap = { dine_in: 0, takeaway: 0, delivery: 0, total: 0 };
    currentOrdersRes.rows.forEach(row => {
      const t = row.order_type || 'dine_in';
      activeOrdersMap[t] = parseInt(row.count);
      activeOrdersMap.total += parseInt(row.count);
    });

    res.json({
      salesOverview: parseFloat(salesOverviewRes.rows[0].total_sales),
      todayOrders: parseInt(salesOverviewRes.rows[0].today_orders || 0),
      goodsSold: goodsSoldRes.rows,
      currentOrders: Object.keys(activeOrdersMap).map(k => ({
        id: k,
        name: k === 'dine_in' ? 'In-Restaurant' : k === 'takeaway' ? 'To-Go' : k === 'delivery' ? 'Delivery' : 'Total',
        count: activeOrdersMap[k]
      })).filter(o => o.id !== 'total'),
      totalActiveOrders: activeOrdersMap.total,
      financialFlow: {
        inflow: inflowRes.rows,
        outflow: parseFloat(outflowRes.rows[0].expenses) + parseFloat(outflowRes.rows[0].salaries) + parseFloat(outflowRes.rows[0].delivery_payments),
        outflowBreakdown: {
          expenses: parseFloat(outflowRes.rows[0].expenses),
          salaries: parseFloat(outflowRes.rows[0].salaries),
          deliveryPayments: parseFloat(outflowRes.rows[0].delivery_payments),
        }
      },
      warehouse: {
        goodsConsumed: parseFloat(consumedRes.rows[0].total_value),
        goodsArrived: parseFloat(arrivedRes.rows[0].total_value),
        currentStatus: {
          itemCount: parseInt(statusRes.rows[0].item_count),
          totalValue: parseFloat(statusRes.rows[0].total_value)
        }
      },
      staffPerformance: staffRes.rows.map(r => ({
        name: r.name,
        hours: parseFloat(r.hours_worked),
        orders: parseInt(r.orders_handled)
      })),
      charts: {
        dailySalesTrend: trendRes.rows,
        productPerformance: perfRes.rows
      }
    });

  } catch (err) {
    console.error('Error fetching admin summary', err);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/reports/best-sellers
router.get('/best-sellers', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || localFirstOfMonth();
  const toDate = req.query.to || localToday();
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT m.name, c.name as category,
              SUM(oi.quantity) as total_sold,
              ROUND(SUM(oi.quantity * oi.unit_price)::numeric, 2) as total_revenue
       FROM order_items oi
       JOIN menu_items m ON oi.menu_item_id=m.id
       LEFT JOIN categories c ON m.category_id=c.id
       JOIN orders o ON oi.order_id=o.id
       WHERE o.status='paid' AND o.paid_at::date BETWEEN $1 AND $2 AND m.restaurant_id=$3 AND o.restaurant_id=$3
       GROUP BY m.name, c.name ORDER BY total_sold DESC LIMIT 20`,
      [fromDate, toDate, restaurantId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/waitress-performance
router.get('/waitress-performance', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || localFirstOfMonth();
  const toDate = req.query.to || localToday();
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT u.name,
              COUNT(o.id) as total_orders,
              ROUND(COALESCE(SUM(o.total_amount),0)::numeric, 2) as total_sales,
              ROUND(COALESCE(AVG(o.total_amount),0)::numeric, 2) as avg_order
       FROM users u
       LEFT JOIN orders o ON o.waitress_id=u.id AND o.status='paid' AND o.paid_at::date BETWEEN $1 AND $2 AND o.restaurant_id=$3
       WHERE u.role='waitress' AND u.is_active=true AND u.restaurant_id=$3
       GROUP BY u.name ORDER BY total_sales DESC`,
      [fromDate, toDate, restaurantId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/cashier-stats?from=&to=
// Returns per-cashier order count & revenue for the period
router.get('/cashier-stats', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const from = req.query.from || localFirstOfMonth();
  const to   = req.query.to   || localToday();
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT u.id, u.name,
              COUNT(o.id)::int                                           AS orders_count,
              ROUND(COALESCE(SUM(o.total_amount), 0)::numeric, 2)       AS total_revenue
       FROM users u
       LEFT JOIN orders o ON o.paid_by = u.id
                          AND o.status  = 'paid'
                          AND o.paid_at::date BETWEEN $1 AND $2
                          AND o.restaurant_id = $3
       WHERE u.role = 'cashier' AND u.is_active = true AND u.restaurant_id = $3
       GROUP BY u.id, u.name
       ORDER BY total_revenue DESC`,
      [from, to, restaurantId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/kitchen-stats?from=&to=
// Returns per-station order count & avg cook time (created_at → updated_at) in minutes
router.get('/kitchen-stats', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const from = req.query.from || localFirstOfMonth();
  const to   = req.query.to   || localToday();
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT
         COALESCE(m.kitchen_station, 'general') AS station,
         COUNT(DISTINCT o.id)::int              AS orders_count,
         ROUND(
           AVG(EXTRACT(EPOCH FROM (o.updated_at - o.created_at)) / 60)::numeric
         , 1)                                   AS avg_minutes
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN menu_items  m  ON m.id        = oi.menu_item_id
       WHERE o.status IN ('ready', 'served', 'paid')
         AND o.created_at::date BETWEEN $1 AND $2
         AND m.restaurant_id = $3
         AND o.restaurant_id = $3
       GROUP BY COALESCE(m.kitchen_station, 'general')`,
      [from, to, restaurantId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
