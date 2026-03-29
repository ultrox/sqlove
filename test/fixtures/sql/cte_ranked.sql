-- Users ranked by total spend using a CTE.
WITH user_spend AS (
  SELECT user_id, sum(total)::numeric(10,2) AS total_spent
  FROM orders
  WHERE status != 'cancelled'
  GROUP BY user_id
)
SELECT u.name, u.email, us.total_spent,
       rank() OVER (ORDER BY us.total_spent DESC)::int AS rank
FROM users u
JOIN user_spend us ON us.user_id = u.id
