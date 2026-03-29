-- Product stats: avg rating, total sold, revenue.
SELECT
  p.id,
  p.name,
  p.sku,
  coalesce(avg(r.rating), 0)::numeric(3,1) AS avg_rating,
  coalesce(sum(li.quantity), 0)::int AS total_sold,
  coalesce(sum(li.quantity * li.unit_price), 0)::numeric(10,2) AS revenue,
  count(DISTINCT r.id)::int AS review_count
FROM products p
LEFT JOIN line_items li ON li.product_id = p.id
LEFT JOIN reviews r ON r.product_id = p.id
GROUP BY p.id
ORDER BY revenue DESC
