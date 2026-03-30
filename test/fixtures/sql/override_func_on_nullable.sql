-- upper(bio) where bio is nullable.
-- pg_proc.proisstrict detects upper is strict → null in = null out.
-- No ? needed — auto-detected.
SELECT id, upper(bio) AS display_bio FROM users WHERE id = $1
