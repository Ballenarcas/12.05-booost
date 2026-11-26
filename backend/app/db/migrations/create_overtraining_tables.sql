-- Overtraining deload week and alert dismissal state per user.
-- Run once in the Supabase SQL editor. Re-running is safe.

CREATE TABLE IF NOT EXISTS public.overtraining_states (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    deload_pct INTEGER NOT NULL DEFAULT 0 CHECK (deload_pct IN (0, 15, 20)),
    deload_applied_at TIMESTAMPTZ,
    deload_expires_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.overtraining_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "overtraining_states_service_role" ON public.overtraining_states;
CREATE POLICY "overtraining_states_service_role"
    ON public.overtraining_states FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.overtraining_states FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.overtraining_states TO service_role;
