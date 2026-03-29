-- Test schema. Applied before tests run.
-- When a new edge case breaks us, add the table here
-- and the query in fixtures/sql/.

-- ── Enums ────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'member', 'guest');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE todo_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ── Users ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  bio text,
  age int,
  active boolean NOT NULL DEFAULT true,
  role user_role NOT NULL DEFAULT 'member',
  manager_id int REFERENCES users(id),
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ── Products ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  parent_id int REFERENCES categories(id),
  description text
);

CREATE TABLE IF NOT EXISTS products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  price numeric(10,2) NOT NULL,
  category_id int REFERENCES categories(id),
  in_stock boolean NOT NULL DEFAULT true,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Orders ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  status order_status NOT NULL DEFAULT 'pending',
  total numeric(10,2) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  shipped_at timestamptz,
  delivered_at timestamptz
);

CREATE TABLE IF NOT EXISTS line_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  product_id int NOT NULL REFERENCES products(id),
  quantity int NOT NULL DEFAULT 1,
  unit_price numeric(10,2) NOT NULL
);

-- ── Payments ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  amount numeric(10,2) NOT NULL,
  method text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id serial PRIMARY KEY,
  payment_id int NOT NULL REFERENCES payments(id),
  order_id int NOT NULL REFERENCES orders(id),
  amount numeric(10,2) NOT NULL,
  reason text,
  refunded_at timestamptz NOT NULL DEFAULT now()
);

-- ── Reviews ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  product_id int NOT NULL REFERENCES products(id),
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);

-- ── Tags (many-to-many) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS tags (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS user_tags (
  user_id int NOT NULL REFERENCES users(id),
  tag_id int NOT NULL REFERENCES tags(id),
  PRIMARY KEY (user_id, tag_id)
);

-- ── Todos (for existing tests) ──────────────────────────

CREATE TABLE IF NOT EXISTS todo (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  done boolean NOT NULL DEFAULT false,
  priority todo_priority NOT NULL DEFAULT 'medium',
  tags text[] NOT NULL DEFAULT '{}',
  due_date date,
  share_with text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
