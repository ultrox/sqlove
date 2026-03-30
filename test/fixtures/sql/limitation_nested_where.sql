-- WHERE in a CTE is not analyzed by the outer query.
-- The CTE filters bio IS NOT NULL, but the outer SELECT
-- doesn't know that. Tool says bio is nullable.
-- Use ! to override if you know the CTE guarantees non-null.
WITH filtered AS (
  SELECT id, bio FROM users WHERE bio IS NOT NULL
)
SELECT id, bio FROM filtered WHERE id = $1
