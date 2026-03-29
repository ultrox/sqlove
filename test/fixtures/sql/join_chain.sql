-- Multiple LEFT JOINs forming a chain.
SELECT u.name, o.total, li.quantity, p.sku
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
LEFT JOIN line_items li ON li.order_id = o.id
LEFT JOIN products p ON p.id = li.product_id
