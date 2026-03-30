-- AND guarantees non-null: bio must pass IS NOT NULL.
SELECT id, bio FROM users WHERE bio IS NOT NULL AND age > 18
