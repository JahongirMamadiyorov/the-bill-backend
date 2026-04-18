const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ─── Auto-migrate: add columns that may not exist yet ─────────────────────────
(async () => {
  try {
    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS salary           DECIMAL(12,2),
        ADD COLUMN IF NOT EXISTS shift_start      VARCHAR(10),
        ADD COLUMN IF NOT EXISTS shift_end        VARCHAR(10),
        ADD COLUMN IF NOT EXISTS salary_type      VARCHAR(20) DEFAULT 'monthly',
        ADD COLUMN IF NOT EXISTS kitchen_station  VARCHAR(50) DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS commission_rate  DECIMAL(5,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS restaurant_id    UUID
    `);
    await db.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await db.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('super_admin','owner','admin','cashier','waitress','kitchen','manager','cleaner'))
    `);
  } catch (_) { /* columns / constraint already up to date */ }
})();

// ─── GET /api/users/me — any authenticated user can fetch their own profile ────
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, phone, role, salary, salary_type, shift_start, shift_end,
              is_active, kitchen_station, commission_rate, created_at
       FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/users ────────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, phone, role, salary, salary_type, shift_start, shift_end,
              is_active, kitchen_station, commission_rate, created_at
       FROM users WHERE restaurant_id=$1 ORDER BY created_at DESC`,
      [rid(req)]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/users/:id ────────────────────────────────────────────────────────
router.get('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, phone, role, salary, salary_type, shift_start, shift_end,
              is_active, kitchen_station, commission_rate, created_at
       FROM users WHERE id=$1 AND restaurant_id=$2`,
      [req.params.id, rid(req)]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/users — create staff ───────────────────────────────────────────
router.post('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const {
    name, email, password, phone, role,
    // Accept both camelCase (from website interceptor) and snake_case (from app)
    salary,
    salary_type, salaryType,
    shift_start, shiftStart,
    shift_end, shiftEnd,
    kitchen_station, kitchenStation,
  } = req.body;
  const resolvedSalaryType    = (salary_type || salaryType || 'monthly').toLowerCase();
  const resolvedShiftStart    = shift_start  || shiftStart  || null;
  const resolvedShiftEnd      = shift_end    || shiftEnd    || null;
  const resolvedStation       = kitchen_station || kitchenStation || null;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users
         (name, email, phone, password_hash, role, salary, salary_type, shift_start, shift_end, kitchen_station, restaurant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, name, email, phone, role, salary, salary_type, shift_start, shift_end, kitchen_station`,
      [name, email, phone, hash, role,
       salary ? parseFloat(salary) : null,
       resolvedSalaryType, resolvedShiftStart, resolvedShiftEnd, resolvedStation, rid(req)]
    );
    if (role === 'waitress') {
      await db.query('INSERT INTO waitress_permissions (user_id, restaurant_id) VALUES ($1, $2)', [result.rows[0].id, rid(req)]);
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const detail = (err.detail || '').toLowerCase();
      if (detail.includes('phone')) return res.status(409).json({ error: 'Phone number already exists' });
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/users/:id — partial update (only sent fields are changed) ────────
router.put('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const body = req.body;
  try {
    // Fetch current row so we never overwrite a NOT NULL column with null
    const cur = await db.query(
      `SELECT name, phone, role, is_active, salary, salary_type, shift_start, shift_end, kitchen_station, commission_rate FROM users WHERE id=$1 AND restaurant_id=$2`,
      [req.params.id, rid(req)]
    );
    if (!cur.rows[0]) return res.status(404).json({ error: 'User not found' });
    const c = cur.rows[0];

    const result = await db.query(
      `UPDATE users
       SET name=$1, phone=$2, role=$3, is_active=$4,
           salary=$5, salary_type=$6, shift_start=$7, shift_end=$8,
           kitchen_station=$9, commission_rate=$10, updated_at=NOW()
       WHERE id=$11 AND restaurant_id=$12
       RETURNING id, name, email, phone, role, salary, salary_type, shift_start, shift_end,
                 is_active, kitchen_station, commission_rate`,
      [
        body.name             !== undefined ? body.name                          : c.name,
        body.phone            !== undefined ? body.phone                         : c.phone,
        body.role             !== undefined ? body.role                          : c.role,
        body.is_active        !== undefined ? body.is_active                     : c.is_active,
        body.salary           !== undefined ? parseFloat(body.salary)            : c.salary,
        body.salary_type      !== undefined ? body.salary_type                   : (c.salary_type || 'monthly'),
        body.shift_start      !== undefined ? body.shift_start                   : c.shift_start,
        body.shift_end        !== undefined ? body.shift_end                     : c.shift_end,
        body.kitchen_station  !== undefined ? (body.kitchen_station || null)     : c.kitchen_station,
        body.commission_rate  !== undefined ? parseFloat(body.commission_rate)   : (c.commission_rate || 0),
        req.params.id,
        rid(req),
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PUT /api/users/:id/credentials — update email and/or password ────────────
// Accepts: { email, currentPassword, password (new), confirmPassword }
// currentPassword is optional — admin can skip it; if provided it is verified.
router.put('/:id/credentials', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { email, password, current_password, confirm_password } = req.body;
  if (!email && !password)
    return res.status(400).json({ error: 'Provide at least an email or a new password.' });

  try {
    // Fetch current user row and verify they belong to this restaurant
    const userRow = await db.query('SELECT id, password_hash FROM users WHERE id=$1 AND restaurant_id=$2', [req.params.id, rid(req)]);
    if (!userRow.rows[0]) return res.status(404).json({ error: 'User not found' });

    // If current password was provided, verify it
    if (current_password) {
      const valid = await bcrypt.compare(current_password, userRow.rows[0].password_hash);
      if (!valid) return res.status(403).json({ error: 'Current password is incorrect.' });
    }

    // If new password provided, verify confirmation matches
    if (password && confirm_password && password.trim() !== confirm_password.trim()) {
      return res.status(400).json({ error: 'New passwords do not match.' });
    }

    // Check email uniqueness
    if (email) {
      const dupe = await db.query(
        'SELECT id FROM users WHERE email=$1 AND id!=$2',
        [email, req.params.id]
      );
      if (dupe.rows.length > 0)
        return res.status(409).json({ error: 'Email is already in use by another account.' });
    }

    let sql, params;

    if (email && password && password.trim()) {
      const hash = await bcrypt.hash(password.trim(), 10);
      sql    = `UPDATE users SET email=$1, password_hash=$2, updated_at=NOW()
                WHERE id=$3 RETURNING id, name, email, role`;
      params = [email, hash, req.params.id];
    } else if (email) {
      sql    = `UPDATE users SET email=$1, updated_at=NOW()
                WHERE id=$2 RETURNING id, name, email, role`;
      params = [email, req.params.id];
    } else {
      const hash = await bcrypt.hash(password.trim(), 10);
      sql    = `UPDATE users SET password_hash=$1, updated_at=NOW()
                WHERE id=$2 RETURNING id, name, email, role`;
      params = [hash, req.params.id];
    }

    const result = await db.query(sql, params);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DELETE /api/users/:id ─────────────────────────────────────────────────────
// Owner  → can delete anyone
// Admin  → can delete any non-owner employee, but NOT themselves and NOT owners
router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const targetId = req.params.id; // keep as-is — works for both integer and UUID PKs

    // Fetch the target user so we can check their role and verify they belong to this restaurant
    const targetRes = await db.query('SELECT id, role FROM users WHERE id=$1 AND restaurant_id=$2', [targetId, rid(req)]);
    if (!targetRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    const targetRole = targetRes.rows[0].role;

    if (req.user.role === 'admin') {
      // Admin cannot remove themselves (compare as strings to handle UUID or integer PKs)
      if (String(targetId) === String(req.user.id)) {
        return res.status(403).json({ error: 'You cannot remove your own account.' });
      }
      // Admin cannot remove owners
      if (targetRole === 'owner') {
        return res.status(403).json({ error: 'Admins cannot remove owner accounts.' });
      }
    }

    await db.query('DELETE FROM users WHERE id=$1 AND restaurant_id=$2', [targetId, rid(req)]);
    res.json({ message: 'User removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
