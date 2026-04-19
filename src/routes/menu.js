const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// ── Image upload setup ─────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, '../../uploads/menu');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req,  file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (_req, file, cb) => {
    if (/\.(jpe?g|png|webp|gif|heic)$/i.test(path.extname(file.originalname)))
      cb(null, true);
    else
      cb(new Error('Only image files are allowed (jpg, png, webp, gif, heic)'));
  },
});

// POST /api/menu/upload-image
router.post('/upload-image', authenticate, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Return both a relative path (for web proxy) and a full URL (for native app)
  const relativePath = `/uploads/menu/${req.file.filename}`;
  const fullUrl      = `${req.protocol}://${req.get('host')}${relativePath}`;
  res.json({ url: relativePath, fullUrl, filename: req.file.filename });
});

// ── Auto-migration: create menu_item_ingredients table if it doesn't exist ─────
;(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS menu_item_ingredients (
        menu_item_id  UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
        ingredient_id UUID NOT NULL REFERENCES warehouse_items(id) ON DELETE CASCADE,
        quantity_used NUMERIC(10,2) NOT NULL DEFAULT 1,
        PRIMARY KEY (menu_item_id, ingredient_id)
      )
    `);
    console.log('menu_item_ingredients table ready');
  } catch (e) { console.error('menu_item_ingredients migration error:', e.message); }
})();

// ── Auto-migration: add item_type, kitchen_station, sort_order, unit to menu_items ───
;(async () => {
  try {
    await db.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) DEFAULT 'food'`);
    await db.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS kitchen_station VARCHAR(50) DEFAULT NULL`);
    await db.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
    await db.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS unit VARCHAR(10) DEFAULT 'piece'`);
    await db.query(`UPDATE menu_items SET unit = 'piece' WHERE unit IS NULL`);
    await db.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`);
    // Allow fractional quantities (kg / l items)
    await db.query(`ALTER TABLE order_items ALTER COLUMN quantity TYPE NUMERIC(10,3) USING quantity::numeric`);
  } catch (e) { console.error('menu migration error:', e.message); }
})();

// ── Auto-migration: custom_stations table (with restaurant_id for multi-tenancy) ──────
;(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS custom_stations (
        id            SERIAL PRIMARY KEY,
        restaurant_id UUID NOT NULL,
        name          VARCHAR(50) NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (restaurant_id, name)
      )
    `);
    console.log('custom_stations table ready');
  } catch (e) { console.error('custom_stations migration error:', e.message); }
})();

// GET /api/menu/stations — returns all custom station names for this restaurant
router.get('/stations', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      'SELECT name FROM custom_stations WHERE restaurant_id = $1 ORDER BY created_at',
      [restaurant_id]
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/menu/stations — add a custom station for this restaurant
router.post('/stations', authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const restaurant_id = rid(req);
    await db.query(
      'INSERT INTO custom_stations (restaurant_id, name) VALUES ($1, $2) ON CONFLICT (restaurant_id, name) DO NOTHING',
      [restaurant_id, String(name).trim()]
    );
    const result = await db.query(
      'SELECT name FROM custom_stations WHERE restaurant_id = $1 ORDER BY created_at',
      [restaurant_id]
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/menu/stations/:name — remove a custom station for this restaurant
// Blocks deletion if active staff members are assigned to this station.
router.delete('/stations/:name', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    // Check if any active staff is assigned to this station
    const staffCheck = await db.query(
      'SELECT name, role FROM users WHERE LOWER(kitchen_station) = LOWER($1) AND is_active = true AND restaurant_id = $2',
      [req.params.name, restaurant_id]
    );
    if (staffCheck.rows.length > 0) {
      const names = staffCheck.rows.map(r => r.name).join(', ');
      return res.status(409).json({
        error: `Cannot delete — ${staffCheck.rows.length} active staff assigned to this station: ${names}. Reassign them to a different station first.`,
        staffCount: staffCheck.rows.length,
        staffNames: names,
      });
    }
    await db.query(
      'DELETE FROM custom_stations WHERE LOWER(name)=LOWER($1) AND restaurant_id=$2',
      [req.params.name, restaurant_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/menu/categories
router.get('/categories', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, name',
      [restaurant_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/menu/categories
router.post('/categories', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { name, sort_order } = req.body;
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING *',
      [restaurant_id, name, sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/menu/items
router.get('/items', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    const { category_id, available_only } = req.query;
    let query = `
      SELECT m.*, c.name as category_name
      FROM menu_items m
      LEFT JOIN categories c ON m.category_id = c.id
      WHERE m.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (category_id) { params.push(category_id); query += ` AND m.category_id=$${params.length}`; }
    if (available_only === 'true') query += ' AND m.is_available=true';
    query += ' ORDER BY c.sort_order, m.sort_order, m.name';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/menu/items/:id
router.get('/items/:id', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      'SELECT m.*, c.name as category_name FROM menu_items m LEFT JOIN categories c ON m.category_id=c.id WHERE m.id=$1 AND m.restaurant_id=$2',
      [req.params.id, restaurant_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Allowed unit values — anything else is normalised to 'piece'
const ALLOWED_UNITS = new Set(['piece', 'kg', 'l', 'g', 'ml']);
const normaliseUnit = (u) => {
  const v = String(u || '').toLowerCase().trim();
  return ALLOWED_UNITS.has(v) ? v : 'piece';
};

// POST /api/menu/items
router.post('/items', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { category_id, name, description, price, image_url, item_type, kitchen_station, unit } = req.body;
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, image_url, item_type, kitchen_station, unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [restaurant_id, category_id, name, description, price, image_url, item_type || 'food', kitchen_station || null, normaliseUnit(unit)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/menu/items/:id
router.put('/items/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { category_id, name, description, price, image_url, is_available, available, item_type, kitchen_station, sort_order, unit } = req.body;
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      `UPDATE menu_items
       SET category_id=$1, name=$2, description=$3, price=$4, image_url=$5,
           is_available=$6, item_type=$7, kitchen_station=$8, sort_order=COALESCE($9, sort_order),
           unit=COALESCE($10, unit), updated_at=NOW()
       WHERE id=$11 AND restaurant_id=$12 RETURNING *`,
      [
        category_id, name, description, price, image_url,
        is_available ?? available ?? true,
        item_type || 'food',
        kitchen_station || null,
        sort_order !== undefined ? sort_order : null,
        unit !== undefined ? normaliseUnit(unit) : null,
        req.params.id,
        restaurant_id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/menu/items/:id
router.delete('/items/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurant_id = rid(req);
    await db.query('DELETE FROM menu_items WHERE id=$1 AND restaurant_id=$2', [req.params.id, restaurant_id]);
    res.json({ message: 'Item deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/menu/items/:id/warehouse_items
router.get('/items/:id/warehouse_items', authenticate, async (req, res) => {
  try {
    const restaurant_id = rid(req);
    const result = await db.query(
      `SELECT mii.menu_item_id, mii.ingredient_id,
              mii.quantity_used AS quantity,
              i.name AS ingredient_name, i.unit
       FROM menu_item_ingredients mii
       JOIN warehouse_items i ON mii.ingredient_id = i.id
       JOIN menu_items m ON mii.menu_item_id = m.id
       WHERE mii.menu_item_id = $1 AND m.restaurant_id = $2`,
      [req.params.id, restaurant_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/menu/items/:id/warehouse_items
router.post('/items/:id/warehouse_items', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { ingredient_id, quantity } = req.body;
  try {
    const restaurant_id = rid(req);
    // Verify menu_item exists and belongs to this restaurant
    const menuCheck = await db.query(
      'SELECT id FROM menu_items WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, restaurant_id]
    );
    if (!menuCheck.rows[0]) return res.status(404).json({ error: 'Menu item not found' });

    // Verify ingredient exists and belongs to this restaurant
    const ingredientCheck = await db.query(
      'SELECT id FROM warehouse_items WHERE id = $1 AND restaurant_id = $2',
      [ingredient_id, restaurant_id]
    );
    if (!ingredientCheck.rows[0]) return res.status(404).json({ error: 'Ingredient not found' });

    const result = await db.query(
      `INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity_used)
       VALUES ($1, $2, $3)
       ON CONFLICT (menu_item_id, ingredient_id) DO UPDATE SET quantity_used = $3
       RETURNING *`,
      [req.params.id, ingredient_id, quantity]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/menu/items/:id/warehouse_items/:ingId
router.delete('/items/:id/warehouse_items/:ingId', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurant_id = rid(req);
    // Verify menu_item belongs to this restaurant
    const menuCheck = await db.query(
      'SELECT id FROM menu_items WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, restaurant_id]
    );
    if (!menuCheck.rows[0]) return res.status(404).json({ error: 'Menu item not found' });

    await db.query(
      'DELETE FROM menu_item_ingredients WHERE menu_item_id=$1 AND ingredient_id=$2',
      [req.params.id, req.params.ingId]
    );
    res.json({ message: 'Ingredient removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/menu/categories/:id
router.put('/categories/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  // Accept sort_order (website) and display_order (app legacy) interchangeably
  const { name, sort_order, display_order } = req.body;
  const newSortOrder = sort_order !== undefined ? sort_order : display_order;
  try {
    const restaurant_id = rid(req);
    // Fetch current values first so we never overwrite with undefined/null
    const current = await db.query(
      'SELECT * FROM categories WHERE id=$1 AND restaurant_id=$2',
      [req.params.id, restaurant_id]
    );
    if (!current.rows[0]) return res.status(404).json({ error: 'Category not found' });
    const cur = current.rows[0];
    const result = await db.query(
      'UPDATE categories SET name=$1, sort_order=$2 WHERE id=$3 AND restaurant_id=$4 RETURNING *',
      [
        (name !== undefined && name !== null) ? name : cur.name,
        newSortOrder !== undefined ? Number(newSortOrder) : cur.sort_order,
        req.params.id,
        restaurant_id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/menu/categories/:id
router.delete('/categories/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const restaurant_id = rid(req);
    await db.query('DELETE FROM categories WHERE id=$1 AND restaurant_id=$2', [req.params.id, restaurant_id]);
    res.json({ message: 'Category deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
