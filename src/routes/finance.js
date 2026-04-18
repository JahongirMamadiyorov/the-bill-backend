const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// All finance routes require authentication
router.use(authenticate);

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/finance/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/summary', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });

  const restaurantId = rid(req);
  try {
    // ── Calculate previous period (same length, immediately before start) ──
    const startD = new Date(start + 'T00:00:00');
    const endD   = new Date(end + 'T00:00:00');
    const days   = Math.round((endD - startD) / 86400000) + 1;
    const prevEndD = new Date(startD);
    prevEndD.setDate(prevEndD.getDate() - 1);
    const prevStartD = new Date(prevEndD);
    prevStartD.setDate(prevStartD.getDate() - days + 1);
    const prevStart = prevStartD.toISOString().split('T')[0];
    const prevEnd   = prevEndD.toISOString().split('T')[0];

    // ── Revenue from orders (current period) ──
    const revQ = await db.query(`
      SELECT
        COALESCE(SUM(total_amount), 0)                                         AS total_revenue,
        COALESCE(SUM(total_amount) FILTER (WHERE payment_method IN ('cash','Cash')), 0)          AS rev_cash,
        COALESCE(SUM(total_amount) FILTER (WHERE payment_method IN ('card','Card')), 0)          AS rev_card,
        COALESCE(SUM(total_amount) FILTER (WHERE payment_method IN ('online','qr_code','QR Code')), 0) AS rev_qr,
        COALESCE(SUM(total_amount) FILTER (WHERE order_type = 'dine_in'), 0)   AS rev_dine_in,
        COALESCE(SUM(total_amount) FILTER (WHERE order_type = 'takeaway'), 0)  AS rev_takeaway,
        COALESCE(SUM(total_amount) FILTER (WHERE order_type = 'delivery'), 0)  AS rev_delivery,
        COALESCE(SUM(total_amount) FILTER (WHERE EXTRACT(HOUR FROM created_at) >= 6  AND EXTRACT(HOUR FROM created_at) < 12), 0) AS rev_morning,
        COALESCE(SUM(total_amount) FILTER (WHERE EXTRACT(HOUR FROM created_at) >= 12 AND EXTRACT(HOUR FROM created_at) < 17), 0) AS rev_afternoon,
        COALESCE(SUM(total_amount) FILTER (WHERE EXTRACT(HOUR FROM created_at) >= 17 OR  EXTRACT(HOUR FROM created_at) < 6),  0) AS rev_evening
      FROM orders
      WHERE restaurant_id = $3 AND status = 'paid'
        AND DATE(paid_at) >= $1::date AND DATE(paid_at) <= $2::date
    `, [start, end, restaurantId]);

    // ── Revenue by day of week ──
    const dowQ = await db.query(`
      SELECT
        EXTRACT(ISODOW FROM paid_at)::int AS dow,
        COALESCE(SUM(total_amount), 0)    AS total,
        COUNT(*)                          AS cnt
      FROM orders
      WHERE restaurant_id = $3 AND status = 'paid'
        AND DATE(paid_at) >= $1::date AND DATE(paid_at) <= $2::date
      GROUP BY dow ORDER BY dow
    `, [start, end, restaurantId]);

    // ── Daily cash flow (revenue per day + expenses per day) ──
    const dailyRevQ = await db.query(`
      SELECT DATE(paid_at) AS day, COALESCE(SUM(total_amount), 0) AS cash_in
      FROM orders
      WHERE restaurant_id = $3 AND status = 'paid'
        AND DATE(paid_at) >= $1::date AND DATE(paid_at) <= $2::date
      GROUP BY day ORDER BY day
    `, [start, end, restaurantId]);

    const dailyExpQ = await db.query(`
      SELECT date AS day, COALESCE(SUM(amount), 0) AS cash_out
      FROM finance_expenses
      WHERE restaurant_id = $1
        AND date >= $2::date AND date <= $3::date
      GROUP BY day ORDER BY day
    `, [restaurantId, start, end]);

    const dailyManualQ = await db.query(`
      SELECT date AS day, COALESCE(SUM(amount), 0) AS income
      FROM finance_manual_income
      WHERE restaurant_id = $1
        AND date >= $2::date AND date <= $3::date
      GROUP BY day ORDER BY day
    `, [restaurantId, start, end]);

    // Build daily cash flow array
    const expMap = {};
    dailyExpQ.rows.forEach(r => { expMap[r.day] = parseFloat(r.cash_out); });
    const incMap = {};
    dailyManualQ.rows.forEach(r => { incMap[r.day] = parseFloat(r.income); });

    let runBal = 0;
    const dailyCashFlow = dailyRevQ.rows.map(r => {
      const day   = r.day;
      const ci    = parseFloat(r.cash_in) + (incMap[day] || 0);
      const co    = expMap[day] || 0;
      runBal += ci - co;
      return { date: day, cash_in: ci, cash_out: co, net: ci - co, balance: runBal };
    });

    // ── Total expenses (current period) ──
    const expQ = await db.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_expenses
      FROM finance_expenses
      WHERE restaurant_id = $1
        AND date >= $2::date AND date <= $3::date
    `, [restaurantId, start, end]);

    // ── Previous period revenue & expenses ──
    const prevRevQ = await db.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS total_revenue
      FROM orders
      WHERE restaurant_id = $3 AND status = 'paid'
        AND DATE(paid_at) >= $1::date AND DATE(paid_at) <= $2::date
    `, [prevStart, prevEnd, restaurantId]);

    const prevExpQ = await db.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_expenses
      FROM finance_expenses
      WHERE restaurant_id = $1
        AND date >= $2::date AND date <= $3::date
    `, [restaurantId, prevStart, prevEnd]);

    // ── Expense breakdown by category ──
    const expCatQ = await db.query(`
      SELECT category, COALESCE(SUM(amount), 0) AS total
      FROM finance_expenses
      WHERE restaurant_id = $1
        AND date >= $2::date AND date <= $3::date
      GROUP BY category ORDER BY total DESC
    `, [restaurantId, start, end]);

    // ── Payroll summary per role ──
    const payrollQ = await db.query(`
      SELECT u.role, COUNT(DISTINCT u.id) AS staff_count,
        COALESCE(SUM(sp.amount), 0) AS total_cost
      FROM staff_payments sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.payment_date >= $1::date AND sp.payment_date <= $2::date
      GROUP BY u.role ORDER BY total_cost DESC
    `, [start, end]);

    // ── Assemble response ──
    const rev  = revQ.rows[0];
    const totalRev  = parseFloat(rev.total_revenue);
    const totalExp  = parseFloat(expQ.rows[0].total_expenses);
    const net       = totalRev - totalExp;
    const margin    = totalRev > 0 ? (net / totalRev * 100) : 0;

    const prevRev = parseFloat(prevRevQ.rows[0].total_revenue);
    const prevExp = parseFloat(prevExpQ.rows[0].total_expenses);
    const prevNet = prevRev - prevExp;
    const prevMargin = prevRev > 0 ? (prevNet / prevRev * 100) : 0;

    const TAX_RATE = 0.12;
    const SVC_RATE = 0.05;

    // day-of-week map (1=Mon .. 7=Sun)
    const DOW_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const revenueByDow = {};
    DOW_NAMES.forEach(d => { revenueByDow[d] = { total: 0, count: 0 }; });
    dowQ.rows.forEach(r => {
      const name = DOW_NAMES[r.dow - 1];
      if (name) { revenueByDow[name] = { total: parseFloat(r.total), count: parseInt(r.cnt) }; }
    });

    res.json({
      period: { start, end, days },
      current: {
        total_revenue: totalRev,
        total_expenses: totalExp,
        net_profit: net,
        profit_margin: Math.round(margin * 10) / 10,
      },
      previous: {
        start: prevStart,
        end: prevEnd,
        total_revenue: prevRev,
        total_expenses: prevExp,
        net_profit: prevNet,
        profit_margin: Math.round(prevMargin * 10) / 10,
      },
      revenue_by_payment: {
        cash:   parseFloat(rev.rev_cash),
        card:   parseFloat(rev.rev_card),
        qr:     parseFloat(rev.rev_qr),
      },
      revenue_by_order_type: {
        dine_in:  parseFloat(rev.rev_dine_in),
        takeaway: parseFloat(rev.rev_takeaway),
        delivery: parseFloat(rev.rev_delivery),
      },
      revenue_by_time: {
        morning:   parseFloat(rev.rev_morning),
        afternoon: parseFloat(rev.rev_afternoon),
        evening:   parseFloat(rev.rev_evening),
      },
      revenue_by_dow: revenueByDow,
      expense_by_category: expCatQ.rows.map(r => ({ category: r.category, total: parseFloat(r.total) })),
      daily_cash_flow: dailyCashFlow,
      payroll: payrollQ.rows.map(r => ({ role: r.role, staff_count: parseInt(r.staff_count), total_cost: parseFloat(r.total_cost) })),
      tax: {
        rate: TAX_RATE,
        tax_collected: Math.round(totalRev * TAX_RATE * 100) / 100,
        service_charge_rate: SVC_RATE,
        service_charge: Math.round(totalRev * SVC_RATE * 100) / 100,
      },
    });
  } catch (err) {
    console.error('GET /finance/summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPENSES  CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/finance/expenses?start=&end=
router.get('/expenses', async (req, res) => {
  const { start, end } = req.query;
  const restaurantId = rid(req);
  try {
    let q = `SELECT * FROM finance_expenses WHERE restaurant_id = $1`;
    const p = [restaurantId];
    if (start) { p.push(start); q += ` AND date >= $${p.length}::date`; }
    if (end)   { p.push(end);   q += ` AND date <= $${p.length}::date`; }
    q += ' ORDER BY date DESC, created_at DESC';
    const result = await db.query(q, p);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /finance/expenses error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finance/expenses
router.post('/expenses', async (req, res) => {
  const { category, amount, date, description, recurring, frequency } = req.body;
  if (!category || amount == null) return res.status(400).json({ error: 'category and amount required' });
  const restaurantId = rid(req);
  try {
    const result = await db.query(`
      INSERT INTO finance_expenses (restaurant_id, category, amount, date, description, recurring, frequency)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [restaurantId, category, amount, date || new Date().toISOString().split('T')[0], description || null, recurring || false, frequency || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /finance/expenses error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/finance/expenses/:id
router.put('/expenses/:id', async (req, res) => {
  const { id } = req.params;
  const { category, amount, date, description, recurring, frequency } = req.body;
  const restaurantId = rid(req);
  try {
    const cur = await db.query('SELECT * FROM finance_expenses WHERE id=$1 AND restaurant_id=$2', [id, restaurantId]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Expense not found' });
    const c = cur.rows[0];

    const result = await db.query(`
      UPDATE finance_expenses
      SET category=$1, amount=$2, date=$3, description=$4, recurring=$5, frequency=$6
      WHERE id=$7 AND restaurant_id=$8 RETURNING *
    `, [
      category    !== undefined ? category    : c.category,
      amount      !== undefined ? amount      : c.amount,
      date        !== undefined ? date        : c.date,
      description !== undefined ? description : c.description,
      recurring   !== undefined ? recurring   : c.recurring,
      frequency   !== undefined ? frequency   : c.frequency,
      id, restaurantId,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /finance/expenses/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/finance/expenses/:id
router.delete('/expenses/:id', async (req, res) => {
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      'DELETE FROM finance_expenses WHERE id=$1 AND restaurant_id=$2 RETURNING id',
      [req.params.id, restaurantId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted', id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /finance/expenses/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOANS  CRUD
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/finance/loans
router.get('/loans', async (req, res) => {
  const restaurantId = rid(req);
  try {
    const loansRes = await db.query(`
      SELECT * FROM finance_loans WHERE restaurant_id = $1 ORDER BY created_at DESC
    `, [restaurantId]);

    // Attach payments to each loan
    const loans = [];
    for (const loan of loansRes.rows) {
      const payRes = await db.query(
        'SELECT * FROM finance_loan_payments WHERE loan_id=$1 ORDER BY payment_date DESC',
        [loan.id]
      );
      loans.push({ ...loan, payments: payRes.rows });
    }
    res.json(loans);
  } catch (err) {
    console.error('GET /finance/loans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finance/loans
router.post('/loans', async (req, res) => {
  const { lender_name, total_amount, amount_paid, interest_rate, due_date, notes } = req.body;
  if (!lender_name || !total_amount) return res.status(400).json({ error: 'lender_name and total_amount required' });
  const restaurantId = rid(req);
  try {
    const result = await db.query(`
      INSERT INTO finance_loans (restaurant_id, lender_name, total_amount, amount_paid, interest_rate, due_date, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [
      restaurantId, lender_name, total_amount,
      amount_paid || 0, interest_rate || 0,
      due_date || null, notes || null,
      (amount_paid || 0) >= total_amount ? 'paid' : 'active',
    ]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /finance/loans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/finance/loans/:id
router.put('/loans/:id', async (req, res) => {
  const { id } = req.params;
  const { lender_name, total_amount, amount_paid, interest_rate, due_date, notes, status } = req.body;
  const restaurantId = rid(req);
  try {
    const cur = await db.query('SELECT * FROM finance_loans WHERE id=$1 AND restaurant_id=$2', [id, restaurantId]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Loan not found' });
    const c = cur.rows[0];

    const newPaid  = amount_paid  !== undefined ? amount_paid  : c.amount_paid;
    const newTotal = total_amount !== undefined ? total_amount : c.total_amount;
    const newStatus = newPaid >= newTotal ? 'paid' : (status || c.status);

    const result = await db.query(`
      UPDATE finance_loans
      SET lender_name=$1, total_amount=$2, amount_paid=$3, interest_rate=$4,
          due_date=$5, notes=$6, status=$7
      WHERE id=$8 AND restaurant_id=$9 RETURNING *
    `, [
      lender_name   !== undefined ? lender_name   : c.lender_name,
      newTotal, newPaid,
      interest_rate !== undefined ? interest_rate : c.interest_rate,
      due_date      !== undefined ? due_date      : c.due_date,
      notes         !== undefined ? notes         : c.notes,
      newStatus, id, restaurantId,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /finance/loans/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/finance/loans/:id
router.delete('/loans/:id', async (req, res) => {
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      'DELETE FROM finance_loans WHERE id=$1 AND restaurant_id=$2 RETURNING id',
      [req.params.id, restaurantId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Loan not found' });
    res.json({ message: 'Loan deleted', id: result.rows[0].id });
  } catch (err) {
    console.error('DELETE /finance/loans/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finance/loans/:id/payment
router.post('/loans/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { amount, payment_date, method } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required and must be > 0' });
  const restaurantId = rid(req);
  try {
    // Verify loan belongs to this restaurant
    const loan = await db.query('SELECT * FROM finance_loans WHERE id=$1 AND restaurant_id=$2', [id, restaurantId]);
    if (!loan.rows[0]) return res.status(404).json({ error: 'Loan not found' });

    // Insert payment record
    const payRes = await db.query(`
      INSERT INTO finance_loan_payments (loan_id, amount, payment_date, method)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [id, amount, payment_date || new Date().toISOString().split('T')[0], method || 'cash']);

    // Update loan amount_paid and auto-set status
    const newPaid = parseFloat(loan.rows[0].amount_paid) + parseFloat(amount);
    const newStatus = newPaid >= parseFloat(loan.rows[0].total_amount) ? 'paid' : loan.rows[0].status;

    const updated = await db.query(`
      UPDATE finance_loans SET amount_paid=$1, status=$2 WHERE id=$3 RETURNING *
    `, [newPaid, newStatus, id]);

    res.status(201).json({ payment: payRes.rows[0], loan: updated.rows[0] });
  } catch (err) {
    console.error('POST /finance/loans/:id/payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGETS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/finance/budgets
router.get('/budgets', async (req, res) => {
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      'SELECT * FROM finance_budgets WHERE restaurant_id=$1 ORDER BY category',
      [restaurantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /finance/budgets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finance/budgets  — upsert (insert or update)
// Body: { budgets: { Rent: 3500000, Utilities: 800000, ... } }
router.post('/budgets', async (req, res) => {
  const { budgets } = req.body;
  if (!budgets || typeof budgets !== 'object') return res.status(400).json({ error: 'budgets object required' });
  const restaurantId = rid(req);
  try {
    const results = [];
    for (const [category, monthly_budget] of Object.entries(budgets)) {
      const r = await db.query(`
        INSERT INTO finance_budgets (restaurant_id, category, monthly_budget, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (restaurant_id, category)
        DO UPDATE SET monthly_budget = EXCLUDED.monthly_budget, updated_at = NOW()
        RETURNING *
      `, [restaurantId, category, monthly_budget]);
      results.push(r.rows[0]);
    }
    res.json(results);
  } catch (err) {
    console.error('POST /finance/budgets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL INCOME
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/finance/manual-income
router.post('/manual-income', async (req, res) => {
  const { amount, category, date, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required and must be > 0' });
  const restaurantId = rid(req);
  try {
    const result = await db.query(`
      INSERT INTO finance_manual_income (restaurant_id, amount, category, date, note)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [restaurantId, amount, category || 'Sales', date || new Date().toISOString().split('T')[0], note || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /finance/manual-income error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TAX HISTORY — last 6 months from orders
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/finance/tax-history
router.get('/tax-history', async (req, res) => {
  const TAX_RATE = 0.12;
  const restaurantId = rid(req);
  try {
    const result = await db.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', paid_at), 'YYYY-MM') AS month,
        TO_CHAR(DATE_TRUNC('month', paid_at), 'Month YYYY') AS month_label,
        COALESCE(SUM(total_amount), 0) AS revenue,
        COALESCE(SUM(total_amount), 0) * $1 AS tax_collected
      FROM orders
      WHERE restaurant_id = $2 AND status = 'paid'
        AND paid_at >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
      GROUP BY DATE_TRUNC('month', paid_at)
      ORDER BY DATE_TRUNC('month', paid_at) DESC
    `, [TAX_RATE, restaurantId]);

    res.json(result.rows.map(r => ({
      month:         r.month,
      month_label:   r.month_label.trim(),
      revenue:       parseFloat(r.revenue),
      tax_collected: Math.round(parseFloat(r.tax_collected) * 100) / 100,
    })));
  } catch (err) {
    console.error('GET /finance/tax-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
