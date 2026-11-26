"""AI Coach chat use cases: the daily limit, saved conversations and one question to the model."""

import json
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from app.core.config import get_settings
from app.core.i18n import get_language
from app.core.local_day import LocalDay
from app.db.supabase_client import get_supabase
from app.schemas.ai_chat import (
    ChatExercise,
    ChatMeal,
    ChatMessage,
    ChatQuota,
    ChatReply,
    ConversationDetail,
    ConversationSummary,
)
from app.services import ai_chat_service as coach
from app.services.ai_service import chat_reply
from app.services.exercise_catalog import get_cached_exercise
from app.services.meal_recommendation_service import meals_by_key
from app.services.premium_service import has_active_premium

CONVERSATIONS = "ai_chat_conversations"
MESSAGES = "ai_chat_messages"
FREE_DAILY_MESSAGES = 10
PREMIUM_DAILY_MESSAGES = 50
# Rolling window: the browser's "day" is client input, and moving it would reset the count.
LIMIT_WINDOW = timedelta(hours=24)
HISTORY_TURNS = 8
MAX_CONVERSATIONS = 30
MAX_MESSAGES_SHOWN = 100
TITLE_LENGTH = 60
# shortcut: suggested dishes share the exercise_ids column under this prefix, so no migration is needed.
# A dish removed later just stops showing; give them their own column if they need to survive that.
MEAL_PREFIX = "meal:"


class DailyLimitReached(Exception):
    pass


class ConversationNotFound(Exception):
    pass


def _session() -> Any:
    session = get_supabase(admin=True)
    if session is None:
        raise RuntimeError("Database connection unavailable")
    return session


def _used(session: Any, user_id: UUID) -> int:
    since = datetime.now(timezone.utc) - LIMIT_WINDOW
    rows = (session.table(MESSAGES).select("id").eq("user_id", str(user_id)).eq("role", "user")
            .gte("created_at", since.isoformat()).execute().data or [])
    return len(rows)


def _quota(session: Any, user_id: UUID, premium: bool | None = None) -> ChatQuota:
    if premium is None:
        premium = has_active_premium(str(user_id), session)
    limit = PREMIUM_DAILY_MESSAGES if premium else FREE_DAILY_MESSAGES
    return ChatQuota(used=min(_used(session, user_id), limit), limit=limit, is_premium=premium)


def _messages(session: Any, user_id: UUID, rows: list[dict[str, Any]]) -> list[ChatMessage]:
    has_meals = any(value.startswith(MEAL_PREFIX) for row in rows for value in row.get("exercise_ids") or [])
    dishes = meals_by_key(session, str(user_id)) if has_meals else {}
    return [_message(row, dishes) for row in rows]


def _message(row: dict[str, Any], dishes: dict[str, dict[str, Any]]) -> ChatMessage:
    ids = row.get("exercise_ids") or []
    exercises = [get_cached_exercise(value) for value in ids if not value.startswith(MEAL_PREFIX)]
    meals = [dishes.get(value.removeprefix(MEAL_PREFIX)) for value in ids if value.startswith(MEAL_PREFIX)]
    return ChatMessage(
        id=row["id"],
        role=row["role"],
        content=row["content"],
        exercises=[ChatExercise(id=item.id, name=item.name, is_cardio=item.category == "Cardio")
                   for item in exercises if item],
        meals=[ChatMeal(**{key: meal[key] for key in ChatMeal.model_fields}) for meal in meals if meal],
        created_at=row["created_at"],
    )


def _owned_conversation(session: Any, user_id: UUID, conversation_id: UUID) -> dict[str, Any]:
    rows = (session.table(CONVERSATIONS).select("id,title,updated_at").eq("id", str(conversation_id))
            .eq("user_id", str(user_id)).limit(1).execute().data or [])
    if not rows:
        raise ConversationNotFound()
    return rows[0]


def _recent_messages(session: Any, conversation_id: str, limit: int) -> list[dict[str, Any]]:
    rows = (session.table(MESSAGES).select("*").eq("conversation_id", conversation_id)
            .order("created_at", desc=True).limit(limit).execute().data or [])
    return rows[::-1]


class AIChatFacade:
    def quota(self, user_id: UUID) -> ChatQuota:
        return _quota(_session(), user_id)

    def list_conversations(self, user_id: UUID) -> list[ConversationSummary]:
        rows = (_session().table(CONVERSATIONS).select("id,title,updated_at").eq("user_id", str(user_id))
                .order("updated_at", desc=True).limit(MAX_CONVERSATIONS).execute().data or [])
        return [ConversationSummary(**row) for row in rows]

    def conversation(self, user_id: UUID, conversation_id: UUID) -> ConversationDetail:
        session = _session()
        row = _owned_conversation(session, user_id, conversation_id)
        messages = _recent_messages(session, str(conversation_id), MAX_MESSAGES_SHOWN)
        return ConversationDetail(**row, messages=_messages(session, user_id, messages))

    def send_message(
        self, user_id: UUID, day: LocalDay, content: str, conversation_id: UUID | None = None,
    ) -> ChatReply:
        session = _session()
        premium = has_active_premium(str(user_id), session)
        limit = PREMIUM_DAILY_MESSAGES if premium else FREE_DAILY_MESSAGES
        if _used(session, user_id) >= limit:
            raise DailyLimitReached()

        medical = coach.is_medical_question(content)
        if not medical and not get_settings().ai_api_key:
            raise ValueError("AI is not configured")

        history: list[dict[str, str]] = []
        if conversation_id:
            _owned_conversation(session, user_id, conversation_id)
            history = [{"role": row["role"], "content": row["content"]}
                       for row in _recent_messages(session, str(conversation_id), HISTORY_TURNS)]
            chat_id = str(conversation_id)
        else:
            title = " ".join(content.split())[:TITLE_LENGTH]
            created = session.table(CONVERSATIONS).insert({"user_id": str(user_id), "title": title}).execute()
            chat_id = str(created.data[0]["id"])

        def save(role: str, text: str, exercise_ids: list[str]) -> dict[str, Any]:
            return session.table(MESSAGES).insert({
                "conversation_id": chat_id, "user_id": str(user_id), "role": role,
                "content": text, "exercise_ids": exercise_ids,
            }).execute().data[0]

        # The question is saved before the model is called, so parallel requests cannot pass the limit together.
        question_id = None
        try:
            question_id = save("user", content, [])["id"]
            if _used(session, user_id) > limit:
                raise DailyLimitReached()
            text, exercise_ids = self._answer(session, user_id, day, content, history, medical, premium)
            saved = save("assistant", text, exercise_ids)
        except Exception:
            # A question that got no answer does not count against the limit.
            if question_id:
                session.table(MESSAGES).delete().eq("id", question_id).execute()
            if not conversation_id:
                session.table(CONVERSATIONS).delete().eq("id", chat_id).execute()
            raise

        session.table(CONVERSATIONS).update(
            {"updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", chat_id).execute()
        return ChatReply(
            conversation_id=chat_id,
            message=_messages(session, user_id, [saved])[0],
            quota=_quota(session, user_id, premium),
        )

    def _answer(
        self,
        session: Any,
        user_id: UUID,
        day: LocalDay,
        content: str,
        history: list[dict[str, str]],
        medical: bool,
        premium: bool,
    ) -> tuple[str, list[str]]:
        if medical:
            return coach.medical_refusal(), []
        facts, candidates, meals = coach.build_context(session, user_id, day, content, premium)
        try:
            answer = chat_reply(history + [{"role": "user", "content": content}], facts, candidates, meals, get_language())
        except json.JSONDecodeError:  # a cut-off reply is a bad answer, not an unavailable coach
            return coach.fallback_reply(), []
        reply = answer.get("reply") if isinstance(answer, dict) else None
        ids = answer.get("exercise_ids") if isinstance(answer, dict) else None
        meal_ids = answer.get("meal_ids", []) if isinstance(answer, dict) else []
        if not coach.is_safe_chat_reply(reply, ids, facts, candidates, meal_ids, meals):
            return coach.fallback_reply(), []
        dishes = dict.fromkeys(meal_ids + coach.named_meals(reply, meals))
        return reply.strip(), (list(dict.fromkeys(ids + coach.named_exercises(reply, candidates)))
                               + [f"{MEAL_PREFIX}{key}" for key in dishes])


ai_chat_facade = AIChatFacade()
