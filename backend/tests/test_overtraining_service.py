from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.schemas.health import HealthActivitySummary
from app.schemas.overtraining import FatigueFeedbackCreate, FatigueFeedbackEntry
from app.services import overtraining_service as service


@pytest.fixture
def offline(monkeypatch):
    """No Supabase: state and check-ins live in the in-memory fallback; history is injected."""
    data = {"workouts": [], "plan": None, "nutrition": (0, {})}
    monkeypatch.setattr(service, "get_supabase", lambda admin=True: None)
    monkeypatch.setattr(service, "_FALLBACK_CHECKINS", {})
    monkeypatch.setattr(service, "_FALLBACK_STATES", {})
    monkeypatch.setattr(service, "_fetch_workouts_35d", lambda *_: data["workouts"])
    monkeypatch.setattr(service, "_fetch_todays_plan", lambda *_: data["plan"])
    monkeypatch.setattr(service, "_fetch_nutrition_3d", lambda *_: data["nutrition"])
    monkeypatch.setattr(service, "get_cached_exercise", lambda _id: None)
    monkeypatch.setattr(service.health_service, "get_activity_summary", lambda *_: HealthActivitySummary())
    return data


def hard_workout(days_ago, muscle="Chest", sets=8, rpe=9.5, fatigue=9):
    start = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=1)
    return {
        "id": str(uuid4()), "name": "Heavy", "fatigue_level": fatigue,
        "start_time": start.isoformat(), "end_time": (start + timedelta(hours=1)).isoformat(),
        "workout_sets": [
            {"exercise_id": f"ex-{muscle}", "set_number": n, "reps": 8, "weight": 100, "rpe": rpe,
             "is_done": True, "exercises": {"name": f"{muscle} press", "muscle_group": muscle}}
            for n in range(sets)
        ],
    }


# --- pure rules ---

@pytest.mark.parametrize("raw, expected", [
    (None, None), ("  ", None), ("Cardio", None), ("strength", None),
    ("Pectorals", "Chest"), ("front delts", "Shoulders"), ("lats", "Back"), ("quadriceps", "Quads"),
    ("hamstrings", "Hamstrings"), ("glutes", "Glutes"), ("calves", "Legs"), ("biceps", "Arms"),
    ("obliques", "Core"), ("neck", "Neck"),
])
def test_muscle_names_are_normalized(raw, expected):
    assert service._normalize_muscle(raw) == expected


def test_parse_dt_accepts_iso_strings_and_naive_datetimes():
    assert service._parse_dt("2026-01-01T10:00:00Z") == datetime(2026, 1, 1, 10, tzinfo=timezone.utc)
    assert service._parse_dt(datetime(2026, 1, 1)).tzinfo == timezone.utc
    assert service._parse_dt("2026-01-01T10:00:00").tzinfo == timezone.utc
    assert service._parse_dt("yesterday") is None
    assert service._parse_dt(42) is None


def test_consecutive_training_days_counts_back_from_today_or_yesterday():
    today = date(2026, 3, 10)
    days = {today - timedelta(days=n) for n in range(4)}
    assert service._consecutive_training_days(days, today) == 4
    assert service._consecutive_training_days({today - timedelta(days=1)}, today) == 1
    assert service._consecutive_training_days({today - timedelta(days=3)}, today) == 0


@pytest.mark.parametrize("fatigue, soreness, sleep, joint, expected", [
    (3, 3, "restorative", "none", False),
    (6, 3, "poor", "none", True),     # poor sleep pushes fatigue to 8
    (3, 3, "average", "sharp", True),  # sharp joint pain always counts
    (6, 6, "average", "mild", True),   # 7 + 7 >= 13
])
def test_high_fatigue_checkins(fatigue, soreness, sleep, joint, expected):
    entry = FatigueFeedbackEntry(id="1", fatigue_level=fatigue, soreness_level=soreness,
                                 sleep_quality=sleep, joint_strain=joint, created_at=datetime.now(timezone.utc))
    assert service._is_high_fatigue_checkin(entry) is expected


def test_deload_trims_sets_and_load_by_the_percentage():
    reduced = service._apply_deload_to_exercises([
        {"sets": 4, "previous_weight_kg": 100},
        {"sets": 1, "previous_weight_kg": 0},
        "not an exercise",
    ], 15)
    assert reduced[0] == {"sets": 3, "previous_weight_kg": 85.0}
    assert reduced[1] == {"sets": 1, "previous_weight_kg": 0}  # a single set is never removed
    assert reduced[2] == "not an exercise"


def test_cardio_sets_are_recognised():
    assert service._is_cardio_set({"duration_seconds": 600}, {}, None) is True
    assert service._is_cardio_set({}, {"muscle_group": "Cardio"}, None) is True
    cached = SimpleNamespace(category="", muscle_group="", muscles=["cardio system"])
    assert service._is_cardio_set({}, {}, cached) is True
    assert service._is_cardio_set({}, {"muscle_group": "Chest"}, None) is False


# --- evaluation ---

def test_a_rested_user_has_no_alert(offline):
    status = service.evaluate_overtraining(uuid4())

    assert status.risk_level == "none"
    assert status.has_alert is False
    assert status.sessions_last_7_days == 0


def test_a_hard_week_with_poor_recovery_raises_an_alert(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(n, muscle=("Chest" if n % 2 else "Legs")) for n in range(7)]
    offline["workouts"].append(hard_workout(20, sets=2, rpe=6, fatigue=3))  # light chronic baseline
    offline["nutrition"] = (2500, {datetime.now(timezone.utc).date() - timedelta(days=1): 1200})
    for _ in range(2):
        service.record_fatigue_feedback(uid, FatigueFeedbackCreate(
            fatigue_level=9, soreness_level=8, sleep_quality="poor", joint_strain="mild",
            sore_muscles=["Pecs"], notes=" heavy legs ",
        ))

    status = service.evaluate_overtraining(uid)

    assert status.risk_level in {"moderate", "high"}
    assert status.has_alert is True
    assert status.sessions_last_7_days == 7
    assert status.high_rpe_sets_count == status.total_sets_last_7_days == 56
    assert status.consecutive_training_days >= 6
    assert status.latest_workout_fatigue == 9
    assert status.signals
    assert status.readiness_score < 100


def test_deload_is_applied_then_cleared_by_the_next_workout(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(n) for n in range(5)]

    applied = service.apply_overtraining_mods(uid)
    assert applied.deload_active is True
    assert applied.volume_reduction_pct == service.DELOAD_PCT

    service.on_workout_completed(uid)
    assert service.evaluate_overtraining(uid).deload_active is False


def test_clearing_mods_ends_the_deload(offline):
    uid = uuid4()
    service.apply_overtraining_mods(uid)
    assert service.clear_overtraining_mods(uid).deload_active is False


def test_dismissing_hides_the_alert_until_new_feedback(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(n) for n in range(7)]

    assert service.dismiss_overtraining_alert(uid).has_alert is False
    service.record_fatigue_feedback(uid, FatigueFeedbackCreate(fatigue_level=9, soreness_level=9))
    assert service.evaluate_overtraining(uid).dismissed is False


def test_checkins_can_be_deleted_once(offline):
    uid = uuid4()
    status = service.record_fatigue_feedback(uid, FatigueFeedbackCreate(fatigue_level=4, soreness_level=4))
    entry_id = status.recent_checkins[0].id

    assert service.delete_fatigue_feedback(uid, entry_id).recent_checkins == []
    with pytest.raises(HTTPException) as error:
        service.delete_fatigue_feedback(uid, entry_id)
    assert error.value.status_code == 404


def test_rest_day_needs_a_database(offline):
    with pytest.raises(HTTPException) as error:
        service.schedule_recovery_rest_day(uuid4())
    assert error.value.status_code == 503
