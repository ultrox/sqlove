-- Test schema. Applied once before tests run.
-- When a new edge case breaks us, add the table here
-- and the query in fixtures/sql/.

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  bio text,
  age int,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  total numeric(10,2) NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'member', 'guest');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'member';

CREATE TABLE IF NOT EXISTS tags (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id int REFERENCES users(id);

CREATE TABLE IF NOT EXISTS user_tags (
  user_id int NOT NULL REFERENCES users(id),
  tag_id int NOT NULL REFERENCES tags(id),
  PRIMARY KEY (user_id, tag_id)
);

CREATE TABLE IF NOT EXISTS line_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  product_id int NOT NULL,
  quantity int NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  sku text NOT NULL,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  amount numeric(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS todo (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

DO $$ BEGIN
  CREATE TYPE todo_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE todo ADD COLUMN IF NOT EXISTS priority todo_priority NOT NULL DEFAULT 'medium';
ALTER TABLE todo ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE todo ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE todo ADD COLUMN IF NOT EXISTS share_with text;
