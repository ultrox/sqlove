-- length(bio) > 0 rejects nulls (length is strict, NULL → NULL > 0 → filtered).
SELECT id, bio FROM users WHERE length(bio) > 0
