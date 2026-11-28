"""The muscle the user chose to prioritise. It outranks what an accepted tip suggested."""

import logging
from typing import Any

logger = logging.getLogger(__name__)


ALLOWED_MUSCLE_FOCUS = frozenset({"Chest", "Back", "Shoulders", "Arms", "Legs", "Abs", "Glutes"})


def get_muscle_focus(session: Any, user_id: Any) -> str | None:
    """None means automatic. A missing column or a failed read must not break the coach or the planner."""
    try:
        rows = session.table("users").select("muscle_focus").eq("id", str(user_id)).limit(1).execute().data or []
    except Exception:
        logger.warning("Could not read the muscle focus", exc_info=True)
        return None
    value = rows[0].get("muscle_focus") if rows else None
    return value if isinstance(value, str) and value in ALLOWED_MUSCLE_FOCUS else None


def set_muscle_focus(session: Any, user_id: Any, focus: str | None) -> None:
    saved = session.table("users").update({"muscle_focus": focus}).eq("id", str(user_id)).execute().data
    if not saved:
        raise LookupError("User profile was not found")
