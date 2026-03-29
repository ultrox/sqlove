-- UNION inside a subquery joined with LEFT.
SELECT u.name, combined.amount
FROM users u
LEFT JOIN (
  SELECT o.user_id, r.amount FROM refunds r JOIN orders o ON o.id = r.order_id
  UNION ALL
  SELECT user_id, total AS amount FROM orders
) combined ON combined.user_id = u.id
