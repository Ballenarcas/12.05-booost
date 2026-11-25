from __future__ import annotations

import logging
import math
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable
from uuid import UUID

from fastapi import HTTPException

from app.db.supabase_client import get_supabase
from app.schemas.nutrition_statistics import (
    MacroBreakdownItem,
    MealCalendarDay,
    MealCalendarItem,
    NutritionProgressionPoint,
    NutritionStatisticsRange,
    NutritionStatisticsResponse,
)
from app.services.workout_statistics_service import (
    _bucket_date,
    _local_date,
    _parse_datetime,
    _to_number,
    resolve_range_bounds,
)

logger = logging.getLogger(__name__)

_MEAL_TYPE_ORDER = {
    "Breakfast": 0,
    "Lunch": 1,
    "Snack": 2,
    "Dinner": 3,
    "Meal": 4,
}


def _missing_meal_ingredients_table(error: Exception) -> bool:
    message = str(error).lower()
    return "meal_ingredients" in message and any(
        marker in message for marker in ("schema cache", "does not exist", "could not find", "undefined table")
    )


def _normalize_meal_type(value: Any, local_hour: int) -> str:
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned:
            lower = cleaned.casefold()
            canonical = {
                "breakfast": "Breakfast",
                "lunch": "Lunch",
                "snack": "Snack",
                "dinner": "Dinner",
                "meal": "Meal",
            }.get(lower)
            return canonical or cleaned.title()
    if local_hour < 11:
        return "Breakfast"
    if local_hour < 16:
        return "Lunch"
    if local_hour < 19:
        return "Snack"
    return "Dinner"


def _local_datetime(value: datetime, timezone_offset_minutes: int) -> datetime:
    offset = max(-1440, min(1440, timezone_offset_minutes))
    return value.astimezone(timezone(timedelta(minutes=-offset)))


def _non_negative_number(value: Any) -> float:
    parsed = _to_number(value)
    if parsed is None or not math.isfinite(parsed) or parsed < 0:
        return 0.0
    return parsed


def aggregate_nutrition_statistics(
    meal_rows: Iterable[dict[str, Any]] | None,
    *,
    range_key: NutritionStatisticsRange,
    start: datetime,
    end: datetime,
    timezone_offset_minutes: int = 0,
    meal_types_by_meal: dict[str, str] | None = None,
    hydration_rows: Iterable[dict[str, Any]] | None = None,
) -> NutritionStatisticsResponse:
    """Aggregate logged meals and hydration entries into nutrition statistics."""
    range_start = _parse_datetime(start)
    range_end = _parse_datetime(end)
    if range_start is None or range_end is None or range_start > range_end:
        raise ValueError("Statistics range bounds are invalid")

    meal_types = meal_types_by_meal or {}
    total_meals = 0
    total_calories = 0.0
    protein_g = 0.0
    carbs_g = 0.0
    fats_g = 0.0

    daily_calories: dict[date, float] = defaultdict(float)
    calendar_groups: dict[date, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    seen_meals: set[str] = set()

    for index, row in enumerate(meal_rows or []):
        if not isinstance(row, dict):
            continue
        meal_key = str(row.get("id") or f"meal-row-{index}")
        if meal_key in seen_meals:
            continue

        consumed_at = _parse_datetime(row.get("consumed_at"))
        if consumed_at is None or consumed_at < range_start or consumed_at > range_end:
            continue

        seen_meals.add(meal_key)
        total_meals += 1

        calories = _non_negative_number(row.get("calories"))
        protein = _non_negative_number(row.get("proteins"))
        carbs = _non_negative_number(row.get("carbs"))
        fats = _non_negative_number(row.get("fats"))

        total_calories += calories
        protein_g += protein
        carbs_g += carbs
        fats_g += fats

        local_dt = _local_datetime(consumed_at, timezone_offset_minutes)
        local_day = local_dt.date()
        daily_calories[local_day] += calories

        meal_type = _normalize_meal_type(meal_types.get(meal_key), local_dt.hour)
        bucket = calendar_groups[local_day][meal_type]
        bucket[0] += round(calories)
        bucket[1] += 1

    start_local = _local_date(range_start, timezone_offset_minutes)
    end_local = _local_date(range_end, timezone_offset_minutes)
    total_hydration_ml = 0
    for row in hydration_rows or []:
        if not isinstance(row, dict):
            continue
        raw_date = str(row.get("log_date") or "")[:10]
        try:
            log_day = date.fromisoformat(raw_date)
        except ValueError:
            continue
        if log_day < start_local or log_day > end_local:
            continue
        amount = _non_negative_number(row.get("amount_ml"))
        total_hydration_ml += round(amount)

    granularity = "week" if range_key == "3M" else "day"
    if granularity == "day":
        calorie_progression = [
            NutritionProgressionPoint(date=day, calories=round(cals), logged_days=1)
            for day, cals in sorted(daily_calories.items())
            if cals > 0
        ]
    else:
        weekly_totals: dict[date, list[float]] = defaultdict(list)
        for day, cals in sorted(daily_calories.items()):
            if cals > 0:
                weekly_totals[_bucket_date(day, range_key)].append(cals)
        calorie_progression = [
            NutritionProgressionPoint(
                date=week_start,
                calories=round(sum(day_values) / len(day_values)),
                logged_days=len(day_values),
            )
            for week_start, day_values in sorted(weekly_totals.items())
            if day_values
        ]

    calendar_days = []
    for day, type_map in sorted(calendar_groups.items()):
        items = [
            MealCalendarItem(meal_type=meal_type, calories=values[0], meal_count=values[1])
            for meal_type, values in sorted(
                type_map.items(),
                key=lambda item: (_MEAL_TYPE_ORDER.get(item[0], 99), item[0].casefold()),
            )
        ]
        calendar_days.append(
            MealCalendarDay(
                date=day,
                meal_count=sum(item.meal_count for item in items),
                total_calories=sum(item.calories for item in items),
                items=items,
            )
        )

    rounded_protein = round(protein_g, 1)
    rounded_carbs = round(carbs_g, 1)
    rounded_fats = round(fats_g, 1)
    total_macros_g = round(rounded_protein + rounded_carbs + rounded_fats, 1)

    return NutritionStatisticsResponse(
        range=range_key,
        start_date=range_start,
        end_date=range_end,
        total_meals=total_meals,
        total_hydration_ml=total_hydration_ml,
        total_calories=round(total_calories),
        total_macros_g=total_macros_g,
        protein_g=rounded_protein,
        carbs_g=rounded_carbs,
        fats_g=rounded_fats,
        macro_distribution=[
            MacroBreakdownItem(macro="protein", label="Protein", grams=rounded_protein),
            MacroBreakdownItem(macro="carbs", label="Carbs", grams=rounded_carbs),
            MacroBreakdownItem(macro="fats", label="Fats", grams=rounded_fats),
        ],
        progression_granularity=granularity,
        calorie_progression=calorie_progression,
        calendar_days=calendar_days,
    )


def _fetch_meals_with_types(
    supabase: Any,
    user_id: str,
    start: datetime,
    end: datetime,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    meal_rows = (
        supabase.table("meals")
        .select("id,calories,proteins,carbs,fats,consumed_at")
        .eq("user_id", user_id)
        .gte("consumed_at", start.isoformat())
        .lte("consumed_at", end.isoformat())
        .order("consumed_at")
        .execute()
        .data
        or []
    )
    meal_ids = [str(row["id"]) for row in meal_rows if row.get("id")]
    meal_types_by_meal: dict[str, str] = {}
    if not meal_ids:
        return meal_rows, meal_types_by_meal

    try:
        for offset in range(0, len(meal_ids), 150):
            batch = meal_ids[offset : offset + 150]
            ingredient_rows = (
                supabase.table("meal_ingredients")
                .select("meal_id,meal_type")
                .eq("user_id", user_id)
                .in_("meal_id", batch)
                .execute()
                .data
                or []
            )
            for row in ingredient_rows:
                meal_id = str(row.get("meal_id") or "")
                meal_type = row.get("meal_type")
                if meal_id and isinstance(meal_type, str) and meal_type.strip() and meal_id not in meal_types_by_meal:
                    meal_types_by_meal[meal_id] = meal_type.strip()
    except Exception as err:
        if not _missing_meal_ingredients_table(err):
            logger.warning("Could not load meal ingredient types for statistics: %s", err)

    return meal_rows, meal_types_by_meal


def _fetch_hydration_rows(
    supabase: Any,
    user_id: str,
    start_local: date,
    end_local: date,
) -> list[dict[str, Any]]:
    try:
        return (
            supabase.table("hydration_logs")
            .select("log_date,amount_ml")
            .eq("user_id", user_id)
            .gte("log_date", start_local.isoformat())
            .lte("log_date", end_local.isoformat())
            .execute()
            .data
            or []
        )
    except Exception as err:
        logger.warning("Could not load hydration logs for nutrition statistics: %s", err)
        return []


def get_nutrition_statistics(
    user_id: UUID,
    range_key: NutritionStatisticsRange,
    timezone_offset_minutes: int = 0,
    now: datetime | None = None,
) -> NutritionStatisticsResponse:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    start, end = resolve_range_bounds(range_key, now)
    start_local = _local_date(start, timezone_offset_minutes)
    end_local = _local_date(end, timezone_offset_minutes)
    uid = str(user_id)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            meals_future = executor.submit(_fetch_meals_with_types, supabase, uid, start, end)
            hydration_future = executor.submit(_fetch_hydration_rows, supabase, uid, start_local, end_local)
            meal_rows, meal_types = meals_future.result()
            hydration_rows = hydration_future.result()
    except HTTPException:
        raise
    except Exception as err:
        logger.exception("Failed to load nutrition statistics")
        raise HTTPException(status_code=502, detail="Could not load nutrition statistics") from err

    return aggregate_nutrition_statistics(
        meal_rows,
        range_key=range_key,
        start=start,
        end=end,
        timezone_offset_minutes=timezone_offset_minutes,
        meal_types_by_meal=meal_types,
        hydration_rows=hydration_rows,
    )
