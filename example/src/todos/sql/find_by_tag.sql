-- Find todos that have a given tag.
SELECT id, title, priority, tags, done
FROM todo
WHERE $1 = ANY(tags)
ORDER BY created_at DESC
