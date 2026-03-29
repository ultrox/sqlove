-- Reopen a completed todo.
UPDATE todo
SET done = false, completed_at = null
WHERE id = $1 AND done = true
RETURNING id, title, priority, done
