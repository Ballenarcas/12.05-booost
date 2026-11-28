from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

RiskLevel = Literal["none", "moderate", "high"]
SignalSeverity = Literal["ok", "watch", "high"]


class OvertrainingSignal(BaseModel):
    id: str
    label: str
    value: str
    detail: str
    severity: SignalSeverity


class MuscleStrainSummary(BaseModel):
    muscle_group: str
    sets_7d: int = 0
    hours_since_trained: int | None = None
    status: SignalSeverity = "ok"


class OvertrainingStatusResponse(BaseModel):
    has_alert: bool = False
    risk_level: RiskLevel = "none"
    readiness_score: int = Field(default=100, ge=0, le=100)
    acwr: float | None = None
    load_increase_pct: int = 0
    sessions_last_7_days: int = 0
    total_sets_last_7_days: int = 0
    high_rpe_sets_count: int = 0
    consecutive_training_days: int = 0
    consecutive_high_load_weeks: int = 0
    avg_workout_fatigue_7d: float | None = None
    latest_workout_fatigue: int | None = None
    repeated_joint_pain: list[str] = Field(default_factory=list)
    strained_muscles: list[str] = Field(default_factory=list)
    muscle_strain: list[MuscleStrainSummary] = Field(default_factory=list)
    signals: list[OvertrainingSignal] = Field(default_factory=list)
    headline: str = "No overtraining detected"
    summary: str = ""
    recommendations: list[str] = Field(default_factory=list)
    deload_week_recommended: bool = False
    deload_week_reason: str | None = None
    volume_reduction_pct: int = 15
    deload_active: bool = False
    deload_expires_at: datetime | None = None
    deload_days_remaining: int = 0
    rest_day_scheduled: bool = False
    dismissed: bool = False
