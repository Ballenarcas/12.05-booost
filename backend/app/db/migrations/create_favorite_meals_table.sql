-- Favorite meals: a saved copy of a meal (not a link), so editing or deleting
-- the original meal does not change the favorite.
CREATE TABLE IF NOT EXISTS public.favorite_meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    meal_type TEXT NOT NULL DEFAULT 'Meal',
    ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
    calories INTEGER NOT NULL DEFAULT 0 CHECK (calories >= 0),
    proteins_g NUMERIC NOT NULL DEFAULT 0 CHECK (proteins_g >= 0),
    carbs_g NUMERIC NOT NULL DEFAULT 0 CHECK (carbs_g >= 0),
    fats_g NUMERIC NOT NULL DEFAULT 0 CHECK (fats_g >= 0),
    quantity_g NUMERIC NOT NULL DEFAULT 100 CHECK (quantity_g > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, meal_type, name)
);
-- favorite_meals_case_insensitive_name.sql replaces that UNIQUE with one on lower(name).

-- The unique index starts with user_id, so it also serves per-user lookups.

ALTER TABLE public.favorite_meals ENABLE ROW LEVEL SECURITY;
-- No policies: only the backend (service role) reads and writes this table.
