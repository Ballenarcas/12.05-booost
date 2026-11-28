import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.schemas.health import HealthActivitySummary
from app.schemas.workout_log import WorkoutLogCreate
from app.services import overtraining_service as service
from app.services import workout_adjustment_service, workout_service
from app.services.training_load import set_effort_weight
from main import app
from tests.auth_helpers import auth_headers
from tests.test_workout_adjustment_service import FakeDatabase

client = TestClient(app)


@pytest.fixture
def offline(monkeypatch):
    """No Supabase: state lives in the in-memory fallback; history is injected."""
    data = {"workouts": [], "plan": None, "nutrition": (0, {})}
    monkeypatch.setattr(service, "get_supabase", lambda admin=True: None)
    monkeypatch.setattr(service, "_FALLBACK_STATES", {})
    monkeypatch.setattr(service, "_fetch_workouts_35d", lambda *_: data["workouts"])
    monkeypatch.setattr(service, "_fetch_todays_plan", lambda *_: data["plan"])
    monkeypatch.setattr(service, "_fetch_nutrition_3d", lambda *_: data["nutrition"])
    monkeypatch.setattr(service, "get_cached_exercise", lambda _id: None)
    monkeypatch.setattr(service.health_service, "get_activity_summary", lambda *_: HealthActivitySummary())
    return data


def hard_workout(days_ago, muscle="Chest", sets=8, rpe=9.5, fatigue=9, joint_pain=None):
    start = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=1)
    return {
        "id": str(uuid4()),
        "name": "Heavy",
        "fatigue_level": fatigue,
        "joint_pain": joint_pain or [],
        "start_time": start.isoformat(),
        "end_time": (start + timedelta(hours=1)).isoformat(),
        "workout_sets": [
            {
                "exercise_id": f"ex-{muscle}",
                "set_number": n,
                "reps": 8,
                "weight": 100,
                "rpe": rpe,
                "is_done": True,
                "exercises": {"name": f"{muscle} press", "muscle_group": muscle},
            }
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


# --- automatic detection & deload week ---

def test_a_rested_user_has_no_alert(offline):
    status = service.evaluate_overtraining(uuid4())

    assert status.risk_level == "none"
    assert status.has_alert is False
    assert status.deload_week_recommended is False
    assert status.deload_week_reason is None
    assert status.sessions_last_7_days == 0


def test_a_hard_week_with_high_post_workout_fatigue_raises_alert_and_deload_week(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(n, muscle=("Chest" if n % 2 else "Legs")) for n in range(7)]
    offline["workouts"].append(hard_workout(20, sets=2, rpe=6, fatigue=3))
    offline["nutrition"] = (2500, {datetime.now(timezone.utc).date() - timedelta(days=1): 1200})

    status = service.evaluate_overtraining(uid)

    assert status.risk_level == "high"
    assert status.has_alert is True
    assert status.deload_week_recommended is True
    assert status.deload_week_reason is not None
    assert status.sessions_last_7_days == 7
    assert status.high_rpe_sets_count == status.total_sets_last_7_days == 56
    assert status.consecutive_training_days >= 6
    assert status.latest_workout_fatigue == 9
    assert status.readiness_score < 50


def test_single_vs_repeated_joint_pain_drives_watch_then_high_deload_alert(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(1, muscle="Legs", sets=4, rpe=7.5, fatigue=5, joint_pain=["knee"])]

    single = service.evaluate_overtraining(uid)
    single_sig = next(sig for sig in single.signals if sig.id == "joint_pain")
    assert single_sig.severity == "watch"
    assert single.repeated_joint_pain == []

    # Second session reporting knee pain within 14 days escalates to repeated joint pain + deload week.
    offline["workouts"].append(hard_workout(8, muscle="Legs", sets=4, rpe=7.5, fatigue=5, joint_pain=["knee"]))
    repeated = service.evaluate_overtraining(uid)
    rep_sig = next(sig for sig in repeated.signals if sig.id == "joint_pain")

    assert rep_sig.severity == "high"
    assert repeated.repeated_joint_pain == ["knee"]
    assert repeated.risk_level == "high"
    assert repeated.has_alert is True
    assert repeated.deload_week_recommended is True
    assert repeated.deload_week_reason is not None
    assert "knee" in repeated.deload_week_reason.lower()


def test_four_consecutive_heavy_weeks_recommends_deload_week(offline):
    uid = uuid4()
    workouts = []
    for week in range(4):
        for offset in (0, 2, 4, 5):
            workouts.append(hard_workout(week * 7 + offset, sets=14, rpe=8.5, fatigue=7))
    offline["workouts"] = workouts

    status = service.evaluate_overtraining(uid)

    assert status.consecutive_high_load_weeks == 4
    assert status.deload_week_recommended is True
    assert any(sig.id == "sustained_block" for sig in status.signals)


def test_deload_week_persists_across_workouts_and_expires_after_seven_days(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(n) for n in range(5)]

    applied = service.apply_overtraining_mods(uid)
    assert applied.deload_active is True
    assert applied.has_alert is False
    assert applied.volume_reduction_pct == service.DELOAD_PCT
    assert applied.deload_days_remaining == 7

    # Completing a workout must NOT clear a 7-day deload week.
    service.on_workout_completed(uid)
    still_active = service.evaluate_overtraining(uid)
    assert still_active.deload_active is True
    assert service.get_active_deload_pct(uid) == 15

    # Once expired, evaluation and helper clear it cleanly.
    service._FALLBACK_STATES[str(uid)]["deload_expires_at"] = (
        datetime.now(timezone.utc) - timedelta(minutes=1)
    ).isoformat()
    assert service.get_active_deload_pct(uid) == 0
    assert service.evaluate_overtraining(uid).deload_active is False


def test_clearing_mods_ends_the_deload(offline):
    uid = uuid4()
    service.apply_overtraining_mods(uid)
    assert service.clear_overtraining_mods(uid).deload_active is False


def test_dismissing_hides_alert_for_cooldown_window(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(n) for n in range(7)]

    assert service.dismiss_overtraining_alert(uid).has_alert is False
    # Completing a workout within the 3-day cooldown keeps the alert quiet.
    service.on_workout_completed(uid)
    right_after = service.evaluate_overtraining(uid)
    assert right_after.dismissed is True
    assert right_after.has_alert is False

    # Once the 3-day dismiss cooldown elapses, the alert can surface again.
    service._FALLBACK_STATES[str(uid)]["dismissed_at"] = (
        datetime.now(timezone.utc) - timedelta(days=service.DISMISS_COOLDOWN_DAYS, minutes=1)
    ).isoformat()
    service.on_workout_completed(uid)
    after_cooldown = service.evaluate_overtraining(uid)
    assert after_cooldown.dismissed is False
    assert after_cooldown.has_alert is True


# --- API endpoints & planner/workout_log integration ---

def test_overtraining_api_endpoints_and_removed_checkin_route(offline):
    uid = str(uuid4())
    offline["workouts"] = [hard_workout(n) for n in range(7)]
    headers = auth_headers(uid)

    res = client.get("/api/v1/workouts/overtraining-alerts", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["has_alert"] is True
    assert body["deload_week_recommended"] is True

    applied = client.post("/api/v1/workouts/overtraining-alerts/apply", headers=headers)
    assert applied.status_code == 200
    assert applied.json()["deload_active"] is True
    assert applied.json()["deload_days_remaining"] == 7

    cleared = client.delete("/api/v1/workouts/overtraining-alerts/apply", headers=headers)
    assert cleared.status_code == 200
    assert cleared.json()["deload_active"] is False

    dismissed = client.post("/api/v1/workouts/overtraining-alerts/dismiss", headers=headers)
    assert dismissed.status_code == 200
    assert dismissed.json()["has_alert"] is False

    # Manual check-in endpoints were removed.
    gone = client.post("/api/v1/workouts/fatigue-feedback", json={"fatigue_level": 8}, headers=headers)
    assert gone.status_code == 404


def test_saving_workout_persists_deduplicated_joint_pain(monkeypatch):
    database = FakeDatabase()
    database.rows["workout_sets"] = []
    database.rows["workouts"] = []
    monkeypatch.setattr(workout_service, "get_supabase", lambda **_: database)
    monkeypatch.setattr(workout_service, "resolve_exercise_log_id", lambda exercise_id: exercise_id)
    now = datetime.now(timezone.utc)
    one_set = [{"set_number": 1, "weight_kg": 50, "reps": 8, "is_completed": True}]

    workout_service.save_workout_log(uuid4(), WorkoutLogCreate(
        name="Legs",
        duration_seconds=60,
        started_at=now,
        completed_at=now,
        fatigue_level=7,
        joint_pain=["knee", "knee", "lower_back"],
        exercises=[{"exercise_id": "squat", "sets": one_set}],
    ))

    saved_workout = database.rows["workouts"][0]
    assert saved_workout["fatigue_level"] == 7
    assert saved_workout["joint_pain"] == ["knee", "lower_back"]


@pytest.mark.asyncio
async def test_daily_plan_respects_active_deload_week_and_joint_pain(monkeypatch):
    database = FakeDatabase()
    database.rows["routine_exercises"][0]["target_sets"] = 4
    now = datetime.now(timezone.utc)
    database.rows["workouts"] = [
        {"id": "w1", "user_id": database.rows["users"][0]["id"], "start_time": (now - timedelta(days=3)).isoformat(),
         "end_time": (now - timedelta(days=3)).isoformat(), "joint_pain": ["shoulder"]},
        {"id": "w2", "user_id": database.rows["users"][0]["id"], "start_time": (now - timedelta(days=6)).isoformat(),
         "end_time": (now - timedelta(days=6)).isoformat(), "joint_pain": ["shoulder"]},
    ]
    database.rows["overtraining_states"] = [{
        "user_id": database.rows["users"][0]["id"],
        "deload_pct": 15,
        "deload_applied_at": (now - timedelta(days=1)).isoformat(),
        "deload_expires_at": (now + timedelta(days=6)).isoformat(),
        "dismissed_at": None,
    }]
    monkeypatch.setattr(workout_adjustment_service, "MIN_PLAN_EXERCISES", 1)
    monkeypatch.setattr(workout_adjustment_service, "_catalog_cache", None)
    prompts = []

    async def recommend(prompt, _schema):
        prompts.append(json.loads(prompt))
        return {
            "routine_id": database.routine_id,
            "workout_name": "Routine",
            "rest_day": False,
            "adjusted": False,
            "reasoning": "Keep the plan.",
            "exercises": [{"exercise_id": database.exercise_id, "sets": 4, "reps": 8}],
        }

    monkeypatch.setattr(workout_adjustment_service, "_request_json", recommend)
    plan = await workout_adjustment_service.plan_daily_workout(UUID(database.rows["users"][0]["id"]), database)

    assert prompts[0]["joint_pain"] == {"recent": ["shoulder"], "repeated": ["shoulder"]}
    assert prompts[0]["deload_week"] == {"active": True, "reduction_pct": 15, "rpe_cap": 6}
    assert plan["ai_adjusted"] is True
    assert "Deload week active" in plan["reasoning"]
    written_plan = next(row for table, row in database.writes if table == "workout_plans")
    assert written_plan["exercises"][0]["sets"] == 3


def test_set_effort_weight_scales_with_rpe():
    assert set_effort_weight(None) == 1.0
    assert set_effort_weight(5.5) == 0.5
    assert set_effort_weight(7.0) == 0.75
    assert set_effort_weight(8.0) == 1.0
    assert set_effort_weight(8.5) == 1.2
    assert set_effort_weight(9.0) == 1.4
    assert set_effort_weight(9.5) == 1.7
    assert set_effort_weight(10.0) == 2.0


def test_heavy_duty_low_volume_high_rpe_does_not_trigger_overtraining(offline):
    uid = uuid4()
    # Week 1 only: 3 sessions x 7 working sets @ RPE 9.5, normal fatigue
    offline["workouts"] = [hard_workout(d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=5) for d in (1, 3, 5)]

    week1 = service.evaluate_overtraining(uid)
    rpe_sig = next(sig for sig in week1.signals if sig.id == "high_rpe")
    assert week1.risk_level == "none"
    assert week1.has_alert is False
    assert week1.deload_week_recommended is False
    assert rpe_sig.severity == "ok"

    # Steady 4-week Heavy Duty block (same low volume & high RPE each week)
    offline["workouts"] = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=5)
        for w in range(4)
        for d in (1, 3, 5)
    ]
    steady = service.evaluate_overtraining(uid)
    steady_rpe_sig = next(sig for sig in steady.signals if sig.id == "high_rpe")
    assert steady.acwr == 1.0
    assert steady.risk_level == "none"
    assert steady.has_alert is False
    assert steady.consecutive_high_load_weeks == 0
    assert steady.deload_week_recommended is False
    assert steady_rpe_sig.severity == "ok"


def test_heavy_duty_lifter_doubling_volume_triggers_spike_and_intensity_strain(offline):
    uid = uuid4()
    # 3 chronic weeks of 21 sets/wk @ RPE 9.5 (35.7 load), then 36 sets/wk @ RPE 9.5 acute (61.2 load)
    chronic = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=5)
        for w in range(1, 4)
        for d in (1, 3, 5)
    ]
    acute = [
        hard_workout(d, muscle="Chest" if d % 2 else "Legs", sets=6, rpe=9.5, fatigue=6)
        for d in range(6)
    ]
    offline["workouts"] = acute + chronic

    status = service.evaluate_overtraining(uid)
    spike_sig = next(sig for sig in status.signals if sig.id == "workload_spike")
    rpe_sig = next(sig for sig in status.signals if sig.id == "high_rpe")
    assert spike_sig.severity == "high"
    assert rpe_sig.severity == "high"
    assert status.risk_level == "high"


def test_volume_lifter_escalating_rpe_at_same_set_count_triggers_effort_acwr(offline):
    uid = uuid4()
    # Same 45 sets/wk, chronic @ RPE 7.0 (33.75 load) vs acute @ RPE 9.5 (76.5 load)
    chronic = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=15, rpe=7.0, fatigue=5)
        for w in range(1, 4)
        for d in (1, 3, 5)
    ]
    acute = [
        hard_workout(d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=15, rpe=9.5, fatigue=6)
        for d in (1, 3, 5)
    ]
    offline["workouts"] = acute + chronic

    status = service.evaluate_overtraining(uid)
    spike_sig = next(sig for sig in status.signals if sig.id == "workload_spike")
    rpe_sig = next(sig for sig in status.signals if sig.id == "high_rpe")
    assert status.acwr is not None and status.acwr > 2.0
    assert spike_sig.severity == "high"
    assert rpe_sig.severity in ("watch", "high")


def test_moderate_fatigue_recommendation_is_style_neutral(offline):
    uid = uuid4()
    # Trigger moderate risk via a sustained +3.0 fatigue jump above personal 5.0 baseline.
    chronic = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=5)
        for w in range(1, 4)
        for d in (1, 3, 5)
    ]
    acute = [
        hard_workout(d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=8)
        for d in (1, 3, 5)
    ]
    offline["workouts"] = acute + chronic

    status = service.evaluate_overtraining(uid, lang="en")
    assert status.risk_level == "moderate"
    joined = " ".join(status.recommendations).lower()
    assert "trim 1–2 working sets" in joined
    assert "rpe 7–8" not in joined

    status_es = service.evaluate_overtraining(uid, lang="es")
    joined_es = " ".join(status_es.recommendations).lower()
    assert "reduce 1–2 series efectivas" in joined_es
    assert "rpe 7–8" not in joined_es


@pytest.mark.parametrize("fatigue", [8, 9])
def test_steady_high_fatigue_8_to_9_is_normal_and_triggers_no_alarm(offline, fatigue):
    uid = uuid4()
    # 3 weeks of 3x/wk normal hard sessions at 8-9/10 fatigue -> never an overtraining alarm.
    offline["workouts"] = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=fatigue)
        for w in range(3)
        for d in (1, 3, 5)
    ]

    status = service.evaluate_overtraining(uid)
    fatigue_sig = next(sig for sig in status.signals if sig.id == "workout_fatigue")
    assert fatigue_sig.severity == "ok"
    assert status.risk_level == "none"
    assert status.has_alert is False
    assert status.deload_week_recommended is False

    # Even 4 steady weeks at 8/10 (< 8.5 threshold) stays clear at low volume.
    if fatigue == 8:
        offline["workouts"].extend(
            hard_workout(21 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=8)
            for d in (1, 3, 5)
        )
        four_weeks = service.evaluate_overtraining(uid)
        assert four_weeks.risk_level == "none"
        assert four_weeks.has_alert is False
        assert four_weeks.deload_week_recommended is False


def test_fatigue_jump_above_personal_baseline_triggers_watch_then_high(offline):
    uid = uuid4()
    chronic = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.0, fatigue=5)
        for w in range(1, 4)
        for d in (1, 3, 5)
    ]
    two_hard = [
        hard_workout(1, muscle="Legs", sets=7, rpe=9.0, fatigue=8),
        hard_workout(3, muscle="Back", sets=7, rpe=9.0, fatigue=8),
    ]
    offline["workouts"] = two_hard + chronic

    watching = service.evaluate_overtraining(uid)
    watch_sig = next(sig for sig in watching.signals if sig.id == "workout_fatigue")
    assert watch_sig.severity == "watch"
    assert watching.risk_level == "none"

    offline["workouts"].append(hard_workout(5, muscle="Chest", sets=7, rpe=9.0, fatigue=8))
    spiked = service.evaluate_overtraining(uid)
    high_sig = next(sig for sig in spiked.signals if sig.id == "workout_fatigue")
    assert high_sig.severity == "high"
    assert spiked.has_alert is True
    assert spiked.deload_week_recommended is True


def test_repeated_ten_out_of_ten_exhaustion_triggers_watch_then_high(offline):
    uid = uuid4()
    offline["workouts"] = [hard_workout(1, muscle="Legs", sets=7, rpe=9.5, fatigue=10)]
    one = service.evaluate_overtraining(uid)
    assert next(s for s in one.signals if s.id == "workout_fatigue").severity == "ok"
    assert one.has_alert is False

    offline["workouts"].append(hard_workout(3, muscle="Back", sets=7, rpe=9.5, fatigue=10))
    two = service.evaluate_overtraining(uid)
    assert next(s for s in two.signals if s.id == "workout_fatigue").severity == "watch"
    assert two.has_alert is False

    offline["workouts"].append(hard_workout(5, muscle="Chest", sets=7, rpe=9.5, fatigue=10))
    three = service.evaluate_overtraining(uid)
    assert next(s for s in three.signals if s.id == "workout_fatigue").severity == "high"
    assert three.has_alert is True
    assert three.deload_week_recommended is True


def test_four_week_sustained_nine_fatigue_block_suggests_planned_deload(offline):
    uid = uuid4()
    offline["workouts"] = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Back" if d == 3 else "Legs", sets=7, rpe=9.5, fatigue=9)
        for w in range(4)
        for d in (1, 3, 5)
    ]

    status = service.evaluate_overtraining(uid)
    assert status.consecutive_high_load_weeks == 4
    assert status.deload_week_recommended is True
    assert any(sig.id == "sustained_block" for sig in status.signals)


def test_steady_ten_out_of_ten_exhaustion_is_never_ok(offline):
    uid = uuid4()
    # Even at 2x/wk low volume where baseline delta is 0.0, steady 10/10 exhaustion must still flag.
    offline["workouts"] = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Legs", sets=7, rpe=9.5, fatigue=10)
        for w in range(3)
        for d in (1, 4)
    ]

    status = service.evaluate_overtraining(uid)
    fatigue_sig = next(sig for sig in status.signals if sig.id == "workout_fatigue")
    assert fatigue_sig.severity == "high"
    assert status.has_alert is True
    assert status.deload_week_recommended is True


def test_post_deload_cooldown_prevents_immediate_re_suggestion_and_rebound_spike(offline):
    uid = uuid4()
    # Weeks 1-3: lighter deload/transition (15 sets @ RPE 8 = 15 load), then week 0 resumes heavy training (84 load).
    chronic = [
        hard_workout(w * 7 + d, muscle="Chest" if d == 1 else "Legs", sets=15, rpe=8.0, fatigue=5)
        for w in range(1, 4)
        for d in (1,)
    ]
    acute = [
        hard_workout(d, muscle="Chest" if d in (0, 4) else "Back" if d == 2 else "Legs", sets=15, rpe=9.0, fatigue=6)
        for d in (0, 2, 4, 6)
    ]
    offline["workouts"] = acute + chronic

    service.apply_overtraining_mods(uid)
    # Expire the 7-day deload 3 days ago -> inside the 14-day post-deload cooldown.
    service._FALLBACK_STATES[str(uid)]["deload_expires_at"] = (
        datetime.now(timezone.utc) - timedelta(days=3)
    ).isoformat()

    during_cooldown = service.evaluate_overtraining(uid)
    assert during_cooldown.deload_active is False
    assert during_cooldown.acwr is None
    assert during_cooldown.deload_week_recommended is False

    # Once 14 days have passed after deload expiry, cooldown ends and normal ACWR + deload logic resumes.
    service._FALLBACK_STATES[str(uid)]["deload_expires_at"] = (
        datetime.now(timezone.utc) - timedelta(days=service.POST_DELOAD_COOLDOWN_DAYS + 1)
    ).isoformat()
    after_cooldown = service.evaluate_overtraining(uid)
    assert after_cooldown.acwr is not None and after_cooldown.acwr > 1.5
    assert after_cooldown.deload_week_recommended is True


def test_week_two_onboarding_ramp_up_does_not_false_trigger_acwr(offline):
    uid = uuid4()
    # Week 1: 1 light trial workout (10 sets @ RPE 8.5 = 12 load); Week 2: normal 3x/wk routine (30 sets = 36 load).
    offline["workouts"] = [
        hard_workout(1, muscle="Chest", sets=10, rpe=8.5, fatigue=6),
        hard_workout(3, muscle="Back", sets=10, rpe=8.5, fatigue=6),
        hard_workout(5, muscle="Legs", sets=10, rpe=8.5, fatigue=6),
        hard_workout(10, muscle="Chest", sets=10, rpe=8.5, fatigue=5),
    ]

    status = service.evaluate_overtraining(uid)
    assert status.acwr is None
    assert status.risk_level == "none"
    assert status.has_alert is False
