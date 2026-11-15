from datetime import datetime, timedelta, timezone

from app.schemas.nutrition import (
    DailyNutritionResponse,
    FavoriteMeal,
    FoodSearchItem,
    MealCreateRequest,
    MealItem,
    MealUpdateRequest,
)
from app.services import nutrition_service


def _resolve_window(today_start: datetime | None, today_end: datetime | None) -> tuple[datetime, datetime]:
    start = today_start or datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = today_end or (start + timedelta(days=1))
    return start, end


class NutritionFacade:
    def search_foods(self, query: str) -> list[FoodSearchItem]:
        return nutrition_service.search_foods(query)

    def get_today(
        self,
        user_id: str,
        today_start: datetime | None = None,
        today_end: datetime | None = None,
    ) -> DailyNutritionResponse:
        start, end = _resolve_window(today_start, today_end)
        return nutrition_service.get_user_nutrition_today(user_id, start, end)

    def create_meal(self, payload: MealCreateRequest) -> MealItem:
        return nutrition_service.create_user_meal(payload)

    def update_meal(self, user_id: str, meal_id: str, payload: MealUpdateRequest) -> MealItem:
        return nutrition_service.update_user_meal(user_id, meal_id, payload)

    def delete_meal(self, user_id: str, meal_id: str) -> bool:
        return nutrition_service.delete_user_meal(user_id, meal_id)

    def list_favorites(self, user_id: str) -> list[FavoriteMeal]:
        return nutrition_service.list_favorite_meals(user_id)

    def add_favorite(self, user_id: str, meal_id: str) -> FavoriteMeal:
        return nutrition_service.add_favorite_from_meal(user_id, meal_id)

    def update_favorite(self, user_id: str, favorite_id: str, payload: MealUpdateRequest) -> FavoriteMeal:
        return nutrition_service.update_favorite_meal(user_id, favorite_id, payload)

    def delete_favorite(self, user_id: str, favorite_id: str) -> None:
        nutrition_service.delete_favorite_meal(user_id, favorite_id)


nutrition_facade = NutritionFacade()
