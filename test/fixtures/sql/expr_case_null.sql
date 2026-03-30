-- CASE with ELSE NULL is always nullable.
SELECT
  id,
  CASE WHEN active THEN name ELSE NULL END AS maybe_name
FROM users
WHERE id = $1
