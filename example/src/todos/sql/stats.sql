-- Get todo stats: total, done, pending.
SELECT
  count(*)::int AS total,
  count(*) FILTER (WHERE done)::int AS done,
  count(*) FILTER (WHERE NOT done)::int AS pending
FROM todo
