-- List todos that are past their due date.
SELECT id, title, priority, due_date
FROM todo
WHERE due_date < now()::date AND done = false
ORDER BY due_date
