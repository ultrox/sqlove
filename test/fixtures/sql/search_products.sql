-- Full text search on products with category and rating.
SELECT
  p.id,
  p.name,
  p.price,
  p.in_stock,
  c.name AS category,
  coalesce(avg(r.rating), 0)::numeric(3,1) AS avg_rating
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN reviews r ON r.product_id = p.id
WHERE p.name ILIKE $1
  AND ($2::int IS NULL OR c.id = $2)
GROUP BY p.id, c.name
ORDER BY p.name
