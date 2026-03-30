-- OR does NOT guarantee non-null: bio could still be null
-- because the other branch (age > 18) can match null-bio rows.
SELECT id, bio FROM users WHERE bio IS NOT NULL OR age > 18
