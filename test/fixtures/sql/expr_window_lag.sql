-- lag() and lead() return null at boundaries.
SELECT
  name,
  lag(name) OVER (ORDER BY id) AS prev_name,
  lead(name) OVER (ORDER BY id) AS next_name
FROM users
