from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ChatMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    conversation_id: UUID | None = None
    content: str = Field(min_length=1, max_length=1000)


class ChatExercise(BaseModel):
    id: str
    name: str


class ChatMessage(BaseModel):
    id: UUID
    role: Literal["user", "assistant"]
    content: str
    exercises: list[ChatExercise] = Field(default_factory=list)
    created_at: datetime


class ChatQuota(BaseModel):
    used: int
    limit: int
    is_premium: bool


class ChatReply(BaseModel):
    conversation_id: UUID
    message: ChatMessage
    quota: ChatQuota


class ConversationSummary(BaseModel):
    id: UUID
    title: str
    updated_at: datetime


class ConversationDetail(ConversationSummary):
    messages: list[ChatMessage]
