-- Non-strict custom function: tool can't know it returns null.
-- concat_ws is non-strict (handles nulls internally, returns non-null).
-- But a hypothetical user function could return null on non-null input.
-- This tests that non-strict functions default to not-nullable.
-- Use ? to override if you know better.
SELECT id, concat_ws(' ', name, bio) AS full_text FROM users WHERE id = $1
