-- ============================================================
-- Migration v7: Kitchen Stations
-- Each menu item can belong to a station (salad, grill, bar, etc.)
-- Each kitchen user can be assigned to a station
-- NULL = general / sees everything
-- ============================================================

-- Add station to menu items
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS kitchen_station VARCHAR(30) DEFAULT NULL;

-- Add station to kitchen users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kitchen_station VARCHAR(30) DEFAULT NULL;

SELECT 'Migration v7 (Kitchen Stations) complete!' AS result;
