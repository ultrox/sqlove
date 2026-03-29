-- This used to be a LEFT JOIN orders but we changed it.
SELECT u.name, o.total
FROM users u
JOIN orders o ON o.user_id = u.id
