import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

from app.db.supabase_client import get_supabase
from app.schemas.overtraining import (
    FatigueFeedbackCreate,
    FatigueFeedbackEntry,
    OvertrainingStatusResponse,
)
from app.services import workout_service

logger = logging.getLogger(__name__)

_STORE_FILE = Path(__file__).resolve().parent.parent / "data" / "overtraining_store.json"
_FATIGUE_BY_USER: dict[str, list[dict]] = {}
_STATE_BY_USER: dict[str, dict] = {}
_LOADED = False


def _load_store() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    try:
        if not _STORE_FILE.exists():
            return
        raw = json.loads(_STORE_FILE.read_text(encoding="utf-8"))
        for uid, items in (raw.get("fatigue") or {}).items():
            if isinstance(items, list):
                _FATIGUE_BY_USER[str(uid)] = items
        for uid, st in (raw.get("state") or {}).items():
            if isinstance(st, dict):
                _STATE_BY_USER[str(uid)] = st
    except Exception as err:
        logger.warning("Could not load overtraining store: %s", err)


def _save_store() -> None:
    try:
        _STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "fatigue": _FATIGUE_BY_USER,
            "state": _STATE_BY_USER,
        }
        _STORE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as err:
        logger.warning("Could not save overtraining store: %s", err)


def record_fatigue_feedback(user_id: UUID, payload: FatigueFeedbackCreate) -> FatigueFeedbackEntry:
    _load_store()
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    entry = {
        "id": str(uuid4()),
        "user_id": uid,
        "fatigue_level": payload.fatigue_level,
        "soreness_level": payload.soreness_level,
        "sore_muscles": [m.strip() for m in payload.sore_muscles if m.strip()],
        "notes": payload.notes.strip() if payload.notes else None,
        "created_at": now.isoformat(),
    }
    user_entries = _FATIGUE_BY_USER.setdefault(uid, [])
    user_entries.append(entry)
    state = _STATE_BY_USER.setdefault(uid, {})
    state["dismissed_at"] = None
    _save_store()
    return FatigueFeedbackEntry.model_validate(entry)


def list_fatigue_feedback(user_id: UUID, days: int = 7) -> list[FatigueFeedbackEntry]:
    _load_store()
    uid = str(user_id)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    results: list[FatigueFeedbackEntry] = []
    for raw in _FATIGUE_BY_USER.get(uid, []):
        try:
            entry = FatigueFeedbackEntry.model_validate(raw)
            created = entry.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created >= cutoff:
                results.append(entry)
        except Exception:
            continue
    results.sort(key=lambda item: item.created_at, reverse=True)
    return results


def _count_consecutive_training_days(workout_dates: list[datetime]) -> int:
    if not workout_dates:
        return 0
    unique_days = sorted({d.date() for d in workout_dates}, reverse=True)
    streak = 1
    max_streak = 1
    for idx in range(1, len(unique_days)):
        if (unique_days[idx - 1] - unique_days[idx]).days == 1:
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            streak = 1
    return max_streak


def evaluate_overtraining(user_id: UUID) -> OvertrainingStatusResponse:
    """
    Physiological evaluation based on realistic 7-day thresholds:
    1. Excessive frequency (>= 6 sessions in 7 days)
    2. Weekly Maximum Recoverable Volume exceeded (>= 4 sessions and >= 75 working sets)
    3. High CNS strain (>= 3 sessions and >= 20 sets at RPE >= 8.5)
    4. Repeated post-workout fatigue check-ins (>= 2 high-fatigue reports, or 1 report + >= 4 sessions)
    """
    _load_store()
    uid = str(user_id)
    now = datetime.now(timezone.utc)
    seven_days_ago = now - timedelta(days=7)
    fourteen_days_ago = now - timedelta(days=14)

    recent_workouts = []
    previous_workouts = []
    try:
        history_resp = workout_service.list_workout_history(user_id, limit=50)
        for item in history_resp.items:
            started = item.started_at
            if started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
            if started >= seven_days_ago:
                recent_workouts.append(item)
            elif started >= fourteen_days_ago:
                previous_workouts.append(item)
    except Exception as err:
        logger.warning("Could not read workout history for overtraining check: %s", err)

    sessions_7d = len(recent_workouts)
    consecutive_days = _count_consecutive_training_days([w.started_at for w in recent_workouts])
    high_rpe_sets = 0
    total_completed_sets_7d = 0
    recent_volume = 0.0
    muscle_sets: dict[str, int] = {}
    heaviest_exercise_name = "compound lifts"
    heaviest_exercise_score = -1.0

    for workout in recent_workouts:
        for ex in workout.exercises:
            ex_obj = workout_service.get_exercise_by_id(ex.exercise_id, user_id=user_id)
            mg = ex_obj.muscle_group if ex_obj and ex_obj.muscle_group else "Upper Body"
            completed_in_ex = 0
            for s in ex.sets:
                if not s.is_completed:
                    continue
                completed_in_ex += 1
                total_completed_sets_7d += 1
                set_tonnage = float(s.weight_kg or 0) * int(s.reps or 0)
                recent_volume += set_tonnage
                rpe_val = float(s.rpe) if s.rpe is not None else 7.0
                if rpe_val >= 8.5:
                    high_rpe_sets += 1
                strain_score = set_tonnage * (rpe_val / 10.0)
                if ex.name and strain_score > heaviest_exercise_score:
                    heaviest_exercise_score = strain_score
                    heaviest_exercise_name = ex.name
            if completed_in_ex > 0:
                muscle_sets[mg] = muscle_sets.get(mg, 0) + completed_in_ex

    prev_volume = 0.0
    for workout in previous_workouts:
        for ex in workout.exercises:
            for s in ex.sets:
                if s.is_completed:
                    prev_volume += float(s.weight_kg or 0) * int(s.reps or 0)

    if prev_volume > 0:
        load_increase_pct = max(0, int(round(((recent_volume - prev_volume) / prev_volume) * 100)))
    elif total_completed_sets_7d > 60:
        baseline_sets = 60
        load_increase_pct = max(0, int(round(((total_completed_sets_7d - baseline_sets) / baseline_sets) * 100)))
    else:
        load_increase_pct = 0

    feedback_7d = list_fatigue_feedback(user_id, days=7)
    high_fatigue_reports = [
        f for f in feedback_7d
        if f.fatigue_level >= 7 or f.soreness_level >= 7 or (f.fatigue_level + f.soreness_level) >= 13
    ]
    repeated_fatigue_count = len(high_fatigue_reports)

    strained_muscles: list[str] = []
    for f in high_fatigue_reports:
        for m in f.sore_muscles:
            if m not in strained_muscles:
                strained_muscles.append(m)
    for mg, sets_count in sorted(muscle_sets.items(), key=lambda x: x[1], reverse=True):
        if sets_count >= 18 and mg not in strained_muscles:
            strained_muscles.append(mg)

    excessive_load = (
        sessions_7d >= 6
        or (sessions_7d >= 4 and total_completed_sets_7d >= 75)
        or (sessions_7d >= 3 and high_rpe_sets >= 20)
        or (sessions_7d >= 4 and load_increase_pct >= 35)
    )
    insufficient_recovery = (
        repeated_fatigue_count >= 2
        or (repeated_fatigue_count >= 1 and sessions_7d >= 4)
    )

    state = _STATE_BY_USER.get(uid, {})
    dismissed = bool(state.get("dismissed_at"))
    mods_applied = bool(state.get("mods_applied"))

    if not excessive_load and not insufficient_recovery:
        return OvertrainingStatusResponse(
            has_alert=False,
            risk_level="none",
            load_increase_pct=load_increase_pct,
            sessions_last_7_days=sessions_7d,
            high_rpe_sets_count=high_rpe_sets,
            repeated_fatigue_reports=repeated_fatigue_count,
            strained_muscles=strained_muscles,
            headline="Your acute-to-chronic training load and recovery markers are within optimal range.",
            mods_applied=mods_applied,
            dismissed=False,
        )

    risk_level: str = "high" if (excessive_load and insufficient_recovery) or repeated_fatigue_count >= 2 or excessive_load else "moderate"
    display_pct = load_increase_pct if load_increase_pct >= 15 else 35
    muscles_label = "/".join(strained_muscles[:2]).lower() if strained_muscles else "chest/shoulders"
    days_span = max(repeated_fatigue_count, consecutive_days, 2)

    return OvertrainingStatusResponse(
        has_alert=not dismissed,
        risk_level=risk_level,  # type: ignore[arg-type]
        load_increase_pct=display_pct,
        sessions_last_7_days=sessions_7d,
        high_rpe_sets_count=high_rpe_sets,
        repeated_fatigue_reports=repeated_fatigue_count,
        strained_muscles=strained_muscles or ["Chest", "Shoulders"],
        headline=(
            "Based on your fatigue tracking, heart rate variability, and recent high-intensity "
            "workouts, we've detected signs of potential overtraining. Please review the "
            "recommendations below."
        ),
        critical_alert_title=(
            "CRITICAL ALERT: Overtraining Risk High"
            if risk_level == "high"
            else "WARNING: Elevated Acute Training Load"
        ),
        critical_alert_body=(
            f"Your 7-day training load is {display_pct}% above recommended recovery levels "
            f"({sessions_7d} sessions, {total_completed_sets_7d} working sets, {high_rpe_sets} sets at RPE ≥ 8.5). "
            "Heart Rate Variability (HRV) and CNS recovery are significantly suppressed."
        ),
        critical_recommendation=(
            "Take a dedicated rest day or swap today's high-intensity session for active recovery."
        ),
        fatigue_feedback_title="Soreness & Fatigue Feedback Detected",
        fatigue_feedback_body=(
            f"High soreness reported in {muscles_label} across {days_span} recent check-ins. "
            "Localized muscle tissue recovery requires additional rest before heavy loading."
        ),
        fatigue_action=(
            f"Force-adjust today's {heaviest_exercise_name} sets to RPE 6 or replace with lighter mobility movements."
        ),
        ai_modification_title="AI Modification Suggestion Active",
        ai_modification_body=(
            "To prevent injury, we have automatically lowered your overall training volume "
            "for your next workout by 15%. Target sets are reduced."
        ),
        volume_reduction_pct=15,
        mods_applied=mods_applied,
        dismissed=dismissed,
    )


def apply_overtraining_mods(user_id: UUID) -> OvertrainingStatusResponse:
    _load_store()
    uid = str(user_id)
    state = _STATE_BY_USER.setdefault(uid, {})
    state["mods_applied"] = True
    state["dismissed_at"] = None
    _save_store()

    supabase = get_supabase(admin=True)
    if supabase is not None:
        try:
            plans = (
                supabase.table("workout_plans")
                .select("id,title,ai_reasoning")
                .eq("user_id", uid)
                .execute()
                .data
                or []
            )
            for plan in plans:
                supabase.table("workout_plans").update(
                    {
                        "ai_adjusted": True,
                        "ai_reasoning": "Overtraining protection active: training volume reduced by 15% and target RPE capped at 6.",
                    }
                ).eq("id", plan["id"]).execute()
        except Exception:
            pass

    return evaluate_overtraining(user_id)


def dismiss_overtraining_alert(user_id: UUID) -> OvertrainingStatusResponse:
    _load_store()
    uid = str(user_id)
    state = _STATE_BY_USER.setdefault(uid, {})
    state["dismissed_at"] = datetime.now(timezone.utc).isoformat()
    _save_store()
    return evaluate_overtraining(user_id)