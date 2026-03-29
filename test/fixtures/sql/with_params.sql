-- Find user by email and minimum age.
SELECT id, name, email
FROM users
WHERE email = $1 AND age >= $2
