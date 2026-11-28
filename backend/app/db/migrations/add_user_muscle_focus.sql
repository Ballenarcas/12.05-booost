-- The muscle the user wants to prioritise, chosen in settings. NULL means automatic.
-- Run once in the Supabase SQL editor. Re-running is safe.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS muscle_focus TEXT;

UPDATE public.users
    SET muscle_focus = NULL
    WHERE muscle_focus IS NOT NULL
      AND muscle_focus NOT IN ('Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Abs', 'Glutes');

ALTER TABLE public.users
    DROP CONSTRAINT IF EXISTS users_muscle_focus_check;

ALTER TABLE public.users
    ADD CONSTRAINT users_muscle_focus_check
    CHECK (muscle_focus IS NULL OR muscle_focus IN ('Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Abs', 'Glutes'));
