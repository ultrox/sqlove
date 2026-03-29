-- Each user with their 3 most recent orders (LATERAL).
SELECT u.name, recent.id AS order_id, recent.total, recent.status
FROM users u
LEFT JOIN LATERAL (
  SELECT id, total, status
  FROM orders
  WHERE user_id = u.id
  ORDER BY created_at DESC
  LIMIT 3
) recent ON true
WHERE u.active = true
