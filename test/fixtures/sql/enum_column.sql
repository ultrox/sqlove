-- Query with enum column and enum param.
SELECT id, name, role FROM users WHERE role = $1::user_role
