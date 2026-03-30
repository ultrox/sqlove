-- coalesce(bio, notes) where both are nullable.
-- Tool says not nullable (CoalesceExpr → not nullable).
-- But if ALL args are null, result is null. Use ? to correct.
SELECT u.id, coalesce(u.bio, o.notes) AS "fallback?" 
FROM users u LEFT JOIN orders o ON o.user_id = u.id
WHERE u.id = $1
