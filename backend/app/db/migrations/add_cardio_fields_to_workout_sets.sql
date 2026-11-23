-- Stores cardio block duration and distance on workout_sets alongside strength reps and weight.
ALTER TABLE public.workout_sets
    ADD COLUMN IF NOT EXISTS duration_seconds integer,
    ADD COLUMN IF NOT EXISTS distance_km double precision;

-- Backfill existing cardio rows that stored duration_seconds in reps and distance_km in weight.
UPDATE public.workout_sets AS ws
SET duration_seconds = COALESCE(ws.duration_seconds, NULLIF(ws.reps, 0)),
    distance_km = COALESCE(ws.distance_km, NULLIF(ws.weight, 0))
FROM public.exercises AS ex
WHERE ws.exercise_id = ex.id
  AND ex.muscle_group ILIKE '%cardio%'
  AND ws.duration_seconds IS NULL
  AND (ws.reps > 0 OR ws.weight > 0);
