from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.auth import issue_access_token
from app.schemas.workout import CustomExerciseCreate
from app.services import workout_service
from main import app

OWNER = uuid4()
OTHER = uuid4()


class FakeTable:
    """Just enough of the Supabase query builder for custom exercises."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.filters: list = []
        self.action, self.values = "select", None

    def select(self, _columns: str) -> "FakeTable":
        return self

    def insert(self, values: dict) -> "FakeTable":
        self.action, self.values = "insert", values
        return self

    def update(self, values: dict) -> "FakeTable":
        self.action, self.values = "update", values
        return self

    def delete(self) -> "FakeTable":
        self.action = "delete"
        return self

    def eq(self, column: str, value) -> "FakeTable":
        self.filters.append(lambda row: str(row.get(column)) == str(value))
        return self

    def is_(self, column: str, _null: str) -> "FakeTable":
        self.filters.append(lambda row: row.get(column) is None)
        return self

    def order(self, *_args, **_kwargs) -> "FakeTable":
        return self

    def limit(self, _count: int) -> "FakeTable":
        return self

    def execute(self) -> SimpleNamespace:
        matching = [row for row in self.rows if all(check(row) for check in self.filters)]
        if self.action == "insert":
            self.rows.append(dict(self.values))
        elif self.action == "update":
            for row in matching:
                row.update(self.values)
        elif self.action == "delete":
            self.rows[:] = [row for row in self.rows if row not in matching]
        return SimpleNamespace(data=matching)


class FakeSupabase:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict]] = {"exercises": [], "workout_sets": [], "routine_exercises": []}

    def table(self, name: str) -> FakeTable:
        return FakeTable(self.tables[name])


@pytest.fixture
def db():
    fake = FakeSupabase()
    with patch.object(workout_service, "get_supabase", return_value=fake), \
         patch.object(workout_service, "has_active_premium", return_value=True):
        yield fake


def create(user=OWNER, name="Cable Crunch") -> str:
    return workout_service.create_custom_exercise(user, CustomExerciseCreate(name=name, muscle_group="Abs")).id


def custom_names(user) -> list[str]:
    items, _ = workout_service.list_exercises(user_id=user, limit=10000)
    return [item.name for item in items if item.is_custom]


def test_custom_exercises_are_private(db):
    exercise_id = create()
    assert db.tables["exercises"][0]["owner_id"] == str(OWNER)
    assert custom_names(OWNER) == ["Cable Crunch"]
    assert custom_names(OTHER) == []
    assert custom_names(None) == []
    assert workout_service.get_exercise_by_id(exercise_id, OWNER).name == "Cable Crunch"
    assert workout_service.get_exercise_by_id(exercise_id, OTHER) is None
    assert workout_service.get_exercise_by_id(exercise_id, None) is None


def test_another_users_custom_exercise_cannot_be_logged_or_changed(db):
    exercise_id = create()
    assert workout_service._resolve_exercise_id_for_user(exercise_id, OWNER) == exercise_id
    with pytest.raises(ValueError):
        workout_service._resolve_exercise_id_for_user(exercise_id, OTHER)
    for action in (
        lambda: workout_service.update_custom_exercise(OTHER, exercise_id, CustomExerciseCreate(name="Mine now", muscle_group="Abs")),
        lambda: workout_service.delete_custom_exercise(OTHER, exercise_id),
    ):
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 404
    assert db.tables["exercises"][0]["name"] == "Cable Crunch"


def test_creating_needs_premium(db):
    with patch.object(workout_service, "has_active_premium", return_value=False):
        with pytest.raises(HTTPException) as error:
            create()
    assert error.value.status_code == 403
    assert db.tables["exercises"] == []


def test_duplicate_names_are_refused(db):
    create()
    with pytest.raises(HTTPException) as error:
        create(name="cable crunch")
    assert error.value.status_code == 409
    create(user=OTHER)  # another user may use the same name


def test_unused_exercise_is_deleted_and_used_one_is_archived(db):
    unused = create(name="Unused")
    used = create(name="Used")
    db.tables["workout_sets"].append({"exercise_id": used})

    workout_service.delete_custom_exercise(OWNER, unused)
    workout_service.delete_custom_exercise(OWNER, used)

    assert [row["id"] for row in db.tables["exercises"]] == [used]
    assert db.tables["exercises"][0]["archived_at"]
    assert custom_names(OWNER) == []
    with pytest.raises(ValueError):
        workout_service._resolve_exercise_id_for_user(used, OWNER)


def test_list_route_uses_the_signed_in_user_not_the_query(db):
    create()
    client = TestClient(app)
    other_token, _ = issue_access_token(str(OTHER))
    owner_token, _ = issue_access_token(str(OWNER))

    def names(headers: dict, query: str = "") -> list[str]:
        body = client.get(f"/api/v1/workouts/exercises?q=cable crunch&limit=100{query}", headers=headers).json()
        return [item["name"] for item in body["items"] if item["is_custom"]]

    assert names({}, f"&user_id={OWNER}") == []
    assert names({"Authorization": f"Bearer {other_token}"}, f"&user_id={OWNER}") == []
    assert names({"Authorization": f"Bearer {owner_token}"}) == ["Cable Crunch"]
