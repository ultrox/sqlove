-- Mark a todo as done.
UPDATE todo
SET done = true, completed_at = now()
WHERE id = $1 AND done = false
RETURNING id, title, priority, done, completed_at
