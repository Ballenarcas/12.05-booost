-- Optional post-workout joint pain tracking on finished workouts.
-- Run once in the Supabase SQL editor. Re-running is safe.

ALTER TABLE public.workouts
    ADD COLUMN IF NOT EXISTS joint_pain TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS workouts_user_joint_pain_idx
    ON public.workouts (user_id, start_time DESC)
    WHERE cardinality(joint_pain) > 0;
