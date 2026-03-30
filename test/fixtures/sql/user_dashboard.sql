-- User dashboard: profile, order count, total spent, latest order.
SELECT
  u.id,
  u.name,
  u.email,
  u.role,
  u.tags,
  count(o.id)::int AS order_count,
  coalesce(sum(o.total), 0)::numeric(10,2) AS total_spent,
  max(o.created_at) AS last_order_at
FROM users u
LEFT JOIN orders o ON o.user_id = u.id AND o.status != 'cancelled'
WHERE u.id = $1
GROUP BY u.id
