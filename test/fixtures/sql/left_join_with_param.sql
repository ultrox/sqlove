-- LEFT JOIN where the NOT NULL right side column must be nullable.
-- The WHERE clause uses a param which collapses the plan with NULL.
SELECT u.name, o.total
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.id = $1
