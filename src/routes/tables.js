const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ── Ensure table_sections table exists (runs on every request if needed) ─────
const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS table_sections (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  INSERT INTO table_sections (name)
  VALUES ('Indoor'),('Outdoor'),('Terrace')
  ON CONFLICT (name) DO NOTHING;
`;
let sectionsTableReady = false;
async function ensureSectionsTable() {
  if (sectionsTableReady) return;
  await db.query(ENSURE_SQL);
  sectionsTableReady = true;
}
// Run once on startup
ensureSectionsTable().catch(() => {});

// GET /api/tables/sections
router.get('/sections', authenticate, async (req, res) => {
  try {
    await ensureSectionsTable();
    const restaurantId = rid(req);
    const [stored, fromTables] = await Promise.all([
      db.query(`SELECT name FROM table_sections WHERE restaurant_id = $1 ORDER BY id`, [restaurantId]),
      db.query(`SELECT DISTINCT section FROM restaurant_tables WHERE restaurant_id = $1 AND section IS NOT NULL AND section != ''`, [restaurantId]),
    ]);
    const set = new Set([
      ...stored.rows.map(r => r.name),
      ...fromTables.rows.map(r => r.section),
    ]);
    res.json([...set]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tables/sections
router.post('/sections', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Section name required' });
  try {
    await ensureSectionsTable();
    const restaurantId = rid(req);
    await db.query(`INSERT INTO table_sections (name, restaurant_id) VALUES ($1, $2) ON CONFLICT (restaurant_id, name) DO NOTHING`, [name.trim(), restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/tables/sections/:name
router.delete('/sections/:name', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureSectionsTable();
    const restaurantId = rid(req);
    await db.query(`DELETE FROM table_sections WHERE name = $1 AND restaurant_id = $2`, [req.params.name, restaurantId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tables
router.get('/', authenticate, async (req, res) => {
  try {
    const restaurantId = rid(req);
    const result = await db.query(`
      SELECT t.*,
             u.name as waitress_name,
             COALESCE(
               (SELECT SUM(oi.unit_price * oi.quantity)
                FROM orders o
                JOIN order_items oi ON oi.order_id = o.id
                WHERE o.table_id = t.id AND o.restaurant_id = $1 AND o.status NOT IN ('paid','cancelled')),
               0
             ) AS order_total
      FROM restaurant_tables t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.restaurant_id = $1
      ORDER BY t.table_number
    `, [restaurantId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tables — admin/owner creates tables
router.post('/', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { table_number, capacity, name, section, shape } = req.body;
  try {
    const restaurantId = rid(req);

    // Auto-assign table_number if not provided
    let tNum = table_number;
    if (!tNum) {
      const maxRes = await db.query('SELECT COALESCE(MAX(table_number), 0) + 1 AS next FROM restaurant_tables WHERE restaurant_id = $1', [restaurantId]);
      tNum = maxRes.rows[0].next;
    }
    const tName = name || `Table ${tNum}`;

    // Try with extra columns first, fall back to basic insert if columns don't exist yet
    let result;
    try {
      result = await db.query(
        `INSERT INTO restaurant_tables (table_number, capacity, name, section, shape, restaurant_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tNum, capacity || 4, tName, section || 'Indoor', shape || 'Square', restaurantId]
      );
    } catch (colErr) {
      // Columns don't exist yet — insert with basic fields only
      result = await db.query(
        `INSERT INTO restaurant_tables (table_number, capacity, restaurant_id) VALUES ($1, $2, $3) RETURNING *`,
        [tNum, capacity || 4, restaurantId]
      );
    }
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── IMPORTANT: specific sub-routes MUST come before /:id ──────────────────

// PUT /api/tables/merge — merge two tables
router.put('/merge', authenticate, async (req, res) => {
  const { table_id_1, table_id_2 } = req.body;
  try {
    const restaurantId = rid(req);

    // Verify both tables belong to this restaurant
    const tablesRes = await db.query(
      `SELECT id FROM restaurant_tables WHERE id IN ($1, $2) AND restaurant_id = $3`,
      [table_id_1, table_id_2, restaurantId]
    );
    if (tablesRes.rows.length !== 2) {
      return res.status(403).json({ error: 'One or both tables not found in your restaurant' });
    }

    await db.query('UPDATE orders SET table_id=$1 WHERE table_id=$2 AND restaurant_id=$3 AND status != $4', [table_id_1, table_id_2, restaurantId, 'paid']);
    await db.query(`UPDATE restaurant_tables SET status='free', assigned_to=NULL WHERE id=$1 AND restaurant_id=$2`, [table_id_2, restaurantId]);
    res.json({ message: 'Tables merged successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tables/:id/open — opens table (sets occupied)
router.put('/:id/open', authenticate, async (req, res) => {
  const { guests_count, assigned_to } = req.body || {};
  try {
    const restaurantId = rid(req);
    const result = await db.query(
      `UPDATE restaurant_tables
       SET status = 'occupied',
           assigned_to = COALESCE($1, assigned_to, $2),
           guests_count = COALESCE($3, guests_count),
           opened_at = NOW()
       WHERE id = $4 AND restaurant_id = $5 RETURNING *`,
      [assigned_to || null, req.user.id, guests_count ? parseInt(guests_count) : null, req.params.id, restaurantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Table not found' });

    db.query(
      "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
      [req.user.id, "Table Opened", `Table ${result.rows[0].table_number} is now occupied.`, "table_status", restaurantId]
    ).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tables/:id/close
router.put('/:id/close', authenticate, async (req, res) => {
  try {
    const restaurantId = rid(req);
    const result = await db.query(
      `UPDATE restaurant_tables
       SET status = 'free',
           assigned_to = NULL,
           opened_at = NULL,
           guests_count = NULL,
           reservation_guest = NULL,
           reservation_phone = NULL,
           reservation_date = NULL,
           reservation_time = NULL
       WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
      [req.params.id, restaurantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Table not found' });

    db.query(
      "INSERT INTO notifications (user_id, title, body, type, restaurant_id) VALUES ($1,$2,$3,$4,$5)",
      [req.user.id, "Table Closed", `Table ${result.rows[0].table_number} is now free.`, "table_status", restaurantId]
    ).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tables/:id/transfer
router.put('/:id/transfer', authenticate, async (req, res) => {
  const { new_waitress_id } = req.body;
  try {
    const restaurantId = rid(req);
    const result = await db.query(
      `UPDATE restaurant_tables SET assigned_to = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *`,
      [new_waitress_id, req.params.id, restaurantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Table not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tables/:id — generic update (MUST be after all /:id/xxx routes)
router.put('/:id', authenticate, authorize('owner', 'admin', 'waitress'), async (req, res) => {
  const { id } = req.params;
  const restaurantId = rid(req);
  const allowed = [
    'name', 'capacity', 'section', 'shape', 'status',
    'assigned_to', 'guests_count',
    'reservation_guest', 'reservation_phone', 'reservation_date', 'reservation_time',
  ];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = $${idx++}`);
      vals.push(req.body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  vals.push(id);
  vals.push(restaurantId);
  try {
    const result = await db.query(
      `UPDATE restaurant_tables SET ${sets.join(', ')} WHERE id = $${idx} AND restaurant_id = $${idx + 1} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Table not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/tables/:id
router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurantId = rid(req);
    const result = await db.query('DELETE FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2 RETURNING id', [req.params.id, restaurantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Table not found' });
    res.json({ message: 'Table deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
