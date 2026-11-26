"""AI meal recommendations (Premium).

The model only picks from a pool the server builds (meal_options plus the user's
favorites) and writes a short reason. Foods, grams and numbers always come from
the database. Without a model, or when it fails, the best rule-ranked meals are used.
"""

import json
import logging
import re
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException

from app.core.ai_quota import use_ai_call
from app.core.config import get_settings
from app.core.i18n import get_language, pick
from app.core.local_day import LocalDay
from app.db.supabase_client import get_supabase
from app.schemas.nutrition import MealCreateRequest, MealIngredient, MealRecommendation, MealRecommendationsResponse
from app.services import nutrition_service
from app.services.premium_service import has_active_premium

logger = logging.getLogger(__name__)

PICKS = 3
POOL_FOR_MODEL = 12
MAX_REFRESHES_PER_DAY = 5
GOAL_REACHED_KCAL = 150  # below this there is nothing sensible left to suggest
KCAL_OVERSHOOT = 1.1  # a suggestion may use at most 110% of the remaining calories
MEAL_TARGET_KCAL = 700  # one meal should not try to fill a whole day
MAX_REASON_LENGTH = 140
MODEL_TIMEOUT_SECONDS = 12
class RefreshLimitReached(RuntimeError):
    pass


class AlreadyHandled(RuntimeError):
    pass


COLUMNS = "id,name,meal_type,ingredients,calories,proteins_g,carbs_g,fats_g,quantity_g,reason,source,status,batch_id"

INSTRUCTION = (
    "You help a fitness app suggest meals. Pick exactly 3 different meals from the given options "
    "that best fit what the user still needs today and their objective. Use only option ids from the list. "
    "For each pick write one short, friendly reason (max 20 words) about why it fits. "
    "Do not write any numbers, do not invent foods, and do not give medical advice. "
    'Answer as JSON: {"picks": [{"id": "...", "reason": "..."}]}'
)


def _require_supabase() -> Any:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise RuntimeError("Database connection unavailable")
    return supabase


def _require_premium(supabase: Any, user_id: str) -> None:
    if not has_active_premium(user_id, supabase):
        raise PermissionError("Meal recommendations are a Premium feature.")


def _totals(ingredients: list[MealIngredient]) -> dict[str, Any]:
    quantity, calories, proteins, carbs, fats = nutrition_service._summarize_ingredients(ingredients)
    return {"quantity_g": quantity, "calories": calories, "proteins_g": proteins, "carbs_g": carbs, "fats_g": fats}


def _pool(supabase: Any, user_id: str) -> list[dict[str, Any]]:
    """Every meal the recommender may suggest, each with ingredients and totals from stored data."""
    pool: list[dict[str, Any]] = []
    for row in supabase.table("meal_options").select("id,name,meal_type,ingredients").eq("active", True).execute().data or []:
        ingredients = [MealIngredient(**item) for item in row.get("ingredients") or []]
        if ingredients:
            pool.append({"key": f"o{row['id']}", "name": row["name"], "meal_type": row["meal_type"],
                         "ingredients": ingredients, "origin": "option", **_totals(ingredients)})
    for favorite in nutrition_service.list_favorite_meals(user_id):
        pool.append({"key": f"f{favorite.id}", "name": favorite.name, "meal_type": favorite.meal_type,
                     "ingredients": favorite.ingredients, "origin": "favorite", "quantity_g": favorite.quantity_g,
                     "calories": favorite.calories, "proteins_g": favorite.proteins_g,
                     "carbs_g": favorite.carbs_g, "fats_g": favorite.fats_g})
    return pool


def rank_candidates(pool: list[dict[str, Any]], remaining: dict[str, float], eaten_names: set[str]) -> list[dict[str, Any]]:
    """Meals that fit the remaining calories, best fit first.

    Fit = calories close to one meal's share of what is left, and a protein/carb/fat
    split close to the split still needed.
    """
    kcal_left = remaining["calories"]
    target = min(kcal_left, MEAL_TARGET_KCAL)
    need = {key: max(0.0, remaining[key]) * factor for key, factor in (("proteins_g", 4), ("carbs_g", 4), ("fats_g", 9))}
    need_total = sum(need.values()) or 1.0

    def score(meal: dict[str, Any]) -> float:
        kcal_fit = 1 - abs(meal["calories"] - target) / target
        have = {"proteins_g": meal["proteins_g"] * 4, "carbs_g": meal["carbs_g"] * 4, "fats_g": meal["fats_g"] * 9}
        have_total = sum(have.values()) or 1.0
        split_gap = sum(abs(have[key] / have_total - need[key] / need_total) for key in need)
        return kcal_fit - split_gap

    seen: set[str] = set()
    fitting = []
    for meal in pool:
        name = meal["name"].strip().lower()
        if name in seen or name in eaten_names or not 0 < meal["calories"] <= kcal_left * KCAL_OVERSHOOT:
            continue
        seen.add(name)
        fitting.append(meal)
    return sorted(fitting, key=score, reverse=True)


def ask_model(candidates: list[dict[str, Any]], remaining: dict[str, float], objective: str | None) -> Any:
    """The raw model answer. Callers must validate it: this only returns what the model wrote."""
    settings = get_settings()
    payload = {
        "objective": objective or "general health",
        "still_needed_today": {key: round(value) for key, value in remaining.items()},
        "options": [
            {"id": meal["key"], "name": meal["name"], "meal_type": meal["meal_type"], "kcal": meal["calories"],
             "protein_g": round(meal["proteins_g"]), "carbs_g": round(meal["carbs_g"]), "fat_g": round(meal["fats_g"]),
             "is_favorite": meal["origin"] == "favorite"}
            for meal in candidates
        ],
    }
    instruction = (
        f"{INSTRUCTION} Write each \"reason\" in natural Spanish."
        if get_language() == "es"
        else INSTRUCTION
    )
    request: dict[str, Any] = {
        "model": settings.ai_model,
        "temperature": 0.4,
        "messages": [{"role": "system", "content": instruction}, {"role": "user", "content": json.dumps(payload)}],
        "response_format": {"type": "json_object"},
    }
    if "gpt-oss" in settings.ai_model:
        request["reasoning_effort"] = "low"  # reasoning models spend completion tokens on thinking first
        request["max_completion_tokens"] = 800
    else:
        request["max_tokens"] = 300
    from app.services.ai_service import get_ai_client  # imported late: it needs AI settings only when used

    client = get_ai_client().with_options(timeout=MODEL_TIMEOUT_SECONDS, max_retries=0)
    response = client.chat.completions.create(**request)
    return json.loads(response.choices[0].message.content or "null")


def _clean_reason(reason: Any) -> str | None:
    """Keep a model reason only if it is short plain text without numbers (numbers come from data only)."""
    if not isinstance(reason, str):
        return None
    reason = " ".join(reason.split())
    if not reason or len(reason) > MAX_REASON_LENGTH or re.search(r"\d", reason):
        return None
    return reason


def pick_meals(candidates: list[dict[str, Any]], answer: Any) -> list[tuple[dict[str, Any], str | None]]:
    """The model's picks that are real candidates, in its order, without repeats."""
    by_key = {meal["key"]: meal for meal in candidates}
    picks: list[tuple[dict[str, Any], str | None]] = []
    for item in (answer or {}).get("picks", []) if isinstance(answer, dict) else []:
        meal = by_key.get(item.get("id")) if isinstance(item, dict) else None
        if meal is not None and all(meal is not chosen for chosen, _ in picks):
            picks.append((meal, _clean_reason(item.get("reason"))))
        if len(picks) == PICKS:
            break
    return picks


def _rules_reason(meal: dict[str, Any]) -> str:
    if meal["origin"] == "favorite":
        return pick(
            "One of your favorites, and it fits what you have left today.",
            "Una de tus favoritas y encaja con lo que te queda hoy.",
        )
    return pick(
        "Fits the calories and macros you have left today.",
        "Encaja con las calorías y macros que te quedan hoy.",
    )


def _choose(user_id: str, candidates: list[dict[str, Any]], remaining: dict[str, float], objective: str | None) -> list[tuple[dict[str, Any], str, str]]:
    """(meal, reason, source) for each suggestion: the model's picks when it answers well, else the rule ranking."""
    if get_settings().ai_api_key and len(candidates) > PICKS:
        try:
            use_ai_call(UUID(user_id))
            picks = pick_meals(candidates[:POOL_FOR_MODEL], ask_model(candidates[:POOL_FOR_MODEL], remaining, objective))
            if len(picks) == PICKS:
                return [(meal, reason or _rules_reason(meal), "ai") for meal, reason in picks]
            logger.info("Meal recommendation model gave %d usable picks; using rules", len(picks))
        except HTTPException:
            logger.info("AI limit reached for meal recommendations; using rules")
        except Exception as err:
            logger.warning("Meal recommendation model failed; using rules: %s", err)
    return [(meal, _rules_reason(meal), "rules") for meal in candidates[:PICKS]]


def _item(row: dict[str, Any]) -> MealRecommendation:
    return MealRecommendation(
        id=str(row["id"]), name=row["name"], meal_type=row["meal_type"], calories=int(row.get("calories") or 0),
        proteins_g=round(float(row.get("proteins_g") or 0), 1), carbs_g=round(float(row.get("carbs_g") or 0), 1),
        fats_g=round(float(row.get("fats_g") or 0), 1), quantity_g=float(row.get("quantity_g") or 100),
        ingredients=row.get("ingredients") or [], reason=row.get("reason"),
        source=row.get("source") or "rules", status=row.get("status") or "pending",
    )


def _today_rows(supabase: Any, user_id: str, day: LocalDay) -> list[dict[str, Any]]:
    return (
        supabase.table("meal_recommendations").select(COLUMNS)
        .eq("user_id", user_id).eq("day", day.local_date.isoformat())
        .order("created_at").execute().data or []
    )


def _response(rows: list[dict[str, Any]], remaining: dict[str, float]) -> MealRecommendationsResponse:
    batches = {str(row["batch_id"]) for row in rows}
    latest = str(rows[-1]["batch_id"]) if rows else None
    return MealRecommendationsResponse(
        remaining_calories=round(remaining["calories"]),
        remaining_proteins_g=round(remaining["proteins_g"], 1),
        remaining_carbs_g=round(remaining["carbs_g"], 1),
        remaining_fats_g=round(remaining["fats_g"], 1),
        goal_reached=remaining["calories"] < GOAL_REACHED_KCAL,
        # The first set of the day is free; each later set is one refresh.
        refreshes_left=max(0, MAX_REFRESHES_PER_DAY - max(0, len(batches) - 1)),
        items=[_item(row) for row in rows if str(row["batch_id"]) == latest and row.get("status") == "pending"],
    )


def _remaining(user_id: str, day: LocalDay) -> tuple[dict[str, float], set[str]]:
    today = nutrition_service.get_user_nutrition_today(user_id, day.start, day.end)
    remaining = {
        "calories": float(today.remaining_calories),
        "proteins_g": today.remaining_proteins_g,
        "carbs_g": today.remaining_carbs_g,
        "fats_g": today.remaining_fats_g,
    }
    return remaining, {meal.meal_name.strip().lower() for meal in today.meals}


def coach_candidates(supabase: Any, user_id: str, day: LocalDay, limit: int) -> list[dict[str, Any]]:
    """Dishes the AI Coach may suggest: the ones that best fit what is left today. Callers check Premium."""
    remaining, eaten = _remaining(user_id, day)
    if remaining["calories"] < GOAL_REACHED_KCAL:
        return []
    return rank_candidates(_pool(supabase, user_id), remaining, eaten)[:limit]


def meals_by_key(supabase: Any, user_id: str) -> dict[str, dict[str, Any]]:
    return {meal["key"]: meal for meal in _pool(supabase, user_id)}


def _generate(supabase: Any, user_id: str, remaining: dict[str, float], eaten: set[str]) -> list[dict[str, Any]]:
    if remaining["calories"] < GOAL_REACHED_KCAL:
        return []
    objective_rows = supabase.table("users").select("objective").eq("id", user_id).limit(1).execute().data or []
    objective = objective_rows[0].get("objective") if objective_rows else None
    candidates = rank_candidates(_pool(supabase, user_id), remaining, eaten)
    return [
        {
            "name": meal["name"], "meal_type": meal["meal_type"],
            "ingredients": [item.model_dump() for item in meal["ingredients"]],
            "calories": meal["calories"], "proteins_g": meal["proteins_g"], "carbs_g": meal["carbs_g"],
            "fats_g": meal["fats_g"], "quantity_g": meal["quantity_g"] or 100, "reason": reason, "source": source,
        }
        for meal, reason, source in _choose(user_id, candidates, remaining, objective)
    ]


def _save_batch(supabase: Any, user_id: str, day: LocalDay, meals: list[dict[str, Any]]) -> None:
    batch_id = str(uuid4())
    if meals:
        supabase.table("meal_recommendations").insert([
            {"user_id": user_id, "day": day.local_date.isoformat(), "batch_id": batch_id, "status": "pending", **meal}
            for meal in meals
        ]).execute()


def get_recommendations(user_id: str, day: LocalDay) -> MealRecommendationsResponse:
    """Today's suggestions, created once per day; reopening the screen does not call the model again."""
    supabase = _require_supabase()
    _require_premium(supabase, user_id)
    remaining, eaten = _remaining(user_id, day)
    rows = _today_rows(supabase, user_id, day)
    if not rows:
        _save_batch(supabase, user_id, day, _generate(supabase, user_id, remaining, eaten))
        rows = _today_rows(supabase, user_id, day)
    return _response(rows, remaining)


def refresh_recommendations(user_id: str, day: LocalDay) -> MealRecommendationsResponse:
    supabase = _require_supabase()
    _require_premium(supabase, user_id)
    rows = _today_rows(supabase, user_id, day)
    remaining, eaten = _remaining(user_id, day)
    if rows and _response(rows, remaining).refreshes_left <= 0:
        raise RefreshLimitReached("You've used today's refreshes. New suggestions come tomorrow.")
    # Meals still on screen should not come straight back.
    shown = {str(row["name"]).strip().lower() for row in rows if row.get("status") == "pending"}
    supabase.table("meal_recommendations").update({"status": "dismissed"}).eq("user_id", user_id) \
        .eq("day", day.local_date.isoformat()).eq("status", "pending").execute()
    _save_batch(supabase, user_id, day, _generate(supabase, user_id, remaining, eaten | shown))
    return _response(_today_rows(supabase, user_id, day), remaining)


def _owned_pending(supabase: Any, user_id: str, recommendation_id: str, day: LocalDay) -> dict[str, Any]:
    rows = (
        supabase.table("meal_recommendations").select(COLUMNS)
        .eq("id", recommendation_id).eq("user_id", user_id).eq("day", day.local_date.isoformat())
        .limit(1).execute().data or []
    )
    if not rows:
        raise LookupError("Recommendation not found")
    return rows[0]


def add_recommendation(user_id: str, recommendation_id: str, day: LocalDay):
    """Logs a suggestion as a meal now. The status flips first, so a double tap logs it only once."""
    supabase = _require_supabase()
    _require_premium(supabase, user_id)
    row = _owned_pending(supabase, user_id, recommendation_id, day)
    claimed = (
        supabase.table("meal_recommendations").update({"status": "added"})
        .eq("id", recommendation_id).eq("user_id", user_id).eq("status", "pending")
        .select("id").execute().data
    )
    if not claimed:
        raise AlreadyHandled("This suggestion was already added or dismissed.")
    try:
        return nutrition_service.create_user_meal(MealCreateRequest(
            user_id=user_id, name=row["name"], meal_type=row["meal_type"],
            ingredients=[MealIngredient(**item) for item in row.get("ingredients") or []],
        ))
    except Exception:
        supabase.table("meal_recommendations").update({"status": "pending"}).eq("id", recommendation_id) \
            .eq("user_id", user_id).execute()
        raise


def dismiss_recommendation(user_id: str, recommendation_id: str, day: LocalDay) -> None:
    supabase = _require_supabase()
    _require_premium(supabase, user_id)
    _owned_pending(supabase, user_id, recommendation_id, day)
    supabase.table("meal_recommendations").update({"status": "dismissed"}).eq("id", recommendation_id) \
        .eq("user_id", user_id).eq("status", "pending").execute()
