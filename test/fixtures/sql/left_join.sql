-- Left join: right side columns become nullable.
SELECT users.name, orders.total, orders.notes
FROM users
LEFT JOIN orders ON orders.user_id = users.id
WHERE users.id = $1
