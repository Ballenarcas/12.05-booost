from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field


class FatigueFeedbackCreate(BaseModel):
    fatigue_level: int = Field(ge=1, le=10, description="1 (fresh) to 10 (exhausted)")
    soreness_level: int = Field(ge=1, le=10, description="1 (no soreness) to 10 (severe soreness)")
    sore_muscles: list[str] = Field(default_factory=list, max_length=10)
    notes: str | None = Field(default=None, max_length=300)


class FatigueFeedbackEntry(BaseModel):
    id: str
    user_id: str
    fatigue_level: int
    soreness_level: int
    sore_muscles: list[str] = Field(default_factory=list)
    notes: str | None = None
    created_at: datetime


class OvertrainingStatusResponse(BaseModel):
    has_alert: bool = False
    risk_level: Literal["none", "moderate", "high"] = "none"
    load_increase_pct: int = 0
    sessions_last_7_days: int = 0
    high_rpe_sets_count: int = 0
    repeated_fatigue_reports: int = 0
    strained_muscles: list[str] = Field(default_factory=list)
    headline: str = "Recovery on track"
    critical_alert_title: str | None = None
    critical_alert_body: str | None = None
    critical_recommendation: str | None = None
    fatigue_feedback_title: str | None = None
    fatigue_feedback_body: str | None = None
    fatigue_action: str | None = None
    ai_modification_title: str | None = None
    ai_modification_body: str | None = None
    volume_reduction_pct: int = 15
    mods_applied: bool = False
    dismissed: bool = False