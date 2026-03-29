-- Create a new todo.
INSERT INTO todo (title, description, priority, share_with, fido)
VALUES ($1, $2, $3::todo_priority, $4, $5)
RETURNING id, title, priority, done, created_at
