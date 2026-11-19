from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest

from app.core.local_day import LocalDay
from app.schemas.nutrition import DailyNutritionResponse, FavoriteMeal, MealIngredient, MealItem
from app.services import meal_recommendation_service as service

START = datetime(2026, 11, 17, tzinfo=timezone.utc)
DAY = LocalDay(date(2026, 11, 17), START, START + timedelta(days=1))


def food(name: str, kcal: float, protein: float, carbs: float, fat: float, grams: float = 100) -> dict:
    return {"name": name, "quantity_g": grams, "calories_per_100g": kcal,
            "proteins_per_100g": protein, "carbs_per_100g": carbs, "fats_per_100g": fat}


OPTIONS = [
    {"id": str(uuid4()), "name": "Chicken and rice", "meal_type": "Lunch", "active": True,
     "ingredients": [food("Chicken", 165, 31, 0, 3.6, 150), food("Rice", 130, 2.7, 28, 0.3, 180)]},
    {"id": str(uuid4()), "name": "Greek yogurt", "meal_type": "Snack", "active": True,
     "ingredients": [food("Yogurt", 59, 10, 3.6, 0.4, 200)]},
    {"id": str(uuid4()), "name": "Salmon and potato", "meal_type": "Dinner", "active": True,
     "ingredients": [food("Salmon", 208, 20, 0, 13, 140), food("Potato", 77, 2, 17, 0.1, 250)]},
    {"id": str(uuid4()), "name": "Protein shake", "meal_type": "Snack", "active": True,
     "ingredients": [food("Whey", 375, 75, 6, 4.5, 30), food("Milk", 61, 3.2, 4.8, 3.3, 250)]},
    {"id": str(uuid4()), "name": "Huge pasta", "meal_type": "Dinner", "active": True,
     "ingredients": [food("Pasta", 131, 5, 25, 1.1, 1500)]},
]


class FakeTable:
    def __init__(self, rows: list[dict]) -> None:
        self.rows, self.filters, self.action, self.values = rows, [], "select", None

    def select(self, *_):
        return self

    def insert(self, values):
        self.action, self.values = "insert", values
        return self

    def update(self, values):
        self.action, self.values = "update", values
        return self

    def eq(self, column, value):
        self.filters.append(lambda row: str(row.get(column)) == str(value))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_):
        return self

    def execute(self):
        matching = [row for row in self.rows if all(check(row) for check in self.filters)]
        if self.action == "insert":
            matching = [{"id": str(uuid4()), **values} for values in self.values]
            self.rows.extend(matching)
        elif self.action == "update":
            for row in matching:
                row.update(self.values)
        return SimpleNamespace(data=matching)


class FakeSupabase:
    def __init__(self) -> None:
        self.tables = {"meal_options": [dict(row) for row in OPTIONS], "meal_recommendations": [],
                       "users": [], "meals": []}

    def table(self, name):
        return FakeTable(self.tables[name])


def today(remaining_kcal=1200, meals=()):
    return DailyNutritionResponse(
        consumed_calories=0, daily_goal=2400, calories_progress_percentage=0, remaining_calories=remaining_kcal,
        remaining_proteins_g=90, remaining_carbs_g=120, remaining_fats_g=40,
        carbs_g=0, proteins_g=0, fats_g=0, meals=list(meals),
    )


@pytest.fixture
def env():
    db = FakeSupabase()
    state = SimpleNamespace(db=db, premium=True, today=today(), favorites=[], answer=None, model_calls=0, logged=[])

    def model(candidates, remaining, objective):
        state.model_calls += 1
        state.offered = [meal["key"] for meal in candidates]
        if isinstance(state.answer, Exception):
            raise state.answer
        return state.answer(candidates) if callable(state.answer) else state.answer

    def create_meal(payload):
        state.logged.append(payload)
        return MealItem(id=str(uuid4()), user_id=payload.user_id, meal_name=payload.name, item_calories=500)

    with patch.object(service, "get_supabase", return_value=db), \
         patch.object(service, "has_active_premium", side_effect=lambda *_: state.premium), \
         patch.object(service, "get_settings", return_value=SimpleNamespace(ai_api_key="key", ai_model="m")), \
         patch.object(service, "ask_model", side_effect=model), \
         patch.object(service.nutrition_service, "get_user_nutrition_today", side_effect=lambda *_: state.today), \
         patch.object(service.nutrition_service, "list_favorite_meals", side_effect=lambda _: state.favorites), \
         patch.object(service.nutrition_service, "create_user_meal", side_effect=create_meal):
        yield state


def user() -> str:
    return str(uuid4())  # a new user per test keeps the in-process AI limit apart


def test_model_picks_only_from_the_pool_and_numbers_come_from_data(env):
    def answer(candidates):
        real = candidates[0]["key"]
        return {"picks": [
            {"id": "made-up-id", "reason": "Invented"},
            {"id": real, "reason": "Great protein for your evening."},
            {"id": real, "reason": "Repeat"},
            {"id": candidates[1]["key"], "reason": "Has 900 kcal of goodness"},
            {"id": candidates[2]["key"], "reason": "Light and easy."},
        ]}
    env.answer = answer
    result = service.get_recommendations(user(), DAY)

    assert [item.source for item in result.items] == ["ai"] * 3
    assert len({item.name for item in result.items}) == 3
    reasons = [item.reason for item in result.items]
    assert reasons[0] == "Great protein for your evening."
    assert reasons[1] == service._rules_reason({"origin": "option"})  # the reason with a number was dropped
    assert "Huge pasta" not in [item.name for item in result.items]  # over the remaining calories
    chicken = next(item for item in result.items if item.name == "Chicken and rice")
    assert chicken.calories == round(165 * 1.5 + 130 * 1.8)


def test_rules_are_used_when_the_model_fails_or_answers_badly(env):
    env.answer = RuntimeError("timeout")
    assert {item.source for item in service.get_recommendations(user(), DAY).items} == {"rules"}

    env.answer = {"picks": [{"id": "nope"}]}
    assert {item.source for item in service.get_recommendations(user(), DAY).items} == {"rules"}


def test_suggestions_are_saved_and_not_regenerated(env):
    env.answer = RuntimeError("off")
    uid = user()
    first = service.get_recommendations(uid, DAY)
    calls = env.model_calls
    second = service.get_recommendations(uid, DAY)
    assert [item.id for item in first.items] == [item.id for item in second.items]
    assert env.model_calls == calls


def test_favorites_are_in_the_pool(env):
    env.favorites = [FavoriteMeal(id=str(uuid4()), name="My oats", meal_type="Breakfast", calories=450,
                                  proteins_g=30, carbs_g=55, fats_g=10, quantity_g=300,
                                  ingredients=[MealIngredient(**food("Oats", 150, 10, 18, 3.3, 300))])]
    env.answer = lambda candidates: {"picks": [{"id": key, "reason": "Fits."} for key in [
        next(meal["key"] for meal in candidates if meal["origin"] == "favorite"),
        *[meal["key"] for meal in candidates if meal["origin"] == "option"][:2],
    ]]}
    names = [item.name for item in service.get_recommendations(user(), DAY).items]
    assert "My oats" in names


def test_goal_reached_means_no_suggestions_and_no_model_call(env):
    env.today = today(remaining_kcal=100)
    result = service.get_recommendations(user(), DAY)
    assert result.goal_reached and result.items == [] and env.model_calls == 0


def test_premium_is_required_everywhere(env):
    env.premium = False
    uid = user()
    for call in (
        lambda: service.get_recommendations(uid, DAY),
        lambda: service.refresh_recommendations(uid, DAY),
        lambda: service.add_recommendation(uid, str(uuid4()), DAY),
        lambda: service.dismiss_recommendation(uid, str(uuid4()), DAY),
    ):
        with pytest.raises(PermissionError):
            call()
    assert env.db.tables["meal_recommendations"] == []


def test_adding_logs_the_meal_once(env):
    env.answer = RuntimeError("off")
    uid = user()
    item = service.get_recommendations(uid, DAY).items[0]
    service.add_recommendation(uid, item.id, DAY)
    with pytest.raises(service.AlreadyHandled):
        service.add_recommendation(uid, item.id, DAY)
    assert len(env.logged) == 1
    assert env.logged[0].name == item.name and len(env.logged[0].ingredients) == len(item.ingredients)
    assert item.id not in [i.id for i in service.get_recommendations(uid, DAY).items]


def test_another_users_suggestion_cannot_be_added(env):
    env.answer = RuntimeError("off")
    item = service.get_recommendations(user(), DAY).items[0]
    with pytest.raises(LookupError):
        service.add_recommendation(user(), item.id, DAY)
    assert env.logged == []


def test_refresh_replaces_the_set_and_stops_after_the_daily_limit(env):
    env.answer = RuntimeError("off")
    uid = user()
    first = {item.name for item in service.get_recommendations(uid, DAY).items}
    refreshed = service.refresh_recommendations(uid, DAY)
    assert not first & {item.name for item in refreshed.items}  # shown meals don't come straight back
    for _ in range(service.MAX_REFRESHES_PER_DAY - 1):
        refreshed = service.refresh_recommendations(uid, DAY)
    assert refreshed.refreshes_left == 0
    with pytest.raises(service.RefreshLimitReached):
        service.refresh_recommendations(uid, DAY)
