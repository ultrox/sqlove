-- Select mix of nullable and non-nullable columns.
SELECT name, bio, age FROM users WHERE id = $1
