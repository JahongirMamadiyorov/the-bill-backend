-- Migration: Extend restaurant_tables with extra fields
-- Run once: psql -U postgres -d restaurant_db -f migrate_tables_v2.sql

-- Add UI/display columns
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS name               VARCHAR(100),
  ADD COLUMN IF NOT EXISTS section            VARCHAR(50)  DEFAULT 'Indoor',
  ADD COLUMN IF NOT EXISTS shape              VARCHAR(20)  DEFAULT 'Square',
  ADD COLUMN IF NOT EXISTS guests_count       INT,
  ADD COLUMN IF NOT EXISTS reservation_guest  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reservation_phone  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS reservation_date   DATE,
  ADD COLUMN IF NOT EXISTS reservation_time   VARCHAR(10);

-- Extend status check constraint to include 'cleaning'
ALTER TABLE restaurant_tables
  DROP CONSTRAINT IF EXISTS restaurant_tables_status_check;

ALTER TABLE restaurant_tables
  ADD CONSTRAINT restaurant_tables_status_check
  CHECK (status IN ('free', 'occupied', 'reserved', 'closed', 'cleaning'));

-- Backfill name for existing rows
UPDATE restaurant_tables
  SET name = 'Table ' || table_number
  WHERE name IS NULL;
