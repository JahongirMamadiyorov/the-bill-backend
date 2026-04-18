const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { identifier, email: legacyEmail, password } = req.body;
  const id = (identifier || legacyEmail || '').trim();

  if (!id || !password)
    return res.status(400).json({ error: 'Identifier and password required' });

  try {
    let result;

    const baseSelect = `SELECT u.*, r.name AS restaurant_name, r.slug AS restaurant_slug,
      r.plan AS restaurant_plan, r.plan_expires_at AS restaurant_plan_expires_at
      FROM users u
      LEFT JOIN restaurants r ON r.id = u.restaurant_id`;
    const activeFilter = `AND u.is_active IS NOT FALSE AND (u.restaurant_id IS NULL OR r.is_active = TRUE)`;

    if (id.includes('@')) {
      result = await db.query(
        `${baseSelect} WHERE LOWER(u.email)=LOWER($1) ${activeFilter}`, [id]
      );
    } else if (/^\+?\d[\d\s\-()+]*$/.test(id)) {
      const digitsOnly = id.replace(/\D/g, '');
      result = await db.query(
        `${baseSelect} WHERE REGEXP_REPLACE(COALESCE(u.phone,''), '[^0-9]', '', 'g') = $1 ${activeFilter}`, [digitsOnly]
      );
    } else {
      result = await db.query(
        `${baseSelect} WHERE (LOWER(u.name)=LOWER($1) OR LOWER(u.email)=LOWER($1)) ${activeFilter}`, [id]
      );
    }

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Account not found. Check your phone, email or username.', code: 'NOT_FOUND' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong password. Please try again.', code: 'WRONG_PASSWORD' });

    // ── Subscription check (skip for super_admin and VIP) ──
    if (user.restaurant_id && user.restaurant_plan !== 'vip') {
      const expiresAt = user.restaurant_plan_expires_at;
      if (expiresAt && new Date(expiresAt) < new Date()) {
        return res.status(403).json({
          error: 'Your restaurant subscription has expired. Please contact the administrator to renew.',
          code: 'SUBSCRIPTION_EXPIRED',
          plan: user.restaurant_plan,
          expired_at: expiresAt,
        });
      }
    }

    const token = jwt.sign(
      {
        id: user.id,
        restaurant_id: user.restaurant_id || null,
        role: user.role,
        name: user.name,
        kitchen_station: user.kitchen_station || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const response = {
      token,
      user: {
        id: user.id,
        restaurant_id: user.restaurant_id || null,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        kitchen_station: user.kitchen_station || null,
        created_at: user.created_at || null,
      },
    };

    if (user.restaurant_id) {
      response.restaurant = {
        id: user.restaurant_id,
        name: user.restaurant_name,
        slug: user.restaurant_slug,
      };
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, phone, role, restaurant_id } = req.body;
  if (!name || !email || !password || !role || !restaurant_id)
    return res.status(400).json({ error: 'name, email, password, role, restaurant_id required' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (restaurant_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, restaurant_id, name, email, role',
      [restaurant_id, name, email, phone, hash, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      const detail = (err.detail || '').toLowerCase();
      if (detail.includes('phone')) return res.status(409).json({ error: 'Phone number already exists for this restaurant' });
      return res.status(409).json({ error: 'Email already exists for this restaurant' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/restaurants -- public list for login screen
router.get('/restaurants', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, slug, address, phone, logo_url FROM restaurants WHERE is_active = TRUE ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
