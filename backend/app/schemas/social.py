"""Community requests and answers. Every answer lists its fields, so nothing else can leave the server."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

CardType = Literal["workout", "pr", "nutrition_streak"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class JoinRequest(_Request):
    username: str = Field(max_length=40)
    is_private: bool = False


class MeUpdate(_Request):
    username: str | None = Field(default=None, max_length=40)
    is_private: bool | None = None


class CardRef(_Request):
    """Points at the author's own data. The server reads the numbers itself."""

    type: CardType
    workout_id: UUID | None = None
    exercise_id: str | None = Field(default=None, max_length=64)


class CommentCreate(_Request):
    body: str = Field(max_length=2000)


class AuthorOut(BaseModel):
    id: str
    username: str
    name: str
    avatar_url: str | None = None
    is_private: bool


class WorkoutCard(BaseModel):
    name: str
    duration_seconds: int
    exercise_count: int
    completed_sets: int
    total_volume_kg: float
    completed_at: datetime


class PrCard(BaseModel):
    exercise_name: str
    weight_kg: float
    reps: int
    previous_best_kg: float


class StreakCard(BaseModel):
    days: int


class PostOut(BaseModel):
    id: str
    author: AuthorOut
    body: str
    image_urls: list[str]
    card_type: CardType | None = None
    card: WorkoutCard | PrCard | StreakCard | None = None
    like_count: int
    comment_count: int
    liked_by_me: bool
    can_delete: bool
    created_at: datetime


class CommentOut(BaseModel):
    id: str
    author: AuthorOut
    body: str
    can_delete: bool
    created_at: datetime


class FeedPage(BaseModel):
    items: list[PostOut]
    next_cursor: str | None = None


class ProfileOut(BaseModel):
    user: AuthorOut
    followers: int
    following: int
    posts_visible: bool
    follow_state: Literal["none", "pending", "following"]
    follows_you: bool
    is_me: bool


class MeOut(BaseModel):
    id: str
    joined: bool
    username: str | None = None
    name: str
    is_private: bool
    avatar_url: str | None = None
    followers: int
    following: int
    pending_requests: int
    following_preview: list[AuthorOut] = []


class PrOption(PrCard):
    exercise_id: str


class WorkoutOption(BaseModel):
    workout_id: str
    name: str
    completed_at: datetime
    prs: list[PrOption]


class Attachables(BaseModel):
    workouts: list[WorkoutOption]
    streak_days: int
    streak_to_share: int
