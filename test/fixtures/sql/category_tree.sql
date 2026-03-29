-- Recursive category tree with product count.
WITH RECURSIVE cat_tree AS (
  SELECT id, name, parent_id, 0 AS depth
  FROM categories
  WHERE parent_id IS NULL

  UNION ALL

  SELECT c.id, c.name, c.parent_id, ct.depth + 1
  FROM categories c
  JOIN cat_tree ct ON ct.id = c.parent_id
)
SELECT
  ct.id,
  ct.name,
  ct.depth,
  ct.parent_id AS "parent_id?",
  count(p.id)::int AS product_count
FROM cat_tree ct
LEFT JOIN products p ON p.category_id = ct.id
GROUP BY ct.id, ct.name, ct.depth, ct.parent_id
ORDER BY ct.depth, ct.name
