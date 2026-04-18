-- v9: table_sections — shared section list across app and website
CREATE TABLE IF NOT EXISTS table_sections (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Seed the three default sections (ignore if they already exist)
INSERT INTO table_sections (name)
VALUES ('Indoor'), ('Outdoor'), ('Terrace')
ON CONFLICT (name) DO NOTHING;
