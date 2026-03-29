-- Query using multiple enum types.
SELECT
  u.name,
  u.role,
  o.id AS order_id,
  o.status
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.role = $1::user_role
  AND o.status = $2::order_status
