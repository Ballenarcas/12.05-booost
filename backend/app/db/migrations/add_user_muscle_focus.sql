-- The muscle the user wants to prioritise, chosen in settings. NULL means automatic.
-- Run once in the Supabase SQL editor. Re-running is safe.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS muscle_focus TEXT
    CHECK (muscle_focus IS NULL OR muscle_focus IN ('Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Abs', 'Calves'));
