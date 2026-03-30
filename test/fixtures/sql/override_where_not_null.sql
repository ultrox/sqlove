-- bio is nullable in the table, but WHERE filters nulls out.
-- WHERE null-rejection detects this automatically.
-- No ! needed.
SELECT id, bio FROM users WHERE bio IS NOT NULL
