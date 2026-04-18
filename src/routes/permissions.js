const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize, rid } = require('../middleware/auth');

// GET /api/permissions/:userId — get waitress permissions
router.get('/:userId', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const restaurantId = rid(req);
  try {
    const result = await db.query(
      'SELECT * FROM waitress_permissions WHERE user_id=$1 AND restaurant_id=$2', [req.params.userId, restaurantId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Permissions not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/permissions/:userId — update waitress permissions
router.put('/:userId', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const {
    can_create_orders, can_modify_orders, can_cancel_orders,
    can_delete_order_items, can_add_free_items, can_apply_discounts,
    can_set_custom_price, can_process_payments, can_split_bills,
    can_issue_refunds, can_open_close_table, can_transfer_table,
    can_merge_tables, can_see_other_tables, can_see_sales_numbers,
    can_see_customer_history
  } = req.body;
  const restaurantId = rid(req);

  try {
    const result = await db.query(`
      UPDATE waitress_permissions SET
        can_create_orders=$1, can_modify_orders=$2, can_cancel_orders=$3,
        can_delete_order_items=$4, can_add_free_items=$5, can_apply_discounts=$6,
        can_set_custom_price=$7, can_process_payments=$8, can_split_bills=$9,
        can_issue_refunds=$10, can_open_close_table=$11, can_transfer_table=$12,
        can_merge_tables=$13, can_see_other_tables=$14, can_see_sales_numbers=$15,
        can_see_customer_history=$16, updated_at=NOW()
      WHERE user_id=$17 AND restaurant_id=$18 RETURNING *`,
      [
        can_create_orders, can_modify_orders, can_cancel_orders,
        can_delete_order_items, can_add_free_items, can_apply_discounts,
        can_set_custom_price, can_process_payments, can_split_bills,
        can_issue_refunds, can_open_close_table, can_transfer_table,
        can_merge_tables, can_see_other_tables, can_see_sales_numbers,
        can_see_customer_history, req.params.userId, restaurantId
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Permissions not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
