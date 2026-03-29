-- Multiple joins, mixed types.
SELECT u.name, o.total
FROM users u
JOIN orders o ON o.user_id = u.id
LEFT JOIN tags t ON t.id = 1
