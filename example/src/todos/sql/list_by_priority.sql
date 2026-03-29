-- List todos filtered by priority.
SELECT id, title, priority, done, created_at
FROM todo
WHERE priority = $1::todo_priority
ORDER BY created_at DESC
