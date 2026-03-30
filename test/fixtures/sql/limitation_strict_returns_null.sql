-- Strict function that CAN return null on non-null input.
-- replace(name, 'a', NULL) → NULL because third arg is null literal.
-- But what if a strict function returns null from non-null inputs
-- by internal logic? proisstrict only guarantees null-in→null-out,
-- not non-null-in→non-null-out. Tool says not-nullable here.
-- Use ? to override if you know the function can return null.
SELECT id, replace(name, 'a', 'b') AS cleaned FROM users WHERE id = $1
