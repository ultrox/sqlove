-- Delete without RETURNING — a void mutation.
DELETE FROM users WHERE id = $1
