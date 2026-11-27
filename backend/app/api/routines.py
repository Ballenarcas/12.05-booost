from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.auth import current_user
from app.core.local_day import LocalDay, local_day
from app.schemas.weekly_routine import (
    WeeklyRoutineAcceptRequest,
    WeeklyRoutineAcceptResponse,
    WeeklyRoutineDraft,
    WeeklyRoutineGenerateRequest,
    WeeklyRoutineModifyRequest,
)
from app.schemas.workout import RoutineCreate, RoutineSummary
from app.facades.workout_facade import workout_facade

router = APIRouter(prefix="/routines", tags=["routines"])


@router.get("", response_model=list[RoutineSummary])
def list_routines(user_id: UUID = Depends(current_user)) -> list[RoutineSummary]:
    return workout_facade.list_routines(user_id)


@router.post("", response_model=RoutineSummary)
def create_routine(
    payload: RoutineCreate,
    user_id: UUID = Depends(current_user),
) -> RoutineSummary:
    return workout_facade.create_routine(user_id, payload)


@router.put("/{routine_id}", response_model=RoutineSummary)
def update_routine(
    routine_id: UUID,
    payload: RoutineCreate,
    user_id: UUID = Depends(current_user),
) -> RoutineSummary:
    return workout_facade.update_routine(user_id, routine_id, payload)


@router.delete("/{routine_id}")
def delete_routine(
    routine_id: UUID,
    user_id: UUID = Depends(current_user),
) -> dict[str, str]:
    workout_facade.delete_routine(user_id, routine_id)
    return {"status": "deleted"}


@router.post("/ai-weekly/generate", response_model=WeeklyRoutineDraft)
def generate_ai_weekly_routine(
    payload: WeeklyRoutineGenerateRequest,
    user_id: UUID = Depends(current_user),
) -> WeeklyRoutineDraft:
    return workout_facade.generate_weekly_routine(user_id, payload)


@router.post("/ai-weekly/modify", response_model=WeeklyRoutineDraft)
def modify_ai_weekly_routine(
    payload: WeeklyRoutineModifyRequest,
    user_id: UUID = Depends(current_user),
) -> WeeklyRoutineDraft:
    return workout_facade.modify_weekly_routine(user_id, payload)


@router.post("/ai-weekly/accept", response_model=WeeklyRoutineAcceptResponse)
def accept_ai_weekly_routine(
    payload: WeeklyRoutineAcceptRequest,
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> WeeklyRoutineAcceptResponse:
    return workout_facade.accept_weekly_routine(user_id, payload, day)
