from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

WorkoutStatisticsRange = Literal["1W", "1M", "3M"]
ProgressionGranularity = Literal["day", "week"]


class VolumeProgressionPoint(BaseModel):
    date: date
    volume_kg: float = Field(ge=0)


class MuscleGroupVolume(BaseModel):
    muscle_group: str
    volume_kg: float = Field(ge=0)


class FatigueHistoryPoint(BaseModel):
    date: date
    fatigue_level: int = Field(ge=1, le=10)
    workout_id: str
    name: str
    workout_count: int = Field(default=1, ge=1)


class WorkoutCalendarItem(BaseModel):
    label: str
    duration_seconds: int = Field(default=0, ge=0)
    volume_kg: float = Field(default=0.0, ge=0)


class WorkoutCalendarDay(BaseModel):
    date: date
    workout_count: int = Field(ge=1)
    total_duration_seconds: int = Field(default=0, ge=0)
    items: list[WorkoutCalendarItem] = Field(default_factory=list)


class WorkoutStatisticsResponse(BaseModel):
    range: WorkoutStatisticsRange
    start_date: datetime
    end_date: datetime
    total_workouts: int = Field(ge=0)
    total_volume_kg: float = Field(ge=0)
    total_duration_seconds: int = Field(ge=0)
    workouts_with_duration: int = Field(ge=0)
    eligible_set_count: int = Field(ge=0)
    progression_granularity: ProgressionGranularity
    volume_progression: list[VolumeProgressionPoint]
    muscle_group_distribution: list[MuscleGroupVolume]
    classified_volume_kg: float = Field(ge=0)
    unclassified_volume_kg: float = Field(ge=0)
    calendar_days: list[WorkoutCalendarDay] = Field(default_factory=list)
    fatigue_history: list[FatigueHistoryPoint] = Field(default_factory=list)
    fatigue_workouts: int = Field(default=0, ge=0)
    fatigue_days: int = Field(default=0, ge=0)
    fatigue_average: float | None = Field(default=None, ge=1, le=10)
    fatigue_latest: int | None = Field(default=None, ge=1, le=10)
