-- "Oats with banana" and "oats with banana" are the same favorite.
ALTER TABLE public.favorite_meals
    DROP CONSTRAINT IF EXISTS favorite_meals_user_id_meal_type_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS favorite_meals_user_type_name_key
    ON public.favorite_meals (user_id, meal_type, lower(name));
