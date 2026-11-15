-- Self-reported fatigue after a workout (1 = fresh, 10 = exhausted).
-- Run this BEFORE deploying the backend that reads and writes it.
ALTER TABLE public.workouts
    ADD COLUMN IF NOT EXISTS fatigue_level smallint;

ALTER TABLE public.workouts
    DROP CONSTRAINT IF EXISTS workouts_fatigue_level_check;

ALTER TABLE public.workouts
    ADD CONSTRAINT workouts_fatigue_level_check
    CHECK (fatigue_level IS NULL OR fatigue_level BETWEEN 1 AND 10);

-- The AI trainer reads the last week of fatigue when planning calories and training.
CREATE INDEX IF NOT EXISTS workouts_user_fatigue_idx
    ON public.workouts (user_id, start_time DESC)
    WHERE fatigue_level IS NOT NULL;
