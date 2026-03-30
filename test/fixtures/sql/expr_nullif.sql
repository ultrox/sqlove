-- NULLIF returns null when both args are equal.
SELECT id, NULLIF(name, 'deleted') AS name_or_null
FROM users
WHERE id = $1
