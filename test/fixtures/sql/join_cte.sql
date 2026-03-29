-- CTE with LEFT JOIN.
WITH active_users AS (
  SELECT id, name FROM users WHERE active = true
)
SELECT au.name, o.total
FROM active_users au
LEFT JOIN orders o ON o.user_id = au.id
