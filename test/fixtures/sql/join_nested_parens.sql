-- Nested joins with parentheses changing precedence.
-- Both orders and payments should be nullable.
SELECT u.name, o.total
FROM users u
LEFT JOIN (orders o JOIN line_items li ON li.order_id = o.id)
  ON o.user_id = u.id
