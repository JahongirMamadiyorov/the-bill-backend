const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// POST /api/shifts/clock-in
// Any authenticated user can clock themselves in.
// Admin/owner can clock in another user by providing a different user_id in the body.
router.post('/clock-in', authenticate, async (req, res) => {
  const { user_id: bodyUserId, hourly_rate, scheduled_start_time, status: forceStatus } = req.body;
  const isAdminOrOwner = ['owner', 'admin'].includes(req.user.role);

  // Non-admin attempting to clock in someone else is forbidden
  if (bodyUserId && bodyUserId !== req.user.id && !isAdminOrOwner) {
    return res.status(403).json({ error: 'You can only clock in yourself' });
  }

  // Default to self-clock-in when no user_id provided
  const user_id = bodyUserId || req.user.id;

  try {
    // Get restaurant_id from JWT
    const restaurant_id = rid(req);
    if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

    // Prevent double clock-in
    const open = await db.query(
      'SELECT * FROM shifts WHERE user_id=$1 AND restaurant_id=$2 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1',
      [user_id, restaurant_id]
    );
    if (open.rows.length > 0) return res.status(400).json({ error: 'User is already clocked in' });

    let calculatedStatus = 'present';
    // Admin/owner can force a specific status (e.g. 'late') when clocking in someone
    if (isAdminOrOwner && forceStatus && ['present', 'late'].includes(forceStatus)) {
      calculatedStatus = forceStatus;
    } else if (scheduled_start_time) {
      const start = new Date(scheduled_start_time);
      const now   = new Date();
      if ((now - start) / 60000 > 15) calculatedStatus = 'late';
    }

    const result = await db.query(
      'INSERT INTO shifts (user_id, restaurant_id, clock_in, hourly_rate, scheduled_start_time, status) VALUES ($1, $2, NOW(), $3, $4, $5) RETURNING *',
      [user_id, restaurant_id, hourly_rate || 0, scheduled_start_time || null, calculatedStatus]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /shifts/clock-in error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/clock-out
// Any authenticated user can clock out their own active shift.
// Admin/owner can clock out another user by providing user_id in the body.
async function clockOut(req, res) {
  const isAdminOrOwner = ['owner', 'admin'].includes(req.user.role);
  const bodyUserId = req.body.user_id;

  if (bodyUserId && bodyUserId !== req.user.id && !isAdminOrOwner) {
    return res.status(403).json({ error: 'You can only clock out yourself' });
  }

  const user_id = bodyUserId || req.user.id;
  const restaurant_id = rid(req);
  if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

  try {
    const result = await db.query(
      `UPDATE shifts SET clock_out=NOW()
       WHERE user_id=$1 AND restaurant_id=$2 AND clock_out IS NULL
       RETURNING *, ROUND((EXTRACT(EPOCH FROM (clock_out - clock_in))/3600)::numeric, 2) AS hours_worked`,
      [user_id, restaurant_id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'No active shift found for this user' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
}
router.post('/clock-out', authenticate, clockOut);
router.put('/clock-out',  authenticate, clockOut);

// GET /api/shifts/active — check if currently clocked in
router.get('/active', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

    const result = await db.query(
      'SELECT * FROM shifts WHERE user_id=$1 AND restaurant_id=$2 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1',
      [req.user.id, restaurant_id]
    );
    // Always return JSON object — { active: false } or the shift row
    if (result.rows[0]) {
      res.json({ active: true, ...result.rows[0] });
    } else {
      res.json({ active: false });
    }
  } catch (err) {
    console.error('GET /shifts/active error:', err.message);
    res.json({ active: false });
  }
});

// GET /api/shifts/mine
router.get('/mine', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

    const result = await db.query(
      `SELECT *, ROUND((EXTRACT(EPOCH FROM COALESCE(clock_out, NOW()) - clock_in)/3600)::numeric, 2) AS hours_worked
       FROM shifts WHERE user_id=$1 AND restaurant_id=$2 ORDER BY clock_in DESC LIMIT 30`,
      [req.user.id, restaurant_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/shifts/payroll
router.get('/payroll', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { from, to } = req.query;
  const restaurant_id = rid(req);
  if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

  try {
    const result = await db.query(
      `SELECT
         u.id, u.name, u.role, u.salary, u.salary_type, u.commission_rate,
         -- Closed shifts only
         COUNT(CASE WHEN s.clock_out IS NOT NULL THEN 1 END)::int AS shift_count,
         ROUND(COALESCE(SUM(
           CASE WHEN s.clock_out IS NOT NULL
                THEN EXTRACT(EPOCH FROM s.clock_out - s.clock_in) / 3600
                ELSE 0 END
         ), 0)::numeric, 2) AS total_hours,
         -- Unique calendar days where staff clocked in (matches admin panel logic — includes open/current shifts)
         COUNT(DISTINCT s.clock_in::date)::int AS days_worked,
         -- Gross pay — respects salary_type
         CASE
           WHEN u.salary_type = 'monthly' THEN
             COALESCE(u.salary, 0)
           WHEN u.salary_type = 'hourly' THEN
             ROUND(
               COALESCE(SUM(
                 CASE WHEN s.clock_out IS NOT NULL
                      THEN EXTRACT(EPOCH FROM s.clock_out - s.clock_in) / 3600
                      ELSE 0 END
               ), 0) * COALESCE(u.salary, 0), 2)
           WHEN u.salary_type = 'daily' THEN
             COUNT(DISTINCT s.clock_in::date) * COALESCE(u.salary, 0)
           WHEN u.salary_type = 'weekly' THEN
             FLOOR(COUNT(DISTINCT s.clock_in::date) / 5.0) * COALESCE(u.salary, 0)
           ELSE COALESCE(u.salary, 0)
         END AS gross_pay,
         -- Commission: waitress-only, dine_in paid orders in the period
         CASE WHEN u.role = 'waitress' AND COALESCE(u.commission_rate, 0) > 0 THEN
           ROUND(
             COALESCE(u.commission_rate, 0) / 100.0 * (
               SELECT COALESCE(SUM(o.total_amount), 0)
               FROM orders o
               WHERE o.waitress_id    = u.id
                 AND o.restaurant_id  = $3
                 AND o.order_type     = 'dine_in'
                 AND o.status         = 'paid'
                 AND o.paid_at::date BETWEEN $1 AND $2
             ), 2)
         ELSE 0 END AS commission_earned
       FROM users u
       LEFT JOIN shifts s ON u.id = s.user_id AND s.restaurant_id = $3 AND s.clock_in::date BETWEEN $1 AND $2
       WHERE u.is_active = true
         AND u.restaurant_id = $3
         AND u.role IN ('owner','admin','waitress','kitchen','manager','cashier','cleaner')
       GROUP BY u.id, u.name, u.role, u.salary, u.salary_type, u.commission_rate
       ORDER BY u.name`,
      [from || '2000-01-01', to || new Date().toISOString().split('T')[0], restaurant_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/shifts
router.get('/', authenticate, async (req, res) => {
  const { from, to, user_id } = req.query;
  const restaurant_id = rid(req);
  if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

  try {
    let query = `
      SELECT s.*, u.name, u.role,
        CASE
          WHEN s.clock_in IS NOT NULL AND s.clock_out IS NOT NULL
            THEN ROUND((EXTRACT(EPOCH FROM s.clock_out - s.clock_in)/3600)::numeric, 2)
          WHEN s.clock_in IS NOT NULL AND s.clock_out IS NULL
            THEN ROUND((EXTRACT(EPOCH FROM NOW() - s.clock_in)/3600)::numeric, 2)
          ELSE 0
        END AS hours_worked,
        CASE
          WHEN s.clock_in IS NOT NULL AND s.clock_out IS NOT NULL
            THEN ROUND(((EXTRACT(EPOCH FROM s.clock_out - s.clock_in)/3600) * s.hourly_rate)::numeric, 2)
          WHEN s.clock_in IS NOT NULL AND s.clock_out IS NULL
            THEN ROUND(((EXTRACT(EPOCH FROM NOW() - s.clock_in)/3600) * s.hourly_rate)::numeric, 2)
          ELSE 0
        END AS earnings
      FROM shifts s LEFT JOIN users u ON s.user_id=u.id WHERE s.restaurant_id=$1
    `;
    const params = [restaurant_id];
    if (req.user.role === 'waitress') { params.push(req.user.id); query += ` AND s.user_id=$${params.length}`; }
    else if (user_id) { params.push(user_id); query += ` AND s.user_id=$${params.length}`; }
    // Use COALESCE(shift_date, clock_in::date) to handle manual absent records where clock_in is NULL
    if (from) { params.push(from); query += ` AND COALESCE(s.shift_date, s.clock_in::date) >= $${params.length}`; }
    if (to)   { params.push(to);   query += ` AND COALESCE(s.shift_date, s.clock_in::date) <= $${params.length}`; }
    query += ' ORDER BY COALESCE(s.shift_date, s.clock_in::date) DESC NULLS LAST, s.created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/shifts/admin/staff-status
router.get('/admin/staff-status', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurant_id = rid(req);
    if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

    const result = await db.query(`
            SELECT u.id as user_id, u.name, u.role, u.email,
                   s.id as shift_id, s.clock_in, s.clock_out, s.scheduled_start_time, s.status,
                   CASE
                     WHEN s.clock_in IS NOT NULL AND s.clock_out IS NOT NULL
                       THEN ROUND((EXTRACT(EPOCH FROM s.clock_out - s.clock_in)/3600)::numeric, 2)
                     WHEN s.clock_in IS NOT NULL AND s.clock_out IS NULL
                       THEN ROUND((EXTRACT(EPOCH FROM NOW() - s.clock_in)/3600)::numeric, 2)
                     ELSE 0
                   END AS hours_worked
            FROM users u
            LEFT JOIN (
                SELECT DISTINCT ON (user_id)
                    id, user_id, clock_in, clock_out, scheduled_start_time, status
                FROM shifts
                WHERE restaurant_id = $1 AND (
                    -- Shifts for today using COALESCE to handle both clock-in and manual records
                    COALESCE(shift_date, clock_in::date) = CURRENT_DATE
                )
                ORDER BY user_id,
                         -- Priority: active shift (clocked in, not out) > completed > absence
                         (CASE
                           WHEN clock_in IS NOT NULL AND clock_out IS NULL THEN 0
                           WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL THEN 1
                           ELSE 2
                         END),
                         clock_in DESC NULLS LAST
            ) s ON u.id = s.user_id
            WHERE u.is_active = true
              AND u.restaurant_id = $1
              AND u.role IN ('waitress', 'kitchen', 'cashier', 'cleaner', 'manager')
            ORDER BY u.role, u.name
        `, [restaurant_id]);

    // Accurately map shift state:
    //   clock_in present  → use actual status from DB (present / late)
    //   explicit absence record (shift_id present, no clock_in) → 'absent'
    //   no record at all (LEFT JOIN miss) → 'off'  (not yet started, NOT absent)
    const mapped = result.rows.map(row => ({
      ...row,
      status: row.clock_in
        ? row.status          // real clock-in: trust DB status (present/late)
        : row.shift_id
          ? 'absent'          // explicit absence record exists for today
          : 'off'             // no record yet — staff hasn't started / day off
    }));

    res.json(mapped);
  } catch (err) {
    console.error('GET /shifts/admin/staff-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/manual — admin creates a manual attendance record (e.g. absent/excused)
router.post('/manual', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { user_id, date, status, clock_in, clock_out, note } = req.body;
  if (!user_id || !date) return res.status(400).json({ error: 'Missing user_id or date' });

  const restaurant_id = rid(req);
  if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

  const validStatuses = ['present', 'absent', 'late', 'excused'];
  const finalStatus = validStatuses.includes(status) ? status : 'absent';

  try {
    // Check if a shift already exists for this user on this date
    const existing = await db.query(
      `SELECT id FROM shifts
       WHERE user_id=$1
         AND restaurant_id=$2
         AND COALESCE(shift_date, clock_in::date) = $3`,
      [user_id, restaurant_id, date]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A shift record already exists for this date. Use PUT /shifts/:id to edit it.', existing_id: existing.rows[0].id });
    }

    const clockInVal  = (clock_in  && clock_in  !== '') ? new Date(`${date}T${clock_in}:00`)  : null;
    const clockOutVal = (clock_out && clock_out !== '') ? new Date(`${date}T${clock_out}:00`) : null;

    const result = await db.query(
      `INSERT INTO shifts (user_id, restaurant_id, clock_in, clock_out, status, note, hourly_rate, shift_date)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7) RETURNING *`,
      [user_id, restaurant_id, clockInVal, clockOutVal, finalStatus, note || null, date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /shifts/manual error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/shifts/:id — admin edits an existing shift record
router.put('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { status, clock_in, clock_out, note, date } = req.body;
  const restaurant_id = rid(req);
  if (!restaurant_id) return res.status(400).json({ error: 'Restaurant ID not found' });

  try {
    const cur = await db.query('SELECT * FROM shifts WHERE id=$1 AND restaurant_id=$2', [id, restaurant_id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Shift not found' });

    const c = cur.rows[0];
    const validStatuses = ['present', 'absent', 'late', 'excused'];
    const newStatus = validStatuses.includes(status) ? status : c.status;

    // Helper: get YYYY-MM-DD in LOCAL timezone from a Date object
    // (avoids .toISOString() which returns UTC and can shift the date by -1 day)
    const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    // Determine the date for this shift using LOCAL timezone
    // Priority: explicit date param > existing shift_date > clock_in local date > today
    const existingShiftDate = c.shift_date
      ? (c.shift_date instanceof Date ? localDateStr(c.shift_date) : String(c.shift_date).split('T')[0])
      : null;
    const useDate = date || existingShiftDate || (c.clock_in ? localDateStr(c.clock_in) : localDateStr(new Date()));

    let newClockIn  = c.clock_in;
    let newClockOut = c.clock_out;

    if (clock_in !== undefined) {
      newClockIn = (clock_in === null || clock_in === '') ? null : new Date(`${useDate}T${clock_in}:00`);
    }
    if (clock_out !== undefined) {
      newClockOut = (clock_out === null || clock_out === '') ? null : new Date(`${useDate}T${clock_out}:00`);
    }

    const newNote = note !== undefined ? note : c.note;

    // Always set shift_date to the correct local date so COALESCE filtering works reliably
    const newShiftDate = useDate;

    const result = await db.query(
      `UPDATE shifts SET status=$1, clock_in=$2, clock_out=$3, note=$4, shift_date=$5 WHERE id=$6 RETURNING *`,
      [newStatus, newClockIn, newClockOut, newNote, newShiftDate, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /shifts/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
