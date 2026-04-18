-- ============================================================
--  RESTAURANT APP - PostgreSQL Database Schema
--  Multi-Restaurant Architecture
--  Roles: Owner, Admin, Cashier, Waitress, Kitchen, Manager, Cleaner
-- ============================================================

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- RESTAURANTS (master table - every other table references this)
-- ============================================================

CREATE TABLE restaurants (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(200) NOT NULL,
  slug         VARCHAR(100) UNIQUE NOT NULL,   -- url-friendly identifier
  address      TEXT,
  phone        VARCHAR(30),
  logo_url     TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  -- Subscription
  plan         VARCHAR(20) DEFAULT 'trial' CHECK (plan IN ('trial','monthly','6month','12month','vip')),
  plan_started_at  TIMESTAMPTZ DEFAULT NOW(),
  plan_expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),  -- trial = 30 days
  plan_price       DECIMAL(10,2) DEFAULT 0,       -- price paid (monthly rate)
  plan_total       DECIMAL(10,2) DEFAULT 0,       -- total amount for full period
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUBSCRIPTION HISTORY (payment log)
-- ============================================================

CREATE TABLE subscription_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  plan            VARCHAR(20) NOT NULL,
  price_monthly   DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_amount    DECIMAL(10,2) NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USERS & AUTH
-- ============================================================

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID REFERENCES restaurants(id) ON DELETE CASCADE,   -- NULL for super_admin
  name            VARCHAR(100) NOT NULL,
  email           VARCHAR(150) NOT NULL,
  phone           VARCHAR(30),
  password_hash   TEXT NOT NULL,
  role            VARCHAR(20) NOT NULL CHECK (role IN ('super_admin','owner','admin','cashier','waitress','kitchen','manager','cleaner')),
  is_active       BOOLEAN DEFAULT TRUE,
  salary          DECIMAL(12,2),
  salary_type     VARCHAR(20) DEFAULT 'monthly',
  shift_start     VARCHAR(10),
  shift_end       VARCHAR(10),
  kitchen_station VARCHAR(50),
  commission_rate DECIMAL(5,2),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, email),
  UNIQUE(restaurant_id, phone)
);

-- ============================================================
-- WAITRESS PERMISSIONS (controlled by Admin)
-- ============================================================

CREATE TABLE waitress_permissions (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id               UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  can_create_orders           BOOLEAN DEFAULT TRUE,
  can_modify_orders           BOOLEAN DEFAULT TRUE,
  can_cancel_orders           BOOLEAN DEFAULT FALSE,
  can_delete_order_items      BOOLEAN DEFAULT FALSE,
  can_add_free_items          BOOLEAN DEFAULT FALSE,
  can_apply_discounts         BOOLEAN DEFAULT FALSE,
  can_set_custom_price        BOOLEAN DEFAULT FALSE,
  can_process_payments        BOOLEAN DEFAULT TRUE,
  can_split_bills             BOOLEAN DEFAULT TRUE,
  can_issue_refunds           BOOLEAN DEFAULT FALSE,
  can_open_close_table        BOOLEAN DEFAULT TRUE,
  can_transfer_table          BOOLEAN DEFAULT TRUE,
  can_merge_tables            BOOLEAN DEFAULT FALSE,
  can_see_other_tables        BOOLEAN DEFAULT FALSE,
  can_see_sales_numbers       BOOLEAN DEFAULT FALSE,
  can_see_customer_history    BOOLEAN DEFAULT FALSE,
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLES (restaurant floor plan)
-- ============================================================

CREATE TABLE table_sections (
  id              SERIAL PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  UNIQUE(restaurant_id, name)
);

CREATE TABLE restaurant_tables (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_number      INT NOT NULL,
  name              VARCHAR(100),
  capacity          INT DEFAULT 4,
  status            VARCHAR(20) DEFAULT 'free' CHECK (status IN ('free','occupied','reserved','closed','cleaning')),
  section           VARCHAR(50) DEFAULT 'Indoor',
  shape             VARCHAR(20) DEFAULT 'Square',
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at         TIMESTAMP,
  guests_count      INT,
  reservation_guest VARCHAR(100),
  reservation_phone VARCHAR(30),
  reservation_date  DATE,
  reservation_time  VARCHAR(10),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, table_number)
);

-- ============================================================
-- MENU
-- ============================================================

CREATE TABLE categories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  sort_order      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE menu_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
  name            VARCHAR(150) NOT NULL,
  description     TEXT,
  price           NUMERIC(10,2) NOT NULL,
  image_url       TEXT,
  is_available    BOOLEAN DEFAULT TRUE,
  item_type       VARCHAR(20) DEFAULT 'food' CHECK (item_type IN ('food','sale')),
  kitchen_station VARCHAR(30),
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE custom_stations (
  id              SERIAL PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            VARCHAR(50) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, name)
);

-- ============================================================
-- ORDERS
-- ============================================================

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id         UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  waitress_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  status           VARCHAR(30) DEFAULT 'pending' CHECK (status IN ('pending','sent_to_kitchen','preparing','ready','served','paid','cancelled')),
  notes            TEXT,
  order_type       VARCHAR(20) DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
  guest_count      INTEGER,
  customer_name    VARCHAR(100),
  customer_phone   VARCHAR(30),
  delivery_address TEXT,
  delivery_status  VARCHAR(20) DEFAULT 'pending',
  daily_number     INTEGER,
  discount_amount  NUMERIC(10,2) DEFAULT 0,
  tax_amount       NUMERIC(10,2) DEFAULT 0,
  total_amount     NUMERIC(10,2) DEFAULT 0,
  payment_method   VARCHAR(30) CHECK (payment_method IN ('cash','card','online','split')),
  paid_at          TIMESTAMP,
  paid_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  split_payments   JSONB,
  cancellation_reason TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE order_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  quantity     INT NOT NULL DEFAULT 1,
  unit_price   NUMERIC(10,2) NOT NULL,
  custom_price NUMERIC(10,2),
  is_free      BOOLEAN DEFAULT FALSE,
  notes        TEXT,
  status       VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','preparing','ready','served')),
  item_ready   BOOLEAN DEFAULT FALSE,
  served_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CUSTOMERS
-- ============================================================

CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            VARCHAR(100),
  phone           VARCHAR(30),
  email           VARCHAR(150),
  loyalty_pts     INT DEFAULT 0,
  visit_count     INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, phone)
);

-- ============================================================
-- SUPPLIERS
-- ============================================================

CREATE TABLE suppliers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            VARCHAR(150) NOT NULL,
  phone           VARCHAR(30),
  email           VARCHAR(150),
  address         TEXT,
  contact_name    TEXT,
  payment_terms   TEXT,
  category        TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INVENTORY / WAREHOUSE
-- ============================================================

CREATE TABLE warehouse_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name              VARCHAR(150) NOT NULL,
  category          VARCHAR(50),
  sku_code          VARCHAR(100),
  unit              VARCHAR(30),
  purchase_unit     VARCHAR(30),
  quantity_in_stock NUMERIC(10,2) DEFAULT 0,
  min_stock_level   NUMERIC(10,2) DEFAULT 5,
  low_stock_alert   NUMERIC(10,2) DEFAULT 5,
  cost_per_unit     NUMERIC(10,2) DEFAULT 0,
  supplier_id       UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, sku_code)
);

CREATE TABLE stock_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_id         UUID REFERENCES warehouse_items(id) ON DELETE CASCADE,
  type            VARCHAR(20) NOT NULL CHECK (type IN ('IN','OUT','ADJUST','WASTE')),
  quantity        NUMERIC(10,2) NOT NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  reason          TEXT,
  notes           TEXT,
  cost_per_unit   NUMERIC(12,4),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stock_batches (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id      UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  item_id            UUID REFERENCES warehouse_items(id) ON DELETE CASCADE,
  quantity_remaining NUMERIC(10,2) NOT NULL,
  cost_price         NUMERIC(12,4),
  expiry_date        DATE,
  received_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE menu_item_ingredients (
  menu_item_id  UUID REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_id UUID REFERENCES warehouse_items(id) ON DELETE CASCADE,
  quantity_used NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (menu_item_id, ingredient_id)
);

-- ============================================================
-- INVENTORY AUDITS
-- ============================================================

CREATE TABLE inventory_audits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  auditor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  status          VARCHAR(20) DEFAULT 'completed',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inventory_audit_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  audit_id        UUID NOT NULL REFERENCES inventory_audits(id) ON DELETE CASCADE,
  item_id         UUID REFERENCES warehouse_items(id) ON DELETE CASCADE,
  expected_qty    NUMERIC(10,2),
  actual_qty      NUMERIC(10,2),
  variance        NUMERIC(10,2),
  variance_reason TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROCUREMENT
-- ============================================================

CREATE TABLE purchase_orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_id     UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  total_cost      NUMERIC(10,2) DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','received','partial')),
  notes           TEXT,
  ordered_at      TIMESTAMPTZ DEFAULT NOW(),
  received_at     TIMESTAMP
);

CREATE TABLE purchase_order_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ingredient_id     UUID REFERENCES warehouse_items(id) ON DELETE SET NULL,
  quantity          NUMERIC(10,2) NOT NULL,
  unit_cost         NUMERIC(10,2) NOT NULL
);

CREATE TABLE supplier_deliveries (
  id              TEXT PRIMARY KEY,
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  supplier_name   TEXT,
  supplier_id     INTEGER,
  total           NUMERIC(14,2),
  status          TEXT DEFAULT 'Delivered',
  payment_status  TEXT DEFAULT 'unpaid',
  notes           TEXT,
  timestamp       DATE,
  paid_at         TIMESTAMPTZ,
  payment_method  TEXT,
  payment_note    TEXT,
  payment_due_date DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE delivery_items (
  id              SERIAL PRIMARY KEY,
  delivery_id     TEXT,
  item_name       TEXT,
  qty             NUMERIC(12,2),
  unit            TEXT DEFAULT 'piece',
  unit_price      NUMERIC(14,2),
  expiry_date     DATE,
  removed         BOOLEAN DEFAULT FALSE,
  remove_reason   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ACCOUNTING & FINANCE
-- ============================================================

CREATE TABLE expenses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category        VARCHAR(100) NOT NULL,
  description     TEXT,
  amount          NUMERIC(10,2) NOT NULL,
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  receipt_url     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE cash_flow (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  type            VARCHAR(10) NOT NULL CHECK (type IN ('in','out')),
  amount          NUMERIC(10,2) NOT NULL,
  description     TEXT,
  recorded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Finance module tables
CREATE TABLE finance_expenses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category        VARCHAR(50),
  amount          NUMERIC(12,2),
  date            DATE,
  description     TEXT,
  recurring       BOOLEAN DEFAULT FALSE,
  frequency       VARCHAR(20),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_loans (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  lender_name     VARCHAR(150),
  total_amount    NUMERIC(12,2),
  amount_paid     NUMERIC(12,2) DEFAULT 0,
  interest_rate   NUMERIC(5,2),
  due_date        DATE,
  notes           TEXT,
  status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','paid','overdue')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_loan_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  loan_id         UUID REFERENCES finance_loans(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2),
  payment_date    DATE,
  method          VARCHAR(30),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_budgets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category        VARCHAR(50),
  monthly_budget  NUMERIC(12,2),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(restaurant_id, category)
);

CREATE TABLE finance_manual_income (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2),
  category        VARCHAR(50) DEFAULT 'Sales',
  date            DATE,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- STAFF SHIFTS & PAYROLL
-- ============================================================

CREATE TABLE shifts (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id        UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id              UUID REFERENCES users(id) ON DELETE CASCADE,
  scheduled_start_time TIMESTAMP,
  status               VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present','absent','late','excused')),
  clock_in             TIMESTAMP,
  clock_out            TIMESTAMP,
  hourly_rate          NUMERIC(10,2) DEFAULT 0,
  hours_worked         NUMERIC(6,2),
  note                 TEXT,
  shift_date           DATE,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE staff_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount          NUMERIC(10,2) NOT NULL,
  payment_method  VARCHAR(30) DEFAULT 'cash' CHECK (payment_method IN ('cash','bank_transfer','check','other')),
  payment_date    DATE NOT NULL,
  note            TEXT,
  recorded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CUSTOMER LOANS (cashier-managed)
-- ============================================================

CREATE TABLE loans (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  due_date        DATE,
  amount          NUMERIC(12,2),
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','paid')),
  paid_at         TIMESTAMPTZ,
  payment_method  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TAX SETTINGS
-- ============================================================

CREATE TABLE tax_settings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  rate            NUMERIC(5,2) NOT NULL,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RESTAURANT SETTINGS
-- ============================================================

CREATE TABLE restaurant_settings (
  id                      SERIAL PRIMARY KEY,
  restaurant_id           UUID NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  restaurant_name         TEXT,
  receipt_header          TEXT,
  service_charge_rate     NUMERIC DEFAULT 0,
  service_charge_enabled  BOOLEAN DEFAULT FALSE,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  action          VARCHAR(200) NOT NULL,
  table_name      VARCHAR(100),
  record_id       UUID,
  details         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  body            TEXT,
  type            VARCHAR(50),
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PERFORMANCE INDEXES
-- ============================================================

CREATE INDEX idx_users_restaurant        ON users(restaurant_id);
CREATE INDEX idx_orders_restaurant       ON orders(restaurant_id);
CREATE INDEX idx_orders_status           ON orders(restaurant_id, status);
CREATE INDEX idx_orders_paid_at          ON orders(restaurant_id, paid_at);
CREATE INDEX idx_order_items_order       ON order_items(order_id);
CREATE INDEX idx_menu_items_restaurant   ON menu_items(restaurant_id);
CREATE INDEX idx_menu_items_category     ON menu_items(restaurant_id, category_id);
CREATE INDEX idx_categories_restaurant   ON categories(restaurant_id);
CREATE INDEX idx_tables_restaurant       ON restaurant_tables(restaurant_id);
CREATE INDEX idx_warehouse_restaurant    ON warehouse_items(restaurant_id);
CREATE INDEX idx_expenses_restaurant     ON expenses(restaurant_id, expense_date);
CREATE INDEX idx_cash_flow_restaurant    ON cash_flow(restaurant_id);
CREATE INDEX idx_shifts_restaurant       ON shifts(restaurant_id, user_id);
CREATE INDEX idx_loans_restaurant        ON loans(restaurant_id);
CREATE INDEX idx_suppliers_restaurant    ON suppliers(restaurant_id);
CREATE INDEX idx_notifications_user      ON notifications(user_id, is_read);
CREATE INDEX idx_fin_expenses_rest_date  ON finance_expenses(restaurant_id, date);
CREATE INDEX idx_fin_loans_rest          ON finance_loans(restaurant_id);
CREATE INDEX idx_fin_loan_pay_loan       ON finance_loan_payments(loan_id);
CREATE INDEX idx_fin_budgets_rest        ON finance_budgets(restaurant_id);
CREATE INDEX idx_fin_manual_inc_rest     ON finance_manual_income(restaurant_id, date);
CREATE INDEX idx_deliveries_restaurant   ON supplier_deliveries(restaurant_id);

-- ============================================================
-- MATERIALIZED VIEWS
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS warehouse_valuation AS
SELECT
  wi.restaurant_id,
  wi.id AS item_id,
  wi.name,
  wi.quantity_in_stock,
  wi.cost_per_unit,
  (wi.quantity_in_stock * wi.cost_per_unit) AS total_value
FROM warehouse_items wi
WHERE wi.quantity_in_stock > 0;

-- ============================================================
-- SEED: 3 Test Restaurants
-- ============================================================

INSERT INTO restaurants (id, name, slug, address, phone, plan, plan_started_at, plan_expires_at, plan_price, plan_total) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'The Bill Central',  'the-bill-central',  '123 Main Street, Tashkent',   '+998 90 111 1111', 'trial', NOW(), NOW() + INTERVAL '30 days', 0, 0),
  ('a0000000-0000-0000-0000-000000000002', 'The Bill Express',  'the-bill-express',  '456 Market Ave, Tashkent',    '+998 90 222 2222', 'trial', NOW(), NOW() + INTERVAL '30 days', 0, 0),
  ('a0000000-0000-0000-0000-000000000003', 'The Bill Premium',  'the-bill-premium',  '789 Palace Road, Tashkent',   '+998 90 333 3333', 'vip',   NOW(), NULL, 0, 0)
ON CONFLICT DO NOTHING;

-- Seed default settings for each restaurant
INSERT INTO restaurant_settings (restaurant_id, restaurant_name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'The Bill Central'),
  ('a0000000-0000-0000-0000-000000000002', 'The Bill Express'),
  ('a0000000-0000-0000-0000-000000000003', 'The Bill Premium')
ON CONFLICT (restaurant_id) DO NOTHING;

-- Seed default tax settings for each restaurant
INSERT INTO tax_settings (restaurant_id, name, rate, is_active) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'VAT', 12.00, TRUE),
  ('a0000000-0000-0000-0000-000000000002', 'VAT', 12.00, TRUE),
  ('a0000000-0000-0000-0000-000000000003', 'VAT', 12.00, TRUE)
ON CONFLICT DO NOTHING;

-- Seed default table sections for each restaurant
INSERT INTO table_sections (restaurant_id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Indoor'),
  ('a0000000-0000-0000-0000-000000000001', 'Outdoor'),
  ('a0000000-0000-0000-0000-000000000001', 'Terrace'),
  ('a0000000-0000-0000-0000-000000000002', 'Indoor'),
  ('a0000000-0000-0000-0000-000000000002', 'Outdoor'),
  ('a0000000-0000-0000-0000-000000000003', 'Indoor'),
  ('a0000000-0000-0000-0000-000000000003', 'Outdoor'),
  ('a0000000-0000-0000-0000-000000000003', 'VIP')
ON CONFLICT (restaurant_id, name) DO NOTHING;

-- Seed super_admin user (email: admin@thebill.uz / password: admin123)
INSERT INTO users (id, restaurant_id, name, email, password_hash, role) VALUES
  ('b0000000-0000-0000-0000-000000000001', NULL, 'Super Admin', 'admin@thebill.uz',
   '$2a$10$qbFfImp3cmynRxOVJzY5mON2rpGdM3Y7TkDC7ggE7a2YKsaGCokgu', 'super_admin')
ON CONFLICT DO NOTHING;
