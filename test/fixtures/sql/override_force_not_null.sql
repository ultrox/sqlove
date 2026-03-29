-- Force non-null with ! suffix on a nullable column.
SELECT bio AS "bio!", age AS "age!"
FROM users
WHERE id = $1
