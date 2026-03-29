-- List all todos, newest first.
SELECT id, title, priority, done, created_at
FROM todo
ORDER BY created_at DESC
