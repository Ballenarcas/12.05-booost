from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest

from app.schemas.nutrition import MealCreateRequest, MealIngredient, MealUpdateRequest
from app.services import nutrition_service

USER = str(uuid4())
OTHER_USER = str(uuid4())


class FakeTable:
    """Just enough of the Supabase query builder for favorites and meal creation."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.filters: list = []
        self.action = "select"
        self.values = None
        self.single = False

    def select(self, _columns: str) -> "FakeTable":
        if self.action == "select":
            self.action = "select"
        return self

    def insert(self, values):
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

    def order(self, *_args, **_kwargs) -> "FakeTable":
        return self

    def limit(self, _count: int) -> "FakeTable":
        return self

    def maybe_single(self) -> "FakeTable":
        self.single = True
        return self

    def execute(self) -> SimpleNamespace:
        matching = [row for row in self.rows if all(check(row) for check in self.filters)]
        if self.action == "insert":
            new_rows = self.values if isinstance(self.values, list) else [self.values]
            for values in new_rows:
                self.rows.append({"id": str(uuid4()), "created_at": "2026-11-15T10:00:00+00:00", **values})
            matching = self.rows[-len(new_rows):]
        elif self.action == "update":
            for row in matching:
                row.update(self.values)
        elif self.action == "delete":
            self.rows[:] = [row for row in self.rows if row not in matching]
        if self.single:
            return SimpleNamespace(data=matching[0] if matching else None)
        return SimpleNamespace(data=matching)


class FakeSupabase:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict]] = {"meals": [], "meal_ingredients": [], "favorite_meals": []}

    def table(self, name: str) -> FakeTable:
        return FakeTable(self.tables[name])


OATS = MealIngredient(name="Oats", quantity_g=80, calories_per_100g=389, proteins_per_100g=16.9, carbs_per_100g=66, fats_per_100g=6.9)
MILK = MealIngredient(name="Milk", quantity_g=200, calories_per_100g=61, proteins_per_100g=3.2, carbs_per_100g=4.8, fats_per_100g=3.3)


@pytest.fixture
def db():
    fake = FakeSupabase()
    with patch.object(nutrition_service, "get_supabase", return_value=fake):
        yield fake


def log_meal(user_id: str = USER, **extra) -> str:
    meal = nutrition_service.create_user_meal(MealCreateRequest(
        user_id=user_id, name="Oats + Milk", meal_type="Breakfast", ingredients=[OATS, MILK], **extra,
    ))
    return meal.id


def test_favorite_copies_the_meal_and_survives_its_deletion(db):
    meal_id = log_meal()
    favorite = nutrition_service.add_favorite_from_meal(USER, meal_id)

    assert favorite.name == "Oats + Milk"
    assert favorite.meal_type == "Breakfast"
    assert [item.name for item in favorite.ingredients] == ["Oats", "Milk"]
    assert favorite.calories == round(389 * 0.8 + 61 * 2)
    assert favorite.quantity_g == 280

    nutrition_service.delete_user_meal(USER, meal_id)
    assert [item.id for item in nutrition_service.list_favorite_meals(USER)] == [favorite.id]


def test_saving_the_same_meal_twice_keeps_one_favorite(db):
    meal_id = log_meal()
    first = nutrition_service.add_favorite_from_meal(USER, meal_id)
    second = nutrition_service.add_favorite_from_meal(USER, meal_id)
    assert first.id == second.id
    assert len(db.tables["favorite_meals"]) == 1


def test_another_users_meal_cannot_be_saved(db):
    meal_id = log_meal(OTHER_USER)
    with pytest.raises(LookupError):
        nutrition_service.add_favorite_from_meal(USER, meal_id)
    assert db.tables["favorite_meals"] == []


def test_favorite_limit(db):
    db.tables["favorite_meals"].extend(
        {"id": str(uuid4()), "user_id": USER, "name": f"Meal {index}", "meal_type": "Meal"}
        for index in range(nutrition_service.MAX_FAVORITE_MEALS)
    )
    with pytest.raises(nutrition_service.FavoriteLimitReached):
        nutrition_service.add_favorite_from_meal(USER, log_meal())


def test_edit_recomputes_totals_and_refuses_a_duplicate_name(db):
    favorite = nutrition_service.add_favorite_from_meal(USER, log_meal())
    edited = nutrition_service.update_favorite_meal(
        USER, favorite.id, MealUpdateRequest(name="Oats", meal_type="Snack", ingredients=[OATS]),
    )
    assert (edited.name, edited.meal_type, edited.calories) == ("Oats", "Snack", round(389 * 0.8))

    other = nutrition_service.add_favorite_from_meal(USER, log_meal())
    with pytest.raises(nutrition_service.FavoriteAlreadyExists):
        nutrition_service.update_favorite_meal(
            USER, other.id, MealUpdateRequest(name="Oats", meal_type="Snack", ingredients=[OATS]),
        )


def test_only_the_owner_can_edit_or_delete(db):
    favorite = nutrition_service.add_favorite_from_meal(USER, log_meal())
    with pytest.raises(LookupError):
        nutrition_service.update_favorite_meal(
            OTHER_USER, favorite.id, MealUpdateRequest(name="Oats", meal_type="Snack", ingredients=[OATS]),
        )
    with pytest.raises(LookupError):
        nutrition_service.delete_favorite_meal(OTHER_USER, favorite.id)
    nutrition_service.delete_favorite_meal(USER, favorite.id)
    assert db.tables["favorite_meals"] == []


def test_meal_can_be_logged_on_a_past_day(db):
    eaten = datetime.now(timezone.utc) - timedelta(days=3)
    log_meal(consumed_at=eaten)
    assert db.tables["meals"][0]["consumed_at"] == eaten.isoformat()


def test_consumed_at_rules():
    now = datetime(2026, 11, 15, 12, tzinfo=timezone.utc)
    assert nutrition_service.resolve_consumed_at(None, now) == now
    assert nutrition_service.resolve_consumed_at(now + timedelta(minutes=2), now) == now + timedelta(minutes=2)
    with pytest.raises(ValueError):
        nutrition_service.resolve_consumed_at(now + timedelta(hours=1), now)
    with pytest.raises(ValueError):
        nutrition_service.resolve_consumed_at(now - timedelta(days=400), now)
