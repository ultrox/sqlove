-- Schema-qualified table in LEFT JOIN.
SELECT u.name, o.total
FROM users u
LEFT JOIN public.orders o ON o.user_id = u.id
