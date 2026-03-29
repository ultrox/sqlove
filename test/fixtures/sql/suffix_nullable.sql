-- Force nullable with ? suffix on a NOT NULL column.
SELECT
  u.name,
  max(o.created_at) AS "last_order_at?"
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id
