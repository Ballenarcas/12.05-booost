"""Coaching detail for the exercise guide page: by movement for staples, by category otherwise."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from app.schemas.exercise import Exercise, ExerciseGuide

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@lru_cache(maxsize=1)
def _load() -> tuple[dict, dict[str, str]]:
    guides = json.loads((DATA_DIR / "exercise_guides.json").read_text(encoding="utf-8"))
    staples = json.loads((DATA_DIR / "exercise_staples.json").read_text(encoding="utf-8"))
    movement_by_id = {row["exercise_id"]: row["movement"] for row in staples["exercises"]}
    return guides, movement_by_id


def guide_for(exercise: Exercise) -> ExerciseGuide | None:
    """Custom exercises get no guide: we don't know how they're performed."""
    if exercise.is_custom:
        return None
    guides, movement_by_id = _load()
    movement = movement_by_id.get(exercise.id)
    entry = guides["movements"].get(movement) if movement else guides["categories"].get(exercise.category)
    if not entry:
        return None
    return ExerciseGuide(**entry, safety=guides["safety"])
