import logging
from collections.abc import Callable
from typing import TypeVar
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import current_user
from app.core.local_day import LocalDay, local_day
from app.facades.ai_chat_facade import ConversationNotFound, DailyLimitReached, ai_chat_facade
from app.schemas.ai_chat import ChatMessageRequest, ChatQuota, ChatReply, ConversationDetail, ConversationSummary

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ai/chat", tags=["ai"])
Result = TypeVar("Result")


def _read(action: Callable[[], Result]) -> Result:
    try:
        return action()
    except ConversationNotFound as error:
        raise HTTPException(status_code=404, detail="Conversation not found") from error
    except httpx.HTTPError:
        raise  # main.py already answers these with 503
    except Exception as error:
        logger.exception("Could not read the coach chat")
        raise HTTPException(status_code=502, detail="Could not load your conversations.") from error


@router.post("/messages", response_model=ChatReply)
def send_message(
    request: ChatMessageRequest,
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> ChatReply:
    try:
        return ai_chat_facade.send_message(user_id, day, request.content, request.conversation_id)
    except DailyLimitReached as error:
        raise HTTPException(status_code=429, detail="You've used today's coach messages.") from error
    except ConversationNotFound as error:
        raise HTTPException(status_code=404, detail="Conversation not found") from error
    except (HTTPException, httpx.ConnectError):
        raise
    except ValueError as error:
        logger.warning("The coach is unavailable", exc_info=True)
        raise HTTPException(status_code=503, detail="The AI trainer is not available right now.") from error
    except Exception as error:
        logger.exception("The coach could not answer")
        raise HTTPException(status_code=502, detail="The AI trainer could not answer. Please try again.") from error


@router.get("/conversations", response_model=list[ConversationSummary])
def list_conversations(user_id: UUID = Depends(current_user)) -> list[ConversationSummary]:
    return _read(lambda: ai_chat_facade.list_conversations(user_id))


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation(conversation_id: UUID, user_id: UUID = Depends(current_user)) -> ConversationDetail:
    return _read(lambda: ai_chat_facade.conversation(user_id, conversation_id))


@router.get("/quota", response_model=ChatQuota)
def get_quota(user_id: UUID = Depends(current_user)) -> ChatQuota:
    return _read(lambda: ai_chat_facade.quota(user_id))
