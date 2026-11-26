import json
import logging
import re
import uuid
from functools import lru_cache
from pathlib import Path

from app.core.i18n import get_language
from app.schemas.exercise import Exercise

logger = logging.getLogger(__name__)

CATALOG_PATH = Path(__file__).resolve().parent.parent / "data" / "exercises_catalog.json"
NAMES_ES_PATH = CATALOG_PATH.with_name("exercise_names_es.json")


@lru_cache
def _spanish_names() -> dict[str, str]:
    try:
        return json.loads(NAMES_ES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("Spanish exercise names are unavailable", exc_info=True)
        return {}


def exercise_label(name: str, lang: str | None = None) -> str:
    """A catalog name in the app language. Names the user typed are not in the list and stay as they are."""
    return _spanish_names().get(name, name) if (lang or get_language()) == "es" else name


TEXT_ES_PATH = CATALOG_PATH.with_name("exercise_text_es.json")


@lru_cache(maxsize=1)
def _read_text(_modified: float) -> dict[str, str]:
    return json.loads(TEXT_ES_PATH.read_text(encoding="utf-8"))


def spanish_text() -> dict[str, str]:
    """English instruction sentence to Spanish. Reread when the file changes, like the catalog."""
    try:
        return _read_text(TEXT_ES_PATH.stat().st_mtime)
    except (OSError, ValueError):
        logger.warning("Spanish exercise instructions are unavailable", exc_info=True)
        return {}


def _description_es(description: str | None) -> str | None:
    """The Spanish instructions, or the English ones whole: a half-translated list helps nobody."""
    parts = [part.strip() for part in re.split(r"(?<=\.)\s+", description or "") if part.strip()]
    # The guide page hides this closing line; its English filter would miss the translation.
    parts = [part for part in parts if not part.lower().startswith("repeat for the desired")]
    translated = [spanish_text().get(part) for part in parts]
    return " ".join(translated) if parts and all(translated) else description


def localized_exercise(exercise: Exercise) -> Exercise:
    """The exercise in the app language. Custom exercises keep the words the user typed."""
    if get_language() != "es" or exercise.is_custom:
        return exercise
    return exercise.model_copy(update={
        "name": exercise_label(exercise.name), "description": _description_es(exercise.description),
    })


_cached_exercises: list[Exercise] | None = None
_cached_mtime: float | None = None
_cached_by_key: dict[str, Exercise] | None = None


def load_cached_exercises() -> list[Exercise]:
    """Loads exercises from local catalog JSON, keeping a process-wide cache."""
    global _cached_exercises, _cached_mtime, _cached_by_key
    if not CATALOG_PATH.exists():
        return []
    try:
        mtime = CATALOG_PATH.stat().st_mtime
        if _cached_exercises is not None and _cached_mtime == mtime:
            return _cached_exercises
        with open(CATALOG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        spanish = _spanish_names()
        exercises = [Exercise(**{"name_es": spanish.get(item.get("name")), **item}) for item in data]
        _cached_exercises = exercises
        _cached_mtime = mtime
        # Workouts and routines store the Supabase UUID, so index by both ids.
        _cached_by_key = {key: exercise for exercise in exercises for key in (exercise.id, supabase_uuid_for(exercise))}
        return exercises
    except Exception as err:
        logger.error(f"Error reading exercises catalog: {err}")
        return []


def get_cached_exercise(exercise_id: str) -> Exercise | None:
    load_cached_exercises()
    if not _cached_by_key:
        return None
    return _cached_by_key.get(exercise_id)


def supabase_uuid_for(exercise: Exercise) -> str:
    """Deterministic Supabase UUID for a catalog exercise (matches replace_exercises_with_dataset.sql)."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"exercise:{exercise.id}"))


def muscle_group_for(exercise: Exercise) -> str:
    """Return the muscle group value stored in the Supabase exercises table."""
    return exercise.category or (exercise.muscles[0] if exercise.muscles else "General")


def resolve_exercise_log_id(exercise_id: str) -> str:
    """Resolve a catalog id to the Supabase exercise UUID.

    Passes through values that are already UUIDs (e.g. routine exercises from Supabase).
    Raises ValueError for unknown exercise ids.
    """
    try:
        return str(uuid.UUID(exercise_id))
    except ValueError:
        pass
    exercise = get_cached_exercise(exercise_id)
    if exercise is None:
        raise ValueError(f"Unknown exercise '{exercise_id}'")
    return supabase_uuid_for(exercise)
