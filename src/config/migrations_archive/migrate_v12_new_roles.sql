-- Migration v12: Add new_cashier and new_waiter roles
-- Run this once against the live Supabase database.
-- Safe to run multiple times (constraint is dropped and re-added).

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'super_admin',
    'owner',
    'admin',
    'cashier',
    'waitress',
    'kitchen',
    'manager',
    'cleaner',
    'new_cashier',
    'new_waiter'
  ));
