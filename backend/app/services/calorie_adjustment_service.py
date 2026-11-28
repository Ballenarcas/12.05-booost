"""Calorie goal adjustments from the last 7 days of logged data.

Pure rules first (propose_adjustment), then a thin service that reads the
existing tables, persists one pending proposal per user, and applies the new
goal to users.calorie_goal when the user accepts.

Health Connect activity is a context and safety input: a high-activity week can
hold a fat-loss target or raise a maintenance target, but it never deepens a
deficit.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

from app.core.i18n import get_language, normalize_language
from app.db.supabase_client import get_supabase
from app.schemas.health import HealthActivitySummary
from app.services.exercise_catalog import get_cached_exercise
from app.services.health_service import get_activity_summary
from app.services.user_profile_service import calculate_calorie_goal

ADJUSTMENTS_TABLE = "ai_calorie_adjustments"
EVALUATION_DAYS = 7
REVIEW_COOLDOWN_DAYS = EVALUATION_DAYS  # the same week of data must not move the goal twice
COMPLIANCE_BAND = 0.10
LOW_COMPLIANCE = 0.50
HIGH_COMPLIANCE = 0.80
FAT_LOSS_STEP = 150
MUSCLE_GAIN_STEP = 200
MIN_STEP = 100
MIN_GOAL = 1200
MAX_GOAL = 5000
MAX_DAILY_DEFICIT = 500

# Self-reported post-workout fatigue (1-10). Above 5 the trainer adds recovery
# calories in proportion to the extra fatigue, capped at 200 kcal/day.
FATIGUE_THRESHOLD = 5
FATIGUE_KCAL_PER_POINT = 40
MAX_FATIGUE_BUMP = 200
FATIGUE_RECENT_DAYS = 3  # only a recent session should move tomorrow's target

# Health Connect activity is a safety and context input, not a second calorie
# target: only a quarter of the active burn can raise a goal, capped at 200 kcal.
ACTIVITY_HIGH_STEPS = 8_000
ACTIVITY_VERY_HIGH_STEPS = 12_000
ACTIVITY_HIGH_KCAL = 350
ACTIVITY_CREDIT_RATE = 0.25
ACTIVITY_CREDIT_CAP = 200
MIN_ACTIVITY_CREDIT = 100

ObjectiveBranch = Literal["fat_loss", "muscle_gain", "maintenance"]


def classify_objective(objective: str | None) -> ObjectiveBranch:
    """Map the free-text objective stored in users to one of the three rule branches."""
    text = (objective or "").lower()
    if "lose" in text or "loss" in text or "fat" in text or "cut" in text:
        return "fat_loss"
    if "hypertrophy" in text or "strength" in text or "muscle" in text or "gain" in text:
        return "muscle_gain"
    return "maintenance"


def _health(metrics: dict[str, Any]) -> HealthActivitySummary:
    value = metrics.get("health")
    if isinstance(value, HealthActivitySummary):
        return value
    if isinstance(value, dict):
        try:
            return HealthActivitySummary(**value)
        except ValueError:
            return HealthActivitySummary()
    return HealthActivitySummary()


def _activity_phrase(health: HealthActivitySummary, is_es: bool = False) -> str:
    parts = []
    if health.steps_avg_7d > 0:
        parts.append(f"{health.steps_avg_7d:,} pasos" if is_es else f"{health.steps_avg_7d:,} steps")
    if health.active_calories_avg_7d > 0:
        parts.append(
            f"{health.active_calories_avg_7d} kcal activas"
            if is_es
            else f"{health.active_calories_avg_7d} active kcal"
        )
    return (" y " if is_es else " and ").join(parts)


def _activity_sentence(metrics: dict[str, Any], is_es: bool = False) -> str:
    health = _health(metrics)
    if not health.connected:
        return ""
    phrase = _activity_phrase(health, is_es=is_es)
    if not phrase:
        return (
            "Health Connect está conectado, pero aún no se ha sincronizado actividad reciente."
            if is_es
            else "Health Connect is connected, but no recent activity was synced."
        )
    return f"Promediaste {phrase} al día." if is_es else f"You averaged {phrase} per day."


def _activity_is_high(metrics: dict[str, Any]) -> bool:
    health = _health(metrics)
    return health.connected and (
        health.active_calories_avg_7d >= ACTIVITY_HIGH_KCAL
        or health.steps_avg_7d >= ACTIVITY_VERY_HIGH_STEPS
    )


def _activity_is_low(metrics: dict[str, Any]) -> bool:
    health = _health(metrics)
    return (
        health.connected
        and health.steps_avg_7d < 4_000
        and health.active_calories_avg_7d < 150
    )


def _activity_credit(metrics: dict[str, Any]) -> int:
    """Calories an active week can add back, kept deliberately small."""
    health = _health(metrics)
    if not health.connected:
        return 0
    credit = min(
        ACTIVITY_CREDIT_CAP,
        round(health.active_calories_avg_7d * ACTIVITY_CREDIT_RATE),
    )
    if health.steps_avg_7d >= ACTIVITY_HIGH_STEPS:
        credit = max(credit, MIN_ACTIVITY_CREDIT)
    return max(0, credit)


def _fatigue_level(metrics: dict[str, Any]) -> float:
    value = metrics.get("fatigue_latest")
    if value is None:
        value = metrics.get("fatigue_avg") or 0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _fatigue_bump(metrics: dict[str, Any]) -> int:
    """Recovery calories proportional to fatigue above the threshold, rounded to 10 kcal."""
    level = _fatigue_level(metrics)
    if level <= FATIGUE_THRESHOLD:
        return 0
    points = level - FATIGUE_THRESHOLD
    return min(MAX_FATIGUE_BUMP, int(round(points * FATIGUE_KCAL_PER_POINT / 10.0) * 10))


def _fatigue_proposal(metrics: dict[str, Any], bump: int, is_es: bool = False) -> dict[str, Any]:
    """High fatigue always earns recovery calories, whatever the compliance picture is."""
    goal = int(metrics.get("goal") or 0)
    level = _fatigue_level(metrics)
    objective = classify_objective(metrics.get("objective"))
    maintenance = int(metrics.get("maintenance") or 0)
    proposed = min(MAX_GOAL, goal + bump)
    if objective == "fat_loss" and maintenance > 0:
        # Recovery during a cut shrinks the deficit; it never turns into a surplus.
        proposed = min(proposed, maintenance)
    label = (
        f"Tu última fatiga tras entrenar fue de {level:.1f}/10."
        if is_es
        else f"Your latest workout fatigue was {level:.1f}/10."
    )
    if proposed <= goal:
        if objective == "fat_loss" and maintenance > 0 and goal >= maintenance:
            detail = (
                "Tu objetivo ya está en mantenimiento, así que se mantiene mientras te recuperas."
                if is_es
                else "Your target is already at maintenance, so it stays there while you recover."
            )
        else:
            detail = (
                f"Tu objetivo ya está en el límite de {MAX_GOAL} kcal, así que se mantiene."
                if is_es
                else f"Your target is at the {MAX_GOAL} kcal ceiling, so it stays there."
            )
        return {"has_change": False, "proposed_goal": goal, "reason": f"{label} {detail}"}
    extra = proposed - goal
    if objective == "fat_loss":
        detail = (
            f"Para favorecer la recuperación, el objetivo sube {extra} kcal "
            "(ajustado a tu fatiga) manteniendo todavía el déficit."
            if is_es
            else f"To keep recovery on track, the target rises by {extra} kcal "
            "(scaled to your fatigue) while still keeping a deficit."
        )
    elif objective == "muscle_gain":
        detail = (
            f"Para favorecer la recuperación y mantener la calidad del entreno, el objetivo sube {extra} kcal "
            "(ajustado a tu fatiga)."
            if is_es
            else f"To support recovery and keep training quality, the target rises by {extra} kcal "
            "(scaled to your fatigue)."
        )
    else:
        detail = (
            f"Para favorecer la recuperación, el objetivo sube {extra} kcal (ajustado a tu fatiga)."
            if is_es
            else f"To support recovery, the target rises by {extra} kcal (scaled to your fatigue)."
        )
    reason = f"{label} {detail}"
    if _health(metrics).connected:
        reason += f" {_activity_sentence(metrics, is_es=is_es)}"
    return {"has_change": True, "proposed_goal": proposed, "reason": reason}


def propose_adjustment(metrics: dict[str, Any], lang: str | None = None) -> dict[str, Any]:
    """Return {has_change, proposed_goal, reason}. Deterministic, no database access."""
    is_es = (normalize_language(lang) if lang is not None else get_language()) == "es"
    goal = int(metrics.get("goal") or 0)
    if goal <= 0:
        return {
            "has_change": False,
            "proposed_goal": goal,
            "reason": (
                "Define tu objetivo diario de calorías en Ajustes antes de poder ajustarlo."
                if is_es
                else "Set your daily calorie goal in Settings before the target can be tuned."
            ),
        }

    fatigue_bump = _fatigue_bump(metrics)
    if fatigue_bump > 0:
        return _fatigue_proposal(metrics, fatigue_bump, is_es=is_es)

    compliance = float(metrics.get("compliance") or 0.0)
    days_within = int(metrics.get("days_within") or 0)
    if compliance < LOW_COMPLIANCE:
        reason = (
            f"Primero constancia: solo {days_within} de {EVALUATION_DAYS} días estuvieron dentro del "
            f"10 % de tu objetivo de {goal} kcal. Registra todos los días durante una semana antes de cambiarlo."
            if is_es
            else f"Consistency first: only {days_within} of {EVALUATION_DAYS} days landed within "
            f"10% of your {goal} kcal goal. Log every day for a week before the target moves."
        )
        if _health(metrics).connected:
            reason += f" {_activity_sentence(metrics, is_es=is_es)}"
        return {
            "has_change": False,
            "proposed_goal": goal,
            "reason": reason,
        }

    if compliance < HIGH_COMPLIANCE:
        reason = (
            f"Estás cerca. {days_within} de {EVALUATION_DAYS} días cumplieron el objetivo; "
            "llega a 6 de 7 antes de moverlo."
            if is_es
            else f"You are close. {days_within} of {EVALUATION_DAYS} days stayed on target; "
            "reach 6 of 7 before the goal changes."
        )
        if _health(metrics).connected:
            reason += f" {_activity_sentence(metrics, is_es=is_es)}"
        return {
            "has_change": False,
            "proposed_goal": goal,
            "reason": reason,
        }

    objective = classify_objective(metrics.get("objective"))
    avg_intake = int(metrics.get("avg_intake") or 0)

    if objective == "fat_loss":
        if avg_intake < goal * 0.98:
            reason = (
                f"Tu ingesta media es de {avg_intake} kcal frente a un objetivo de {goal} kcal, así que el "
                "déficit está funcionando. Mantén el objetivo."
                if is_es
                else f"Your average intake is {avg_intake} kcal against a {goal} kcal goal, so the "
                "deficit is working. Hold the target."
            )
            if _health(metrics).connected:
                reason += (
                    f" {_activity_sentence(metrics, is_es=True)} Tu actividad ya amplía el déficit, así que no hace falta recortar más."
                    if is_es
                    else f" {_activity_sentence(metrics)} Activity is widening the deficit, so no cut is needed."
                )
            return {
                "has_change": False,
                "proposed_goal": goal,
                "reason": reason,
            }
        if _activity_is_high(metrics) and avg_intake <= goal * 1.10:
            return {
                "has_change": False,
                "proposed_goal": goal,
                "reason": (
                    f"{_activity_sentence(metrics, is_es=True)} Tu actividad ya amplía el déficit, "
                    f"así que mantener {goal} kcal es más seguro que recortarlo."
                    if is_es
                    else f"{_activity_sentence(metrics)} Activity is already widening the deficit, "
                    f"so keeping the {goal} kcal target is safer than cutting it."
                ),
            }
        floor = max(MIN_GOAL, int(metrics.get("deficit_floor") or 0))
        reduction = min(FAT_LOSS_STEP, goal - floor)
        if reduction < MIN_STEP:
            return {
                "has_change": False,
                "proposed_goal": goal,
                "reason": (
                    f"Tu objetivo ya está en el mínimo de seguridad de {floor} kcal, así que se mantiene."
                    if is_es
                    else f"Your goal is already at the {floor} kcal safety floor, so it stays there."
                ),
            }
        proposed = goal - reduction
        reason = (
            f"Tu ingesta media es de {avg_intake} kcal frente a un objetivo de {goal} kcal, así que el "
            f"déficit no se está produciendo. Bajamos el objetivo en {goal - proposed} kcal."
            if is_es
            else f"Your average intake is {avg_intake} kcal against a {goal} kcal goal, so the "
            f"deficit is not happening. Lowering the target by {goal - proposed} kcal."
        )
        if _activity_is_low(metrics):
            reason += (
                f" {_activity_sentence(metrics, is_es=True)} Añadir una caminata diaria ampliaría el déficit sin comer menos."
                if is_es
                else f" {_activity_sentence(metrics)} Adding a daily walk would widen the deficit "
                "without eating less."
            )
        elif _health(metrics).connected:
            reason += (
                f" {_activity_sentence(metrics, is_es=True)} Mantén esa actividad mientras baja el objetivo."
                if is_es
                else f" {_activity_sentence(metrics)} Keep that activity up while the target comes down."
            )
        return {
            "has_change": True,
            "proposed_goal": proposed,
            "reason": reason,
        }

    if objective == "muscle_gain":
        volume_now = int(metrics.get("volume_this_week") or 0)
        volume_before = int(metrics.get("volume_prev_week") or 0)
        if volume_before <= 0 or volume_now <= volume_before:
            return {
                "has_change": False,
                "proposed_goal": goal,
                "reason": (
                    "El volumen de entrenamiento aún no sube, así que mantén la ingesta estable hasta que lo haga."
                    if is_es
                    else "Training volume is not rising yet, so keep intake steady until it does."
                ),
            }
        activity_bonus = _activity_credit(metrics) if _activity_is_high(metrics) else 0
        proposed = min(MAX_GOAL, goal + MUSCLE_GAIN_STEP + activity_bonus)
        if proposed <= goal:
            return {
                "has_change": False,
                "proposed_goal": goal,
                "reason": (
                    f"Tu objetivo ya está en el límite de {MAX_GOAL} kcal, así que se mantiene."
                    if is_es
                    else f"Your goal is at the {MAX_GOAL} kcal ceiling, so it stays there."
                ),
            }
        reason = (
            f"El volumen de entrenamiento subió de {volume_before} kg a {volume_now} kg esta semana con "
            f"{days_within} de {EVALUATION_DAYS} días en objetivo. Subimos el objetivo en "
            f"{proposed - goal} kcal."
            if is_es
            else f"Training volume rose from {volume_before} kg to {volume_now} kg this week with "
            f"{days_within} of {EVALUATION_DAYS} days on target. Raising the target by "
            f"{proposed - goal} kcal."
        )
        if activity_bonus:
            reason += (
                f" {_activity_sentence(metrics, is_es=True)} Esa actividad aumenta las necesidades de recuperación, así que el aumento lo cubre."
                if is_es
                else f" {_activity_sentence(metrics)} That activity raises recovery needs, so the "
                "increase covers it."
            )
        return {
            "has_change": True,
            "proposed_goal": proposed,
            "reason": reason,
        }

    activity_credit = _activity_credit(metrics)
    if activity_credit >= MIN_STEP:
        proposed = min(MAX_GOAL, goal + activity_credit)
        return {
            "has_change": True,
            "proposed_goal": proposed,
            "reason": (
                f"Mantenimiento: {_activity_sentence(metrics, is_es=True)} Subir el objetivo en "
                f"{proposed - goal} kcal lo ajusta a esa actividad."
                if is_es
                else f"Maintenance: {_activity_sentence(metrics)} Raising the target by "
                f"{proposed - goal} kcal keeps it matched to that activity."
            ),
        }
    reason = (
        f"Mantenimiento: {days_within} de {EVALUATION_DAYS} días cumplieron tu objetivo de {goal} kcal. "
        "Mantenemos el objetivo estable."
        if is_es
        else f"Maintenance: {days_within} of {EVALUATION_DAYS} days matched your {goal} kcal goal. "
        "Keeping the target steady."
    )
    if _health(metrics).connected:
        reason += f" {_activity_sentence(metrics, is_es=is_es)}"
        if _activity_is_low(metrics):
            reason += (
                " Una caminata diaria le daría más margen al entrenador."
                if is_es
                else " A daily walk would give the trainer more to work with."
            )
    return {
        "has_change": False,
        "proposed_goal": goal,
        "reason": reason,
    }


def _rows(response: Any) -> list[dict[str, Any]]:
    rows = response.data or []
    return rows if isinstance(rows, list) else [rows]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _day_key(consumed_at: Any) -> str | None:
    if not consumed_at:
        return None
    text = str(consumed_at).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).date().isoformat()
    except ValueError:
        return text[:10]


def collect_metrics(session: Any, user_id: UUID, today: str | None = None) -> dict[str, Any]:
    """Read users, meals and workout sets from the existing tables. Seven day window."""
    day = today or _utc_now().date().isoformat()
    window_start = datetime.fromisoformat(f"{day}T00:00:00+00:00") - timedelta(days=EVALUATION_DAYS - 1)
    volume_start = window_start - timedelta(days=EVALUATION_DAYS)

    users = _rows(
        session.table("users").select("calorie_goal,objective,weight,height,age,gender")
        .eq("id", str(user_id)).limit(1).execute()
    )
    user = users[0] if users else {}
    goal = int(user.get("calorie_goal") or 0)
    deficit_floor = 0
    maintenance = 0
    if user.get("weight") and user.get("height") and user.get("age"):
        maintenance = calculate_calorie_goal(user["weight"], user["height"], user["age"], user.get("gender"), None)
        deficit_floor = maintenance - MAX_DAILY_DEFICIT

    meals = _rows(
        session.table("meals").select("calories,consumed_at")
        .eq("user_id", str(user_id))
        .gte("consumed_at", window_start.isoformat()).execute()
    )
    daily: dict[str, float] = {}
    for row in meals:
        key = _day_key(row.get("consumed_at"))
        if key:
            daily[key] = daily.get(key, 0.0) + float(row.get("calories") or 0)

    days_within = 0
    if goal > 0:
        band = goal * COMPLIANCE_BAND
        days_within = sum(1 for total in daily.values() if abs(total - goal) <= band)

    workouts = _rows(
        session.table("workouts")
        .select("id,start_time,fatigue_level,workout_sets(exercise_id,weight,reps,is_done)")
        .eq("user_id", str(user_id))
        .gte("start_time", volume_start.isoformat()).execute()
    )
    volume_this_week = 0.0
    volume_prev_week = 0.0
    fatigue_levels: list[float] = []
    latest_fatigue = 0.0
    latest_started: datetime | None = None
    for workout in workouts:
        started = workout.get("start_time")
        if not started:
            continue
        try:
            started_at = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
        except ValueError:
            continue
        volume = 0.0
        for set_row in workout.get("workout_sets") or []:
            if set_row.get("is_done") is not True:
                continue
            cached = get_cached_exercise(str(set_row.get("exercise_id") or ""))
            if cached and "cardio" in (cached.category or "").lower():
                continue
            volume += float(set_row.get("weight") or 0) * float(set_row.get("reps") or 0)
        if started_at >= window_start:
            volume_this_week += volume
            level = workout.get("fatigue_level")
            if level is not None:
                try:
                    value = float(level)
                except (TypeError, ValueError):
                    value = 0.0
                if 1 <= value <= 10:
                    fatigue_levels.append(value)
                    if latest_started is None or started_at > latest_started:
                        latest_started, latest_fatigue = started_at, value
        else:
            volume_prev_week += volume

    # A mark older than a few days has already served its purpose.
    if latest_started is not None and latest_started < _utc_now() - timedelta(days=FATIGUE_RECENT_DAYS):
        latest_fatigue = 0.0

    total_calories = sum(daily.values())
    return {
        "goal": goal,
        "maintenance": maintenance,
        "deficit_floor": deficit_floor,
        "objective": user.get("objective"),
        "avg_intake": round(total_calories / EVALUATION_DAYS),
        "days_logged": len(daily),
        "days_within": days_within,
        "compliance": round(days_within / EVALUATION_DAYS, 2),
        "volume_this_week": round(volume_this_week),
        "volume_prev_week": round(volume_prev_week),
        "fatigue_avg": round(sum(fatigue_levels) / len(fatigue_levels), 1) if fatigue_levels else 0.0,
        "fatigue_latest": latest_fatigue,
        "fatigue_workouts": len(fatigue_levels),
        "health": get_activity_summary(user_id, db_session=session, today=day),
    }


def _response(row: dict[str, Any], metrics: dict[str, Any] | None = None) -> dict[str, Any]:
    previous = int(row.get("previous_goal") or 0)
    proposed = int(row.get("proposed_goal") or 0)
    data = {
        "adjustment_id": str(row.get("id")) if row.get("id") else None,
        "previous_goal": previous,
        "proposed_goal": proposed,
        "has_change": proposed != previous,
        "reason": str(row.get("reason") or ""),
        "status": str(row.get("status") or "pending"),
        "objective": classify_objective((metrics or {}).get("objective")),
        "avg_daily_intake": int((metrics or {}).get("avg_intake") or 0),
        "compliance_rate": float((metrics or {}).get("compliance") or 0.0),
        "weekly_volume": int((metrics or {}).get("volume_this_week") or 0),
        "fatigue_avg": round(float((metrics or {}).get("fatigue_avg") or 0.0), 1),
        "fatigue_latest": round(float((metrics or {}).get("fatigue_latest") or 0.0), 1),
        "fatigue_workouts": int((metrics or {}).get("fatigue_workouts") or 0),
        "activity": _health(metrics or {}).model_dump(mode="json"),
    }
    return data


def _is_within_cooldown(created_at: Any, now: datetime) -> bool:
    if not created_at:
        return False
    try:
        created = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return False
    return (now - created) < timedelta(days=REVIEW_COOLDOWN_DAYS)


def _high_fatigue_after(session: Any, user_id: UUID, created_at: Any) -> bool:
    """A demanding workout can refresh the advice even inside the weekly cooldown."""
    if not created_at:
        return False
    try:
        since = datetime.fromisoformat(str(created_at).replace("Z", "+00:00")).isoformat()
    except ValueError:
        since = str(created_at)
    try:
        rows = _rows(
            session.table("workouts").select("fatigue_level,end_time")
            .eq("user_id", str(user_id)).gte("end_time", since).execute()
        )
    except Exception:
        return False
    for row in rows:
        try:
            level = float(row.get("fatigue_level") or 0)
        except (TypeError, ValueError):
            continue
        if FATIGUE_THRESHOLD < level <= 10:
            return True
    return False


def _is_missing_table(error: Exception) -> bool:
    text = str(error)
    return "PGRST205" in text or "does not exist" in text or "schema cache" in text


def _missing_table_error(error: Exception) -> RuntimeError:
    return RuntimeError(
        f"{ADJUSTMENTS_TABLE} table is missing. Run create_ai_calorie_adjustments_table.sql."
    )


def _latest_rows(session: Any, user_id: UUID, status: str | None = None) -> list[dict[str, Any]]:
    query = session.table(ADJUSTMENTS_TABLE).select("*").eq("user_id", str(user_id))
    if status:
        query = query.eq("status", status)
    return _rows(query.order("created_at", desc=True).limit(1).execute())


def _find_adjustment(session: Any, user_id: UUID, adjustment_id: UUID) -> dict[str, Any]:
    found = _rows(
        session.table(ADJUSTMENTS_TABLE).select("*")
        .eq("id", str(adjustment_id)).eq("user_id", str(user_id)).limit(1).execute()
    )
    if not found:
        raise ValueError("Adjustment not found")
    return found[0]


def _decided_response(row: dict[str, Any]) -> dict[str, Any]:
    result = _response(row)
    accepted = str(row.get("status")) == "accepted"
    goal = row.get("proposed_goal") if accepted else row.get("previous_goal")
    result["calorie_goal"] = int(goal or 0)
    return result


def get_adjustment(
    user_id: UUID,
    db_session: Any = None,
    today: str | None = None,
) -> dict[str, Any]:
    """Return the current proposal. A decided one is not recomputed until the cooldown ends."""
    session = db_session or get_supabase(admin=True)
    latest = None
    try:
        latest = _latest_rows(session, user_id)
    except Exception as err:
        if _is_missing_table(err):
            raise _missing_table_error(err) from err
        raise

    if latest:
        row = latest[0]
        has_new_fatigue = _high_fatigue_after(session, user_id, row.get("created_at"))
        if row.get("status") == "pending":
            metrics = collect_metrics(session, user_id, today)
            if has_new_fatigue:
                proposal = propose_adjustment(metrics)
                if proposal["has_change"] and proposal["proposed_goal"] != int(row.get("proposed_goal") or 0):
                    refreshed = _rows(
                        session.table(ADJUSTMENTS_TABLE).update({
                            "previous_goal": metrics["goal"],
                            "proposed_goal": proposal["proposed_goal"],
                            "reason": proposal["reason"],
                        }).eq("id", str(row["id"])).eq("status", "pending").select("*").execute()
                    )
                    if refreshed:
                        return _response(refreshed[0], metrics)
            return _response(row, metrics)
        if _is_within_cooldown(row.get("created_at"), _utc_now()) and not has_new_fatigue:
            return _response(row)

    metrics = collect_metrics(session, user_id, today)

    proposal = propose_adjustment(metrics)
    if not proposal["has_change"]:
        return _response({
            "id": None,
            "previous_goal": metrics["goal"],
            "proposed_goal": metrics["goal"],
            "reason": proposal["reason"],
            "status": "advice",
        }, metrics)

    payload = {
        "user_id": str(user_id),
        "previous_goal": metrics["goal"],
        "proposed_goal": proposal["proposed_goal"],
        "reason": proposal["reason"],
        "status": "pending",
    }
    try:
        inserted = _rows(
            session.table(ADJUSTMENTS_TABLE).insert(payload).select("*").execute()
        )
    except Exception as err:
        if _is_missing_table(err):
            raise _missing_table_error(err) from err
        if "23505" in str(err):
            existing = _latest_rows(session, user_id, status="pending")
            if existing:
                return _response(existing[0], metrics)
        raise
    if not inserted:
        raise RuntimeError("Supabase did not return the saved adjustment")
    return _response(inserted[0], metrics)


def decide_adjustment(
    user_id: UUID,
    adjustment_id: UUID,
    status: str,
    db_session: Any = None,
) -> dict[str, Any]:
    """Accept applies proposed_goal to users.calorie_goal. An already decided proposal is returned as is."""
    if status not in ("accepted", "rejected"):
        raise ValueError("Invalid decision status")
    session = db_session or get_supabase(admin=True)
    row = _find_adjustment(session, user_id, adjustment_id)
    if str(row.get("status") or "") != "pending":
        return _decided_response(row)

    applied_goal = int(row.get("previous_goal") or 0)
    if status == "accepted":
        updated_users = _rows(
            session.table("users")
            .update({"calorie_goal": int(row.get("proposed_goal") or 0)})
            .eq("id", str(user_id)).eq("calorie_goal", applied_goal).select("calorie_goal").execute()
        )
        if updated_users:
            applied_goal = int(updated_users[0].get("calorie_goal") or 0)
        else:
            # The goal changed after this proposal was made, so the proposal is out of date.
            status = "rejected"
            users = _rows(session.table("users").select("calorie_goal").eq("id", str(user_id)).limit(1).execute())
            if not users:
                raise RuntimeError("Could not read the calorie goal")
            applied_goal = int(users[0].get("calorie_goal") or 0)

    flipped = _rows(
        session.table(ADJUSTMENTS_TABLE).update({"status": status})
        .eq("id", str(adjustment_id)).eq("status", "pending").select("*").execute()
    )
    if not flipped:
        return _decided_response(_find_adjustment(session, user_id, adjustment_id))
    result = _response(flipped[0])
    result["calorie_goal"] = applied_goal
    return result
