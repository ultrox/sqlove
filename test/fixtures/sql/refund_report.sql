-- Refund report with order and payment details.
SELECT
  r.id AS refund_id,
  r.amount AS refund_amount,
  r.reason,
  r.refunded_at,
  o.id AS order_id,
  o.status AS order_status,
  u.name AS customer,
  p.method AS payment_method
FROM refunds r
JOIN payments p ON p.id = r.payment_id
JOIN orders o ON o.id = r.order_id
JOIN users u ON u.id = o.user_id
WHERE r.refunded_at >= $1 AND r.refunded_at < $2
ORDER BY r.refunded_at DESC
