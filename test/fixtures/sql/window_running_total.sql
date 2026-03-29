-- Running total of orders per user using window function.
SELECT
  o.id,
  u.name,
  o.total,
  o.created_at,
  sum(o.total) OVER (
    PARTITION BY o.user_id
    ORDER BY o.created_at
  )::numeric(10,2) AS running_total
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status != 'cancelled'
ORDER BY u.name, o.created_at
