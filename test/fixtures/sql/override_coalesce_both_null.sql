-- coalesce(bio, notes) where both are nullable.
-- AST checks all args: both are nullable ColumnRefs → result nullable.
-- No ? needed — auto-detected.
SELECT u.id, coalesce(u.bio, o.notes) AS fallback
FROM users u LEFT JOIN orders o ON o.user_id = u.id
WHERE u.id = $1
