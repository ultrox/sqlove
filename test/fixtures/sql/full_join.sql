-- Full join: both sides become nullable.
SELECT users.name, orders.total
FROM users
FULL JOIN orders ON orders.user_id = users.id
