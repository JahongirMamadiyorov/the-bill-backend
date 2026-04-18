const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('super_admin'));

// Plan durations in days
const PLAN_DURATIONS = {
  trial:   30,
  monthly: 30,
  '6month':  180,
  '12month': 365,
  vip:     null,   // never expires
};

const PLAN_PRICES = {
  trial:   { monthly: 0,  total: 0   },
  monthly: { monthly: 41, total: 41  },
  '6month':  { monthly: 36, total: 216 },
  '12month': { monthly: 30, total: 360 },
  vip:     { monthly: 0,  total: 0   },
};

// ============================================================
// RESTAURANTS
// ============================================================

router.get('/restaurants', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM users u WHERE u.restaurant_id = r.id AND u.is_active IS NOT FALSE) AS staff_count
      FROM restaurants r
      ORDER BY r.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/restaurants/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM restaurants WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/restaurants', async (req, res) => {
  const { name, slug, address, phone, logo_url, plan } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

  const selectedPlan = plan || 'trial';
  const duration = PLAN_DURATIONS[selectedPlan];
  const prices = PLAN_PRICES[selectedPlan] || PLAN_PRICES.trial;
  const expiresAt = duration ? `NOW() + INTERVAL '${duration} days'` : 'NULL';

  try {
    const result = await db.query(
      `INSERT INTO restaurants (name, slug, address, phone, logo_url, plan, plan_started_at, plan_expires_at, plan_price, plan_total)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), ${expiresAt}, $7, $8)
       RETURNING *`,
      [name, slug, address || null, phone || null, logo_url || null, selectedPlan, prices.monthly, prices.total]
    );
    const restaurant = result.rows[0];

    // Auto-create defaults
    await db.query(
      `INSERT INTO restaurant_settings (restaurant_id, restaurant_name) VALUES ($1, $2) ON CONFLICT (restaurant_id) DO NOTHING`,
      [restaurant.id, name]
    );
    await db.query(
      `INSERT INTO tax_settings (restaurant_id, name, rate, is_active) VALUES ($1, 'VAT', 12.00, TRUE) ON CONFLICT DO NOTHING`,
      [restaurant.id]
    );
    await db.query(
      `INSERT INTO table_sections (restaurant_id, name) VALUES ($1, 'Indoor'), ($1, 'Outdoor') ON CONFLICT (restaurant_id, name) DO NOTHING`,
      [restaurant.id]
    );

    res.status(201).json(restaurant);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A restaurant with this slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/restaurants/:id', async (req, res) => {
  const { name, slug, address, phone, logo_url, is_active } = req.body;
  try {
    const result = await db.query(
      `UPDATE restaurants
       SET name = COALESCE($2, name), slug = COALESCE($3, slug), address = COALESCE($4, address),
           phone = COALESCE($5, phone), logo_url = COALESCE($6, logo_url), is_active = COALESCE($7, is_active),
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, name, slug, address, phone, logo_url, is_active]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already taken' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/restaurants/:id', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE restaurants SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id, name`, [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({ message: `"${result.rows[0].name}" deactivated`, restaurant: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/restaurants/:id/reactivate', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE restaurants SET is_active = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================

// PUT /api/super-admin/restaurants/:id/plan -- change a restaurant's plan
router.put('/restaurants/:id/plan', async (req, res) => {
  const { plan, note } = req.body;
  if (!plan || !PLAN_DURATIONS.hasOwnProperty(plan))
    return res.status(400).json({ error: 'Invalid plan. Must be trial, monthly, 6month, 12month, or vip' });

  const duration = PLAN_DURATIONS[plan];
  const prices = PLAN_PRICES[plan];
  const expiresAt = duration ? `NOW() + INTERVAL '${duration} days'` : 'NULL';

  try {
    // Update current plan
    const result = await db.query(
      `UPDATE restaurants
       SET plan = $2, plan_started_at = NOW(), plan_expires_at = ${expiresAt},
           plan_price = $3, plan_total = $4, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, plan, prices.monthly, prices.total]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Restaurant not found' });

    // Log to history
    await db.query(
      `INSERT INTO subscription_history (restaurant_id, plan, price_monthly, total_amount, started_at, expires_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.params.id, plan, prices.monthly, prices.total, result.rows[0].plan_started_at, result.rows[0].plan_expires_at, note || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/super-admin/restaurants/:id/plan-history
router.get('/restaurants/:id/plan-history', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM subscription_history WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/super-admin/plans -- return plan definitions
router.get('/plans', async (req, res) => {
  res.json([
    { id: 'trial',   name: 'Free Trial',  monthly: 0,  total: 0,   days: 30,  description: '30 days free' },
    { id: 'monthly', name: 'Monthly',     monthly: 41, total: 41,  days: 30,  description: '$41/month' },
    { id: '6month',  name: '6 Months',    monthly: 36, total: 216, days: 180, description: '$36/month' },
    { id: '12month', name: '12 Months',   monthly: 30, total: 360, days: 365, description: '$30/month' },
    { id: 'vip',     name: 'VIP',         monthly: 0,  total: 0,   days: null, description: 'Unlimited' },
  ]);
});

// ============================================================
// STAFF MANAGEMENT
// ============================================================

router.get('/restaurants/:id/staff', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, phone, role, is_active, created_at
       FROM users WHERE restaurant_id = $1 AND role IN ('owner', 'admin') ORDER BY role, name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/restaurants/:id/staff', async (req, res) => {
  const { name, email, password, phone, role } = req.body;
  const restaurant_id = req.params.id;

  if (!name || !email || !password || !role)
    return res.status(400).json({ error: 'name, email, password, role required' });
  if (!['owner', 'admin'].includes(role))
    return res.status(400).json({ error: 'Only owner or admin roles allowed' });

  try {
    const rest = await db.query('SELECT id FROM restaurants WHERE id = $1', [restaurant_id]);
    if (!rest.rows[0]) return res.status(404).json({ error: 'Restaurant not found' });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (restaurant_id, name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, restaurant_id, name, email, phone, role, is_active, created_at`,
      [restaurant_id, name, email, phone || null, hash, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const detail = (err.detail || '').toLowerCase();
      if (detail.includes('phone')) return res.status(409).json({ error: 'Phone number already exists for this restaurant' });
      return res.status(409).json({ error: 'Email already exists for this restaurant' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/staff/:userId', async (req, res) => {
  const { name, email, phone, role, is_active, password } = req.body;
  try {
    let hashUpdate = '';
    const params = [req.params.userId, name, email, phone, role, is_active];
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      params.push(hash);
      hashUpdate = `, password_hash = $${params.length}`;
    }

    const result = await db.query(
      `UPDATE users
       SET name = COALESCE($2, name), email = COALESCE($3, email), phone = COALESCE($4, phone),
           role = COALESCE($5, role), is_active = COALESCE($6, is_active), updated_at = NOW() ${hashUpdate}
       WHERE id = $1 AND role IN ('owner', 'admin')
       RETURNING id, restaurant_id, name, email, phone, role, is_active, created_at`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Staff not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const detail = (err.detail || '').toLowerCase();
      if (detail.includes('phone')) return res.status(409).json({ error: 'Phone number already exists' });
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/staff/:userId', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND role IN ('owner', 'admin') RETURNING id, name`,
      [req.params.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Staff not found' });
    res.json({ message: `${result.rows[0].name} deactivated` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DASHBOARD STATS
// ============================================================

router.get('/stats', async (req, res) => {
  try {
    const [restaurants, users, activeRestaurants, expiredCount] = await Promise.all([
      db.query('SELECT COUNT(*) FROM restaurants'),
      db.query("SELECT COUNT(*) FROM users WHERE role != 'super_admin'"),
      db.query('SELECT COUNT(*) FROM restaurants WHERE is_active = TRUE'),
      db.query("SELECT COUNT(*) FROM restaurants WHERE plan != 'vip' AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()"),
    ]);
    res.json({
      total_restaurants: parseInt(restaurants.rows[0].count),
      active_restaurants: parseInt(activeRestaurants.rows[0].count),
      total_staff: parseInt(users.rows[0].count),
      expired_subscriptions: parseInt(expiredCount.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
