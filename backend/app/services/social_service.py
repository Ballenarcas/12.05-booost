"""Community rules: who may see whom, what text is allowed and how data cards are built."""

import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable

from app.core.local_day import LocalDay
from app.services.exercise_catalog import get_cached_exercise

# The only columns of ``users`` the Community may read: no e-mail, password hash or body data.
AUTHOR_COLUMNS = 'id,"Name","Surname",username,avatar_path,is_private'
MAX_FOLLOWING = 500
MAX_BLOCKS = 1000
# A set this big means something is wrong; refusing is safer than reading part of it.
MAX_CONTEXT = 5000
PAGE_SIZE = 1000  # Supabase returns at most this many rows per select
ID_CHUNK = 100  # keeps in_() query strings short
MAX_TEXT = 280
STREAK_TO_SHARE = 7
RESERVED_USERNAMES = {"admin", "booost", "support", "me", "settings", "community", "null"}

_USERNAME = re.compile(r"[a-z0-9_]{3,20}")
# Zero-width and bidirectional controls can disguise text. U+200D stays: emoji need it.
_HIDDEN = re.compile("[​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]")


class ContextTooLarge(Exception):
    pass


@dataclass
class ViewerContext:
    viewer_id: str
    blocked_ids: set[str] = field(default_factory=set)
    following_ids: set[str] = field(default_factory=set)


def paged(build: Callable[[], Any], limit: int | None = None) -> list[dict[str, Any]]:
    """Every row of a query. ``build`` must return a fresh, ordered query."""
    rows: list[dict[str, Any]] = []
    while True:
        page = build().range(len(rows), len(rows) + PAGE_SIZE - 1).execute().data or []
        rows += page
        if limit is not None and len(rows) > limit:
            raise ContextTooLarge()
        if len(page) < PAGE_SIZE:
            return rows


def together(*calls: Callable[[], Any]) -> tuple[Any, ...]:
    """Runs independent reads at the same time, so a request waits for one round trip, not one each.

    Results come back in order; the first error is raised. Each call gets its own pool, so calls may nest.
    """
    if len(calls) < 2:
        return tuple(call() for call in calls)
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(call) for call in calls]
        return tuple(future.result() for future in futures)


def chunks(values: list[str]) -> list[list[str]]:
    return [values[start:start + ID_CHUNK] for start in range(0, len(values), ID_CHUNK)]


def load_context(session: Any, viewer_id: str) -> ViewerContext:
    def ids(table: str, mine: str, theirs: str, **equals: str) -> set[str]:
        def build() -> Any:
            query = session.table(table).select(theirs).eq(mine, viewer_id)
            for column, value in equals.items():
                query = query.eq(column, value)
            return query.order(theirs)

        return {str(row[theirs]) for row in paged(build, MAX_CONTEXT)}

    blocked, blocked_by, following = together(
        lambda: ids("social_blocks", "blocker_id", "blocked_id"),
        lambda: ids("social_blocks", "blocked_id", "blocker_id"),
        lambda: ids("social_follows", "follower_id", "followee_id", status="accepted"),
    )
    return ViewerContext(viewer_id=viewer_id, blocked_ids=blocked | blocked_by, following_ids=following)


def can_view(ctx: ViewerContext, author: dict[str, Any] | None) -> bool:
    """The one gate for another member's posts, comments and lists."""
    if not author or not author.get("username"):
        return False
    author_id = str(author["id"])
    if author_id in ctx.blocked_ids:
        return False
    if author_id == ctx.viewer_id or not author.get("is_private"):
        return True
    return author_id in ctx.following_ids


def clean_label(text: str | None, max_length: int = 60) -> str:
    """A name that came from elsewhere (profile, workout, exercise), made safe to show to others."""
    visible = "".join(c for c in _HIDDEN.sub("", text or "") if unicodedata.category(c) != "Cc")
    return " ".join(visible.split())[:max_length]


def normalize_text(text: str) -> str:
    """Post and comment text. Raises ValueError for hidden characters or too much text."""
    value = unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if _HIDDEN.search(value) or any(c != "\n" and unicodedata.category(c) in {"Cc", "Cs"} for c in value):
        raise ValueError("That text contains characters that are not allowed.")
    value = re.sub(r"\n{3,}", "\n\n", value)
    if len(value) > MAX_TEXT:
        raise ValueError("Keep it to 280 characters.")
    return value


def validate_username(value: str) -> str:
    username = value.strip().lower()
    if not _USERNAME.fullmatch(username):
        raise ValueError("Usernames use 3 to 20 letters, numbers or underscores.")
    if username in RESERVED_USERNAMES:
        raise ValueError("That username is reserved.")
    return username


def search_term(value: str) -> str:
    term = unicodedata.normalize("NFC", value).strip().lower()
    # An allow-list, so nothing can reach the filter syntax.
    if not 2 <= len(term) <= 40 or not all(c.isalnum() or c in " _" for c in term):
        raise ValueError("Search with 2 to 40 letters or numbers.")
    return term


# --- data cards: built only from rows the author owns ---

def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _owned_workout(session: Any, user_id: str, workout_id: str) -> dict[str, Any]:
    rows = (session.table("workouts").select("id,name,start_time,end_time")
            .eq("id", workout_id).eq("user_id", user_id).limit(1).execute().data or [])
    if not rows or not rows[0].get("end_time"):
        raise LookupError("Workout not found")
    return rows[0]


def _workout_sets(session: Any, workout_id: str) -> list[dict[str, Any]]:
    return paged(lambda: session.table("workout_sets").select("id,exercise_id,weight,reps,is_done")
                 .eq("workout_id", workout_id).order("id"))


def _weighted(row: dict[str, Any]) -> bool:
    """A finished strength set. Cardio and bodyweight sets are stored with weight 0."""
    return bool(row.get("is_done")) and float(row.get("weight") or 0) > 0 and int(row.get("reps") or 0) >= 1


def _exercise_name(session: Any, exercise_id: str) -> str:
    cached = get_cached_exercise(exercise_id)
    if cached:
        return cached.name  # English; translated when shown, in the reader's language
    rows = session.table("exercises").select("name").eq("id", exercise_id).limit(1).execute().data or []
    return clean_label(rows[0].get("name") if rows else "") or "Exercise"


def records_by_workout(session: Any, user_id: str, workouts: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """For each workout, the exercises where it lifted more than every earlier one.

    ``workouts`` must be the user's own rows. A first attempt at an exercise is not a record.
    History is read once for all of them.
    """
    targets = {str(row["id"]): _time(row["start_time"]) for row in workouts}
    if not targets:
        return {}
    best: dict[str, dict[str, tuple[float, int]]] = {workout_id: {} for workout_id in targets}
    for batch in chunks(list(targets)):
        for row in filter(_weighted, paged(
            lambda: session.table("workout_sets").select("id,workout_id,exercise_id,weight,reps,is_done")
            .in_("workout_id", batch).order("id")
        )):
            lifts, key = best[str(row["workout_id"])], str(row["exercise_id"])
            lift = (float(row["weight"]), int(row["reps"]))
            lifts[key] = max(lift, lifts.get(key, lift))
    exercise_ids = sorted({key for lifts in best.values() for key in lifts})
    if not exercise_ids:
        return {}

    latest = max(targets.values())
    history = {
        str(row["id"]): _time(row["start_time"]) for row in paged(
            lambda: session.table("workouts").select("id,start_time").eq("user_id", user_id).order("id"))
        if _time(row["start_time"]) < latest
    }
    past: list[tuple[datetime, str, float]] = []
    for batch in chunks(list(history)):
        past += [(history[str(row["workout_id"])], str(row["exercise_id"]), float(row["weight"]))
                 for row in filter(_weighted, paged(
                     lambda: session.table("workout_sets").select("id,workout_id,exercise_id,weight,reps,is_done")
                     .in_("workout_id", batch).in_("exercise_id", exercise_ids).order("id")))]

    names: dict[str, str] = {}
    records: dict[str, list[dict[str, Any]]] = {}
    for workout_id, lifts in best.items():
        previous: dict[str, float] = {}
        for started, key, weight in past:
            if started < targets[workout_id]:
                previous[key] = max(weight, previous.get(key, 0.0))
        for key, (weight, reps) in lifts.items():
            if key in previous and weight > previous[key]:
                names[key] = names.get(key) or _exercise_name(session, key)
                records.setdefault(workout_id, []).append({
                    "exercise_id": key, "exercise_name": names[key], "weight_kg": weight,
                    "reps": reps, "previous_best_kg": previous[key]})
    return records


def workout_prs(session: Any, user_id: str, workout_id: str) -> list[dict[str, Any]]:
    workout = _owned_workout(session, user_id, workout_id)
    return records_by_workout(session, user_id, [workout]).get(str(workout["id"]), [])


def pr_card(session: Any, user_id: str, workout_id: str, exercise_id: str) -> dict[str, Any]:
    for record in workout_prs(session, user_id, workout_id):
        if record["exercise_id"] == exercise_id:
            return {key: record[key] for key in ("exercise_name", "weight_kg", "reps", "previous_best_kg")}
    raise ValueError("That is not a personal record.")


def workout_card(session: Any, user_id: str, workout_id: str) -> dict[str, Any]:
    workout = _owned_workout(session, user_id, workout_id)
    done = [row for row in _workout_sets(session, workout_id) if row.get("is_done")]
    return {
        "name": clean_label(workout.get("name")) or "Workout",
        "duration_seconds": max(0, int((_time(workout["end_time"]) - _time(workout["start_time"])).total_seconds())),
        "exercise_count": len({str(row["exercise_id"]) for row in done}),
        "completed_sets": len(done),
        "total_volume_kg": round(sum(float(row.get("weight") or 0) * int(row.get("reps") or 0) for row in done), 1),
        "completed_at": workout["end_time"],
    }


def logging_streak(session: Any, user_id: str, day: LocalDay) -> int:
    """Days in a row with a logged meal, ending today or yesterday."""
    since = (day.start - timedelta(days=366)).isoformat()
    meals = paged(lambda: session.table("meals").select("id,consumed_at").eq("user_id", user_id)
                  .gte("consumed_at", since).order("id"))
    # shortcut: days are 24-hour steps from today's midnight; a daylight saving change can
    # move a meal logged within an hour of midnight to the neighbouring day.
    days = {(_time(row["consumed_at"]) - day.start) // timedelta(days=1) for row in meals if row.get("consumed_at")}
    offset = 0 if 0 in days else -1
    streak = 0
    while offset - streak in days:
        streak += 1
    return streak


def streak_card(session: Any, user_id: str, day: LocalDay) -> dict[str, Any]:
    days = logging_streak(session, user_id, day)
    if days < STREAK_TO_SHARE:
        raise ValueError("Log meals 7 days in a row to share a streak.")
    return {"days": days}
