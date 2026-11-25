from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SleepQuality = Literal["restorative", "average", "poor"]
JointStrain = Literal["none", "mild", "sharp"]
RiskLevel = Literal["none", "moderate", "high"]
SignalSeverity = Literal["ok", "watch", "high"]


class FatigueFeedbackCreate(BaseModel):
    fatigue_level: int = Field(ge=1, le=10, description="1 (fresh) to 10 (exhausted)")
    soreness_level: int = Field(ge=1, le=10, description="1 (no soreness) to 10 (severe soreness)")
    sleep_quality: SleepQuality = "average"
    joint_strain: JointStrain = "none"
    sore_muscles: list[str] = Field(default_factory=list, max_length=10)
    notes: str | None = Field(default=None, max_length=300)


class FatigueFeedbackEntry(BaseModel):
    id: str
    fatigue_level: int
    soreness_level: int
    sleep_quality: SleepQuality = "average"
    joint_strain: JointStrain = "none"
    sore_muscles: list[str] = Field(default_factory=list)
    notes: str | None = None
    created_at: datetime


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
    reported_sore: bool = False
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
    avg_workout_fatigue_7d: float | None = None
    latest_workout_fatigue: int | None = None
    repeated_fatigue_reports: int = 0
    strained_muscles: list[str] = Field(default_factory=list)
    muscle_strain: list[MuscleStrainSummary] = Field(default_factory=list)
    signals: list[OvertrainingSignal] = Field(default_factory=list)
    recent_checkins: list[FatigueFeedbackEntry] = Field(default_factory=list)
    headline: str = "Recovery on track"
    summary: str = ""
    recommendations: list[str] = Field(default_factory=list)
    volume_reduction_pct: int = 15
    deload_active: bool = False
    deload_expires_at: datetime | None = None
    rest_day_scheduled: bool = False
    dismissed: bool = False
