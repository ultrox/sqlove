-- Subquery in LEFT JOIN.
SELECT u.name, o.total
FROM users u
LEFT JOIN (SELECT user_id, sum(total)::numeric(10,2) AS total FROM orders GROUP BY user_id) o
  ON o.user_id = u.id
