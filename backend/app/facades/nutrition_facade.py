from datetime import datetime, timedelta, timezone

from app.schemas.meal_scan import MealScanResult
from app.schemas.nutrition import (
    DailyNutritionResponse,
    FavoriteMeal,
    FoodSearchItem,
    MealCreateRequest,
    MealItem,
    MealRecommendationsResponse,
    MealUpdateRequest,
)
from app.core.local_day import LocalDay
from app.services import meal_recommendation_service, meal_scan_service, nutrition_service


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

    def scan_meal(self, image: bytes, content_type: str) -> MealScanResult:
        return meal_scan_service.estimate_meal_from_image(image, content_type)

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

    def get_recommendations(self, user_id: str, day: LocalDay) -> MealRecommendationsResponse:
        return meal_recommendation_service.get_recommendations(user_id, day)

    def refresh_recommendations(self, user_id: str, day: LocalDay) -> MealRecommendationsResponse:
        return meal_recommendation_service.refresh_recommendations(user_id, day)

    def add_recommendation(self, user_id: str, recommendation_id: str, day: LocalDay) -> MealItem:
        return meal_recommendation_service.add_recommendation(user_id, recommendation_id, day)

    def dismiss_recommendation(self, user_id: str, recommendation_id: str, day: LocalDay) -> None:
        meal_recommendation_service.dismiss_recommendation(user_id, recommendation_id, day)


nutrition_facade = NutritionFacade()
