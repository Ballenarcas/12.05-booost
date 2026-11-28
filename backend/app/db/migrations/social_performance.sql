-- Index for the foreign key the Supabase performance advisor flagged: deleting a workout
-- looks up the posts that point at it. Run once in the Supabase SQL editor. Re-running is safe.

CREATE INDEX IF NOT EXISTS social_posts_workout_idx
    ON public.social_posts (workout_id);
