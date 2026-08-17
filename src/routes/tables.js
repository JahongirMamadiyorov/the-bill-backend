const express = require('express');
const router = express.Router();


// What a table is CALLED. Restaurants name their tables ("Xoli 1", "VIP"), and
// that name is what staff use — a generated "Table 3" is a different thing to
// the person reading the notification. Mirrors the app's utils/tableLabel.js.
function tableDisplayName(row) {
  const name = String(row?.name ?? '').trim();
  if (name) return name;
  return row?.table_number != null ? `Table ${row.table_number}` : 'Table';
}
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// ── Ensure table_sections table exists (multi-tenant schema) ────────────────
// The real schema lives in src/config/schema.sql:
//   CREATE TABLE table_sections (
//     id            SERIAL PRIMARY KEY,
//     restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
//     name          TEXT NOT NULL,
//     UNIQUE(restaurant_id, name)
//   );
// A single-tenant CREATE TABLE here without restaurant_id would clash with the
// real schema and any seeded INSERTs without restaurant_id would violate the
// NOT NULL constraint. Per-restaurant defaults are seeded by super-admin when
// a restaurant is created. Here we only ensure the table exists in dev DBs.
const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS table_sections (
    id            SERIAL PRIMARY KEY,
    restaurant_id UUID NOT NULL,
    name          TEXT NOT NULL,
    UNIQUE(restaurant_id, name)
  );
`;
let sectionsTableReady = false;
async function ensureSectionsTable() {
  if (sectionsTableReady) return;
  try {
    await db.query(ENSURE_SQL);
  } catch (_) {
    // Table likely already exists with the full schema — that's fine.
  }
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
    const name = req.params.name;

    // Refuse to drop a section that's still referenced by tables — otherwise
    // the GET endpoint's UNION fallback would immediately resurrect it from
    // restaurant_tables and the chip would pop back, making the delete look
    // broken. Compare case-insensitively so chip-matched names reliably hit.
    const refs = await db.query(
      `SELECT COUNT(*)::int AS n FROM restaurant_tables
       WHERE restaurant_id = $1 AND LOWER(section) = LOWER($2)`,
      [restaurantId, name]
    );
    if ((refs.rows[0]?.n || 0) > 0) {
      return res.status(409).json({ error: 'Section still has tables. Move or delete them first.' });
    }

    // Case-insensitive name match so a chip click reliably removes the row
    // even if its stored casing doesn't match what the UI displayed.
    await db.query(
      `DELETE FROM table_sections
       WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)`,
      [restaurantId, name]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/tables/sections/:name — rename a section
// Body: { newName: string }
// Updates the `table_sections` row AND every `restaurant_tables.section`
// that currently points at the old name, so the chip and every table card
// stay in sync. Case-insensitive match on the old name.
router.patch('/sections/:name', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    await ensureSectionsTable();
    const restaurantId = rid(req);
    const oldName = req.params.name;
    const newName = String(req.body?.newName ?? req.body?.new_name ?? '').trim();

    if (!newName) {
      return res.status(400).json({ error: 'New section name required' });
    }
    if (newName.length > 80) {
      return res.status(400).json({ error: 'Section name too long' });
    }
    if (newName.toLowerCase() === oldName.toLowerCase()) {
      return res.json({ ok: true, unchanged: true });
    }

    // Reject if another section with the new name already exists (unless
    // that row is the old one itself via a pure-casing change, handled above).
    const clash = await db.query(
      `SELECT 1 FROM table_sections
       WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)`,
      [restaurantId, newName]
    );
    if (clash.rows.length) {
      return res.status(409).json({ error: 'A section with that name already exists' });
    }

    // Update the registry row (case-insensitive match on old name).
    await db.query(
      `UPDATE table_sections SET name = $3
       WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)`,
      [restaurantId, oldName, newName]
    );

    // Keep every table that referenced the old name in sync, otherwise the
    // GET /sections union would resurrect the old name from restaurant_tables.
    await db.query(
      `UPDATE restaurant_tables SET section = $3
       WHERE restaurant_id = $1 AND LOWER(section) = LOWER($2)`,
      [restaurantId, oldName, newName]
    );

    // Safety net: ensure the new section exists as a registry row even if
    // the registry had no prior row for the old name (historical data path).
    await db.query(
      `INSERT INTO table_sections (name, restaurant_id)
       VALUES ($1, $2)
       ON CONFLICT (restaurant_id, name) DO NOTHING`,
      [newName, restaurantId]
    );

    res.json({ ok: true, oldName, newName });
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

    // title/body stay in English as the fallback for older clients; the *_key
    // columns are what a translating client actually renders (see the column
    // comments). body_params carries the table's real NAME — "Xoli 1" — not a
    // generated "Table 1", which is what the staff actually call it.
    db.query(
      `INSERT INTO notifications (user_id, title, body, type, restaurant_id, title_key, body_key, body_params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        req.user.id,
        "Table Opened",
        `${tableDisplayName(result.rows[0])} is now occupied.`,
        "table_status", restaurantId,
        'notif.tableOpened.title', 'notif.tableOpened.body',
        JSON.stringify({ table: tableDisplayName(result.rows[0]) }),
      ]
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
      `INSERT INTO notifications (user_id, title, body, type, restaurant_id, title_key, body_key, body_params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        req.user.id,
        "Table Closed",
        `${tableDisplayName(result.rows[0])} is now free.`,
        "table_status", restaurantId,
        'notif.tableClosed.title', 'notif.tableClosed.body',
        JSON.stringify({ table: tableDisplayName(result.rows[0]) }),
      ]
    ).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tables/:id/reserve — hold a free table for a named guest.
//
// Deliberately its OWN route rather than widening `PUT /api/tables/:id`
// (2026-08-17). That generic update also accepts name, capacity, section and
// shape — floor-layout fields a cashier has no business changing — and it is
// restricted to owner/admin/waitress for exactly that reason. Reserving is a
// front-of-house action a cashier does dozens of times a night, so it gets a
// narrow endpoint that can ONLY touch reservation fields and the status.
//
// Refuses to reserve an occupied table: the guests sitting there have not
// finished, and silently marking their table reserved would hide their live
// order from the floor plan.
router.put('/:id/reserve', authenticate,
  authorize('owner', 'admin', 'cashier', 'new_cashier', 'waitress', 'new_waiter'),
  async (req, res) => {
    const restaurantId = rid(req);
    const guest = String(req.body.reservation_guest ?? req.body.guest ?? '').trim();
    if (!guest) return res.status(400).json({ error: 'A guest name is required' });

    try {
      const current = await db.query(
        'SELECT status FROM restaurant_tables WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, restaurantId]
      );
      if (!current.rows.length) return res.status(404).json({ error: 'Table not found' });
      if (current.rows[0].status === 'occupied') {
        return res.status(409).json({
          error: 'This table is occupied — close its order before reserving it.',
          code: 'TABLE_OCCUPIED',
        });
      }

      const result = await db.query(
        `UPDATE restaurant_tables
            SET status = 'reserved',
                reservation_guest = $1,
                reservation_phone = $2,
                reservation_date  = $3,
                reservation_time  = $4
          WHERE id = $5 AND restaurant_id = $6 RETURNING *`,
        [
          guest,
          req.body.reservation_phone ?? req.body.phone ?? null,
          req.body.reservation_date  ?? req.body.date  ?? null,
          req.body.reservation_time  ?? req.body.time  ?? null,
          req.params.id, restaurantId,
        ]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

// PUT /api/tables/:id/unreserve — release a held table back to free.
//
// Only ever acts on a RESERVED table. Guarding on the status means a mistaken
// tap cannot free a table that has since been seated and has a live order on
// it — that would strand the order with no table on the floor plan.
router.put('/:id/unreserve', authenticate,
  authorize('owner', 'admin', 'cashier', 'new_cashier', 'waitress', 'new_waiter'),
  async (req, res) => {
    try {
      const restaurantId = rid(req);
      const result = await db.query(
        `UPDATE restaurant_tables
            SET status = 'free',
                reservation_guest = NULL,
                reservation_phone = NULL,
                reservation_date  = NULL,
                reservation_time  = NULL
          WHERE id = $1 AND restaurant_id = $2 AND status = 'reserved' RETURNING *`,
        [req.params.id, restaurantId]
      );
      if (!result.rows.length) {
        return res.status(409).json({
          error: 'That table is not reserved.',
          code: 'NOT_RESERVED',
        });
      }
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
