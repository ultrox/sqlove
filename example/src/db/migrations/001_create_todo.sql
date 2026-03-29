DO $$ BEGIN
  CREATE TYPE todo_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS todo (
  id serial PRIMARY KEY,
  title text NOT NULL,
  description text,
  priority todo_priority NOT NULL DEFAULT 'medium',
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
