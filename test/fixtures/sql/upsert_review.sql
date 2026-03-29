-- Upsert a review — insert or update on conflict.
INSERT INTO reviews (user_id, product_id, rating, body)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, product_id)
DO UPDATE SET rating = $3, body = $4
RETURNING id, rating, created_at
