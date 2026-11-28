from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.workout import RoutineSummary

Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
WEEKDAY_ORDER: tuple[Weekday, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

EquipmentKey = Literal[
    "full_gym",
    "barbell",
    "dumbbell",
    "machine",
    "cable",
    "bodyweight",
    "kettlebell",
    "bands",
]
ExperienceLevel = Literal["beginner", "intermediate", "advanced"]
TrainingPhilosophy = Literal["heavy_duty", "high_volume", "powerbuilding", "minimalist"]


def _dedupe_days(values: list[Any]) -> list[Any]:
    seen: set[str] = set()
    ordered: list[Any] = []
    index = {day: pos for pos, day in enumerate(WEEKDAY_ORDER)}
    for raw in values:
        item = raw.strip().lower() if isinstance(raw, str) else raw
        if item not in seen:
            seen.add(item)
            ordered.append(item)
    return sorted(ordered, key=lambda day: index.get(day, 99))


def _dedupe_equipment(values: list[Any]) -> list[Any]:
    seen: set[str] = set()
    result: list[Any] = []
    for raw in values:
        item = raw.strip().lower() if isinstance(raw, str) else raw
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


class WeeklyRoutineGenerateRequest(BaseModel):
    days: list[Weekday] = Field(min_length=1, max_length=7)
    duration_minutes: int = Field(default=60, ge=20, le=120)
    equipment: list[EquipmentKey] = Field(min_length=1, max_length=8)
    objective: str | None = Field(default=None, max_length=120)
    experience_level: ExperienceLevel = "intermediate"
    training_philosophy: TrainingPhilosophy | None = None
    notes: str | None = Field(default=None, max_length=400)

    @field_validator("days")
    @classmethod
    def normalize_days(cls, value: list[Weekday]) -> list[Weekday]:
        return _dedupe_days(value)

    @field_validator("equipment")
    @classmethod
    def normalize_equipment(cls, value: list[EquipmentKey]) -> list[EquipmentKey]:
        return _dedupe_equipment(value)

    @field_validator("objective", "notes", mode="before")
    @classmethod
    def clean_optional_text(cls, value: Any) -> str | None:
        if not isinstance(value, str):
            return value
        cleaned = value.strip()
        return cleaned or None


class WeeklyRoutineExercise(BaseModel):
    exercise_id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    muscle_group: str = Field(default="General", max_length=60)
    equipment: list[str] = Field(default_factory=list, max_length=10)
    target_sets: int = Field(ge=1, le=8)
    target_reps: int = Field(ge=1, le=30)


class WeeklyRoutineDay(BaseModel):
    day: Weekday
    routine_name: str = Field(min_length=1, max_length=100)
    focus: str = Field(min_length=1, max_length=80)
    estimated_duration_minutes: int = Field(ge=10, le=180)
    exercises: list[WeeklyRoutineExercise] = Field(min_length=1, max_length=12)


class WeeklyRoutineDraft(BaseModel):
    plan_title: str = Field(min_length=1, max_length=120)
    split_name: str = Field(min_length=1, max_length=80)
    objective: str = Field(min_length=1, max_length=120)
    experience_level: ExperienceLevel = "intermediate"
    training_philosophy: TrainingPhilosophy | None = None
    summary: str = Field(min_length=1, max_length=400)
    change_summary: str | None = Field(default=None, max_length=400)
    days: list[WeeklyRoutineDay] = Field(min_length=1, max_length=7)


class WeeklyRoutineModifyRequest(BaseModel):
    preferences: WeeklyRoutineGenerateRequest
    current_draft: WeeklyRoutineDraft
    feedback: str = Field(min_length=2, max_length=500)
    feedback_history: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("feedback", mode="before")
    @classmethod
    def strip_feedback(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class WeeklyRoutineAcceptRequest(BaseModel):
    days: list[WeeklyRoutineDay] = Field(min_length=1, max_length=7)


class WeeklyRoutineAcceptResponse(BaseModel):
    routines: list[RoutineSummary]
