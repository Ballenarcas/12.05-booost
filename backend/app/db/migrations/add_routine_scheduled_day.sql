ALTER TABLE public.routines
  ADD COLUMN IF NOT EXISTS scheduled_day TEXT
  CHECK (scheduled_day IS NULL OR scheduled_day IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'));

CREATE INDEX IF NOT EXISTS routines_user_scheduled_day_idx
  ON public.routines (user_id, scheduled_day)
  WHERE scheduled_day IS NOT NULL;
