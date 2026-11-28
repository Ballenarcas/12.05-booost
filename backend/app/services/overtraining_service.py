from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from app.core.i18n import get_language, normalize_language, pick, translate_muscle
from app.core.local_day import LocalDay, utc_day
from app.db.supabase_client import get_supabase
from app.schemas.overtraining import (
    MuscleStrainSummary,
    OvertrainingSignal,
    OvertrainingStatusResponse,
    RiskLevel,
    SignalSeverity,
)
from app.services import health_service
from app.services.exercise_catalog import exercise_label, get_cached_exercise
from app.services.training_load import set_effort_weight
from app.services.user_profile_service import calculate_calorie_goal

logger = logging.getLogger(__name__)

DELOAD_PCT = 15
DELOAD_DURATION_DAYS = 7
POST_DELOAD_COOLDOWN_DAYS = 14
DISMISS_COOLDOWN_DAYS = 3
HIGH_RPE_THRESHOLD = 8.5

_STATES_TABLE = "overtraining_states"

# In-memory fallback used only in offline tests when Supabase is not configured.
_FALLBACK_STATES: dict[str, dict[str, Any]] = {}

_JOINT_LABELS_EN: dict[str, str] = {
    "shoulder": "shoulder",
    "elbow": "elbow",
    "wrist": "wrist",
    "lower_back": "lower back",
    "hip": "hip",
    "knee": "knee",
    "ankle": "ankle",
}

_JOINT_LABELS_ES: dict[str, str] = {
    "shoulder": "hombro",
    "elbow": "codo",
    "wrist": "muñeca",
    "lower_back": "lumbar",
    "hip": "cadera",
    "knee": "rodilla",
    "ankle": "tobillo",
}


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


def _format_joint_list(joints: list[str], is_es: bool) -> str:
    labels = _JOINT_LABELS_ES if is_es else _JOINT_LABELS_EN
    return ", ".join(labels.get(j, j.replace("_", " ")) for j in joints)


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


def _save_state(supabase: Any, uid: str, state: dict[str, Any], now: datetime, *, raise_on_error: bool = False) -> None:
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
                if raise_on_error:
                    raise HTTPException(status_code=502, detail="Could not save overtraining state") from err
                return
    _FALLBACK_STATES[uid] = record


def get_active_deload_pct(user_id: UUID, db_session: Any | None = None) -> int:
    """Return the user's active 7-day deload reduction percentage, or 0 if inactive/expired."""
    supabase = db_session if db_session is not None else get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    state = _load_state(supabase, uid)
    deload_pct = int(state.get("deload_pct") or 0)
    if deload_pct <= 0:
        return 0
    expires_at = _parse_dt(state.get("deload_expires_at"))
    if expires_at is not None and expires_at <= now:
        state["deload_pct"] = 0
        _save_state(supabase, uid, state, now)
        return 0
    return deload_pct


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


def _fetch_workouts_35d(supabase: Any, uid: str, since: datetime) -> list[dict[str, Any]]:
    if supabase is None:
        return []
    try:
        return _rows(
            supabase.table("workouts")
            .select(
                "id,name,start_time,end_time,fatigue_level,joint_pain,"
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
    """Clear an expired alert dismissal cooldown when a workout finishes.

    An active 7-day deload week stays active across workouts until its expiry or manual disable.
    """
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    state = _load_state(supabase, uid)
    dismissed_at = _parse_dt(state.get("dismissed_at"))
    if dismissed_at is not None and (now - dismissed_at) >= timedelta(days=DISMISS_COOLDOWN_DAYS):
        state["dismissed_at"] = None
        _save_state(supabase, uid, state, now)


def evaluate_overtraining(
    user_id: UUID,
    day: LocalDay | None = None,
    lang: str | None = None,
) -> OvertrainingStatusResponse:
    active_lang = normalize_language(lang) if lang is not None else get_language()
    is_es = active_lang == "es"
    active_day = day or utc_day()
    now = datetime.now(timezone.utc)
    tz_offset = active_day.start.utcoffset() or timedelta(0)
    uid = str(user_id)
    supabase = get_supabase(admin=True)

    acute_cutoff = now - timedelta(days=7)
    joint_cutoff = now - timedelta(days=14)
    chronic_cutoff = now - timedelta(days=28)
    history_cutoff = now - timedelta(days=35)
    nutrition_start = active_day.start - timedelta(days=2)

    with ThreadPoolExecutor(max_workers=5) as pool:
        f_workouts = pool.submit(_fetch_workouts_35d, supabase, uid, history_cutoff)
        f_state = pool.submit(_load_state, supabase, uid)
        f_plan = pool.submit(_fetch_todays_plan, supabase, uid, active_day.local_date.isoformat())
        f_nutrition = pool.submit(_fetch_nutrition_3d, supabase, uid, nutrition_start, active_day.end, tz_offset)
        f_activity = pool.submit(health_service.get_activity_summary, user_id, supabase, active_day.local_date)

        workouts = f_workouts.result()
        state = f_state.result()
        todays_plan = f_plan.result()
        calorie_goal, daily_kcal_3d = f_nutrition.result()
        activity_summary = f_activity.result()

    sessions_7d = 0
    total_sets_7d = 0
    high_rpe_sets_7d = 0
    effort_load_7d = 0.0
    chronic_load_buckets: dict[int, float] = {1: 0.0, 2: 0.0, 3: 0.0}
    chronic_high_rpe_buckets: dict[int, int] = {1: 0, 2: 0, 3: 0}
    week_sessions: dict[int, int] = {0: 0, 1: 0, 2: 0, 3: 0}
    week_sets: dict[int, int] = {0: 0, 1: 0, 2: 0, 3: 0}
    week_effort_load: dict[int, float] = {0: 0.0, 1: 0.0, 2: 0.0, 3: 0.0}
    week_fatigue_values: dict[int, list[int]] = {0: [], 1: [], 2: [], 3: []}

    workout_dates_local: set[date] = set()
    acute_fatigue_entries: list[tuple[datetime, int]] = []
    fatigue_14d_entries: list[tuple[datetime, int]] = []
    chronic_fatigue_levels: list[int] = []
    latest_workout_started_at: datetime | None = None

    joint_counts_14d: dict[str, int] = {}
    joint_workouts_7d = 0
    recent_joints_7d: set[str] = set()
    latest_joint_workout_started_at: datetime | None = None

    muscle_sets_7d: dict[str, int] = {}
    muscle_times: dict[str, list[datetime]] = {}
    exercise_sessions: dict[str, dict[str, Any]] = {}

    for workout in workouts:
        started = _parse_dt(workout.get("start_time"))
        if started is None:
            continue
        if latest_workout_started_at is None or started > latest_workout_started_at:
            latest_workout_started_at = started

        local_d = (started + tz_offset).date()
        workout_dates_local.add(local_d)

        is_acute = started >= acute_cutoff
        is_chronic = chronic_cutoff <= started < acute_cutoff
        chronic_week = min(3, max(1, int((now - started).total_seconds() // (7 * 86400)))) if is_chronic else None
        age_seconds = (now - started).total_seconds()
        week_idx = int(age_seconds // (7 * 86400)) if 0 <= age_seconds < 28 * 86400 else None

        raw_fatigue = workout.get("fatigue_level")
        valid_fatigue: int | None = None
        if isinstance(raw_fatigue, (int, float)) and 1 <= int(raw_fatigue) <= 10:
            valid_fatigue = int(raw_fatigue)

        if week_idx is not None:
            week_sessions[week_idx] += 1
            if valid_fatigue is not None:
                week_fatigue_values[week_idx].append(valid_fatigue)

        if is_acute:
            sessions_7d += 1
            if valid_fatigue is not None:
                acute_fatigue_entries.append((started, valid_fatigue))
        elif is_chronic and valid_fatigue is not None:
            chronic_fatigue_levels.append(valid_fatigue)

        if started >= joint_cutoff:
            if valid_fatigue is not None:
                fatigue_14d_entries.append((started, valid_fatigue))
            raw_joints = workout.get("joint_pain") or []
            seen_joints: list[str] = []
            for raw_j in raw_joints:
                if isinstance(raw_j, str):
                    j = raw_j.strip().lower()
                    if j in _JOINT_LABELS_EN and j not in seen_joints:
                        seen_joints.append(j)
            for j in seen_joints:
                joint_counts_14d[j] = joint_counts_14d.get(j, 0) + 1
            if seen_joints and (latest_joint_workout_started_at is None or started > latest_joint_workout_started_at):
                latest_joint_workout_started_at = started
            if is_acute and seen_joints:
                joint_workouts_7d += 1
                recent_joints_7d.update(seen_joints)

        per_ex_in_workout: dict[str, dict[str, Any]] = {}
        muscles_in_workout: set[str] = set()
        workout_strength_sets = 0
        workout_effort_load = 0.0

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

            workout_strength_sets += 1
            rpe_val = set_row.get("rpe")
            rpe_num = float(rpe_val) if rpe_val is not None else None
            weight_u = set_effort_weight(rpe_num)
            is_hard_set = rpe_num is not None and rpe_num >= HIGH_RPE_THRESHOLD
            workout_effort_load += weight_u

            if is_acute:
                total_sets_7d += 1
                effort_load_7d += weight_u
                if is_hard_set:
                    high_rpe_sets_7d += 1

                for muscle in _muscles_for_set(ex_meta, cached_ex):
                    muscle_sets_7d[muscle] = muscle_sets_7d.get(muscle, 0) + 1
                    muscles_in_workout.add(muscle)
            elif is_chronic and chronic_week is not None:
                chronic_load_buckets[chronic_week] += weight_u
                if is_hard_set:
                    chronic_high_rpe_buckets[chronic_week] += 1

            if started >= joint_cutoff:
                weight = float(set_row.get("weight") or 0)
                reps = int(set_row.get("reps") or 0)
                if weight > 0 and reps > 0:
                    ex_name = exercise_label(str(ex_meta.get("name") or (cached_ex.name if cached_ex else "Exercise")))
                    e1rm = weight * (1.0 + min(reps, 30) / 30.0)
                    slot = per_ex_in_workout.setdefault(
                        ex_id,
                        {"name": ex_name, "best_e1rm": 0.0, "rpes": []},
                    )
                    if e1rm > slot["best_e1rm"]:
                        slot["best_e1rm"] = e1rm
                    if set_row.get("rpe") is not None:
                        slot["rpes"].append(float(set_row["rpe"]))

        if week_idx is not None:
            week_sets[week_idx] += workout_strength_sets
            week_effort_load[week_idx] += workout_effort_load

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

    consecutive_high_load_weeks = 0
    for w in range(4):
        wk_fatigues = week_fatigue_values[w]
        wk_very_high_fatigue = len(wk_fatigues) >= 3 and (sum(wk_fatigues) / len(wk_fatigues)) >= 8.5
        if week_sessions[w] >= 4 or week_effort_load[w] >= 65.0 or wk_very_high_fatigue:
            consecutive_high_load_weeks += 1
        else:
            break

    # Consecutive training days up to today/yesterday
    consecutive_days = _consecutive_training_days(workout_dates_local, active_day.local_date)

    # Fatigue trend vs personal chronic baseline & repeated 10/10 exhaustion (normal 8-9s stay OK)
    acute_fatigue_entries.sort(key=lambda pair: pair[0], reverse=True)
    fatigue_14d_entries.sort(key=lambda pair: pair[0], reverse=True)
    acute_fatigue_levels = [val for _, val in acute_fatigue_entries]
    recent_fatigue_14d = [val for _, val in fatigue_14d_entries]
    latest_workout_fatigue = acute_fatigue_levels[0] if acute_fatigue_levels else None

    avg_workout_fatigue_7d = (
        round(sum(acute_fatigue_levels) / len(acute_fatigue_levels), 1)
        if acute_fatigue_levels
        else None
    )
    chronic_fatigue_avg = (
        round(sum(chronic_fatigue_levels) / len(chronic_fatigue_levels), 1)
        if len(chronic_fatigue_levels) >= 3
        else None
    )
    fatigue_delta = (
        round(avg_workout_fatigue_7d - chronic_fatigue_avg, 1)
        if (avg_workout_fatigue_7d is not None and chronic_fatigue_avg is not None)
        else None
    )
    exhausted_7d = sum(1 for v in acute_fatigue_levels if v >= 10)
    exhausted_14d = sum(1 for v in recent_fatigue_14d if v >= 10)
    consecutive_exhausted = 0
    for val in recent_fatigue_14d:
        if val >= 10:
            consecutive_exhausted += 1
        else:
            break

    repeated_joint_pain = sorted([joint for joint, count in joint_counts_14d.items() if count >= 2])
    active_joints_7d = sorted(recent_joints_7d)

    # State maintenance: expire 7-day deload (keep deload_expires_at for 14d cooldown); 3d dismiss cooldown.
    deload_pct = int(state.get("deload_pct") or 0)
    deload_expires_at = _parse_dt(state.get("deload_expires_at"))
    dismissed_at = _parse_dt(state.get("dismissed_at"))

    state_dirty = False
    if deload_pct > 0 and deload_expires_at is not None and deload_expires_at <= now:
        deload_pct = 0
        state["deload_pct"] = 0
        state_dirty = True

    has_new_joint_escalation = (
        (bool(repeated_joint_pain) or joint_workouts_7d >= 2)
        and latest_joint_workout_started_at is not None
        and dismissed_at is not None
        and latest_joint_workout_started_at > dismissed_at
    )
    if dismissed_at is not None and (
        (now - dismissed_at) >= timedelta(days=DISMISS_COOLDOWN_DAYS) or has_new_joint_escalation
    ):
        dismissed_at = None
        state["dismissed_at"] = None
        state_dirty = True

    if state_dirty:
        _save_state(supabase, uid, state, now)

    deload_active = deload_pct > 0
    in_post_deload_cooldown = (
        not deload_active
        and deload_expires_at is not None
        and deload_expires_at <= now < deload_expires_at + timedelta(days=POST_DELOAD_COOLDOWN_DAYS)
    )
    deload_days_remaining = (
        max(1, math.ceil((deload_expires_at - now).total_seconds() / 86400))
        if deload_active and deload_expires_at is not None
        else (DELOAD_DURATION_DAYS if deload_active else 0)
    )
    dismissed = dismissed_at is not None
    rest_day_scheduled = bool(todays_plan and todays_plan.get("is_rest_day"))

    # Personalized ACWR (requires >= 2 chronic weeks & not in 14d post-deload cooldown)
    active_chronic_weeks = sum(1 for v in chronic_load_buckets.values() if v > 0)
    chronic_weekly_load = (sum(chronic_load_buckets.values()) / active_chronic_weeks) if active_chronic_weeks > 0 else 0.0
    if not in_post_deload_cooldown and active_chronic_weeks >= 2 and chronic_weekly_load >= 10.0:
        acwr: float | None = round(effort_load_7d / chronic_weekly_load, 2)
        load_increase_pct = round(((effort_load_7d - chronic_weekly_load) / chronic_weekly_load) * 100)
    else:
        acwr = None
        load_increase_pct = round(((effort_load_7d - 60.0) / 60.0) * 100) if effort_load_7d > 60.0 else 0

    chronic_high_rpe = (sum(chronic_high_rpe_buckets.values()) / active_chronic_weeks) if active_chronic_weeks > 0 else 0.0
    high_rpe_spike = (
        (high_rpe_sets_7d / chronic_high_rpe)
        if not in_post_deload_cooldown and active_chronic_weeks >= 2 and chronic_high_rpe >= 8.0
        else None
    )

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

    # Real per-muscle strain summary (zero hardcoded defaults)
    muscle_strain: list[MuscleStrainSummary] = []
    for muscle in sorted(muscle_sets_7d.keys()):
        sets_count = muscle_sets_7d.get(muscle, 0)
        times = sorted(muscle_times.get(muscle, []), reverse=True)
        hours_since = max(0, int((now - times[0]).total_seconds() // 3600)) if times else None
        back_to_back = any(
            (times[i] - times[i + 1]).total_seconds() <= 28 * 3600
            for i in range(len(times) - 1)
        )
        if sets_count >= 18 or (back_to_back and sets_count >= 14):
            m_status: SignalSeverity = "high"
        elif sets_count >= 14 or back_to_back:
            m_status = "watch"
        else:
            m_status = "ok"
        muscle_strain.append(
            MuscleStrainSummary(
                muscle_group=muscle,
                sets_7d=sets_count,
                hours_since_trained=hours_since,
                status=m_status,
            )
        )
    severity_rank = {"high": 0, "watch": 1, "ok": 2}
    muscle_strain.sort(key=lambda item: (severity_rank[item.status], -item.sets_7d, item.muscle_group))
    strained_muscles = [m.muscle_group for m in muscle_strain if m.status != "ok"]

    # Score & signal breakdown
    score = 100
    signals: list[OvertrainingSignal] = []

    # 1. Workload spike (effort-weighted ACWR vs chronic 3-week baseline, or fallback thresholds)
    if acwr is not None:
        baseline_load = round(chronic_weekly_load)
        if acwr >= 1.50 and effort_load_7d >= 35.0:
            score -= 28
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Pico agudo de carga" if is_es else "Acute workload spike",
                value=f"{acwr:.2f}x",
                detail=(
                    f"{round(effort_load_7d)} de carga por esfuerzo ({total_sets_7d} series) en 7 d (+{load_increase_pct}% frente a tu media de {baseline_load})."
                    if is_es
                    else f"{round(effort_load_7d)} effort load ({total_sets_7d} sets) in 7d (+{load_increase_pct}% vs your {baseline_load} baseline)."
                ),
                severity="high",
            ))
        elif acwr >= 1.30 and effort_load_7d >= 28.0:
            score -= 16
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Carga en aumento" if is_es else "Workload trending up",
                value=f"{acwr:.2f}x",
                detail=(
                    f"{round(effort_load_7d)} de carga por esfuerzo ({total_sets_7d} series) en 7 d (+{load_increase_pct}% frente a tu media de {baseline_load})."
                    if is_es
                    else f"{round(effort_load_7d)} effort load ({total_sets_7d} sets) in 7d (+{load_increase_pct}% vs your {baseline_load} baseline)."
                ),
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Equilibrio de carga semanal" if is_es else "Weekly workload balance",
                value=f"{acwr:.2f}x",
                detail=(
                    f"{round(effort_load_7d)} de carga por esfuerzo ({total_sets_7d} series) frente a una media crónica de {baseline_load}."
                    if is_es
                    else f"{round(effort_load_7d)} effort load ({total_sets_7d} sets) vs {baseline_load} chronic baseline."
                ),
                severity="ok",
            ))
    else:
        if sessions_7d >= 6 or effort_load_7d >= 95.0:
            score -= 24
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Volumen semanal alto" if is_es else "High weekly volume",
                value=f"{total_sets_7d} series" if is_es else f"{total_sets_7d} sets",
                detail=(
                    f"{sessions_7d} sesiones y {round(effort_load_7d)} de carga por esfuerzo ({total_sets_7d} series) en los últimos 7 días."
                    if is_es
                    else f"{sessions_7d} sessions and {round(effort_load_7d)} effort load ({total_sets_7d} sets) logged in the last 7 days."
                ),
                severity="high",
            ))
        elif sessions_7d >= 5 or effort_load_7d >= 70.0:
            score -= 12
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Volumen semanal elevado" if is_es else "Elevated weekly volume",
                value=f"{total_sets_7d} series" if is_es else f"{total_sets_7d} sets",
                detail=(
                    f"{sessions_7d} sesiones y {round(effort_load_7d)} de carga por esfuerzo ({total_sets_7d} series) en 7 días (construyendo referencia de 28 d)."
                    if is_es
                    else f"{sessions_7d} sessions and {round(effort_load_7d)} effort load ({total_sets_7d} sets) in 7d (building 28d baseline)."
                ),
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="workload_spike",
                label="Carga semanal" if is_es else "Weekly workload",
                value=f"{total_sets_7d} series" if is_es else f"{total_sets_7d} sets",
                detail=(
                    f"{sessions_7d} sesiones con {total_sets_7d} series ({round(effort_load_7d)} carga por esfuerzo) en los últimos 7 días."
                    if is_es
                    else f"{sessions_7d} sessions across {total_sets_7d} sets ({round(effort_load_7d)} effort load) in the last 7 days."
                ),
                severity="ok",
            ))

    # 2. Fatigue vs personal baseline & repeated 10/10 exhaustion (normal 8-9/10 sessions stay OK)
    is_baseline_spike_high = False
    if latest_workout_fatigue is not None:
        avg_label = f"{avg_workout_fatigue_7d:.1f}/10" if avg_workout_fatigue_7d is not None else f"{latest_workout_fatigue}/10"
        is_baseline_spike_high = (
            fatigue_delta is not None
            and chronic_fatigue_avg is not None
            and fatigue_delta >= 2.0
            and len(acute_fatigue_levels) >= 3
            and (avg_workout_fatigue_7d or 0) >= 8.0
        )
        is_repeated_exhaustion_high = exhausted_7d >= 3 or exhausted_14d >= 4 or consecutive_exhausted >= 3
        is_baseline_spike_watch = (
            fatigue_delta is not None
            and chronic_fatigue_avg is not None
            and fatigue_delta >= 1.2
            and len(acute_fatigue_levels) >= 2
            and (avg_workout_fatigue_7d or 0) >= 7.5
        )
        is_repeated_exhaustion_watch = exhausted_7d >= 2 or exhausted_14d >= 3
        if is_baseline_spike_high or is_repeated_exhaustion_high:
            score -= 25
            if is_baseline_spike_high and chronic_fatigue_avg is not None and fatigue_delta is not None:
                detail_en = (
                    f"7-day fatigue ({avg_label}) jumped +{fatigue_delta:.1f} above your "
                    f"{chronic_fatigue_avg:.1f}/10 baseline across {len(acute_fatigue_levels)} sessions."
                )
                detail_es = (
                    f"Tu fatiga de 7 días ({avg_label}) subió +{fatigue_delta:.1f} sobre tu media de "
                    f"{chronic_fatigue_avg:.1f}/10 en {len(acute_fatigue_levels)} sesiones."
                )
            else:
                exhaust_count = max(exhausted_7d, exhausted_14d)
                detail_en = f"Logged 10/10 exhaustion in {exhaust_count} recent sessions (7d avg {avg_label})."
                detail_es = f"Registraste agotamiento 10/10 en {exhaust_count} sesiones recientes (media 7 d {avg_label})."
            signals.append(OvertrainingSignal(
                id="workout_fatigue",
                label="Fatiga acumulada" if is_es else "Accumulated fatigue",
                value=avg_label,
                detail=detail_es if is_es else detail_en,
                severity="high",
            ))
        elif is_baseline_spike_watch or is_repeated_exhaustion_watch:
            score -= 14
            if is_baseline_spike_watch and chronic_fatigue_avg is not None and fatigue_delta is not None:
                detail_en = (
                    f"Recent fatigue ({avg_label}) is +{fatigue_delta:.1f} above your "
                    f"{chronic_fatigue_avg:.1f}/10 baseline."
                )
                detail_es = (
                    f"La fatiga reciente ({avg_label}) está +{fatigue_delta:.1f} sobre tu media de "
                    f"{chronic_fatigue_avg:.1f}/10."
                )
            else:
                exhaust_count = max(exhausted_7d, exhausted_14d)
                detail_en = f"Logged 10/10 exhaustion in {exhaust_count} recent sessions (7d avg {avg_label})."
                detail_es = f"Registraste agotamiento 10/10 en {exhaust_count} sesiones recientes (media 7 d {avg_label})."
            signals.append(OvertrainingSignal(
                id="workout_fatigue",
                label="Fatiga en aumento" if is_es else "Rising fatigue trend",
                value=avg_label,
                detail=detail_es if is_es else detail_en,
                severity="watch",
            ))
        else:
            if chronic_fatigue_avg is not None:
                ok_detail = (
                    f"La fatiga de 7 días ({avg_label}) está en línea con tu media habitual de {chronic_fatigue_avg:.1f}/10."
                    if is_es
                    else f"7-day fatigue ({avg_label}) stays in line with your {chronic_fatigue_avg:.1f}/10 baseline."
                )
            elif latest_workout_fatigue >= 8:
                ok_detail = (
                    f"Sesiones exigentes ({avg_label}) dentro de tu ritmo normal; las alertas solo saltan ante un repunte sostenido o varios 10/10 seguidos."
                    if is_es
                    else f"Hard sessions ({avg_label}) are within normal effort; alarms only trigger on repeated 10/10 exhaustion or a sustained baseline jump."
                )
            else:
                ok_detail = (
                    f"Las sesiones recientes promedian {avg_label} en tu escala de fatiga post-entreno."
                    if is_es
                    else f"Recent sessions average {avg_label} on your post-workout fatigue scale."
                )
            signals.append(OvertrainingSignal(
                id="workout_fatigue",
                label="Fatiga post-entreno" if is_es else "Post-workout fatigue",
                value=avg_label,
                detail=ok_detail,
                severity="ok",
            ))

    # 3. Intensity × volume strain (never penalizes high RPE alone at low volume)
    is_high_intensity_volume = (
        (effort_load_7d >= 95.0 and high_rpe_sets_7d >= 25)
        or (high_rpe_sets_7d >= 35 and total_sets_7d >= 50)
        or (high_rpe_spike is not None and high_rpe_spike >= 1.50 and high_rpe_sets_7d >= 20)
    )
    is_watch_intensity_volume = (
        (effort_load_7d >= 75.0 and high_rpe_sets_7d >= 18)
        or (high_rpe_sets_7d >= 25 and total_sets_7d >= 40)
        or (high_rpe_spike is not None and high_rpe_spike >= 1.35 and high_rpe_sets_7d >= 16)
    )
    effort_value = (
        f"{high_rpe_sets_7d} duras · {round(effort_load_7d)} carga"
        if is_es
        else f"{high_rpe_sets_7d} hard · {round(effort_load_7d)} load"
    )
    if is_high_intensity_volume:
        score -= 20
        if high_rpe_spike is not None and high_rpe_spike >= 1.50 and not (effort_load_7d >= 95.0 and high_rpe_sets_7d >= 25):
            detail_en = (
                f"{high_rpe_sets_7d} sets at RPE ≥ 8.5 jumped {round((high_rpe_spike - 1) * 100)}% above your "
                f"{round(chronic_high_rpe)} hard-set baseline ({round(effort_load_7d)} weekly effort load)."
            )
            detail_es = (
                f"{high_rpe_sets_7d} series a RPE ≥ 8.5 subieron un {round((high_rpe_spike - 1) * 100)}% sobre tu media "
                f"de {round(chronic_high_rpe)} series duras ({round(effort_load_7d)} de carga semanal)."
            )
        else:
            detail_en = (
                f"High volume stacked with high intensity: {high_rpe_sets_7d} sets at RPE ≥ 8.5 across "
                f"{total_sets_7d} total sets ({round(effort_load_7d)} effort load)."
            )
            detail_es = (
                f"Alto volumen acumulado junto a alta intensidad: {high_rpe_sets_7d} series a RPE ≥ 8.5 en "
                f"{total_sets_7d} series totales ({round(effort_load_7d)} de carga por esfuerzo)."
            )
        signals.append(OvertrainingSignal(
            id="high_rpe",
            label="Carga por intensidad y volumen" if is_es else "Intensity × volume load",
            value=effort_value,
            detail=detail_es if is_es else detail_en,
            severity="high",
        ))
    elif is_watch_intensity_volume:
        score -= 10
        if high_rpe_spike is not None and high_rpe_spike >= 1.35 and not (effort_load_7d >= 75.0 and high_rpe_sets_7d >= 18):
            detail_en = (
                f"{high_rpe_sets_7d} hard sets (RPE ≥ 8.5) is {round((high_rpe_spike - 1) * 100)}% above your usual "
                f"{round(chronic_high_rpe)}/wk pace ({round(effort_load_7d)} effort load)."
            )
            detail_es = (
                f"{high_rpe_sets_7d} series duras (RPE ≥ 8.5) superan en un {round((high_rpe_spike - 1) * 100)}% tu ritmo "
                f"habitual de {round(chronic_high_rpe)}/sem ({round(effort_load_7d)} de carga)."
            )
        else:
            detail_en = (
                f"{high_rpe_sets_7d} sets at RPE ≥ 8.5 paired with {total_sets_7d} weekly sets "
                f"({round(effort_load_7d)} effort load) are pushing recovery demand up."
            )
            detail_es = (
                f"{high_rpe_sets_7d} series a RPE ≥ 8.5 junto a {total_sets_7d} series semanales "
                f"({round(effort_load_7d)} de carga) aumentan la exigencia de recuperación."
            )
        signals.append(OvertrainingSignal(
            id="high_rpe",
            label="Carga por intensidad y volumen" if is_es else "Intensity × volume load",
            value=effort_value,
            detail=detail_es if is_es else detail_en,
            severity="watch",
        ))
    else:
        signals.append(OvertrainingSignal(
            id="high_rpe",
            label="Carga por intensidad y volumen" if is_es else "Intensity × volume load",
            value=effort_value,
            detail=(
                f"La intensidad y el volumen se mantienen equilibrados ({round(effort_load_7d)} de carga semanal en {total_sets_7d} series)."
                if is_es
                else f"Intensity and volume remain balanced ({round(effort_load_7d)} weekly effort load across {total_sets_7d} sets)."
            ),
            severity="ok",
        ))

    # 4. Consecutive training days
    if consecutive_days >= 6:
        score -= 20
        signals.append(OvertrainingSignal(
            id="consecutive_days",
            label="Racha sin descanso" if is_es else "Rest-day streak",
            value=f"{consecutive_days} d seguidos" if is_es else f"{consecutive_days}d straight",
            detail=(
                f"{consecutive_days} días consecutivos entrenando sin un día completo de descanso."
                if is_es
                else f"{consecutive_days} consecutive training days with no full rest day."
            ),
            severity="high",
        ))
    elif consecutive_days >= 4:
        score -= 10
        signals.append(OvertrainingSignal(
            id="consecutive_days",
            label="Días seguidos entrenando" if is_es else "Consecutive training",
            value=f"{consecutive_days} d seguidos" if is_es else f"{consecutive_days}d straight",
            detail=(
                f"{consecutive_days} días seguidos entrenando; programar un día de descanso pronto protege tu recuperación."
                if is_es
                else f"{consecutive_days} days trained in a row; scheduling a rest day soon protects recovery."
            ),
            severity="watch",
        ))
    else:
        signals.append(OvertrainingSignal(
            id="consecutive_days",
            label="Espaciado de descansos" if is_es else "Rest spacing",
            value=f"Racha {consecutive_days} d" if is_es else f"{consecutive_days}d streak",
            detail=(
                "Los días de descanso están bien repartidos a lo largo de tu semana."
                if is_es
                else "Rest days are well spaced across your training week."
            ),
            severity="ok",
        ))

    # 5. Performance regression (optional when repeat weighted lifts exist)
    if tracked_repeat_exercises > 0:
        if len(regressed_exercises) >= 2:
            score -= 18
            signals.append(OvertrainingSignal(
                id="performance_drop",
                label="Caída de rendimiento" if is_es else "Performance regression",
                value=f"{len(regressed_exercises)} ejercicios" if is_es else f"{len(regressed_exercises)} lifts",
                detail=(
                    f"La fuerza estimada bajó o el RPE subió con la misma carga en {', '.join(regressed_exercises[:2])}."
                    if is_es
                    else f"Estimated strength dipped or RPE spiked at the same load on {', '.join(regressed_exercises[:2])}."
                ),
                severity="high",
            ))
        elif len(regressed_exercises) == 1 and ((len(acute_fatigue_levels) >= 2 and (avg_workout_fatigue_7d or 0) >= 7.5) or joint_workouts_7d >= 1):
            score -= 9
            signals.append(OvertrainingSignal(
                id="performance_drop",
                label="Bajada de rendimiento" if is_es else "Lift readiness dip",
                value="1 ejercicio" if is_es else "1 lift",
                detail=(
                    f"{regressed_exercises[0]} mostró mayor esfuerzo o menor rendimiento que en la sesión anterior."
                    if is_es
                    else f"{regressed_exercises[0]} showed higher effort or lower output than the prior session."
                ),
                severity="watch",
            ))
        else:
            signals.append(OvertrainingSignal(
                id="performance_drop",
                label="Progresión de cargas" if is_es else "Lift progression",
                value="Estable" if is_es else "Steady",
                detail=(
                    f"El rendimiento de fuerza se mantuvo estable en {tracked_repeat_exercises} ejercicios repetidos."
                    if is_es
                    else f"Tracked strength output held steady across {tracked_repeat_exercises} repeated exercises."
                ),
                severity="ok",
            ))

    # 6. Post-workout joint pain (repeated across sessions or single recent report)
    if repeated_joint_pain or joint_workouts_7d >= 2:
        score -= 24
        target_joints = repeated_joint_pain or active_joints_7d
        joint_label = _format_joint_list(target_joints, is_es)
        signals.append(OvertrainingSignal(
            id="joint_pain",
            label="Molestia articular repetida" if is_es else "Repeated joint pain",
            value=f"{len(target_joints)} zonas" if is_es else f"{len(target_joints)} area" + ("s" if len(target_joints) != 1 else ""),
            detail=(
                f"Molestia repetida en {joint_label} tras varias sesiones recientes; evita cargas pesadas ahí y consulta con un profesional si persiste."
                if is_es
                else f"Repeated discomfort logged in {joint_label} across recent sessions; back off heavy loading there and check with a professional if it persists."
            ),
            severity="high",
        ))
    elif joint_workouts_7d == 1 and active_joints_7d:
        score -= 10
        joint_label = _format_joint_list(active_joints_7d, is_es)
        signals.append(OvertrainingSignal(
            id="joint_pain",
            label="Molestia articular reciente" if is_es else "Recent joint discomfort",
            value=f"{len(active_joints_7d)} zona" if is_es else f"{len(active_joints_7d)} area",
            detail=(
                f"Se registró molestia en {joint_label} en una sesión reciente; vigila la carga sobre esa articulación."
                if is_es
                else f"Discomfort logged in {joint_label} after a recent session; monitor loading on that joint."
            ),
            severity="watch",
        ))

    # 7. Sustained multi-week heavy training block
    if consecutive_high_load_weeks >= 4:
        score -= 10
        signals.append(OvertrainingSignal(
            id="sustained_block",
            label="Bloque intenso prolongado" if is_es else "Sustained heavy block",
            value=f"{consecutive_high_load_weeks} sem" if is_es else f"{consecutive_high_load_weeks} wks",
            detail=(
                f"{consecutive_high_load_weeks} semanas seguidas de carga alta sin una semana de descarga planificada."
                if is_es
                else f"{consecutive_high_load_weeks} consecutive high-load weeks without a scheduled deload week."
            ),
            severity="watch",
        ))

    # 8. Nutrition & Health Connect context
    if calorie_goal > 0 and len(daily_kcal_3d) >= 2:
        avg_kcal = round(sum(daily_kcal_3d.values()) / len(daily_kcal_3d))
        if avg_kcal < calorie_goal * 0.80 and sessions_7d >= 3:
            score -= 8
            signals.append(OvertrainingSignal(
                id="nutrition_energy",
                label="Energía para recuperar" if is_es else "Recovery fueling",
                value=f"{round((avg_kcal / calorie_goal) * 100)}%",
                detail=(
                    f"Media de {avg_kcal:,} de {calorie_goal:,} kcal/día en los últimos 3 días mientras entrenas con frecuencia."
                    if is_es
                    else f"Averaging {avg_kcal:,} of {calorie_goal:,} kcal/day over the last 3 days while training frequently."
                ),
                severity="watch",
            ))

    if activity_summary.connected and (
        (activity_summary.steps_avg_7d >= 12000 or activity_summary.active_calories_avg_7d >= 700)
        and sessions_7d >= 4
    ):
        score -= 6
        signals.append(OvertrainingSignal(
            id="activity_load",
            label="Actividad diaria y pasos" if is_es else "Daily NEAT & steps",
            value=f"{activity_summary.steps_avg_7d:,}",
            detail=(
                f"Health Connect promedia {activity_summary.steps_avg_7d:,} pasos/día y "
                f"{activity_summary.active_calories_avg_7d} kcal activas junto con {sessions_7d} sesiones."
                if is_es
                else f"Health Connect averages {activity_summary.steps_avg_7d:,} steps/day and "
                f"{activity_summary.active_calories_avg_7d} active kcal alongside {sessions_7d} sessions."
            ),
            severity="watch",
        ))

    signals.sort(key=lambda sig: severity_rank[sig.severity])

    readiness_score = max(0, min(100, score))
    high_signals = [s for s in signals if s.severity == "high"]
    watch_signals = [s for s in signals if s.severity == "watch"]

    if readiness_score < 50 or len(high_signals) >= 2 or bool(repeated_joint_pain) or joint_workouts_7d >= 2:
        risk_level: RiskLevel = "high"
    elif readiness_score < 75 or len(high_signals) == 1 or len(watch_signals) >= 2:
        risk_level = "moderate"
    else:
        risk_level = "none"

    if in_post_deload_cooldown:
        deload_week_recommended = bool(repeated_joint_pain) or joint_workouts_7d >= 2 or exhausted_7d >= 3
    else:
        deload_week_recommended = (
            risk_level == "high"
            or bool(repeated_joint_pain)
            or joint_workouts_7d >= 2
            or len(regressed_exercises) >= 2
            or exhausted_7d >= 3
            or exhausted_14d >= 4
            or is_baseline_spike_high
            or (
                consecutive_high_load_weeks >= 4
                and (
                    risk_level == "moderate"
                    or effort_load_7d >= 65.0
                    or (len(acute_fatigue_levels) >= 3 and (avg_workout_fatigue_7d or 0) >= 8.5)
                )
            )
        )

    deload_week_reason: str | None = None
    if deload_week_recommended:
        if repeated_joint_pain or joint_workouts_7d >= 2:
            joint_label = _format_joint_list(repeated_joint_pain or active_joints_7d, is_es)
            deload_week_reason = (
                f"Dolor articular repetido ({joint_label}) en tus sesiones recientes: una semana de descarga de 7 días al -{DELOAD_PCT}% reduce el estrés articular y facilita la recuperación."
                if is_es
                else f"Repeated joint discomfort ({joint_label}) across recent sessions: a 7-day -{DELOAD_PCT}% deload week lowers joint stress so tissues can recover."
            )
        elif consecutive_high_load_weeks >= 4:
            deload_week_reason = (
                f"Llevas {consecutive_high_load_weeks} semanas seguidas de carga alta: toca una semana de descarga de 7 días al -{DELOAD_PCT}% (RPE máx. 6) para consolidar adaptaciones."
                if is_es
                else f"You've stacked {consecutive_high_load_weeks} consecutive heavy weeks: a 7-day -{DELOAD_PCT}% deload week (RPE 6 cap) clears fatigue and consolidates gains."
            )
        elif len(regressed_exercises) >= 2:
            deload_week_reason = (
                f"El rendimiento bajó en varios ejercicios ({', '.join(regressed_exercises[:2])}): una semana de descarga de 7 días al -{DELOAD_PCT}% ayuda a recuperar fuerza."
                if is_es
                else f"Output dipped across multiple lifts ({', '.join(regressed_exercises[:2])}): a 7-day -{DELOAD_PCT}% deload week helps restore strength readiness."
            )
        else:
            deload_week_reason = (
                f"Se acumulan señales de fatiga y carga elevada: recomendamos una semana de descarga de 7 días (-{DELOAD_PCT}% de volumen y peso, RPE máx. 6)."
                if is_es
                else f"Elevated fatigue and training strain are stacking up: a 7-day deload week (-{DELOAD_PCT}% volume & load, RPE 6 cap) is recommended."
            )

    has_alert = (risk_level != "none" or deload_week_recommended) and not dismissed and not rest_day_scheduled and not deload_active

    if risk_level == "high":
        headline = (
            "Sobreentrenamiento detectado — semana de descarga recomendada"
            if is_es
            else "Overtraining signals detected — deload week recommended"
        )
        if is_es:
            signal_word = "señal elevada" if len(high_signals) == 1 else "señales elevadas"
            summary = (
                f"Disponibilidad en {readiness_score}/100 con {len(high_signals)} {signal_word}: "
                + " ".join(s.detail for s in high_signals[:2])
            )
            recommendations = [
                f"Activa una semana de descarga de 7 días (-{DELOAD_PCT}% de volumen y carga, RPE máximo 6) o cambia hoy a recuperación activa.",
                "Prioriza más de 7,5 horas de sueño y alcanza tus objetivos diarios de proteína y calorías para favorecer la recuperación.",
            ]
            if repeated_joint_pain or active_joints_7d:
                j_label = _format_joint_list(repeated_joint_pain or active_joints_7d, True)
                recommendations.append(
                    f"Evita cargas pesadas sobre {j_label} y consulta con un profesional si la molestia no desaparece."
                )
            if strained_muscles:
                muscles_label = ", ".join(translate_muscle(m, "es") for m in strained_muscles[:3])
                recommendations.append(
                    f"Mantén el volumen bajo en {muscles_label} durante las próximas 48 horas."
                )
        else:
            summary = (
                f"Readiness is {readiness_score}/100 with {len(high_signals)} elevated strain signal"
                f"{'s' if len(high_signals) != 1 else ''}: "
                + " ".join(s.detail for s in high_signals[:2])
            )
            recommendations = [
                f"Start a 7-day -{DELOAD_PCT}% deload week (capped at RPE 6) or swap today for active recovery.",
                "Favor 7.5+ hours of sleep and hit your daily protein and calorie targets to support tissue repair.",
            ]
            if repeated_joint_pain or active_joints_7d:
                j_label = _format_joint_list(repeated_joint_pain or active_joints_7d, False)
                recommendations.append(
                    f"Stop heavy loading on your {j_label} and check with a professional if discomfort persists."
                )
            if strained_muscles:
                recommendations.append(
                    f"Keep volume light on {', '.join(strained_muscles[:3])} over the next 48 hours."
                )
    elif risk_level == "moderate":
        headline = (
            "Fatiga acumulada detectada — controla la carga hoy"
            if is_es
            else "Accumulated fatigue detected — keep effort controlled"
        )
        top_notes = (high_signals + watch_signals)[:2]
        if is_es:
            summary = f"Disponibilidad en {readiness_score}/100. " + " ".join(s.detail for s in top_notes)
            recommendations = [
                "Reduce 1–2 series efectivas por ejercicio o deja 1–2 repeticiones en reserva hoy.",
                f"Si la fatiga persiste esta semana, inicia la semana de descarga de 7 días al -{DELOAD_PCT}%.",
            ]
        else:
            summary = f"Readiness is {readiness_score}/100. " + " ".join(s.detail for s in top_notes)
            recommendations = [
                "Trim 1–2 working sets per exercise or leave 1–2 reps in reserve today.",
                f"If fatigue carries into your next session, start a 7-day -{DELOAD_PCT}% deload week.",
            ]
        if repeated_joint_pain or active_joints_7d:
            j_label = _format_joint_list(repeated_joint_pain or active_joints_7d, is_es)
            recommendations.append(
                f"Reduce la carga sobre {j_label} hasta entrenar sin molestia."
                if is_es
                else f"Ease loading on your {j_label} until movements feel pain-free."
            )
    else:
        headline = (
            "Sin señales de sobreentrenamiento"
            if is_es
            else "No overtraining detected"
        )
        if is_es:
            summary = (
                f"Disponibilidad en {readiness_score}/100 con {sessions_7d} sesiones y "
                f"{total_sets_7d} series de fuerza en los últimos 7 días."
            )
            recommendations = [
                "Tu carga y recuperación están equilibradas. Sigue progresando dejando 1–2 repeticiones en reserva.",
                "Puedes revisar tus tendencias detalladas de volumen y fatiga en Estadísticas de entreno.",
            ]
        else:
            summary = (
                f"Readiness is {readiness_score}/100 across {sessions_7d} sessions and "
                f"{total_sets_7d} strength sets in the last 7 days."
            )
            recommendations = [
                "Workload and recovery look balanced. Keep progressing within 1–2 reps of target effort.",
                "Check Workout Statistics anytime for detailed volume, muscle, and fatigue trends.",
            ]

    if deload_active:
        recommendations.insert(
            0,
            f"Semana de descarga del -{deload_pct}% activa ({deload_days_remaining} d restantes): se aplica a todos tus entrenos y planes IA."
            if is_es
            else f"A 7-day -{deload_pct}% deload week is active ({deload_days_remaining}d left) across your workouts and AI plans.",
        )
    elif rest_day_scheduled:
        recommendations.insert(
            0,
            "El entrenamiento de IA de hoy ya está marcado como día de descanso y recuperación activa."
            if is_es
            else "Today's AI workout is already set as an active recovery rest day.",
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
        consecutive_high_load_weeks=consecutive_high_load_weeks,
        avg_workout_fatigue_7d=avg_workout_fatigue_7d,
        latest_workout_fatigue=latest_workout_fatigue,
        repeated_joint_pain=repeated_joint_pain,
        strained_muscles=strained_muscles,
        muscle_strain=muscle_strain,
        signals=signals,
        headline=headline,
        summary=summary,
        recommendations=recommendations,
        deload_week_recommended=deload_week_recommended,
        deload_week_reason=deload_week_reason,
        volume_reduction_pct=DELOAD_PCT,
        deload_active=deload_active,
        deload_expires_at=deload_expires_at if deload_active else None,
        deload_days_remaining=deload_days_remaining,
        rest_day_scheduled=rest_day_scheduled,
        dismissed=dismissed,
    )


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
    _save_state(supabase, uid, state, now, raise_on_error=True)

    today_str = active_day.local_date.isoformat()
    todays_plan = _fetch_todays_plan(supabase, uid, today_str)
    if supabase is not None and todays_plan and not todays_plan.get("is_rest_day"):
        reasoning = str(todays_plan.get("ai_reasoning") or "").strip()
        markers = ("Deload active", "Deload week active", "Descarga activa", "Semana de descarga activa")
        if not any(marker in reasoning for marker in markers):
            reduced_exercises = _apply_deload_to_exercises(todays_plan.get("exercises") or [], DELOAD_PCT)
            deload_note = pick(
                f"Deload week active: volume and load reduced by {DELOAD_PCT}%, target RPE capped at 6.",
                f"Semana de descarga activa: volumen y carga reducidos un {DELOAD_PCT} %, RPE objetivo limitado a 6.",
            )
            next_reasoning = f"{reasoning} {deload_note}".strip() if reasoning else deload_note
            try:
                supabase.table("workout_plans").update({
                    "exercises": reduced_exercises,
                    "ai_adjusted": True,
                    "ai_reasoning": next_reasoning,
                    "updated_at": now.isoformat(),
                }).eq("user_id", uid).eq("plan_date", today_str).execute()
            except Exception as err:
                logger.warning("Could not apply deload week to today's workout plan: %s", err)

    return evaluate_overtraining(user_id, active_day)


def clear_overtraining_mods(user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
    supabase = get_supabase(admin=True)
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    state = _load_state(supabase, uid)
    state["deload_pct"] = 0
    state["deload_applied_at"] = None
    state["deload_expires_at"] = None
    _save_state(supabase, uid, state, now, raise_on_error=True)
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
            "title": pick("Active Recovery & Rest", "Recuperación activa y descanso"),
            "exercises": [],
            "is_rest_day": True,
            "ai_adjusted": True,
            "ai_reasoning": pick(
                "Swapped to a recovery rest day based on your readiness check.",
                "Cambiado a un día de descanso y recuperación según tu evaluación de disponibilidad.",
            ),
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
    _save_state(supabase, uid, state, now, raise_on_error=True)
    return evaluate_overtraining(user_id, day)
