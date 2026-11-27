-- AI Coach chat: saved conversations and their messages. The daily limit is counted from these rows.
-- Run once in the Supabase SQL editor. Re-running is safe.

CREATE TABLE IF NOT EXISTS public.ai_chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_conversations_user_idx
    ON public.ai_chat_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.ai_chat_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL CHECK (char_length(content) <= 4000),
    exercise_ids TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_chat_messages_user_created_idx
    ON public.ai_chat_messages (user_id, created_at);
CREATE INDEX IF NOT EXISTS ai_chat_messages_conversation_idx
    ON public.ai_chat_messages (conversation_id, created_at);

ALTER TABLE public.ai_chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_chat_conversations_service_role" ON public.ai_chat_conversations;
CREATE POLICY "ai_chat_conversations_service_role" ON public.ai_chat_conversations
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "ai_chat_messages_service_role" ON public.ai_chat_messages;
CREATE POLICY "ai_chat_messages_service_role" ON public.ai_chat_messages
    FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.ai_chat_conversations, public.ai_chat_messages FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_chat_conversations, public.ai_chat_messages TO service_role;
