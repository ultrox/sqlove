-- jsonb ->> might not have the key. Use ? suffix.
SELECT
  id,
  metadata->>'department' AS "department?",
  metadata->>'level' AS "level?"
FROM users
WHERE id = $1
