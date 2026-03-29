-- Same table joined twice with different aliases.
-- manager should be nullable, u should not.
SELECT u.name, manager.name AS manager_name, o.total
FROM users u
LEFT JOIN users manager ON manager.id = u.manager_id
JOIN orders o ON o.user_id = u.id
