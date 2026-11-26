import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import current_user
from app.facades.settings_facade import settings_facade
from app.schemas.settings import MuscleFocus, UserSettingsUpdate

router = APIRouter(prefix="/settings", tags=["Settings"])
logger = logging.getLogger(__name__)


@router.get("/muscle-focus", response_model=MuscleFocus)
def read_muscle_focus(user_id: UUID = Depends(current_user)) -> MuscleFocus:
    return MuscleFocus(muscle=settings_facade.muscle_focus(str(user_id)))


@router.put("/muscle-focus", response_model=MuscleFocus)
def update_muscle_focus(payload: MuscleFocus, user_id: UUID = Depends(current_user)) -> MuscleFocus:
    try:
        settings_facade.set_muscle_focus(str(user_id), payload.muscle)
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Profile not found.") from err
    except Exception as err:
        logger.exception("Failed to save the muscle focus")
        raise HTTPException(status_code=500, detail="Could not save your settings.") from err
    return payload


@router.put("/update")
def update_settings(
    settings: UserSettingsUpdate,
    user_id: UUID = Depends(current_user),
):
    try:
        settings_facade.update(str(user_id), settings)
    except LookupError as err:
        raise HTTPException(status_code=404, detail="Profile not found.") from err
    except Exception as err:
        logger.exception("Failed to update user settings")
        raise HTTPException(status_code=500, detail="Could not save your settings.") from err
    return {"status": "success", "message": "Settings saved."}
