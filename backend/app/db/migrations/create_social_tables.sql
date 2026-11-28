-- Community: public profile columns on users, posts, likes, comments, follows, blocks
-- and two private Storage buckets. Run once in the Supabase SQL editor. Re-running is safe.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS username TEXT,
    ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS avatar_path TEXT,
    ADD COLUMN IF NOT EXISTS community_joined_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
        lower(coalesce(username, '') || ' ' || coalesce("Name", '') || ' ' || coalesce("Surname", ''))
    ) STORED;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_username_format;
ALTER TABLE public.users
    ADD CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_]{3,20}$');

CREATE UNIQUE INDEX IF NOT EXISTS users_username_key
    ON public.users (lower(username)) WHERE username IS NOT NULL;

DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS users_search_idx ON public.users USING gin (search_text gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm is not available; member search runs without an index.';
END $$;

CREATE TABLE IF NOT EXISTS public.social_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 280),
    image_paths TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(image_paths) <= 4),
    card_type TEXT CHECK (card_type IN ('workout', 'pr', 'nutrition_streak')),
    card JSONB,
    workout_id UUID REFERENCES public.workouts(id) ON DELETE SET NULL,
    author_private BOOLEAN NOT NULL DEFAULT false,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((card_type IS NULL) = (card IS NULL)),
    CHECK (body <> '' OR cardinality(image_paths) > 0 OR card IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS social_posts_user_idx ON public.social_posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS social_posts_discover_idx ON public.social_posts (author_private, created_at DESC);

CREATE TABLE IF NOT EXISTS public.social_post_likes (
    post_id UUID NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS social_post_likes_user_idx ON public.social_post_likes (user_id);

CREATE TABLE IF NOT EXISTS public.social_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS social_comments_post_idx ON public.social_comments (post_id, created_at);
CREATE INDEX IF NOT EXISTS social_comments_user_idx ON public.social_comments (user_id, created_at);

CREATE TABLE IF NOT EXISTS public.social_follows (
    follower_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    followee_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);

CREATE INDEX IF NOT EXISTS social_follows_followee_idx ON public.social_follows (followee_id, status);

CREATE TABLE IF NOT EXISTS public.social_blocks (
    blocker_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS social_blocks_blocked_idx ON public.social_blocks (blocked_id);

-- Counters, so a feed never counts rows.
CREATE OR REPLACE FUNCTION public.social_count_likes() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.social_posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
    ELSE
        UPDATE public.social_posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.social_count_comments() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.social_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
    ELSE
        UPDATE public.social_posts SET comment_count = comment_count - 1 WHERE id = OLD.post_id;
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.social_copy_privacy() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
    UPDATE public.social_posts SET author_private = NEW.is_private WHERE user_id = NEW.id;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS social_post_likes_count ON public.social_post_likes;
CREATE TRIGGER social_post_likes_count AFTER INSERT OR DELETE ON public.social_post_likes
    FOR EACH ROW EXECUTE FUNCTION public.social_count_likes();

DROP TRIGGER IF EXISTS social_comments_count ON public.social_comments;
CREATE TRIGGER social_comments_count AFTER INSERT OR DELETE ON public.social_comments
    FOR EACH ROW EXECUTE FUNCTION public.social_count_comments();

DROP TRIGGER IF EXISTS users_copy_privacy ON public.users;
CREATE TRIGGER users_copy_privacy AFTER UPDATE OF is_private ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.social_copy_privacy();

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'social_posts', 'social_post_likes', 'social_comments', 'social_follows', 'social_blocks'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', target);
        EXECUTE format('DROP POLICY IF EXISTS "%s_service_role" ON public.%I;', target, target);
        EXECUTE format(
            'CREATE POLICY "%s_service_role" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);',
            target, target);
        EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated;', target);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role;', target);
    END LOOP;
END $$;

-- Private buckets: only the backend (service role) reads and writes them.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('avatars', 'avatars', false, 2097152, ARRAY['image/webp']),
    ('post-images', 'post-images', false, 8388608, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Verify afterwards. Expected: rowsecurity true, only *_service_role policies,
-- both buckets public = false, and no storage.objects policy for anon/authenticated.
--   SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'social_%';
--   SELECT schemaname, tablename, policyname, roles FROM pg_policies
--       WHERE tablename LIKE 'social_%' OR (schemaname = 'storage' AND tablename = 'objects');
--   SELECT id, public FROM storage.buckets WHERE id IN ('avatars', 'post-images');
