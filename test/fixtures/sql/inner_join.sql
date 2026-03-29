-- Inner join: no nullability change.
SELECT users.name, orders.total
FROM users
INNER JOIN orders ON orders.user_id = users.id
