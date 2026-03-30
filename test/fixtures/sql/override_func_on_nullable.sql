-- upper(bio) where bio is nullable.
-- Tool says not nullable (upper is not in nullable aggregates list).
-- But upper(NULL) = NULL. Use ? to correct.
SELECT id, upper(bio) AS "display_bio?" FROM users WHERE id = $1
