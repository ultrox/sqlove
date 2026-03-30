-- Comparison operator rejects nulls (bio = 'x' filters null bios).
SELECT id, bio FROM users WHERE bio = $1
