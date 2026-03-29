-- max() on LEFT JOIN can return null. Use ? suffix.
SELECT u.name, max(o.created_at) AS "last_order?"
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id
