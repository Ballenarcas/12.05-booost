from uuid import uuid4

from fastapi.testclient import TestClient

from app.schemas.weekly_routine import WeeklyRoutineGenerateRequest
from app.services import weekly_routine_service as service
from app.services import workout_service
from main import app
from tests.auth_helpers import auth_headers

client = TestClient(app)


def test_ai_weekly_endpoints_require_premium(monkeypatch):
    uid = str(uuid4())
    headers = auth_headers(uid)
    monkeypatch.setattr("app.facades.workout_facade.has_premium_flag", lambda _uid: False)

    payload = {
        "days": ["mon", "wed", "fri"],
        "duration_minutes": 60,
        "equipment": ["dumbbell", "bodyweight"],
    }
    assert client.post("/api/v1/routines/ai-weekly/generate", json=payload, headers=headers).status_code == 403

    draft = service.generate_weekly_routine(WeeklyRoutineGenerateRequest(**payload), lang="en")
    modify_payload = {
        "preferences": payload,
        "current_draft": draft.model_dump(mode="json"),
        "feedback": "Swap push ups for dumbbell press",
        "feedback_history": [],
    }
    assert client.post("/api/v1/routines/ai-weekly/modify", json=modify_payload, headers=headers).status_code == 403
    assert client.post(
        "/api/v1/routines/ai-weekly/accept",
        json={"days": [d.model_dump(mode="json") for d in draft.days]},
        headers=headers,
    ).status_code == 403


def test_equipment_filter_restricts_exercises_strictly():
    filtered = service.filter_exercises_by_equipment(["dumbbell"])
    assert filtered
    for item in filtered:
        assert "dumbbell" in [eq.lower() for eq in item["equipment"]]

    bands_only = service.filter_exercises_by_equipment(["bands"])
    assert bands_only
    for item in bands_only:
        assert any("band" in eq.lower() for eq in item["equipment"])


def test_duration_and_objective_shape_routine_sizing(monkeypatch):
    monkeypatch.setattr(service, "_request_weekly_json", lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("offline")))

    short_strength = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "thu"],
            duration_minutes=30,
            equipment=["full_gym"],
            objective="Strength",
        ),
        lang="en",
    )
    long_hypertrophy = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "wed", "fri"],
            duration_minutes=90,
            equipment=["full_gym"],
            objective="Muscle gain",
        ),
        lang="en",
    )

    assert len(short_strength.days) == 2
    assert len(short_strength.days[0].exercises) == 4
    assert all(ex.target_reps <= 8 for ex in short_strength.days[0].exercises)

    assert len(long_hypertrophy.days) == 3
    assert len(long_hypertrophy.days[0].exercises) == 7


def test_natural_language_modify_swaps_exercise_and_drops_disallowed_ids(monkeypatch):
    uid = str(uuid4())
    headers = auth_headers(uid)
    monkeypatch.setattr("app.facades.workout_facade.has_premium_flag", lambda _uid: True)
    monkeypatch.setattr("app.facades.workout_facade.workout_facade._read_user_objective", lambda _uid: "Muscle gain")

    # Initial fallback draft with full_gym equipment
    monkeypatch.setattr(service, "_request_weekly_json", lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("offline")))
    prefs = {
        "days": ["mon", "wed", "fri"],
        "duration_minutes": 60,
        "equipment": ["machine", "dumbbell"],
        "objective": "Muscle gain",
    }
    gen_res = client.post("/api/v1/routines/ai-weekly/generate", json=prefs, headers=headers)
    assert gen_res.status_code == 200
    draft = gen_res.json()
    assert len(draft["days"]) == 3

    # Pick a valid machine chest exercise from the machine+dumbbell pool to simulate AI swap + reject unknown UUID.
    machine_pool = service.filter_exercises_by_equipment(["machine", "dumbbell"])
    chest_machine = next(
        item for item in machine_pool
        if item["muscle_group"].lower() == "chest" and any("machine" in e.lower() for e in item["equipment"])
    )

    def fake_modify_ai(_system, _payload, schema=service._WEEKLY_PLAN_SCHEMA):  # noqa: ARG001
        return {
            "plan_title": draft["plan_title"],
            "split_name": draft["split_name"],
            "summary": draft["summary"],
            "change_summary": f"Swapped chest press to {chest_machine['name']}.",
            "days": [
                {
                    "day": draft["days"][0]["day"],
                    "routine_name": draft["days"][0]["routine_name"],
                    "focus": draft["days"][0]["focus"],
                    "exercises": [
                        {"exercise_id": chest_machine["exercise_id"], "target_sets": 4, "target_reps": 10},
                        {"exercise_id": "not-in-catalog-or-disallowed", "target_sets": 3, "target_reps": 10},
                        *[
                            {
                                "exercise_id": ex["exercise_id"],
                                "target_sets": ex["target_sets"],
                                "target_reps": ex["target_reps"],
                            }
                            for ex in draft["days"][0]["exercises"][1:4]
                        ],
                    ],
                },
                *[
                    {
                        "day": d["day"],
                        "routine_name": d["routine_name"],
                        "focus": d["focus"],
                        "exercises": [
                            {
                                "exercise_id": ex["exercise_id"],
                                "target_sets": ex["target_sets"],
                                "target_reps": ex["target_reps"],
                            }
                            for ex in d["exercises"]
                        ],
                    }
                    for d in draft["days"][1:]
                ],
            ],
        }

    monkeypatch.setattr(service, "_request_weekly_json", fake_modify_ai)
    mod_res = client.post(
        "/api/v1/routines/ai-weekly/modify",
        json={
            "preferences": prefs,
            "current_draft": draft,
            "feedback": "I don't like barbell bench press, switch to machine press",
            "feedback_history": [],
        },
        headers=headers,
    )
    assert mod_res.status_code == 200
    modified = mod_res.json()
    assert chest_machine["name"] in modified["change_summary"]
    day0_ids = [ex["exercise_id"] for ex in modified["days"][0]["exercises"]]
    assert chest_machine["exercise_id"] in day0_ids
    assert "not-in-catalog-or-disallowed" not in day0_ids


def test_accept_endpoint_saves_each_day_as_a_routine(monkeypatch):
    uid = str(uuid4())
    headers = auth_headers(uid)
    monkeypatch.setattr("app.facades.workout_facade.has_premium_flag", lambda _uid: True)
    monkeypatch.setattr(service, "_request_weekly_json", lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("offline")))

    created = []

    def fake_create_routine(_user_id, routine_payload):
        rid = str(uuid4())
        entry = {
            "id": rid,
            "name": routine_payload.name,
            "exercises": [
                {
                    "exercise_id": ex.exercise_id,
                    "name": f"Ex {idx}",
                    "target_sets": ex.target_sets,
                    "target_reps": ex.target_reps,
                    "reps_by_set": ex.reps_by_set,
                }
                for idx, ex in enumerate(routine_payload.exercises)
            ],
            "estimated_duration_minutes": 50,
        }
        created.append(entry)
        return entry

    monkeypatch.setattr(workout_service, "create_user_routine", fake_create_routine)

    draft = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(days=["mon", "wed", "fri"], duration_minutes=60, equipment=["full_gym"]),
        lang="en",
    )
    res = client.post(
        "/api/v1/routines/ai-weekly/accept",
        json={"days": [d.model_dump(mode="json") for d in draft.days]},
        headers=headers,
    )
    assert res.status_code == 200
    assert len(res.json()["routines"]) == 3
    assert len(created) == 3
    assert [r["name"] for r in created] == [d.routine_name for d in draft.days]


def test_experience_level_and_special_philosophies_shape_volume_and_split(monkeypatch):
    monkeypatch.setattr(service, "_request_weekly_json", lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("offline")))

    heavy_duty = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "wed", "fri"],
            duration_minutes=60,
            equipment=["machine", "dumbbell"],
            experience_level="advanced",
            training_philosophy="heavy_duty",
        ),
        lang="en",
    )
    assert heavy_duty.training_philosophy == "heavy_duty"
    assert all(1 <= ex.target_sets <= 2 for day in heavy_duty.days for ex in day.exercises)

    powerbuilding = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "tue", "thu", "fri"],
            duration_minutes=60,
            equipment=["full_gym"],
            experience_level="intermediate",
            training_philosophy="powerbuilding",
        ),
        lang="en",
    )
    assert powerbuilding.days[0].exercises[0].target_reps <= 5
    assert powerbuilding.days[0].exercises[-1].target_reps >= 8

    minimalist = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "thu"],
            duration_minutes=60,
            equipment=["full_gym"],
            training_philosophy="minimalist",
        ),
        lang="en",
    )
    assert all(len(day.exercises) <= 4 for day in minimalist.days)

    beginner = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "wed", "fri"],
            duration_minutes=75,
            equipment=["full_gym"],
            experience_level="beginner",
        ),
        lang="en",
    )
    assert beginner.experience_level == "beginner"
    assert "Full Body" in beginner.split_name
    assert all(len(day.exercises) <= 5 for day in beginner.days)
    assert all(ex.target_sets <= 3 for day in beginner.days for ex in day.exercises)

    high_volume = service.generate_weekly_routine(
        WeeklyRoutineGenerateRequest(
            days=["mon", "wed", "fri"],
            duration_minutes=60,
            equipment=["full_gym"],
            experience_level="intermediate",
            training_philosophy="high_volume",
        ),
        lang="en",
    )
    assert all(ex.target_sets >= 3 for day in high_volume.days for ex in day.exercises)
