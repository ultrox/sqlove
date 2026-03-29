-- Right join: left side columns become nullable.
SELECT users.name, orders.total
FROM users
RIGHT JOIN orders ON orders.user_id = users.id
