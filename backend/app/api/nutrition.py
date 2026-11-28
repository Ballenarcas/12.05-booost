import logging
from datetime import datetime

from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from app.core.auth import current_user
from app.core.local_day import LocalDay, local_day
from app.schemas.meal_scan import MealScanResult
from app.schemas.nutrition import (
    DailyNutritionResponse,
    FavoriteMeal,
    FavoriteMealCreate,
    FoodSearchItem,
    MealCreateRequest,
    MealItem,
    MealRecommendationsResponse,
    MealUpdateRequest,
)
from app.schemas.nutrition_statistics import NutritionStatisticsRange, NutritionStatisticsResponse
from app.facades.nutrition_facade import nutrition_facade
from app.services.image_service import ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, looks_like_image
from app.services.meal_recommendation_service import AlreadyHandled, RefreshLimitReached
from app.services.meal_scan_service import MealScanFailed, MealScanNoFood, MealScanUnavailable
from app.services.nutrition_service import (
    FavoriteAlreadyExists,
    FavoriteLimitReached,
    MealIngredientStorageUnavailable,
)

router = APIRouter(prefix="/nutrition", tags=["nutrition"])
logger = logging.getLogger(__name__)

@router.get("/search-foods", response_model=list[FoodSearchItem])
def search_food_items(
    q: str = Query("", max_length=60, description="Food name search query"),
    user_id: UUID = Depends(current_user),
) -> list[FoodSearchItem]:
    try:
        return nutrition_facade.search_foods(q)
    except Exception as err:
        logger.exception("Failed to search foods")
        raise HTTPException(status_code=500, detail="Could not search foods right now.") from err


@router.get("/today", response_model=DailyNutritionResponse)
def get_today_nutrition(
    user_id: UUID = Depends(current_user),
    today_start: datetime | None = Query(None, description="Local day start instant (inclusive ISO 8601)"),
    today_end: datetime | None = Query(None, description="Local day end instant (exclusive ISO 8601)"),
) -> DailyNutritionResponse:
    try:
        return nutrition_facade.get_today(str(user_id), today_start, today_end)
    except Exception as err:
        logger.exception("Failed to load today's nutrition")
        raise HTTPException(status_code=500, detail="Could not load today's nutrition.") from err


@router.get("/statistics", response_model=NutritionStatisticsResponse)
def get_nutrition_statistics(
    user_id: UUID = Depends(current_user),
    range_key: NutritionStatisticsRange = Query("1M", alias="range"),
    timezone_offset_minutes: int = Query(
        0,
        ge=-840,
        le=840,
        description="Client getTimezoneOffset() value used for local date buckets",
    ),
) -> NutritionStatisticsResponse:
    return nutrition_facade.get_statistics(user_id, range_key, timezone_offset_minutes)


@router.post("/scan", response_model=MealScanResult)
def scan_meal_photo(
    file: UploadFile = File(...),
    user_id: UUID = Depends(current_user),
) -> MealScanResult:
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="Use a JPEG, PNG, or WebP photo.")
    data = file.file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="That photo is too large. Use one under 8 MB.")
    if not data or not looks_like_image(data):
        raise HTTPException(status_code=415, detail="That file is not a supported photo.")

    try:
        return nutrition_facade.scan_meal(data, content_type)
    except MealScanNoFood as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    except MealScanUnavailable as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    except MealScanFailed as err:
        logger.exception("Meal scan failed")
        raise HTTPException(status_code=502, detail=str(err)) from err
    except Exception as err:
        logger.exception("Unexpected meal scan failure")
        raise HTTPException(status_code=502, detail="Could not analyze that photo. Try again.") from err


@router.post("/meals", response_model=MealItem)
def add_meal(
    payload: MealCreateRequest,
    user_id: UUID = Depends(current_user),
) -> MealItem:
    try:
        # The owner always comes from the signed session, never from the body.
        payload = payload.model_copy(update={"user_id": str(user_id)})
        return nutrition_facade.create_meal(payload)
    except MealIngredientStorageUnavailable as err:
        logger.exception("Meal ingredient storage is unavailable")
        raise HTTPException(status_code=503, detail="Meals can't be saved right now.") from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except Exception as err:
        logger.exception("Failed to save meal")
        raise HTTPException(status_code=500, detail="Could not save this meal.") from err


@router.put("/meals/{meal_id}", response_model=MealItem)
def update_meal(
    meal_id: UUID,
    payload: MealUpdateRequest,
    user_id: UUID = Depends(current_user),
) -> MealItem:
    try:
        return nutrition_facade.update_meal(str(user_id), str(meal_id), payload)
    except MealIngredientStorageUnavailable as err:
        logger.exception("Meal ingredient storage is unavailable")
        raise HTTPException(status_code=503, detail="Meals can't be saved right now.") from err
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Meal not found.") from err
    except Exception as err:
        logger.exception("Failed to update meal")
        raise HTTPException(status_code=500, detail="Could not update this meal.") from err


@router.delete("/meals/{meal_id}")
def remove_meal(
    meal_id: UUID,
    user_id: UUID = Depends(current_user),
) -> dict[str, str]:
    try:
        nutrition_facade.delete_meal(str(user_id), str(meal_id))
        return {"status": "success", "deleted_id": str(meal_id)}
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Meal not found.") from err
    except Exception as err:
        logger.exception("Failed to delete meal")
        raise HTTPException(status_code=500, detail="Could not remove this meal.") from err


@router.get("/favorites", response_model=list[FavoriteMeal])
def list_favorite_meals(user_id: UUID = Depends(current_user)) -> list[FavoriteMeal]:
    try:
        return nutrition_facade.list_favorites(str(user_id))
    except Exception as err:
        logger.exception("Failed to load favorite meals")
        raise HTTPException(status_code=500, detail="Could not load your favorite meals.") from err


@router.post("/favorites", response_model=FavoriteMeal)
def add_favorite_meal(payload: FavoriteMealCreate, user_id: UUID = Depends(current_user)) -> FavoriteMeal:
    try:
        return nutrition_facade.add_favorite(str(user_id), str(payload.meal_id))
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Meal not found.") from err
    except FavoriteLimitReached as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except Exception as err:
        logger.exception("Failed to save favorite meal")
        raise HTTPException(status_code=500, detail="Could not save this favorite.") from err


@router.put("/favorites/{favorite_id}", response_model=FavoriteMeal)
def update_favorite_meal(
    favorite_id: UUID,
    payload: MealUpdateRequest,
    user_id: UUID = Depends(current_user),
) -> FavoriteMeal:
    try:
        return nutrition_facade.update_favorite(str(user_id), str(favorite_id), payload)
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Favorite not found.") from err
    except FavoriteAlreadyExists as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except Exception as err:
        logger.exception("Failed to update favorite meal")
        raise HTTPException(status_code=500, detail="Could not update this favorite.") from err


@router.delete("/favorites/{favorite_id}")
def remove_favorite_meal(favorite_id: UUID, user_id: UUID = Depends(current_user)) -> dict[str, str]:
    try:
        nutrition_facade.delete_favorite(str(user_id), str(favorite_id))
        return {"status": "success", "deleted_id": str(favorite_id)}
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Favorite not found.") from err
    except Exception as err:
        logger.exception("Failed to delete favorite meal")
        raise HTTPException(status_code=500, detail="Could not remove this favorite.") from err


def _recommendation_error(err: Exception, action: str) -> HTTPException:
    if isinstance(err, PermissionError):
        return HTTPException(status_code=403, detail=str(err))
    if isinstance(err, RefreshLimitReached):
        return HTTPException(status_code=429, detail=str(err))
    if isinstance(err, AlreadyHandled):
        return HTTPException(status_code=409, detail=str(err))
    if isinstance(err, LookupError):
        return HTTPException(status_code=404, detail="Suggestion not found.")
    logger.exception("Failed to %s meal recommendations", action)
    return HTTPException(status_code=500, detail="Meal suggestions are not available right now.")


@router.get("/recommendations", response_model=MealRecommendationsResponse)
def get_meal_recommendations(
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> MealRecommendationsResponse:
    try:
        return nutrition_facade.get_recommendations(str(user_id), day)
    except Exception as err:
        raise _recommendation_error(err, "load") from err


@router.post("/recommendations/refresh", response_model=MealRecommendationsResponse)
def refresh_meal_recommendations(
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> MealRecommendationsResponse:
    try:
        return nutrition_facade.refresh_recommendations(str(user_id), day)
    except Exception as err:
        raise _recommendation_error(err, "refresh") from err


@router.post("/recommendations/{recommendation_id}/add", response_model=MealItem)
def add_meal_recommendation(
    recommendation_id: UUID,
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> MealItem:
    try:
        return nutrition_facade.add_recommendation(str(user_id), str(recommendation_id), day)
    except Exception as err:
        raise _recommendation_error(err, "add") from err


@router.post("/recommendations/{recommendation_id}/dismiss")
def dismiss_meal_recommendation(
    recommendation_id: UUID,
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> dict[str, str]:
    try:
        nutrition_facade.dismiss_recommendation(str(user_id), str(recommendation_id), day)
        return {"status": "dismissed"}
    except Exception as err:
        raise _recommendation_error(err, "dismiss") from err
