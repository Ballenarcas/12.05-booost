from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.user import MAX_BODY_WEIGHT_KG, MIN_BODY_WEIGHT_KG

class MuscleFocus(BaseModel):
    """None lets the app decide from the user's training."""

    muscle: Literal["Chest", "Back", "Shoulders", "Arms", "Legs", "Abs", "Glutes"] | None = None


class UserSettingsUpdate(BaseModel):
    # Personal Info 
    age: int = Field(..., ge=12, le=120, description="Age must not be empty and greater than 0")
    weight: float = Field(..., ge=MIN_BODY_WEIGHT_KG, le=MAX_BODY_WEIGHT_KG, description="Body weight in kg")
    height: int = Field(..., ge=80, le=250, description="Height must not be empty and greater than 0")
    gender: str = Field(
        ..., 
        min_length=1,
        max_length=30,
        description="Gender must not be empty (required for metabolism calculations)"
    )
    objective: str = Field(..., min_length=1, max_length=50, description="Objective must not be empty")
    
    # Permissions 
    notifications_enabled: bool = Field(
        default=False, 
        description="Permission to receive notifications"
    )
    health_data_integration: bool = Field(
        default=False, 
        description="Health providers integrations (e.g., Apple Health)"
    )