-- Full order details: user, items, products, payment.
SELECT
  o.id AS order_id,
  o.status,
  u.name AS customer,
  p.name AS product,
  li.quantity,
  li.unit_price,
  (li.quantity * li.unit_price)::numeric(10,2) AS line_total,
  pay.method AS payment_method,
  pay.paid_at
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN line_items li ON li.order_id = o.id
JOIN products p ON p.id = li.product_id
LEFT JOIN payments pay ON pay.order_id = o.id
WHERE o.id = $1
