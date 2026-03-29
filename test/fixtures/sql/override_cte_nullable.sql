-- CTE loses table metadata. Use ? suffix for nullable columns.
WITH cats AS (
  SELECT id, parent_id FROM categories
)
SELECT id, parent_id AS "parent_id?" FROM cats
