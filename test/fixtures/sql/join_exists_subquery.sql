-- EXISTS subquery with inner LEFT JOIN — should not affect outer columns.
SELECT u.name
FROM users u
WHERE EXISTS (
  SELECT 1 FROM orders o
  LEFT JOIN refunds r ON r.order_id = o.id
  WHERE o.user_id = u.id
)
