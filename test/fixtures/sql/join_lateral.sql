-- LATERAL join — nullable side depends on outer row.
SELECT u.name, recent.total
FROM users u
LEFT JOIN LATERAL (
  SELECT total FROM orders
  WHERE user_id = u.id
  ORDER BY created_at DESC
  LIMIT 1
) recent ON true
