-- Custom exercises live in public.exercises (workout_sets and routine_exercises
-- reference it), marked by owner_id. owner_id NULL is the shared catalog.
ALTER TABLE public.exercises
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    -- Set when a custom exercise is removed but past workouts still use it.
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS muscles_secondary TEXT[];

CREATE INDEX IF NOT EXISTS exercises_owner_idx
    ON public.exercises (owner_id)
    WHERE owner_id IS NOT NULL;

-- One active custom exercise per name for each user.
CREATE UNIQUE INDEX IF NOT EXISTS exercises_owner_name_key
    ON public.exercises (owner_id, lower(name))
    WHERE owner_id IS NOT NULL AND archived_at IS NULL;
