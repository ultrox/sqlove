-- string_agg and array_agg return null on zero rows.
SELECT
  u.id,
  string_agg(o.notes, ', ') AS all_notes,
  array_agg(o.total) AS totals
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id
