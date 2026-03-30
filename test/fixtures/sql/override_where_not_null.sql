-- bio is nullable in the table, but WHERE filters nulls out.
-- Tool says nullable (correct per schema, wrong per query).
-- ! overrides to non-null.
SELECT id, bio AS "bio!" FROM users WHERE bio IS NOT NULL
