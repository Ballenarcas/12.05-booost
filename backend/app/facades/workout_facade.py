import asyncio
import logging
from uuid import UUID

from fastapi import HTTPException

from app.core.ai_quota import use_ai_call
from app.core.local_day import LocalDay
from app.db.supabase_client import get_supabase
from app.schemas.exercise import Exercise
from app.schemas.overtraining import OvertrainingStatusResponse
from app.schemas.weekly_routine import (
    WeeklyRoutineAcceptRequest,
    WeeklyRoutineAcceptResponse,
    WeeklyRoutineDraft,
    WeeklyRoutineGenerateRequest,
    WeeklyRoutineModifyRequest,
)
from app.schemas.workout import (
    CustomExerciseCreate,
    LiveWorkoutAdjustmentRequest,
    LiveWorkoutAdjustmentSuggestion,
    RoutineCreate,
    RoutineSummary,
    WarmupRecommendationRequest,
    WarmupRecommendationResponse,
)
from app.schemas.workout_log import WorkoutHistoryResponse, WorkoutLogCreate, WorkoutLogResponse, WorkoutLogUpdate
from app.schemas.workout_statistics import WorkoutStatisticsRange, WorkoutStatisticsResponse
from app.services import overtraining_service, weekly_routine_service, workout_service, workout_statistics_service
from app.services.exercise_guide_service import guide_for
from app.services.premium_service import has_premium_flag
from app.services.warmup_service import build_warmup_recommendation
from app.services.workout_adjustment_service import plan_daily_workout, suggest_live_adjustment

logger = logging.getLogger(__name__)


class WorkoutFacade:
    async def plan_today(self, user_id: UUID, day: LocalDay | None = None):
        supabase = get_supabase(admin=True)
        if supabase is None:
            raise HTTPException(status_code=503, detail="Supabase is not configured")
        # Planning makes many blocking Supabase calls. Running it on a worker thread (with its own
        # event loop for the AI call) keeps the server answering every other request meanwhile.
        return await asyncio.to_thread(asyncio.run, plan_daily_workout(user_id, supabase, day))

    async def suggest_adjustment(self, payload: LiveWorkoutAdjustmentRequest) -> list[LiveWorkoutAdjustmentSuggestion]:
        return await suggest_live_adjustment(payload.model_dump(mode="json"))

    def _require_premium(self, user_id: UUID, detail: str) -> None:
        try:
            is_premium = has_premium_flag(str(user_id))
        except Exception as error:
            logger.exception("Could not check the premium flag")
            raise HTTPException(status_code=503, detail="Could not check your Premium status. Please try again.") from error
        if not is_premium:
            raise HTTPException(status_code=403, detail=detail)

    def recommend_warmup(
        self,
        user_id: UUID,
        payload: WarmupRecommendationRequest,
    ) -> WarmupRecommendationResponse:
        self._require_premium(
            user_id,
            "Warm-up recommendations are a Premium feature. Upgrade to Premium to unlock them.",
        )
        use_ai_call(user_id)
        return build_warmup_recommendation(payload)

    def _read_user_objective(self, user_id: UUID) -> str | None:
        supabase = get_supabase(admin=True)
        if supabase is None:
            return None
        try:
            rows = (
                supabase.table("users")
                .select("objective")
                .eq("id", str(user_id))
                .limit(1)
                .execute()
            ).data or []
            return rows[0].get("objective") if rows else None
        except Exception as err:
            logger.warning("Could not read user objective for weekly routine: %s", err)
            return None

    def generate_weekly_routine(
        self,
        user_id: UUID,
        payload: WeeklyRoutineGenerateRequest,
    ) -> WeeklyRoutineDraft:
        self._require_premium(
            user_id,
            "AI weekly routines are a Premium feature. Upgrade to Premium to unlock them.",
        )
        use_ai_call(user_id)
        user_objective = payload.objective or self._read_user_objective(user_id)
        return weekly_routine_service.generate_weekly_routine(payload, user_objective=user_objective)

    def modify_weekly_routine(
        self,
        user_id: UUID,
        payload: WeeklyRoutineModifyRequest,
    ) -> WeeklyRoutineDraft:
        self._require_premium(
            user_id,
            "AI weekly routines are a Premium feature. Upgrade to Premium to unlock them.",
        )
        use_ai_call(user_id)
        return weekly_routine_service.modify_weekly_routine(payload)

    def accept_weekly_routine(
        self,
        user_id: UUID,
        payload: WeeklyRoutineAcceptRequest,
        day: LocalDay | None = None,
    ) -> WeeklyRoutineAcceptResponse:
        self._require_premium(
            user_id,
            "AI weekly routines are a Premium feature. Upgrade to Premium to unlock them.",
        )
        return weekly_routine_service.accept_weekly_routine(user_id, payload, day)

    def save_log(self, user_id: UUID, payload: WorkoutLogCreate) -> WorkoutLogResponse:
        saved = workout_service.save_workout_log(user_id, payload)
        try:
            overtraining_service.on_workout_completed(user_id)
        except Exception as error:
            logger.warning("Could not refresh overtraining state after saving workout: %s", error)
        return saved

    def list_history(self, user_id: UUID, limit: int = 30) -> WorkoutHistoryResponse:
        return workout_service.list_workout_history(user_id, limit)

    def get_statistics(
        self,
        user_id: UUID,
        range_key: WorkoutStatisticsRange,
        timezone_offset_minutes: int = 0,
    ) -> WorkoutStatisticsResponse:
        return workout_statistics_service.get_workout_statistics(
            user_id, range_key, timezone_offset_minutes
        )

    def update_history_entry(
        self,
        user_id: UUID,
        workout_id: UUID,
        payload: WorkoutLogUpdate,
    ) -> WorkoutLogResponse:
        return workout_service.update_workout_history_entry(user_id, workout_id, payload)

    def delete_history_entry(self, user_id: UUID, workout_id: UUID) -> None:
        workout_service.delete_workout_history_entry(user_id, workout_id)

    def list_routines(self, user_id: UUID) -> list[RoutineSummary]:
        return workout_service.list_user_routines(user_id)

    def create_routine(self, user_id: UUID, payload: RoutineCreate) -> RoutineSummary:
        return workout_service.create_user_routine(user_id, payload)

    def update_routine(self, user_id: UUID, routine_id: UUID, payload: RoutineCreate) -> RoutineSummary:
        return workout_service.update_user_routine(user_id, routine_id, payload)

    def delete_routine(self, user_id: UUID, routine_id: UUID) -> None:
        workout_service.delete_user_routine(user_id, routine_id)

    def list_exercises(self, **filters):
        return workout_service.list_exercises(**filters)

    def get_exercise_categories(self):
        return workout_service.get_exercise_categories()

    def get_exercise_muscle_groups(self):
        return workout_service.get_exercise_muscle_groups()

    def get_exercise_by_id(self, exercise_id: str, user_id: UUID | None = None):
        exercise = workout_service.get_exercise_by_id(exercise_id, user_id=user_id)
        return exercise.model_copy(update={"guide": guide_for(exercise)}) if exercise else None

    def create_custom_exercise(self, user_id: UUID, payload: CustomExerciseCreate) -> Exercise:
        return workout_service.create_custom_exercise(user_id, payload)

    def update_custom_exercise(self, user_id: UUID, exercise_id: str, payload: CustomExerciseCreate) -> Exercise:
        return workout_service.update_custom_exercise(user_id, exercise_id, payload)

    def delete_custom_exercise(self, user_id: UUID, exercise_id: str) -> None:
        workout_service.delete_custom_exercise(user_id, exercise_id)

    def get_overtraining_status(self, user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
        return overtraining_service.evaluate_overtraining(user_id, day)

    def apply_overtraining_mods(self, user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
        return overtraining_service.apply_overtraining_mods(user_id, day)

    def clear_overtraining_mods(self, user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
        return overtraining_service.clear_overtraining_mods(user_id, day)

    def schedule_recovery_rest_day(self, user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
        return overtraining_service.schedule_recovery_rest_day(user_id, day)

    def dismiss_overtraining_alert(self, user_id: UUID, day: LocalDay | None = None) -> OvertrainingStatusResponse:
        return overtraining_service.dismiss_overtraining_alert(user_id, day)


workout_facade = WorkoutFacade()