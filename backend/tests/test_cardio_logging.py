from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.workout_log import ExerciseLogItem, SetLogItem
from app.services import workout_service

CARDIO_ID = str(uuid4())
STRENGTH_ID = str(uuid4())


@pytest.fixture(autouse=True)
def known_exercises(monkeypatch):
    monkeypatch.setattr(workout_service, "_resolve_exercise_id_for_user", lambda exercise_id, *_a, **_k: exercise_id)
    monkeypatch.setattr(workout_service, "get_cached_exercise", lambda _id: None)


def _records(*exercises):
    return workout_service._build_workout_set_records(list(exercises), uuid4())


def test_cardio_is_stored_in_its_own_columns_and_never_as_reps_or_weight():
    [row] = _records(ExerciseLogItem(exercise_id=CARDIO_ID, is_cardio=True, sets=[
        SetLogItem(set_number=1, duration_seconds=1800, distance_km=5.2, is_completed=True),
    ]))
    assert (row["reps"], row["weight"]) == (0, 0.0)
    assert (row["duration_seconds"], row["distance_km"], row["is_done"]) == (1800, 5.2, True)


def test_a_cardio_block_with_a_time_but_not_finished_is_not_done():
    [row] = _records(ExerciseLogItem(exercise_id=CARDIO_ID, is_cardio=True, sets=[
        SetLogItem(set_number=1, duration_seconds=1200, is_completed=False),
    ]))
    assert row["is_done"] is False


def test_strength_sets_are_saved_unchanged():
    [row] = _records(ExerciseLogItem(exercise_id=STRENGTH_ID, sets=[
        SetLogItem(set_number=1, weight_kg=80, reps=8, rpe=8, is_completed=True),
    ]))
    assert (row["weight"], row["reps"], row["rpe"], row["is_done"]) == (80, 8, 8, True)
    assert "duration_seconds" not in row


def test_strength_reps_keep_their_upper_limit():
    with pytest.raises(ValidationError):
        SetLogItem(set_number=1, weight_kg=20, reps=1001)


class _Query:
    def __init__(self, rows):
        self.rows = rows
        self.not_ = self

    def __getattr__(self, _name):
        return lambda *_a, **_k: self

    def execute(self):
        return SimpleNamespace(data=self.rows)


def test_history_reads_old_cardio_rows_that_kept_time_in_reps(monkeypatch):
    workout = {
        "id": str(uuid4()), "routine_id": None, "name": "Run", "fatigue_level": None, "routines": None,
        "start_time": "2026-11-01T10:00:00+00:00", "end_time": "2026-11-01T10:30:00+00:00",
        "workout_sets": [{
            "exercise_id": CARDIO_ID, "exercise_order": 0, "set_number": 1, "reps": 1500, "weight": 4.0,
            "rpe": None, "is_done": True, "duration_seconds": None, "distance_km": None,
            "exercises": {"name": "Treadmill", "muscle_group": "Cardio"},
        }],
    }
    monkeypatch.setattr(workout_service, "get_supabase", lambda admin=False: SimpleNamespace(table=lambda _t: _Query([workout])))
    [entry] = workout_service.list_workout_history(uuid4()).items
    [exercise] = entry.exercises
    [set_row] = exercise.sets
    assert exercise.is_cardio
    assert (set_row.duration_seconds, set_row.distance_km, set_row.reps, set_row.weight_kg) == (1500, 4.0, 0, 0.0)
