-- Recovery check-ins and overtraining deload/dismissal state per user.
-- Run once in the Supabase SQL editor. Re-running is safe.

CREATE TABLE IF NOT EXISTS public.recovery_checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    fatigue_level INTEGER NOT NULL CHECK (fatigue_level BETWEEN 1 AND 10),
    soreness_level INTEGER NOT NULL CHECK (soreness_level BETWEEN 1 AND 10),
    sleep_quality TEXT NOT NULL DEFAULT 'average' CHECK (sleep_quality IN ('restorative', 'average', 'poor')),
    joint_strain TEXT NOT NULL DEFAULT 'none' CHECK (joint_strain IN ('none', 'mild', 'sharp')),
    sore_muscles TEXT[] NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS recovery_checkins_user_created_idx
    ON public.recovery_checkins (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.overtraining_states (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    deload_pct INTEGER NOT NULL DEFAULT 0 CHECK (deload_pct IN (0, 15)),
    deload_applied_at TIMESTAMPTZ,
    deload_expires_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.recovery_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overtraining_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recovery_checkins_service_role" ON public.recovery_checkins;
CREATE POLICY "recovery_checkins_service_role"
    ON public.recovery_checkins FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "overtraining_states_service_role" ON public.overtraining_states;
CREATE POLICY "overtraining_states_service_role"
    ON public.overtraining_states FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.recovery_checkins FROM anon, authenticated;
REVOKE ALL ON TABLE public.overtraining_states FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recovery_checkins TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.overtraining_states TO service_role;
