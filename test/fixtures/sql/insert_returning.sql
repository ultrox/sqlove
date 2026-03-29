-- Insert with RETURNING — not a mutation.
INSERT INTO users (name, email) VALUES ($1, $2)
RETURNING id, name, created_at
