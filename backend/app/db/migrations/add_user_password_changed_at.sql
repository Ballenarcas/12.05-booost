-- Track the last password change or reset so older bearer sessions stop
-- working across restarts and multiple workers.
-- Run once in the Supabase SQL editor. Re-running is safe.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
