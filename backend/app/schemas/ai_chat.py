from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.nutrition import MealIngredient


class ChatMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    conversation_id: UUID | None = None
    content: str = Field(min_length=1, max_length=1000)


class ChatExercise(BaseModel):
    id: str
    name: str
    is_cardio: bool = False


class ChatMeal(BaseModel):
    """A dish from the app's meal list or the user's favorites. Every figure comes from the database."""

    key: str
    name: str
    meal_type: str
    calories: int
    proteins_g: float
    carbs_g: float
    fats_g: float
    ingredients: list[MealIngredient]


class ChatMessage(BaseModel):
    id: UUID
    role: Literal["user", "assistant"]
    content: str
    exercises: list[ChatExercise] = Field(default_factory=list)
    meals: list[ChatMeal] = Field(default_factory=list)
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
