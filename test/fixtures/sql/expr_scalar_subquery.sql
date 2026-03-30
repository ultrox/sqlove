-- Scalar subquery can return null when no row matches.
SELECT
  u.name,
  (SELECT email FROM users u2 WHERE u2.id = u.manager_id) AS manager_email
FROM users u
WHERE u.id = $1
