-- v10: add sort_order to menu_items for manual reordering
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- Initialize sort_order based on current name ordering per category
UPDATE menu_items m
SET sort_order = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY name) - 1 AS rn
  FROM menu_items
) sub
WHERE m.id = sub.id;
