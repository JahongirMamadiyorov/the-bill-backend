const express  = require('express');
const router   = express.Router();
const db       = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

const ALLOWED_ROLES = ['admin', 'owner', 'super_admin'];

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', authenticate, authorize(...ALLOWED_ROLES), async (req, res) => {
  try {
    const restaurantId = rid(req);
    let result = await db.query(
      'SELECT * FROM restaurant_settings WHERE restaurant_id = $1',
      [restaurantId]
    );

    if (result.rows.length === 0) {
      const insert = await db.query(
        `INSERT INTO restaurant_settings (restaurant_id)
         VALUES ($1)
         RETURNING *`,
        [restaurantId]
      );
      return res.json(insert.rows[0]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET /settings error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
router.put('/', authenticate, authorize(...ALLOWED_ROLES), async (req, res) => {
  try {
    const restaurantId = rid(req);
    const {
      restaurant_name,
      address,
      phone,
      logo_url,
      currency_symbol,
      receipt_header,
      receipt_footer,
      // Financial
      tax_rate,
      tax_enabled,
      service_charge_rate,
      service_charge_enabled,
      // Printers (JSONB arrays)
      receipt_printers,
      kitchen_printers,
      // Receipt toggles
      receipt_show_logo,
      receipt_show_tax,
      receipt_show_service_charge,
      receipt_show_footer,
      receipt_show_order_number,
      receipt_show_table_name,
      // Kitchen toggles
      kitchen_show_table_name,
      kitchen_show_order_number,
      kitchen_show_customer_name,
      kitchen_show_notes,
      kitchen_show_timestamp,
      kitchen_show_order_type,
      kitchen_show_item_price,
      kitchen_show_qty_unit,
    } = req.body;

    const result = await db.query(
      `INSERT INTO restaurant_settings (
         restaurant_id, restaurant_name, address, phone, logo_url, currency_symbol,
         receipt_header, receipt_footer,
         tax_rate, tax_enabled, service_charge_rate, service_charge_enabled,
         receipt_printers, kitchen_printers,
         receipt_show_logo, receipt_show_tax, receipt_show_service_charge,
         receipt_show_footer, receipt_show_order_number, receipt_show_table_name,
         kitchen_show_table_name, kitchen_show_order_number, kitchen_show_customer_name,
         kitchen_show_notes, kitchen_show_timestamp,
         kitchen_show_order_type, kitchen_show_item_price, kitchen_show_qty_unit,
         updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         $13::jsonb, $14::jsonb,
         $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,now()
       )
       ON CONFLICT (restaurant_id) DO UPDATE SET
         restaurant_name         = EXCLUDED.restaurant_name,
         address                 = EXCLUDED.address,
         phone                   = EXCLUDED.phone,
         logo_url                = EXCLUDED.logo_url,
         currency_symbol         = EXCLUDED.currency_symbol,
         receipt_header          = EXCLUDED.receipt_header,
         receipt_footer          = EXCLUDED.receipt_footer,
         tax_rate                = EXCLUDED.tax_rate,
         tax_enabled             = EXCLUDED.tax_enabled,
         service_charge_rate     = EXCLUDED.service_charge_rate,
         service_charge_enabled  = EXCLUDED.service_charge_enabled,
         receipt_printers             = EXCLUDED.receipt_printers,
         kitchen_printers             = EXCLUDED.kitchen_printers,
         receipt_show_logo            = EXCLUDED.receipt_show_logo,
         receipt_show_tax             = EXCLUDED.receipt_show_tax,
         receipt_show_service_charge  = EXCLUDED.receipt_show_service_charge,
         receipt_show_footer          = EXCLUDED.receipt_show_footer,
         receipt_show_order_number    = EXCLUDED.receipt_show_order_number,
         receipt_show_table_name      = EXCLUDED.receipt_show_table_name,
         kitchen_show_table_name      = EXCLUDED.kitchen_show_table_name,
         kitchen_show_order_number    = EXCLUDED.kitchen_show_order_number,
         kitchen_show_customer_name   = EXCLUDED.kitchen_show_customer_name,
         kitchen_show_notes           = EXCLUDED.kitchen_show_notes,
         kitchen_show_timestamp       = EXCLUDED.kitchen_show_timestamp,
         kitchen_show_order_type      = EXCLUDED.kitchen_show_order_type,
         kitchen_show_item_price      = EXCLUDED.kitchen_show_item_price,
         kitchen_show_qty_unit        = EXCLUDED.kitchen_show_qty_unit,
         updated_at              = now()
       RETURNING *`,
      [
        restaurantId,
        restaurant_name        ?? null,
        address                ?? null,
        phone                  ?? null,
        logo_url               ?? null,
        currency_symbol        ?? "so'm",
        receipt_header         ?? null,
        receipt_footer         ?? null,
        tax_rate               ?? 0,
        tax_enabled            ?? false,
        service_charge_rate    ?? 0,
        service_charge_enabled ?? false,
        JSON.stringify(receipt_printers ?? []),
        JSON.stringify(kitchen_printers ?? []),
        receipt_show_logo            ?? true,
        receipt_show_tax             ?? true,
        receipt_show_service_charge  ?? true,
        receipt_show_footer          ?? true,
        receipt_show_order_number    ?? true,
        receipt_show_table_name      ?? true,
        kitchen_show_table_name      ?? true,
        kitchen_show_order_number    ?? true,
        kitchen_show_customer_name   ?? true,
        kitchen_show_notes           ?? true,
        kitchen_show_timestamp       ?? true,
        kitchen_show_order_type      ?? true,
        kitchen_show_item_price      ?? false,
        kitchen_show_qty_unit        ?? true,
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('PUT /settings error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
