-- Insert into nullable column — param should be T | null.
INSERT INTO users (name, email, bio) VALUES ($1, $2, $3)
RETURNING id
