-- Get a single todo by id.
SELECT id, title, description, priority, done, created_at, completed_at
FROM todo
WHERE id = $1
