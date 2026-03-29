-- Query JSONB metadata field.
SELECT
  id,
  name,
  metadata->>'department' AS "department?",
  metadata->>'level' AS "level?",
  (metadata->>'salary')::numeric AS "salary?"
FROM users
WHERE metadata @> $1::jsonb
