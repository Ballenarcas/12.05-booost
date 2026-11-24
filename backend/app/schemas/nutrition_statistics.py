from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

NutritionStatisticsRange = Literal["1W", "1M", "3M"]
ProgressionGranularity = Literal["day", "week"]


class NutritionProgressionPoint(BaseModel):
    date: date
    calories: int = Field(ge=0)
    logged_days: int = Field(default=1, ge=1)


class MacroBreakdownItem(BaseModel):
    macro: Literal["protein", "carbs", "fats"]
    label: str
    grams: float = Field(ge=0)


class MealCalendarItem(BaseModel):
    meal_type: str
    calories: int = Field(ge=0)
    meal_count: int = Field(default=1, ge=1)


class MealCalendarDay(BaseModel):
    date: date
    meal_count: int = Field(ge=1)
    total_calories: int = Field(ge=0)
    items: list[MealCalendarItem] = Field(default_factory=list)


class NutritionStatisticsResponse(BaseModel):
    range: NutritionStatisticsRange
    start_date: datetime
    end_date: datetime
    total_meals: int = Field(ge=0)
    total_hydration_ml: int = Field(ge=0)
    total_calories: int = Field(ge=0)
    total_macros_g: float = Field(ge=0)
    protein_g: float = Field(ge=0)
    carbs_g: float = Field(ge=0)
    fats_g: float = Field(ge=0)
    macro_distribution: list[MacroBreakdownItem]
    progression_granularity: ProgressionGranularity
    calorie_progression: list[NutritionProgressionPoint]
    calendar_days: list[MealCalendarDay] = Field(default_factory=list)
