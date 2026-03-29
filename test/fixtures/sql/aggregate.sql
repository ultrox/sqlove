-- Aggregate query — expression columns, no table OID.
SELECT
  count(*)::int AS total,
  count(*) FILTER (WHERE done)::int AS done
FROM todo
