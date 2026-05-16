const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ─── EXPENSES ────────────────────────────────────────────────

router.get('/expenses', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { from, to, category } = req.query;
  const restaurantId = rid(req);
  try {
    let query = `SELECT e.*, u.name as recorded_by_name
                 FROM expenses e LEFT JOIN users u ON e.recorded_by=u.id WHERE e.restaurant_id=$1`;
    const params = [restaurantId];
    if (from)     { params.push(from);     query += ` AND e.expense_date >= $${params.length}`; }
    if (to)       { params.push(to);       query += ` AND e.expense_date <= $${params.length}`; }
    if (category) { params.push(category); query += ` AND e.category=$${params.length}`; }
    query += ' ORDER BY e.expense_date DESC, e.created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/expenses', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { category, description, amount, expense_date } = req.body;
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      'INSERT INTO expenses (category,description,amount,expense_date,recorded_by,restaurant_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [category || 'Other', description, amount, expense_date || new Date().toISOString().split('T')[0], req.user.id, restaurantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── P&L ─────────────────────────────────────────────────────

router.get('/pnl', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const restaurantId = rid(req);
  try {
    const [rev, exp, byCat] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total_amount),0) as total FROM orders WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3`, [restaurantId, fromDate, toDate]),
      db.query(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE restaurant_id=$1 AND expense_date BETWEEN $2 AND $3`, [restaurantId, fromDate, toDate]),
      db.query(`SELECT category, COALESCE(SUM(amount),0) as revenue FROM expenses WHERE restaurant_id=$1 AND expense_date BETWEEN $2 AND $3 GROUP BY category ORDER BY revenue DESC`, [restaurantId, fromDate, toDate]),
    ]);
    const revenue  = parseFloat(rev.rows[0].total);
    const expenses = parseFloat(exp.rows[0].total);
    res.json({
      revenue, expenses,
      profit: revenue - expenses,
      margin: revenue > 0 ? (((revenue - expenses) / revenue) * 100).toFixed(2) : '0.00',
      by_category: byCat.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SALES SUMMARY ───────────────────────────────────────────

router.get('/sales', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const restaurantId = rid(req);

  // Calculate previous period of same length for comparison
  const fromD = new Date(fromDate);
  const toD   = new Date(toDate);
  const days  = Math.round((toD - fromD) / (1000 * 60 * 60 * 24)) + 1;
  const prevToD   = new Date(fromD);
  prevToD.setDate(prevToD.getDate() - 1);
  const prevFromD = new Date(prevToD);
  prevFromD.setDate(prevFromD.getDate() - days + 1);
  const prevFrom = prevFromD.toISOString().split('T')[0];
  const prevTo   = prevToD.toISOString().split('T')[0];

  try {
    // Run ALL analytics queries in parallel for speed
    const [summaryRes, prevRes, dailyRes, hourlyRes, typeRes] = await Promise.all([
      // 1) Main summary
      db.query(
        `SELECT
           COUNT(*)::int                                      AS total_orders,
           COALESCE(SUM(total_amount), 0)                     AS total_revenue,
           COALESCE(AVG(total_amount), 0)                     AS avg_order_value,
           COALESCE(SUM(total_amount) FILTER (WHERE payment_method='cash'),   0) AS cash_revenue,
           COALESCE(SUM(total_amount) FILTER (WHERE payment_method='card'),   0) AS card_revenue,
           COALESCE(SUM(total_amount) FILTER (WHERE payment_method='online'), 0) AS online_revenue
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3`,
        [restaurantId, fromDate, toDate]
      ),
      // 2) Previous period summary (for comparison)
      db.query(
        `SELECT
           COUNT(*)::int                    AS total_orders,
           COALESCE(SUM(total_amount), 0)   AS total_revenue,
           COALESCE(AVG(total_amount), 0)   AS avg_order_value
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3`,
        [restaurantId, prevFrom, prevTo]
      ),
      // 3) Daily trend
      db.query(
        `SELECT
           paid_at::date AS date,
           COUNT(*)::int AS orders,
           COALESCE(SUM(total_amount), 0) AS revenue
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
         GROUP BY paid_at::date
         ORDER BY date`,
        [restaurantId, fromDate, toDate]
      ),
      // 4) Hourly breakdown
      db.query(
        `SELECT
           EXTRACT(HOUR FROM paid_at)::int AS hour,
           COUNT(*)::int AS orders,
           COALESCE(SUM(total_amount), 0) AS revenue
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
         GROUP BY EXTRACT(HOUR FROM paid_at)
         ORDER BY hour`,
        [restaurantId, fromDate, toDate]
      ),
      // 5) Order type breakdown
      db.query(
        `SELECT
           COALESCE(order_type, 'dine_in') AS order_type,
           COUNT(*)::int AS orders,
           COALESCE(SUM(total_amount), 0) AS revenue
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
         GROUP BY COALESCE(order_type, 'dine_in')
         ORDER BY revenue DESC`,
        [restaurantId, fromDate, toDate]
      ),
    ]);

    const row  = summaryRes.rows[0];
    const prev = prevRes.rows[0];

    // Fill all 24 hours
    const hourMap = {};
    hourlyRes.rows.forEach(r => { hourMap[r.hour] = r; });
    const hourly = [];
    for (let h = 0; h < 24; h++) {
      hourly.push({
        hour: h,
        label: String(h).padStart(2, '0') + ':00',
        orders: hourMap[h] ? parseInt(hourMap[h].orders) : 0,
        revenue: hourMap[h] ? parseFloat(hourMap[h].revenue) : 0,
      });
    }

    // Comparison percentages
    const pctChange = (c, p) => {
      const cv = parseFloat(c) || 0;
      const pv = parseFloat(p) || 0;
      if (pv === 0) return cv > 0 ? 100 : 0;
      return parseFloat(((cv - pv) / pv * 100).toFixed(1));
    };

    res.json({
      total_orders:     parseInt(row.total_orders),
      total_revenue:    parseFloat(row.total_revenue),
      avg_order_value:  parseFloat(row.avg_order_value),
      cash_revenue:     parseFloat(row.cash_revenue),
      card_revenue:     parseFloat(row.card_revenue),
      online_revenue:   parseFloat(row.online_revenue),
      // Analytics
      daily_trend: dailyRes.rows.map(r => ({
        date: r.date, orders: parseInt(r.orders), revenue: parseFloat(r.revenue),
      })),
      hourly: hourly,
      by_type: typeRes.rows.map(r => ({
        order_type: r.order_type, orders: parseInt(r.orders), revenue: parseFloat(r.revenue),
      })),
      comparison: {
        previous: {
          total_orders:    parseInt(prev.total_orders),
          total_revenue:   parseFloat(prev.total_revenue),
          avg_order_value: parseFloat(prev.avg_order_value),
          period: { from: prevFrom, to: prevTo },
        },
        changes: {
          revenue_pct:   pctChange(row.total_revenue,   prev.total_revenue),
          orders_pct:    pctChange(row.total_orders,     prev.total_orders),
          avg_order_pct: pctChange(row.avg_order_value,  prev.avg_order_value),
        },
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CASH FLOW — support both /cashflow and /cash-flow ───────

async function getCashFlow(req, res) {
  const restaurantId = rid(req);
  try {
    const [entries, totals] = await Promise.all([
      db.query(`SELECT cf.*, u.name as recorded_by_name FROM cash_flow cf
                LEFT JOIN users u ON cf.recorded_by=u.id WHERE cf.restaurant_id=$1 ORDER BY cf.created_at DESC LIMIT 100`, [restaurantId]),
      db.query(`SELECT
                  COALESCE(SUM(amount) FILTER (WHERE type='in'),  0) AS cash_in,
                  COALESCE(SUM(amount) FILTER (WHERE type='out'), 0) AS cash_out
                FROM cash_flow WHERE restaurant_id=$1 AND DATE(created_at)=CURRENT_DATE`, [restaurantId]),
    ]);
    const t = totals.rows[0];
    res.json({
      entries:  entries.rows,
      cash_in:  parseFloat(t.cash_in),
      cash_out: parseFloat(t.cash_out),
      closing:  parseFloat(t.cash_in) - parseFloat(t.cash_out),
      opening:  0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
router.get('/cashflow',   authenticate, authorize('owner', 'admin'), getCashFlow);
router.get('/cash-flow',  authenticate, authorize('owner', 'admin'), getCashFlow);

router.post('/cashflow', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { type, amount, description } = req.body;
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      'INSERT INTO cash_flow (type,amount,description,recorded_by,restaurant_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [type, amount, description, req.user.id, restaurantId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TAX SETTINGS — support /tax and /tax-settings ───────────

async function getTaxSettings(req, res) {
  const restaurantId = rid(req);
  try {
    const result = await db.query('SELECT * FROM tax_settings WHERE restaurant_id=$1 ORDER BY created_at DESC LIMIT 1', [restaurantId]);
    const row = result.rows[0];
    if (!row) return res.json({ tax_rate: 0, tax_name: 'VAT', tax_enabled: false, tax_inclusive: false });
    res.json({
      id:           row.id,
      tax_name:     row.name,
      tax_rate:     parseFloat(row.rate),
      tax_enabled:  row.is_active,
      tax_inclusive: false,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
router.get('/tax',          authenticate, getTaxSettings);
router.get('/tax-settings', authenticate, getTaxSettings);

async function updateTaxSettings(req, res) {
  const { tax_name, tax_rate, tax_enabled, name, rate } = req.body;
  const restaurantId = rid(req);
  const finalName = tax_name || name || 'VAT';
  const finalRate = parseFloat(tax_rate ?? rate ?? 0);
  const finalEnabled = tax_enabled !== undefined ? tax_enabled : true;
  try {
    const existing = await db.query('SELECT id FROM tax_settings WHERE restaurant_id=$1 LIMIT 1', [restaurantId]);
    let result;
    if (existing.rows[0]) {
      result = await db.query(
        'UPDATE tax_settings SET name=$1, rate=$2, is_active=$3 WHERE id=$4 RETURNING *',
        [finalName, finalRate, finalEnabled, existing.rows[0].id]
      );
    } else {
      result = await db.query(
        'INSERT INTO tax_settings (name, rate, is_active, restaurant_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [finalName, finalRate, finalEnabled, restaurantId]
      );
    }
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
}
router.post('/tax',          authenticate, authorize('owner', 'admin'), updateTaxSettings);
router.put('/tax',           authenticate, authorize('owner', 'admin'), updateTaxSettings);
router.put('/tax-settings',  authenticate, authorize('owner', 'admin'), updateTaxSettings);

// ─── RESTAURANT SETTINGS ──────────────────────────────────────────────────────
// Auto-create table on first use
const ensureRestaurantSettings = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS restaurant_settings (
      id                      SERIAL PRIMARY KEY,
      restaurant_id           UUID NOT NULL,
      restaurant_name         TEXT    DEFAULT 'The Bill Restaurant',
      receipt_header          TEXT    DEFAULT 'Thank you for dining with us!',
      service_charge_rate     NUMERIC DEFAULT 0,
      service_charge_enabled  BOOLEAN DEFAULT false,
      updated_at              TIMESTAMP DEFAULT NOW()
    )
  `);
};
ensureRestaurantSettings().catch(() => {});

router.get('/restaurant-settings', authenticate, async (req, res) => {
  const restaurantId = rid(req);
  try {
    await ensureRestaurantSettings();
    const result = await db.query('SELECT * FROM restaurant_settings WHERE restaurant_id=$1 LIMIT 1', [restaurantId]);
    const row = result.rows[0];
    if (!row) {
      return res.json({
        restaurant_name:             'The Bill Restaurant',
        receipt_header:              'Thank you for dining with us!',
        receipt_footer:              '',
        service_charge_rate:         0,
        service_charge_enabled:      false,
        receipt_show_logo:           true,
        receipt_show_order_number:   true,
        receipt_show_table_name:     true,
        receipt_show_tax:            true,
        receipt_show_service_charge: true,
        receipt_show_footer:         true,
      });
    }
    // Return every receipt-related field so PayModal can use the show flags
    res.json({
      restaurant_name:             row.restaurant_name,
      receipt_header:              row.receipt_header,
      receipt_footer:              row.receipt_footer,
      service_charge_rate:         row.service_charge_rate         ?? 0,
      service_charge_enabled:      row.service_charge_enabled      ?? false,
      receipt_show_logo:           row.receipt_show_logo           ?? true,
      receipt_show_order_number:   row.receipt_show_order_number   ?? true,
      receipt_show_table_name:     row.receipt_show_table_name     ?? true,
      receipt_show_tax:            row.receipt_show_tax            ?? true,
      receipt_show_service_charge: row.receipt_show_service_charge ?? true,
      receipt_show_footer:         row.receipt_show_footer         ?? true,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/restaurant-settings', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { restaurant_name, receipt_header, service_charge_rate, service_charge_enabled } = req.body;
  const restaurantId = rid(req);
  try {
    await ensureRestaurantSettings();
    const existing = await db.query('SELECT id FROM restaurant_settings WHERE restaurant_id=$1 LIMIT 1', [restaurantId]);
    let result;
    if (existing.rows[0]) {
      result = await db.query(
        `UPDATE restaurant_settings
         SET restaurant_name=$1, receipt_header=$2, service_charge_rate=$3, service_charge_enabled=$4, updated_at=NOW()
         WHERE id=$5
         RETURNING *`,
        [restaurant_name, receipt_header, service_charge_rate ?? 0, service_charge_enabled ?? false, existing.rows[0].id]
      );
    } else {
      result = await db.query(
        `INSERT INTO restaurant_settings (restaurant_id, restaurant_name, receipt_header, service_charge_rate, service_charge_enabled)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [restaurantId, restaurant_name, receipt_header, service_charge_rate ?? 0, service_charge_enabled ?? false]
      );
    }
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SALES ANALYTICS: Daily Trend ───────────────────────────
router.get('/sales/daily-trend', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT
         paid_at::date AS date,
         COUNT(*)::int AS orders,
         COALESCE(SUM(total_amount), 0) AS revenue
       FROM orders
       WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
       GROUP BY paid_at::date
       ORDER BY date`,
      [restaurantId, fromDate, toDate]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SALES ANALYTICS: Hourly Breakdown ──────────────────────
router.get('/sales/hourly', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || new Date().toISOString().split('T')[0];
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT
         EXTRACT(HOUR FROM paid_at)::int AS hour,
         COUNT(*)::int AS orders,
         COALESCE(SUM(total_amount), 0) AS revenue
       FROM orders
       WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
       GROUP BY EXTRACT(HOUR FROM paid_at)
       ORDER BY hour`,
      [restaurantId, fromDate, toDate]
    );
    // Fill all 24 hours
    const map = {};
    result.rows.forEach(r => { map[r.hour] = r; });
    const hours = [];
    for (let h = 0; h < 24; h++) {
      hours.push({
        hour: h,
        label: String(h).padStart(2, '0') + ':00',
        orders: map[h] ? parseInt(map[h].orders) : 0,
        revenue: map[h] ? parseFloat(map[h].revenue) : 0,
      });
    }
    res.json(hours);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SALES ANALYTICS: Order Type Breakdown ──────────────────
router.get('/sales/by-type', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      `SELECT
         COALESCE(order_type, 'dine_in') AS order_type,
         COUNT(*)::int AS orders,
         COALESCE(SUM(total_amount), 0) AS revenue
       FROM orders
       WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3
       GROUP BY COALESCE(order_type, 'dine_in')
       ORDER BY revenue DESC`,
      [restaurantId, fromDate, toDate]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SALES ANALYTICS: Comparison (current vs previous period) ─
router.get('/sales/comparison', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const fromDate = req.query.from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
  const toDate   = req.query.to   || new Date().toISOString().split('T')[0];
  const restaurantId = rid(req);

  // Calculate previous period of same length
  const from = new Date(fromDate);
  const to   = new Date(toDate);
  const days = Math.round((to - from) / (1000 * 60 * 60 * 24)) + 1;
  const prevTo   = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - days + 1);
  const prevFromStr = prevFrom.toISOString().split('T')[0];
  const prevToStr   = prevTo.toISOString().split('T')[0];

  try {
    const [current, previous] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int AS total_orders,
           COALESCE(SUM(total_amount), 0) AS total_revenue,
           COALESCE(AVG(total_amount), 0) AS avg_order_value
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3`,
        [restaurantId, fromDate, toDate]
      ),
      db.query(
        `SELECT
           COUNT(*)::int AS total_orders,
           COALESCE(SUM(total_amount), 0) AS total_revenue,
           COALESCE(AVG(total_amount), 0) AS avg_order_value
         FROM orders
         WHERE restaurant_id=$1 AND status='paid' AND paid_at::date BETWEEN $2 AND $3`,
        [restaurantId, prevFromStr, prevToStr]
      ),
    ]);

    const cur  = current.rows[0];
    const prev = previous.rows[0];

    const pctChange = (c, p) => {
      const cv = parseFloat(c) || 0;
      const pv = parseFloat(p) || 0;
      if (pv === 0) return cv > 0 ? 100 : 0;
      return ((cv - pv) / pv * 100);
    };

    res.json({
      current: {
        total_orders:    parseInt(cur.total_orders),
        total_revenue:   parseFloat(cur.total_revenue),
        avg_order_value: parseFloat(cur.avg_order_value),
        period: { from: fromDate, to: toDate },
      },
      previous: {
        total_orders:    parseInt(prev.total_orders),
        total_revenue:   parseFloat(prev.total_revenue),
        avg_order_value: parseFloat(prev.avg_order_value),
        period: { from: prevFromStr, to: prevToStr },
      },
      changes: {
        revenue_pct:     parseFloat(pctChange(cur.total_revenue,   prev.total_revenue).toFixed(1)),
        orders_pct:      parseFloat(pctChange(cur.total_orders,    prev.total_orders).toFixed(1)),
        avg_order_pct:   parseFloat(pctChange(cur.avg_order_value, prev.avg_order_value).toFixed(1)),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
