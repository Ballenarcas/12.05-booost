from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException

from app.core.local_day import LocalDay, utc_day
from app.db.supabase_client import get_supabase
from app.schemas.overtraining import (
    FatigueFeedbackCreate,
    FatigueFeedbackEntry,
    MuscleStrainSummary,
    OvertrainingSignal,
    OvertrainingStatusResponse,
    RiskLevel,
    SignalSeverity,
)
from app.services import health_service
from app.services.exercise_catalog import get_cached_exercise
from app.services.user_profile_service import calculate_calorie_goal

logger = logging.getLogger(__name__)

DELOAD_PCT = 15
DELOAD_DURATION_DAYS = 4
HIGH_RPE_THRESHOLD = 8.5

_CHECKINS_TABLE = "recovery_checkins"
_STATES_TABLE = "overtraining_states"

# In-memory fallback used only when the Supabase migration has not been applied yet.
_FALLBACK_CHECKINS: dict[str, list[dict[str, Any]]] = {}
_FALLBACK_STATES: dict[str, dict[str, Any]] = {}


def _is_missing_table(error: Exception) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in ("pgrst205", "does not exist", "schema cache", "undefined table"))


def _parse_dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None) or []
    return data if isinstance(data, list) else [data]


_NON_MUSCLE_CATEGORIES = {
    "cardio",
    "strength",
    "powerlifting",
    "plyometrics",
    "stretching",
    "olympic weightlifting",
    "strongman",
    "general",
}


def _normalize_muscle(raw: str | None) -> str | None:
    if not raw or not raw.strip():
        return None
    text = raw.strip().lower()
    if text in _NON_MUSCLE_CATEGORIES or "cardio" in text:
        return None
    if "chest" in text or "pect" in text:
        return "Chest"
    if "shoulder" in text or "delt" in text:
        return "Shoulders"
    if "back" in text or "lat" in text or "trap" in text or "rhomboid" in text:
        return "Back"
    if "quad" in text:
        return "Quads"
    if "hamstring" in text:
        return "Hamstrings"
    if "glute" in text:
        return "Glutes"
    if "leg" in text or "calf" in text or "calves" in text or "adductor" in text or "abductor" in text:
        return "Legs"
    if "arm" in text or "bicep" in text or "tricep" in text or "forearm" in text:
        return "Arms"
    if "core" in text or "ab" in text or "oblique" in text:
        return "Core"
    return raw.strip().title()


def _is_cardio_set(set_row: dict[str, Any], ex_meta: dict[str, Any], cached: Any) -> bool:
    if set_row.get("duration_seconds") is not None or set_row.get("distance_km") is not None:
        return True
    if "cardio" in str(ex_meta.get("muscle_group") or "").lower():
        return True
    if cached is not None:
        if "cardio" in (cached.category or "").lower() or "cardio" in (cached.muscle_group or "").lower():
            return True
        if any("cardio" in m.lower() for m in (cached.muscles or [])):
            return True
    return False


def _muscles_for_set(ex_meta: dict[str, Any], cached: Any) -> list[str]:
    candidates: list[str] = []
    if cached is not None and getattr(cached, "muscles", None):
        candidates.extend(cached.muscles[:1])
    if not candidates and cached is not None and getattr(cached, "muscle_group", None):
        candidates.append(cached.muscle_group)
    if not candidates and ex_meta.get("muscle_group"):
        candidates.append(str(ex_meta["muscle_group"]))
    muscles: list[str] = []
    for raw in candidates:
        norm = _normalize_muscle(raw)
        if norm and norm not in muscles:
            muscles.append(norm)
    return muscles


def _load_checkins_7d(supabase: Any, uid: str, since: datetime) -> list[FatigueFeedbackEntry]:
    if supabase is not None:
        try:
            rows = _rows(
                supabase.table(_CHECKINS_TABLE)
                .select("id,fatigue_level,soreness_level,sleep_quality,joint_strain,sore_muscles,notes,created_at")
                .eq("user_id", uid)
                .gte("created_at", since.isoformat())
                .order("created_at", desc=True)
                .execute()
            )
            return [FatigueFeedbackEntry.model_validate(row) for row in rows]
        except Exception as err:
            if not _is_missing_table(err):
                logger.warning("Could not load recovery check-ins from Supabase: %s", err)
                return []

    entries: list[FatigueFeedbackEntry] = []
    for row in _FALLBACK_CHECKINS.get(uid, []):
        created = _parse_dt(row.get("created_at"))
        if created and created >= since:
            entries.append(FatigueFeedbackEntry.model_validate(row))
    entries.sort(key=lambda item: item.created_at, reverse=True)
    return entries


def _insert_checkin(supabase: Any, uid: str, payload: FatigueFeedbackCreate, now: datetime) -> None:
    muscles: list[str] = []
    for raw in payload.sore_muscles:
        norm = _normalize_muscle(raw)
        if norm and norm not in muscles:
            muscles.append(norm)
    record = {
        "id": str(uuid4()),
        "user_id": uid,
        "fatigue_level": payload.fatigue_level,
        "soreness_level": payload.soreness_level,
        "sleep_quality": payload.sleep_quality,
        "joint_strain": payload.joint_strain,
        "sore_muscles": muscles,
        "notes": payload.notes.strip() if payload.notes and payload.notes.strip() else None,
        "created_at": now.isoformat(),
    }
    if supabase is not None:
        try:
            supabase.table(_CHECKINS_TABLE).insert(record).execute()
            return
        except Exception as err:
            if not _is_missing_table(err):
                logger.exception("Failed to save recovery check-in")
                raise HTTPException(status_code=502, detail="Could not save recovery check-in") from err

    _FALLBACK_CHECKINS.setdefault(uid, []).append(record)


def _delete_checkin(supabase: Any, uid: str, entry_id: str) -> None:
    if supabase is not None:
        try:
            existing = _rows(
                supabase.table(_CHECKINS_TABLE)
                .select("id")
                .eq("id", entry_id)
                .eq("user_id", uid)
                .limit(1)
                .execute()
            )
            if not existing:
                raise HTTPException(status_code=404, detail="Recovery check-in not found")
            supabase.table(_CHECKINS_TABLE).delete().eq("id", entry_id).eq("user_id", uid).execute()
            return
        except HTTPException:
            raise
        except Exception as err:
            if not _is_missing_table(err):
                logger.exception("Failed to delete recovery check-in")
                raise HTTPException(status_code=502, detail="Could not delete recovery check-in") from err

    items = _FALLBACK_CHECKINS.get(uid, [])
    remaining = [item for item in items if item.get("id") != entry_id]
    if len(remaining) == len(items):
        raise HTTPException(status_code=404, detail="Recovery check-in not found")
    _FALLBACK_CHECKINS[uid] = remaining


def _load_state(supabase: Any, uid: str) -> dict[str, Any]:
    if supabase is not None:
        try:
            rows = _rows(
                supabase.table(_STATES_TABLE)
                .select("user_id,deload_pct,deload_applied_at,deload_expires_at,dismissed_at")
                .eq("user_id", uid)
                .limit(1)
                .execute()
            )
            return dict(rows[0]) if rows else {}
        except Exception as err:
            if not _is_missing_table(err):
                logger.warning("Could not load overtraining state from Supabase: %s", err)
                return {}
    return dict(_FALLBACK_STATES.get(uid, {}))


def _save_state(supabase: Any, uid: str, state: dict[str, Any], now: datetime) -> None:
    record = {
        "user_id": uid,
        "deload_pct": int(state.get("deload_pct") or 0),
        "deload_applied_at": state.get("deload_applied_at"),
        "deload_expires_at": state.get("deload_expires_at"),
        "dismissed_at": state.get("dismissed_at"),
        "updated_at": now.isoformat(),
    }
    if supabase is not None:
        try:
            supabase.table(_STATES_TABLE).upsert(record, on_conflict="user_id").execute()
            return
        except Exception as err:
            if not _is_missing_table(err):
                logger.warning("Could not persist overtraining state: %s", err)
                return
    _FALLBACK_STATES[uid] = record


def _consecutive_training_days(workout_dates: set[date], today: date) -> int:
    if today in workout_dates:
        cursor = today
    elif (today - timedelta(days=1)) in workout_dates:
        cursor = today - timedelta(days=1)
    else:
        return 0
    streak = 0
    while cursor in workout_dates:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _is_high_fatigue_checkin(entry: FatigueFeedbackEntry) -> bool:
    sleep_penalty = {"restorative": 0, "average": 1, "poor": 2}[entry.sleep_quality]
    joint_penalty = {"none": 0, "mild": 1, "sharp": 2}[entry.joint_strain]
    eff_fatigue = min(10, entry.fatigue_level + sleep_penalty)
    eff_soreness = min(10, entry.soreness_level + joint_penalty)
    return (
        eff_fatigue >= 7
        or eff_soreness >= 7
        or (eff_fatigue + eff_soreness) >= 13
        or entry.joint_strain == "sharp"
    )


def _fetch_workouts_35d(supabase: Any, uid: str, since: datetime) -> list[dict[str, Any]]:
    if supabase is None:
        return []
    try:
        return _rows(
            supabase.table("workouts")
            .select(
                "id,name,start_time,end_time,fatigue_level,"
                "workout_sets(exercise_id,set_number,reps,weight,rpe,is_done,duration_seconds,distance_km,exercises(name,muscle_group))"
            )
            .eq("user_id", uid)
            .not_.is_("end_time", "null")
            .gte("start_time", since.isoformat())
            .order("start_time", desc=True)
            .limit(100)
            .execute()
        )
    except Exception as err:
        logger.warning("Could not read workout history for readiness check: %s", err)
        return []


def _fetch_todays_plan(supabase: Any, uid: str, today_str: str) -> dict[str, Any] | None:
    if supabase is None:
        return None
    try:
        rows = _rows(
            supabase.table("workout_plans")
            .select("id,title,is_rest_day,exercises,ai_adjusted,ai_reasoning")
            .eq("user_id", uid)
            .eq("plan_date", today_str)
            .limit(1)
            .execute()
        )
        return rows[0] if rows else None
    except Exception as err:
        logger.warning("Could not read today's workout plan: %s", err)
        return None


def _fetch_nutrition_3d(
    supabase: Any, uid: str, start_3d: datetime, end_today: datetime, tz_offset: timedelta,
) -> tuple[int, dict[date, float]]:
    if supabase is None:
        return 0, {}
    try:
        users = _rows(
            supabase.table("users")
            .select("calorie_goal,weight,height,age,gender,objective")
            .eq("id", uid)
            .limit(1)
            .execute()
        )
        meals = _rows(
            supabase.table("meals")
            .select("calories,consumed_at")
            .eq("user_id", uid)
            .gte("consumed_at", start_3d.isoformat())
            .lt("consumed_at", end_today.isoformat())
            .execute()
        )
    except Exception as err:
        logger.warning("Could not read nutrition context for readiness check: %s", err)
        return 0, {}

    user = users[0] if users else {}
    goal = 0
    if user.get("calorie_goal"):
        try:
            goal = int(float(user["calorie_goal"]))
        except (TypeError, ValueError):
            goal = 0
    if goal <= 0 and user:
        goal = calculate_calorie_goal(
            user.get("weight"), user.get("height"), user.get("age"), user.get("gender"), user.get("objective"),
        )

    daily_kcal: dict[date, float] = {}
    for meal in meals:
        dt = _parse_dt(meal.get("consumed_at"))
        if dt is None:
            continue
        local_d = (dt + tz_offset).date()
        kcal = float(meal.get("calories") or 0)
        if kcal > 0:
            daily_kcal[local_d] = daily_kcal.get(local_d, 0.0) + kcal
    return goal, daily_kcal


def _apply_deload_to_exercises(exercises: list[Any], pct: int) -> list[Any]:
    factor = 1.0 - (pct / 100.0)
    updated: list[Any] = []
    for raw in exercises:
        if not isinstance(raw, dict):
            updated.append(raw)
            continue
        item = dict(raw)
        sets = int(item.get("sets") or 0)
        if sets >= 2:
            item["sets"] = max(1, min(sets - 1, round(sets * factor)))
        prev_weight = item.get("previous_weight_kg")
        if isinstance(prev_weight, (int, float)) and prev_weight > 0:
            item["previous_weight_kg"] = round(float(prev_weight) * factor * 2) / 2
        updated.append(item)
    return updated


def on_workout_completed(user_id: UUID) -> None:
    """Clear an active deload and any prior dismissal once a workout is saved."""
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    state = _load_state(supabase, uid)
    changed = False
    if int(state.get("deload_pct") or 0) > 0:
        state["deload_pct"] = 0
        state["deload_applied_at"] = None
        state["deload_expires_at"] = None
        changed = True
    if state.get("dismissed_at") is not None:
        state["dismissed_at"] = None
        changed = True
    if changed:
        _save_state(supabase, uid, state, now)


def evaluate_overtraining(user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
    active_day = day or utc_day()
    now = datetime.now(timezone.utc)
    tz_offset = active_day.start.utcoffset() or timedelta(0)
    uid = str(user_id)
    supabase = get_supabase(admin=True)

    acute_cutoff = now - timedelta(days=7)
    chronic_cutoff = now - timedelta(days=28)
    history_cutoff = now - timedelta(days=35)
    nutrition_start = active_day.start - timedelta(days=2)

    with ThreadPoolExecutor(max_workers=6) as pool:
        f_workouts = pool.submit(_fetch_workouts_35d, supabase, uid, history_cutoff)
        f_checkins = pool.submit(_load_checkins_7d, supabase, uid, acute_cutoff)
        f_state = pool.submit(_load_state, supabase, uid)
        f_plan = pool.submit(_fetch_todays_plan, supabase, uid, active_day.local_date.isoformat())
        f_nutrition = pool.submit(_fetch_nutrition_3d, supabase, uid, nutrition_start, active_day.end, tz_offset)
        f_activity = pool.submit(health_service.get_activity_summary, user_id, supabase, active_day.local_date)

        workouts = f_workouts.result()
        checkins_7d = f_checkins.result()
        state = f_state.result()
        todays_plan = f_plan.result()
        calorie_goal, daily_kcal_3d = f_nutrition.result()
        activity_summary = f_activity.result()

    sessions_7d = 0
    total_sets_7d = 0
    high_rpe_sets_7d = 0
    chronic_buckets: dict[int, int] = {1: 0, 2: 0, 3: 0}
    workout_dates_local: set[date] = set()
    acute_fatigue_levels: list[int] = []
    latest_workout_fatigue: int | None = None
    latest_workout_started_at: datetime | None = None
    latest_workout_completed_at: datetime | None = None

    muscle_sets_7d: dict[str, int] = {}
    muscle_times: dict[str, list[datetime]] = {}
    exercise_sessions: dict[str, dict[str, Any]] = {}

    for workout in workouts:
        started = _parse_dt(workout.get("start_time"))
        if started is None:
            continue
        completed = _parse_dt(workout.get("end_time"))
        if latest_workout_started_at is None or started > latest_workout_started_at:
            latest_workout_started_at = started
        if completed and (latest_workout_completed_at is None or completed > latest_workout_completed_at):
            latest_workout_completed_at = completed

        local_d = (started + tz_offset).date()
        workout_dates_local.add(local_d)

        is_acute = started >= acute_cutoff
        is_chronic = chronic_cutoff <= started < acute_cutoff
        chronic_week = min(3, max(1, int((now - started).total_seconds() // (7 * 86400)))) if is_chronic else None

        if is_acute:
            sessions_7d += 1
            raw_fatigue = workout.get("fatigue_level")
            if isinstance(raw_fatigue, (int, float)) and 1 <= int(raw_fatigue) <= 10:
                f_val = int(raw_fatigue)
                acute_fatigue_levels.append(f_val)
                if latest_workout_fatigue is None:
                    latest_workout_fatigue = f_val

        per_ex_in_workout: dict[str, dict[str, Any]] = {}
        muscles_in_workout: set[str] = set()

        for set_row in workout.get("workout_sets") or []:
            if set_row.get("is_done") is not True:
                continue
            ex_id = str(set_row.get("exercise_id") or "")
            ex_meta = set_row.get("exercises") or {}
            if isinstance(ex_meta, list):
                ex_meta = ex_meta[0] if ex_meta else {}
            cached_ex = get_cached_exercise(ex_id) if ex_id else None
            if _is_cardio_set(set_row, ex_meta, cached_ex):
                continue

            if is_acute:
                total_sets_7d += 1
                rpe_val = set_row.get("rpe")
                if rpe_val is not None and float(rpe_val) >= HIGH_RPE_THRESHOLD:
                    high_rpe_sets_7d += 1

                for muscle in _muscles_for_set(ex_meta, cached_ex):
                    muscle_sets_7d[muscle] = muscle_sets_7d.get(muscle, 0) + 1
                    muscles_in_workout.add(muscle)
            elif is_chronic and chronic_week is not None:
                chronic_buckets[chronic_week] += 1

            if started >= now - timedelta(days=14):
                weight = float(set_row.get("weight") or 0)
                reps = int(set_row.get("reps") or 0)
                if weight > 0 and reps > 0:
                    ex_name = str(ex_meta.get("name") or (cached_ex.name if cached_ex else "Exercise"))
                    e1rm = weight * (1.0 + min(reps, 30) / 30.0)
                    slot = per_ex_in_workout.setdefault(
                        ex_id,
                        {"name": ex_name, "best_e1rm": 0.0, "rpes": []},
                    )
                    if e1rm > slot["best_e1rm"]:
                        slot["best_e1rm"] = e1rm
                    if set_row.get("rpe") is not None:
                        slot["rpes"].append(float(set_row["rpe"]))

        for muscle in muscles_in_workout:
            muscle_times.setdefault(muscle, []).append(started)

        workout_id = str(workout.get("id") or started.isoformat())
        for ex_id, ex_perf in per_ex_in_workout.items():
            mean_rpe = (sum(ex_perf["rpes"]) / len(ex_perf["rpes"])) if ex_perf["rpes"] else None
            ex_entry = exercise_sessions.setdefault(
                ex_id,
                {"name": ex_perf["name"], "sessions": []},
            )
            ex_entry["sessions"].append({
                "workout_id": workout_id,
                "started": started,
                "best_e1rm": ex_perf["best_e1rm"],
                "mean_rpe": mean_rpe,
            })

    # Consecutive training days up to today/yesterday
    consecutive_days = _consecutive_training_days(workout_dates_local, active_day.local_date)

    # Fatigue trend from workouts.fatigue_level
    avg_workout_fatigue_7d = (
        round(sum(acute_fatigue_levels) / len(acute_fatigue_levels), 1)
        if acute_fatigue_levels
        else None
    )
    high_workout_fatigue_count = sum(1 for v in acute_fatigue_levels if v >= 7)

    # Personalized ACWR (last 7d strength sets vs chronic 3-week average)
    active_chronic_weeks = sum(1 for v in chronic_buckets.values() if v > 0)
    chronic_weekly_sets = (sum(chronic_buckets.values()) / active_chronic_weeks) if active_chronic_weeks > 0 else 0.0
    if chronic_weekly_sets >= 8.0:
        acwr: float | None = round(total_sets_7d / chronic_weekly_sets, 2)
        load_increase_pct = round(((total_sets_7d - chronic_weekly_sets) / chronic_weekly_sets) * 100)
    else:
        acwr = None
        load_increase_pct = round(((total_sets_7d - 50) / 50) * 100) if total_sets_7d > 50 else 0

    # Performance regression across repeat exercises in last 14 days
    regressed_exercises: list[str] = []
    tracked_repeat_exercises = 0
    for ex_entry in exercise_sessions.values():
        sess_list = sorted(ex_entry["sessions"], key=lambda s: s["started"], reverse=True)
        if len(sess_list) < 2 or sess_list[0]["started"] < acute_cutoff:
            continue
        tracked_repeat_exercises += 1
        latest_s, prev_s = sess_list[0], sess_list[1]
        drop_e1rm = latest_s["best_e1rm"] <= prev_s["best_e1rm"] * 0.94
        rising_rpe = (
            latest_s["best_e1rm"] <= prev_s["best_e1rm"] * 1.01
            and latest_s["mean_rpe"] is not None
            and prev_s["mean_rpe"] is not None
            and latest_s["mean_rpe"] >= prev_s["mean_rpe"] + 1.5
        )
        if drop_e1rm or rising_rpe:
            regressed_exercises.append(ex_entry["name"])

    # Recovery check-ins over last 7 days
    high_checkins = [entry for entry in checkins_7d if _is_high_fatigue_checkin(entry)]
    repeated_fatigue_count = len(high_checkins)
    recent_sharp_joint = any(
        entry.joint_strain == "sharp" and entry.created_at >= (now - timedelta(hours=72))
        for entry in checkins_7d
    )
    reported_sore_muscles: set[str] = set()
    for entry in high_checkins:
        for raw_m in entry.sore_muscles:
            norm = _normalize_muscle(raw_m)
            if norm:
                reported_sore_muscles.add(norm)

    # Real per-muscle strain summary (zero hardcoded defaults)
    all_muscles = sorted(set(muscle_sets_7d.keys()) | reported_sore_muscles)
    muscle_strain: list[MuscleStrainSummary] = []
    for muscle in all_muscles:
        sets_count = muscle_sets_7d.get(muscle, 0)
        times = sorted(muscle_times.get(muscle, []), reverse=True)
        hours_since = max(0, int((now - times[0]).total_seconds() // 3600)) if times else None
        back_to_back = any(
            (times[i] - times[i + 1]).total_seconds() <= 28 * 3600
            for i in range(len(times) - 1)
        )
        is_sore = muscle in reported_sore_muscles
        if sets_count >= 18 or (is_sore and sets_count >= 10) or (back_to_back and is_sore):
            m_status: SignalSeverity = "high"
        elif sets_count >= 14 or is_sore or back_to_back:
            m_status = "watch"
        else:
            m_status = "ok"
        muscle_strain.append(
            MuscleStrainSummary(
                muscle_group=muscle,
                sets_7d=sets_count,
                hours_since_trained=hours_since,
                reported_sore=is_sore,
                status=m_status,
            )
        )
    severity_rank = {"high": 0, "watch": 1, "ok": 2}
    muscle_strain.sort(key=lambda item: (severity_rank[item.status], -item.sets_7d, item.muscle_group))
    strained_muscles = [m.muscle_group for m in muscle_strain if m.status != "ok"]

    # State maintenance: auto-expire deload & auto-un-dismiss on new activity
    deload_pct = int(state.get("deload_pct") or 0)
    deload_applied_at = _parse_dt(state.get("deload_applied_at"))
    deload_expires_at = _parse_dt(state.get("deload_expires_at"))
    dismissed_at = _parse_dt(state.get("dismissed_at"))
    latest_checkin_at = checkins_7d[0].created_at if checkins_7d else None
    latest_activity_at = max(
        [dt for dt in (latest_workout_started_at, latest_checkin_at) if dt is not None],
        default=None,
    )

    state_dirty = False
    if deload_pct > 0 and (
        (deload_expires_at is not None and deload_expires_at <= now)
        or (
            deload_applied_at is not None
            and latest_workout_completed_at is not None
            and latest_workout_completed_at > deload_applied_at
        )
    ):
        deload_pct = 0
        deload_applied_at = None
        deload_expires_at = None
        state["deload_pct"] = 0
        state["deload_applied_at"] = None
        state["deload_expires_at"] = None
        state_dirty = True

    if dismissed_at is not None and latest_activity_at is not None and latest_activity_at > dismissed_at:
        dismissed_at = None
        state["dismissed_at"] = None
        state_dirty = True

    if state_dirty:
        _save_state(supabase, uid, state, now)

    deload_active = deload_pct > 0
    dismissed = dismissed_at is not None
    rest_day_scheduled = bool(todays_plan and todays_plan.get("is_rest_day"))

    # Score & signal breakdown
    score = 100
    signals: list[OvertrainingSignal] = []

    # 1. Workload spike (ACWR vs chronic 3-week baseline, or fallback thresholds)
    if acwr is not None:
        if acwr >= 1.50 and total_sets_7d >= 30:
            score -= 28
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Acute workload spike",
                value=f"{acwr:.2f}x",
                detail=f"{total_sets_7d} sets in 7d (+{load_increase_pct}% vs your {round(chronic_weekly_sets)} sets/wk baseline).",
                severity="high",
            ))
        elif acwr >= 1.30 and total_sets_7d >= 25:
            score -= 16
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Workload trending up",
                value=f"{acwr:.2f}x",
                detail=f"{total_sets_7d} sets in 7d (+{load_increase_pct}% vs your {round(chronic_weekly_sets)} sets/wk baseline).",
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Weekly workload balance",
                value=f"{acwr:.2f}x",
                detail=f"{total_sets_7d} strength sets vs {round(chronic_weekly_sets)} sets/wk chronic baseline.",
                severity="ok",
            ))
    else:
        if sessions_7d >= 6 or total_sets_7d >= 85:
            score -= 24
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="High weekly volume",
                value=f"{total_sets_7d} sets",
                detail=f"{sessions_7d} sessions and {total_sets_7d} strength sets logged in the last 7 days.",
                severity="high",
            ))
        elif sessions_7d >= 5 or total_sets_7d >= 65:
            score -= 12
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Elevated weekly volume",
                value=f"{total_sets_7d} sets",
                detail=f"{sessions_7d} sessions and {total_sets_7d} strength sets in 7 days (building 28d baseline).",
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Weekly workload",
                value=f"{total_sets_7d} sets",
                detail=f"{sessions_7d} sessions across {total_sets_7d} strength sets in the last 7 days.",
                severity="ok",
            ))

    # 2. Post-workout fatigue_level trend (from finished workouts)
    if latest_workout_fatigue is not None:
        avg_label = f"{avg_workout_fatigue_7d:.1f}/10" if avg_workout_fatigue_7d is not None else f"{latest_workout_fatigue}/10"
        if latest_workout_fatigue >= 8 and ((avg_workout_fatigue_7d or 0) >= 7.0 or high_workout_fatigue_count >= 2):
            score -= 25
            signals.append(OvertrainingSignal(
                id="workout_fatigue",
                label="Post-workout fatigue",
                value=f"{latest_workout_fatigue}/10",
                detail=f"Latest session rated {latest_workout_fatigue}/10 with a 7-day average of {avg_label}.",
                severity="high",
            ))
        elif latest_workout_fatigue >= 7 or (avg_workout_fatigue_7d or 0) >= 6.5:
            score -= 14
            signals.append(OvertrainingSignal(
                id="workout_fatigue",
                label="Post-workout fatigue",
                value=avg_label,
                detail=f"Latest session fatigue is {latest_workout_fatigue}/10 across {len(acute_fatigue_levels)} rated workouts.",
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="workout_fatigue",
                label="Post-workout fatigue",
                value=avg_label,
                detail=f"Recent sessions average {avg_label} on your post-workout fatigue scale.",
                severity="ok",
            ))

    # 3. High-RPE strain
    rpe_ratio = (high_rpe_sets_7d / total_sets_7d) if total_sets_7d > 0 else 0.0
    if high_rpe_sets_7d >= 20 or (total_sets_7d >= 20 and rpe_ratio >= 0.45):
        score -= 20
        signals.append(OvertrainingSignal(
            id="high_rpe",
            label="High-RPE strain",
            value=f"{high_rpe_sets_7d} sets",
            detail=f"{round(rpe_ratio * 100)}% of weekly strength sets were pushed to RPE ≥ 8.5.",
            severity="high",
        ))
    elif high_rpe_sets_7d >= 12 or (total_sets_7d >= 20 and rpe_ratio >= 0.30):
        score -= 10
        signals.append(OvertrainingSignal(
            id="high_rpe",
            label="Near-failure effort",
            value=f"{high_rpe_sets_7d} sets",
            detail=f"{high_rpe_sets_7d} strength sets reached RPE ≥ 8.5 over the last 7 days.",
            severity="watch",
        ))
    else:
        signals.append(OvertrainingSignal(
            id="high_rpe",
            label="Session intensity (RPE)",
            value=f"{high_rpe_sets_7d} hard",
            detail="Intensity distribution stays inside sustainable RPE targets.",
            severity="ok",
        ))

    # 4. Consecutive training days
    if consecutive_days >= 6:
        score -= 20
        signals.append(OvertrainingSignal(
            id="consecutive_days",
            label="Rest-day streak",
            value=f"{consecutive_days}d straight",
            detail=f"{consecutive_days} consecutive training days with no full rest day.",
            severity="high",
        ))
    elif consecutive_days >= 4:
        score -= 10
        signals.append(OvertrainingSignal(
            id="consecutive_days",
            label="Consecutive training",
            value=f"{consecutive_days}d straight",
            detail=f"{consecutive_days} days trained in a row; scheduling a rest day soon protects recovery.",
            severity="watch",
        ))
    else:
        signals.append(OvertrainingSignal(
            id="consecutive_days",
            label="Rest spacing",
            value=f"{consecutive_days}d streak",
            detail="Rest days are well spaced across your training week.",
            severity="ok",
        ))

    # 5. Performance regression (optional when repeat weighted lifts exist)
    if tracked_repeat_exercises > 0:
        if len(regressed_exercises) >= 2:
            score -= 18
            signals.append(OvertrainingSignal(
                id="performance_drop",
                label="Performance regression",
                value=f"{len(regressed_exercises)} lifts",
                detail=f"Estimated strength dipped or RPE spiked at the same load on {', '.join(regressed_exercises[:2])}.",
                severity="high",
            ))
        elif len(regressed_exercises) == 1 and ((avg_workout_fatigue_7d or 0) >= 6.0 or repeated_fatigue_count >= 1):
            score -= 9
            signals.append(OvertrainingSignal(
                id="performance_drop",
                label="Lift readiness dip",
                value="1 lift",
                detail=f"{regressed_exercises[0]} showed higher effort or lower output than the prior session.",
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="performance_drop",
                label="Lift progression",
                value="Steady",
                detail=f"Tracked strength output held steady across {tracked_repeat_exercises} repeated exercises.",
                severity="ok",
            ))

    # 6. Manual recovery check-ins (7-day window)
    if repeated_fatigue_count >= 2 or recent_sharp_joint:
        score -= 24
        detail = (
            "Sharp joint discomfort logged in the last 72h; heavy axial/joint loading should be backed off."
            if recent_sharp_joint
            else f"{repeated_fatigue_count} high-fatigue check-ins recorded in the last 7 days."
        )
        signals.append(OvertrainingSignal(
            id="checkins",
            label="Recovery check-ins",
            value=f"{repeated_fatigue_count}/7d",
            detail=detail,
            severity="high",
        ))
    elif repeated_fatigue_count == 1:
        score -= 12
        signals.append(OvertrainingSignal(
            id="checkins",
            label="Recovery check-ins",
            value="1/7d",
            detail="1 elevated fatigue/soreness check-in logged this week.",
            severity="watch",
        ))
    else:
        signals.append(OvertrainingSignal(
            id="checkins",
            label="Recovery check-ins",
            value=f"{len(checkins_7d)} logged",
            detail="No repeated high-fatigue or joint-strain check-ins in the past 7 days.",
            severity="ok",
        ))

    # 7. Nutrition & Health Connect context (honest supporting signals)
    if calorie_goal > 0 and len(daily_kcal_3d) >= 2:
        avg_kcal = round(sum(daily_kcal_3d.values()) / len(daily_kcal_3d))
        if avg_kcal < calorie_goal * 0.80 and sessions_7d >= 3:
            score -= 8
            signals.append(OvertrainingSignal(
                id="nutrition_energy",
                label="Recovery fueling",
                value=f"{round((avg_kcal / calorie_goal) * 100)}%",
                detail=f"Averaging {avg_kcal:,} of {calorie_goal:,} kcal/day over the last 3 days while training frequently.",
                severity="watch",
            ))

    if activity_summary.connected and (
        (activity_summary.steps_avg_7d >= 12000 or activity_summary.active_calories_avg_7d >= 700)
        and sessions_7d >= 4
    ):
        score -= 6
        signals.append(OvertrainingSignal(
            id="activity_load",
            label="Daily NEAT & steps",
            value=f"{activity_summary.steps_avg_7d:,}",
            detail=(
                f"Health Connect averages {activity_summary.steps_avg_7d:,} steps/day and "
                f"{activity_summary.active_calories_avg_7d} active kcal alongside {sessions_7d} sessions."
            ),
            severity="watch",
        ))

    readiness_score = max(0, min(100, score))
    high_signals = [s for s in signals if s.severity == "high"]
    watch_signals = [s for s in signals if s.severity == "watch"]

    if readiness_score < 50 or len(high_signals) >= 2 or recent_sharp_joint:
        risk_level: RiskLevel = "high"
    elif readiness_score < 75 or len(high_signals) == 1 or len(watch_signals) >= 2:
        risk_level = "moderate"
    else:
        risk_level = "none"

    has_alert = risk_level != "none" and not dismissed and not rest_day_scheduled

    # Honest headline, summary & recommendations (zero HRV claims, zero false auto-applied claims)
    if risk_level == "high":
        headline = "Recovery debt is stacking up — prioritize rest or a light deload"
        summary = (
            f"Readiness is {readiness_score}/100 with {len(high_signals)} elevated strain signal"
            f"{'s' if len(high_signals) != 1 else ''}: "
            + " ".join(s.detail for s in high_signals[:2])
        )
        recommendations = [
            f"Swap today for active recovery or apply a -{DELOAD_PCT}% deload (capped at RPE 6) to let fatigue clear.",
            "Favor 7.5+ hours of sleep and hit your daily protein and calorie targets to support tissue repair.",
        ]
        if strained_muscles:
            recommendations.append(
                f"Keep volume light on {', '.join(strained_muscles[:3])} over the next 48 hours."
            )
    elif risk_level == "moderate":
        headline = "Elevated fatigue signals — keep effort controlled today"
        top_notes = (high_signals + watch_signals)[:2]
        summary = f"Readiness is {readiness_score}/100. " + " ".join(s.detail for s in top_notes)
        recommendations = [
            "Leave 2–3 reps in reserve (RPE 7–8) on main compound lifts today.",
            f"Use Apply -{DELOAD_PCT}% Deload below if energy or bar speed still feel sluggish.",
        ]
    else:
        headline = "Readiness & workload look balanced"
        summary = (
            f"Readiness is {readiness_score}/100 across {sessions_7d} sessions and "
            f"{total_sets_7d} strength sets in the last 7 days."
        )
        recommendations = [
            "Continue progressive overload within 1–2 reps of target effort.",
            "Log a quick recovery check-in anytime stiffness or sleep dips start carrying over.",
        ]

    if deload_active:
        recommendations.insert(
            0,
            f"A -{deload_pct}% deload is active on your next workout or AI plan and clears automatically once completed.",
        )
    elif rest_day_scheduled:
        recommendations.insert(
            0,
            "Today's AI workout is already set as an active recovery rest day.",
        )

    return OvertrainingStatusResponse(
        has_alert=has_alert,
        risk_level=risk_level,
        readiness_score=readiness_score,
        acwr=acwr,
        load_increase_pct=load_increase_pct,
        sessions_last_7_days=sessions_7d,
        total_sets_last_7_days=total_sets_7d,
        high_rpe_sets_count=high_rpe_sets_7d,
        consecutive_training_days=consecutive_days,
        avg_workout_fatigue_7d=avg_workout_fatigue_7d,
        latest_workout_fatigue=latest_workout_fatigue,
        repeated_fatigue_reports=repeated_fatigue_count,
        strained_muscles=strained_muscles,
        muscle_strain=muscle_strain,
        signals=signals,
        recent_checkins=checkins_7d,
        headline=headline,
        summary=summary,
        recommendations=recommendations,
        volume_reduction_pct=DELOAD_PCT,
        deload_active=deload_active,
        deload_expires_at=deload_expires_at if deload_active else None,
        rest_day_scheduled=rest_day_scheduled,
        dismissed=dismissed,
    )


def record_fatigue_feedback(
    user_id: UUID,
    payload: FatigueFeedbackCreate,
    day: LocalDay | None = None,
) -> OvertrainingStatusResponse:
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    _insert_checkin(supabase, uid, payload, now)
    state = _load_state(supabase, uid)
    if state.get("dismissed_at") is not None:
        state["dismissed_at"] = None
        _save_state(supabase, uid, state, now)
    return evaluate_overtraining(user_id, day)


def delete_fatigue_feedback(
    user_id: UUID,
    entry_id: str,
    day: LocalDay | None = None,
) -> OvertrainingStatusResponse:
    supabase = get_supabase(admin=True)
    _delete_checkin(supabase, str(user_id), entry_id)
    return evaluate_overtraining(user_id, day)


def apply_overtraining_mods(user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
    active_day = day or utc_day()
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)

    state = _load_state(supabase, uid)
    state["deload_pct"] = DELOAD_PCT
    state["deload_applied_at"] = now.isoformat()
    state["deload_expires_at"] = (now + timedelta(days=DELOAD_DURATION_DAYS)).isoformat()
    state["dismissed_at"] = None
    _save_state(supabase, uid, state, now)

    today_str = active_day.local_date.isoformat()
    todays_plan = _fetch_todays_plan(supabase, uid, today_str)
    if supabase is not None and todays_plan and not todays_plan.get("is_rest_day"):
        reasoning = str(todays_plan.get("ai_reasoning") or "").strip()
        if "Deload active" not in reasoning:
            reduced_exercises = _apply_deload_to_exercises(todays_plan.get("exercises") or [], DELOAD_PCT)
            deload_note = f"Deload active: volume and load reduced by {DELOAD_PCT}%, target RPE capped at 6."
            next_reasoning = f"{reasoning} {deload_note}".strip() if reasoning else deload_note
            try:
                supabase.table("workout_plans").update({
                    "exercises": reduced_exercises,
                    "ai_adjusted": True,
                    "ai_reasoning": next_reasoning,
                    "updated_at": now.isoformat(),
                }).eq("user_id", uid).eq("plan_date", today_str).execute()
            except Exception as err:
                logger.warning("Could not apply deload to today's workout plan: %s", err)

    return evaluate_overtraining(user_id, active_day)


def clear_overtraining_mods(user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    state = _load_state(supabase, uid)
    state["deload_pct"] = 0
    state["deload_applied_at"] = None
    state["deload_expires_at"] = None
    _save_state(supabase, uid, state, now)
    return evaluate_overtraining(user_id, day)


def schedule_recovery_rest_day(user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
    active_day = day or utc_day()
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    try:
        supabase.table("workout_plans").upsert({
            "user_id": uid,
            "plan_date": active_day.local_date.isoformat(),
            "routine_id": None,
            "title": "Active Recovery & Rest",
            "exercises": [],
            "is_rest_day": True,
            "ai_adjusted": True,
            "ai_reasoning": "Swapped to a recovery rest day based on your readiness check.",
            "updated_at": now.isoformat(),
        }, on_conflict="user_id,plan_date").execute()
    except Exception as err:
        logger.exception("Failed to schedule recovery rest day")
        raise HTTPException(status_code=502, detail="Could not update today's workout plan") from err

    state = _load_state(supabase, uid)
    if state.get("dismissed_at") is not None:
        state["dismissed_at"] = None
        _save_state(supabase, uid, state, now)
    return evaluate_overtraining(user_id, active_day)


def dismiss_overtraining_alert(user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    state = _load_state(supabase, uid)
    state["dismissed_at"] = now.isoformat()
    _save_state(supabase, uid, state, now)
    return evaluate_overtraining(user_id, day)
