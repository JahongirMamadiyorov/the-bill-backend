const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ── Auto-migration: loans table ────────────────────────────────────────────────
;(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        order_id       UUID REFERENCES orders(id) ON DELETE SET NULL,
        customer_name  TEXT NOT NULL,
        customer_phone TEXT,
        due_date       DATE NOT NULL,
        amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'paid')),
        paid_at        TIMESTAMPTZ,
        payment_method TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add missing columns to existing tables (safe — IF NOT EXISTS)
    await db.query(`ALTER TABLE loans ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE`);
    await db.query(`ALTER TABLE loans ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE loans ADD COLUMN IF NOT EXISTS payment_method TEXT`);
    await db.query(`ALTER TABLE loans ADD COLUMN IF NOT EXISTS notes TEXT`);
  } catch (err) {
    console.warn('Loans table migration warning:', err.message);
  }
})();

// GET /api/loans  — optional ?status=active|paid  &from=YYYY-MM-DD  &to=YYYY-MM-DD
router.get('/', authenticate, async (req, res) => {
  try {
    let query = `
      SELECT
        l.*,
        o.daily_number,
        t.name AS table_name,
        o.order_type,
        o.customer_name AS order_customer_name
      FROM loans l
      LEFT JOIN orders            o ON l.order_id  = o.id
      LEFT JOIN restaurant_tables t ON o.table_id  = t.id
      WHERE l.restaurant_id = $1
    `;
    const params = [rid(req)];
    if (req.query.status) {
      params.push(req.query.status);
      query += ` AND l.status = $${params.length}`;
    }
    if (req.query.from) {
      params.push(req.query.from);
      query += ` AND DATE(l.created_at) >= $${params.length}::date`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      query += ` AND DATE(l.created_at) <= $${params.length}::date`;
    }
    query += ' ORDER BY l.created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/loans/stats  — overall summary counts + totals for current restaurant
router.get('/stats', authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')                             AS active_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'active'),  0)            AS active_total,
        COUNT(*) FILTER (WHERE status = 'paid')                               AS paid_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'),    0)            AS paid_total,
        COUNT(*) FILTER (WHERE status = 'active' AND due_date < CURRENT_DATE) AS overdue_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'active' AND due_date < CURRENT_DATE), 0) AS overdue_total
      FROM loans
      WHERE restaurant_id = $1
    `, [rid(req)]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/loans/notify-overdue  — send overdue notifications to all admins/owners
router.post('/notify-overdue', authenticate, async (req, res) => {
  try {
    const restaurantId = rid(req);

    // Find all currently overdue active loans for this restaurant
    const overdueRes = await db.query(`
      SELECT l.*, o.daily_number
      FROM loans l
      LEFT JOIN orders o ON l.order_id = o.id
      WHERE l.restaurant_id = $1 AND l.status = 'active' AND l.due_date < CURRENT_DATE
      ORDER BY l.due_date ASC
    `, [restaurantId]);
    const overdue = overdueRes.rows;

    if (overdue.length === 0) {
      return res.json({ notified: 0, overdueCount: 0, message: 'No overdue loans' });
    }

    // Find all admin and owner users to notify
    const adminRes = await db.query(
      `SELECT id FROM users WHERE role IN ('admin', 'owner') AND is_active IS NOT FALSE`
    );
    const admins = adminRes.rows;

    if (admins.length === 0) {
      return res.json({ notified: 0, overdueCount: overdue.length, message: 'No admin users found' });
    }

    const totalAmt = overdue.reduce((s, l) => s + parseFloat(l.amount || 0), 0);
    const count    = overdue.length;
    const title    = `${count} overdue loan${count > 1 ? 's' : ''} require attention`;
    const body     = `${count} loan${count > 1 ? 's are' : ' is'} past due date. ` +
                     `Total outstanding: ${Math.round(totalAmt).toLocaleString()} so'm. ` +
                     `Notified by cashier ${req.user.name || req.user.id}.`;

    // Insert a notification for each admin/owner
    for (const admin of admins) {
      try {
        await db.query(
          `INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1, $2, $3, $4, $5)`,
          [admin.id, title, body, 'loan_overdue', restaurantId]
        );
      } catch (_) { /* notifications table may not exist — skip gracefully */ }
    }

    res.json({ notified: admins.length, overdueCount: count, totalAmount: totalAmt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/loans/:id/pay  — mark a loan as paid
router.patch('/:id/pay', authenticate, async (req, res) => {
  const { payment_method } = req.body;
  try {
    const result = await db.query(
      `UPDATE loans
         SET status='paid', paid_at=NOW(), updated_at=NOW(),
             payment_method=COALESCE($2, payment_method)
       WHERE id=$1 AND restaurant_id=$3
       RETURNING *`,
      [req.params.id, payment_method || null, rid(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Loan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
