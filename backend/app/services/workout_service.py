import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException

from app.db.supabase_client import get_supabase
from app.schemas.exercise import Exercise
from app.schemas.workout import CustomExerciseCreate, RoutineCreate, RoutineExerciseSummary, RoutineSummary
from app.schemas.workout_log import (
    WorkoutHistoryEntry,
    WorkoutHistoryExercise,
    WorkoutHistoryResponse,
    WorkoutHistorySet,
    WorkoutLogCreate,
    WorkoutLogResponse,
    WorkoutLogUpdate,
)
from app.services.exercise_catalog import (
    get_cached_exercise,
    load_cached_exercises,
    muscle_group_for,
    resolve_exercise_log_id,
    supabase_uuid_for,
)
from app.services.premium_service import has_active_premium

logger = logging.getLogger(__name__)

# Custom exercises are rows of public.exercises with owner_id set (see add_custom_exercise_owner.sql).
# They must live there because workout_sets and routine_exercises reference that table.
CUSTOM_EXERCISE_COLUMNS = "id,name,muscle_group,equipment,description,muscles,muscles_secondary,archived_at"
MAX_CUSTOM_EXERCISES = 100


def _require_supabase() -> Any:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    return supabase


def _custom_from_row(row: dict[str, Any]) -> Exercise:
    group = row.get("muscle_group") or "General"
    equipment = row.get("equipment") or ""
    return Exercise(
        id=str(row["id"]),
        name=row.get("name") or "Exercise",
        muscle_group=group,
        category=group,
        description=row.get("description"),
        muscles=row.get("muscles") or [group],
        muscles_secondary=row.get("muscles_secondary") or [],
        equipment=[item.strip() for item in equipment.split(",") if item.strip()],
        is_custom=True,
    )


def _user_custom_rows(user_id: UUID, supabase: Any | None = None) -> list[dict[str, Any]]:
    return (
        (supabase or _require_supabase()).table("exercises")
        .select(CUSTOM_EXERCISE_COLUMNS)
        .eq("owner_id", str(user_id))
        .is_("archived_at", "null")
        .order("name")
        .execute()
        .data or []
    )


def _owned_custom_row(supabase: Any, user_id: UUID, exercise_id: str) -> dict[str, Any] | None:
    try:
        UUID(str(exercise_id))
    except ValueError:
        return None
    rows = (
        supabase.table("exercises")
        .select(CUSTOM_EXERCISE_COLUMNS)
        .eq("id", str(exercise_id))
        .eq("owner_id", str(user_id))
        .is_("archived_at", "null")
        .limit(1)
        .execute()
        .data or []
    )
    return rows[0] if rows else None


_catalog_uuids: tuple[int, frozenset[str]] | None = None


def _catalog_uuid_set() -> frozenset[str]:
    """Supabase ids of the shared catalog, rebuilt only when the catalog file is reloaded."""
    global _catalog_uuids
    catalog = load_cached_exercises()
    if _catalog_uuids is None or _catalog_uuids[0] != id(catalog):
        _catalog_uuids = (id(catalog), frozenset(supabase_uuid_for(exercise) for exercise in catalog))
    return _catalog_uuids[1]


def _resolve_exercise_id_for_user(exercise_id: str, user_id: UUID | None = None, allow_archived: bool = False) -> str:
    """Resolve to an exercises.id the user may log: a shared one, or one of their own custom exercises.

    allow_archived keeps removed custom exercises valid when re-saving past workouts.
    Raises ValueError otherwise, including for another user's custom exercise.
    """
    resolved = resolve_exercise_log_id(exercise_id)
    if resolved in _catalog_uuid_set():
        return resolved
    rows = (
        _require_supabase().table("exercises")
        .select("owner_id,archived_at")
        .eq("id", resolved)
        .limit(1)
        .execute()
        .data or []
    )
    if rows:
        owner, archived = rows[0].get("owner_id"), rows[0].get("archived_at")
        if owner is None:
            return resolved
        if user_id is not None and str(owner) == str(user_id) and (allow_archived or not archived):
            return resolved
    raise ValueError(f"Unknown exercise '{exercise_id}'")


def list_exercises(
    user_id: UUID | None = None,
    query: str | None = None,
    category: str | None = None,
    muscle_group: str | None = None,
    muscle: str | None = None,
    equipment: str | None = None,
    page: int = 1,
    limit: int = 20,
) -> tuple[list[Exercise], int]:
    """Retrieves and filters the catalog plus the signed-in user's custom exercises, with pagination."""
    catalog_exercises = [
        exercise.model_copy(update={"muscle_group": muscle_group_for(exercise), "is_custom": False})
        for exercise in load_cached_exercises()
    ]
    custom_exercises = [_custom_from_row(row) for row in _user_custom_rows(user_id)] if user_id else []
    all_exercises = custom_exercises + catalog_exercises

    filtered = all_exercises
    if category:
        cat_lower = category.lower()
        filtered = [e for e in filtered if e.category and e.category.lower() == cat_lower]

    if muscle_group:
        group_lower = muscle_group.lower()
        filtered = [e for e in filtered if e.muscle_group.lower() == group_lower]

    if muscle:
        m_lower = muscle.lower()
        filtered = [
            e
            for e in filtered
            if any(m_lower in m.lower() for m in e.muscles + e.muscles_secondary)
        ]

    if equipment:
        eq_lower = equipment.lower()
        filtered = [
            e
            for e in filtered
            if any(eq_lower in eq.lower() for eq in e.equipment)
        ]

    if query:
        q_lower = query.lower().strip()
        filtered = [
            e
            for e in filtered
            if q_lower in e.name.lower()
            or (e.name_es and q_lower in e.name_es.lower())
            or any(q_lower in a.lower() for a in e.aliases)
            or (e.description and q_lower in e.description.lower())
        ]

    total = len(filtered)
    start_idx = max(0, (page - 1) * limit)
    end_idx = start_idx + limit
    return filtered[start_idx:end_idx], total


def get_exercise_by_id(exercise_id: str, user_id: UUID | None = None) -> Exercise | None:
    """Find an exercise in the catalog, or among the signed-in user's own custom exercises."""
    cached = get_cached_exercise(exercise_id)
    if cached:
        return cached.model_copy(update={"muscle_group": muscle_group_for(cached), "is_custom": False})
    if user_id is None:
        return None
    row = _owned_custom_row(_require_supabase(), user_id, exercise_id)
    return _custom_from_row(row) if row else None


def _check_custom_name(supabase: Any, user_id: UUID, name: str, exclude_id: str | None = None) -> None:
    lowered = name.lower()
    clash = next((e.name for e in load_cached_exercises() if e.name.strip().lower() == lowered), None)
    if clash is None:
        clash = next(
            (row["name"] for row in _user_custom_rows(user_id, supabase)
             if str(row["id"]) != exclude_id and str(row.get("name", "")).strip().lower() == lowered),
            None,
        )
    if clash is not None:
        raise HTTPException(status_code=409, detail=f'The name is already in use by "{clash}".')


def _custom_record(payload: CustomExerciseCreate) -> dict[str, Any]:
    group = payload.muscle_group.strip() or "General"
    return {
        "name": payload.name.strip(),
        "muscle_group": group,
        "description": payload.description.strip() if payload.description else None,
        "muscles": payload.muscles or [group],
        "muscles_secondary": payload.muscles_secondary or [],
        "equipment": ", ".join(item.strip() for item in payload.equipment if item.strip()) or None,
    }


def _is_unique_violation(error: Exception) -> bool:
    return "23505" in str(error) or "duplicate key" in str(error).lower()


def create_custom_exercise(user_id: UUID, payload: CustomExerciseCreate) -> Exercise:
    supabase = _require_supabase()
    if not has_active_premium(str(user_id), supabase):
        raise HTTPException(status_code=403, detail="Custom exercises are a Premium feature.")
    if len(_user_custom_rows(user_id, supabase)) >= MAX_CUSTOM_EXERCISES:
        raise HTTPException(status_code=409, detail=f"You can have up to {MAX_CUSTOM_EXERCISES} custom exercises.")
    record = {"id": str(uuid4()), "owner_id": str(user_id), **_custom_record(payload)}
    _check_custom_name(supabase, user_id, record["name"])
    try:
        supabase.table("exercises").insert(record).execute()
    except Exception as err:
        if _is_unique_violation(err):
            raise HTTPException(status_code=409, detail=f'The name is already in use by "{record["name"]}".') from err
        raise
    return _custom_from_row(record)


def update_custom_exercise(user_id: UUID, exercise_id: str, payload: CustomExerciseCreate) -> Exercise:
    supabase = _require_supabase()
    if not _owned_custom_row(supabase, user_id, exercise_id):
        raise HTTPException(status_code=404, detail="Custom exercise not found")
    record = _custom_record(payload)
    _check_custom_name(supabase, user_id, record["name"], exclude_id=str(exercise_id))
    try:
        supabase.table("exercises").update(record).eq("id", str(exercise_id)).eq("owner_id", str(user_id)).execute()
    except Exception as err:
        if _is_unique_violation(err):
            raise HTTPException(status_code=409, detail=f'The name is already in use by "{record["name"]}".') from err
        raise
    return _custom_from_row({"id": exercise_id, **record})


def delete_custom_exercise(user_id: UUID, exercise_id: str) -> None:
    """Deletes an unused custom exercise; one that past workouts or routines use is archived instead."""
    supabase = _require_supabase()
    if not _owned_custom_row(supabase, user_id, exercise_id):
        raise HTTPException(status_code=404, detail="Custom exercise not found")
    used = any(
        supabase.table(table).select("exercise_id").eq("exercise_id", str(exercise_id)).limit(1).execute().data
        for table in ("workout_sets", "routine_exercises")
    )
    query = supabase.table("exercises")
    if used:
        query = query.update({"archived_at": datetime.now(timezone.utc).isoformat()})
    else:
        query = query.delete()
    query.eq("id", str(exercise_id)).eq("owner_id", str(user_id)).execute()


def get_exercise_categories() -> list[str]:
    """Returns unique list of exercise categories."""
    exercises = load_cached_exercises()
    categories = sorted({e.category for e in exercises if e.category})
    return categories


def get_exercise_muscle_groups() -> list[str]:
    return sorted({muscle_group_for(exercise) for exercise in load_cached_exercises()})


def _routine_reps_by_set(row: dict) -> list[int]:
    target_sets = int(row.get("target_sets") or 0)
    reps_by_set = row.get("reps_by_set")
    if isinstance(reps_by_set, list) and len(reps_by_set) == target_sets:
        return [int(reps) for reps in reps_by_set]
    return [int(row.get("target_reps") or 0)] * target_sets


def list_user_routines(user_id: UUID) -> list[RoutineSummary]:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    routines = supabase.table("routines").select("id,name").eq("user_id", str(user_id)).execute().data or []
    if not routines:
        return []

    routine_ids = [routine["id"] for routine in routines]
    rows = (
        supabase.table("routine_exercises")
        .select("routine_id,exercise_id,target_sets,target_reps,reps_by_set,set_order,exercises(name,archived_at)")
        .in_("routine_id", routine_ids)
        .order("set_order")
        .execute()
        .data or []
    )
    grouped: dict[str, list[RoutineExerciseSummary]] = {str(routine_id): [] for routine_id in routine_ids}
    for row in rows:
        ex_id = str(row["exercise_id"])
        exercise = row.get("exercises") or {}
        if isinstance(exercise, list):
            exercise = exercise[0] if exercise else {}
        name = exercise.get("name", "Exercise")
        if exercise.get("archived_at"):
            name = f"{name} (Removed - pick a replacement)"
        grouped.setdefault(str(row["routine_id"]), []).append(
            RoutineExerciseSummary(
                exercise_id=ex_id,
                name=name,
                target_sets=row.get("target_sets"),
                target_reps=row.get("target_reps"),
                reps_by_set=_routine_reps_by_set(row),
            )
        )
    return [
        RoutineSummary(id=str(routine["id"]), name=routine["name"], exercises=grouped.get(str(routine["id"]), []))
        for routine in routines
    ]


def create_user_routine(user_id: UUID, payload: RoutineCreate) -> RoutineSummary:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    try:
        resolved_exercise_ids = [
            _resolve_exercise_id_for_user(exercise.exercise_id, user_id)
            for exercise in payload.exercises
        ]
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    if len(set(resolved_exercise_ids)) != len(resolved_exercise_ids):
        raise HTTPException(status_code=400, detail="A routine cannot contain the same exercise more than once")

    routine_id = None
    exercise_names: dict[str, str] = {}
    try:
        available_exercises = (
            supabase.table("exercises")
            .select("id,name")
            .in_("id", resolved_exercise_ids)
            .execute()
            .data
            or []
        )
        available_ids = {str(row["id"]) for row in available_exercises}
        exercise_names = {
            str(row["id"]): str(row.get("name", "Exercise"))
            for row in available_exercises
        }
        unknown_ids = set(resolved_exercise_ids) - available_ids
        if unknown_ids:
            raise HTTPException(status_code=400, detail="One or more selected exercises are unavailable")

        routine_response = (
            supabase.table("routines")
            .insert({"user_id": str(user_id), "name": payload.name.strip()})
            .select("id")
            .execute()
        )
        routine_row = routine_response.data[0] if routine_response.data else None
        if not isinstance(routine_row, dict) or not routine_row.get("id"):
            raise RuntimeError("Supabase did not return the saved routine ID")
        routine_id = routine_row["id"]

        exercise_rows = [
            {
                "id": str(uuid4()),
                "routine_id": routine_id,
                "exercise_id": resolved_exercise_id,
                "set_order": index,
                "target_sets": exercise.target_sets,
                "target_reps": exercise.target_reps,
                "reps_by_set": exercise.reps_by_set or [exercise.target_reps] * exercise.target_sets,
            }
            for index, (exercise, resolved_exercise_id) in enumerate(
                zip(payload.exercises, resolved_exercise_ids),
                start=1,
            )
        ]
        supabase.table("routine_exercises").insert(exercise_rows).execute()
    except HTTPException:
        raise
    except Exception as err:
        logger.exception("Failed to persist routine")
        if routine_id:
            try:
                supabase.table("routines").delete().eq("id", routine_id).execute()
            except Exception:
                logger.exception("Failed to clean up incomplete routine")
        raise HTTPException(status_code=502, detail="Could not save this routine.") from err

    return RoutineSummary(
        id=str(routine_id),
        name=payload.name.strip(),
        exercises=[
            RoutineExerciseSummary(
                exercise_id=resolved_exercise_id,
                name=exercise_names.get(resolved_exercise_id, "Exercise"),
                target_sets=exercise.target_sets,
                target_reps=exercise.target_reps,
                reps_by_set=exercise.reps_by_set or [exercise.target_reps] * exercise.target_sets,
            )
            for exercise, resolved_exercise_id in zip(payload.exercises, resolved_exercise_ids)
        ],
    )


def update_user_routine(user_id: UUID, routine_id: UUID, payload: RoutineCreate) -> RoutineSummary:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    routine_rows = (
        supabase.table("routines")
        .select("id,name")
        .eq("id", str(routine_id))
        .eq("user_id", str(user_id))
        .execute()
        .data or []
    )
    if not routine_rows:
        raise HTTPException(status_code=404, detail="Routine not found")

    try:
        resolved_exercise_ids = [
            _resolve_exercise_id_for_user(exercise.exercise_id, user_id)
            for exercise in payload.exercises
        ]
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    if len(set(resolved_exercise_ids)) != len(resolved_exercise_ids):
        raise HTTPException(status_code=400, detail="A routine cannot contain the same exercise more than once")

    exercise_rows = (
        supabase.table("exercises")
        .select("id,name")
        .in_("id", resolved_exercise_ids)
        .execute()
        .data or []
    )
    exercise_names = {str(row["id"]): str(row.get("name", "Exercise")) for row in exercise_rows}
    if set(resolved_exercise_ids) - exercise_names.keys():
        raise HTTPException(status_code=400, detail="One or more selected exercises are unavailable")

    existing_rows = (
        supabase.table("routine_exercises")
        .select("id,routine_id,exercise_id,target_sets,target_reps,reps_by_set,set_order")
        .eq("routine_id", str(routine_id))
        .execute()
        .data or []
    )
    replacement_rows = [
        {
            "id": str(uuid4()),
            "routine_id": str(routine_id),
            "exercise_id": exercise_id,
            "set_order": index,
            "target_sets": exercise.target_sets,
            "target_reps": exercise.target_reps,
            "reps_by_set": exercise.reps_by_set or [exercise.target_reps] * exercise.target_sets,
        }
        for index, (exercise, exercise_id) in enumerate(zip(payload.exercises, resolved_exercise_ids), start=1)
    ]

    try:
        supabase.table("routine_exercises").delete().eq("routine_id", str(routine_id)).execute()
        supabase.table("routine_exercises").insert(replacement_rows).execute()
        supabase.table("routines").update({"name": payload.name.strip()}).eq(
            "id", str(routine_id)
        ).eq("user_id", str(user_id)).execute()
    except Exception as err:
        logger.exception("Failed to update routine")
        try:
            supabase.table("routine_exercises").delete().eq("routine_id", str(routine_id)).execute()
            if existing_rows:
                supabase.table("routine_exercises").insert(existing_rows).execute()
        except Exception:
            logger.exception("Failed to restore routine exercises after update failure")
        raise HTTPException(status_code=502, detail="Could not update this routine.") from err

    return RoutineSummary(
        id=str(routine_id),
        name=payload.name.strip(),
        exercises=[
            RoutineExerciseSummary(
                exercise_id=exercise_id,
                name=exercise_names[exercise_id],
                target_sets=exercise.target_sets,
                target_reps=exercise.target_reps,
                reps_by_set=exercise.reps_by_set or [exercise.target_reps] * exercise.target_sets,
            )
            for exercise, exercise_id in zip(payload.exercises, resolved_exercise_ids)
        ],
    )


def delete_user_routine(user_id: UUID, routine_id: UUID) -> None:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    routine = (
        supabase.table("routines")
        .select("id")
        .eq("id", str(routine_id))
        .eq("user_id", str(user_id))
        .execute()
        .data or []
    )
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    try:
        supabase.table("workouts").update({"routine_id": None}).eq(
            "routine_id", str(routine_id)
        ).eq("user_id", str(user_id)).execute()
        supabase.table("routine_exercises").delete().eq(
            "routine_id", str(routine_id)
        ).execute()
        supabase.table("routines").delete().eq(
            "id", str(routine_id)
        ).eq("user_id", str(user_id)).execute()
    except Exception as err:
        logger.exception("Failed to delete routine")
        raise HTTPException(status_code=502, detail=f"Could not delete routine: {err}") from err


def _saved_workout_id(supabase, user_id: UUID, payload: WorkoutLogCreate) -> str | None:
    """A session keeps its start time, so the same start means a retry of the same workout."""
    rows = (
        supabase.table("workouts")
        .select("id")
        .eq("user_id", str(user_id))
        .eq("start_time", payload.started_at.isoformat())
        .limit(1)
        .execute()
        .data or []
    )
    return rows[0]["id"] if rows else None


def _is_cardio_exercise(
    exercise_id: str,
    exercise_meta: dict[str, Any] | None = None,
    *,
    explicit: bool = False,
) -> bool:
    if explicit:
        return True
    if isinstance(exercise_meta, dict):
        group = str(exercise_meta.get("muscle_group") or exercise_meta.get("category") or "").lower()
        if "cardio" in group:
            return True
        muscles = exercise_meta.get("muscles")
        if isinstance(muscles, list) and any("cardio" in str(m).lower() for m in muscles):
            return True
    cached = get_cached_exercise(str(exercise_id))
    if cached is not None:
        if "cardio" in (cached.category or "").lower() or "cardio" in (cached.muscle_group or "").lower():
            return True
        if any("cardio" in m.lower() for m in (cached.muscles or [])):
            return True
    return False


def _build_workout_set_records(
    exercises: list[Any],
    user_id: UUID,
    *,
    workout_id: str | None = None,
) -> list[dict[str, Any]]:
    set_records: list[dict[str, Any]] = []
    for position, exercise in enumerate(exercises):
        try:
            resolved_id = _resolve_exercise_id_for_user(exercise.exercise_id, user_id, allow_archived=True)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=f"Unknown exercise '{exercise.exercise_id}'") from err
        is_cardio = _is_cardio_exercise(
            resolved_id,
            explicit=bool(getattr(exercise, "is_cardio", False)),
        ) or any(
            getattr(s, "duration_seconds", None) is not None or getattr(s, "distance_km", None) is not None
            for s in exercise.sets
        )
        for set_item in exercise.sets:
            if is_cardio:
                raw_dur = getattr(set_item, "duration_seconds", None)
                raw_dist = getattr(set_item, "distance_km", None)
                duration_sec = int(raw_dur) if raw_dur is not None else (int(set_item.reps) if set_item.reps > 0 else 0)
                dist_km = float(raw_dist) if raw_dist is not None else (float(set_item.weight_kg) if set_item.weight_kg > 0 else None)
                # Cardio lives in its own columns. weight/reps stay 0 so strength readers
                # (planner, volume, tips) never read seconds as reps or km as kg.
                record: dict[str, Any] = {
                    "exercise_id": resolved_id,
                    "exercise_order": position,
                    "set_number": set_item.set_number,
                    "weight": 0.0,
                    "reps": 0,
                    "rpe": None,
                    "is_done": bool(set_item.is_completed),
                    "duration_seconds": duration_sec if duration_sec > 0 else None,
                    "distance_km": dist_km if (dist_km is not None and dist_km > 0) else None,
                }
            else:
                record = {
                    "exercise_id": resolved_id,
                    "exercise_order": position,
                    "set_number": set_item.set_number,
                    "weight": set_item.weight_kg,
                    "reps": set_item.reps,
                    "rpe": set_item.rpe,
                    "is_done": set_item.is_completed,
                }
            if workout_id is not None:
                record = {"workout_id": workout_id, **record}
            set_records.append(record)
    return set_records


def _insert_workout_sets(supabase: Any, set_records: list[dict[str, Any]]) -> None:
    if set_records:
        supabase.table("workout_sets").insert(set_records).execute()


def save_workout_log(user_id: UUID, payload: WorkoutLogCreate) -> WorkoutLogResponse:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    saved_id = _saved_workout_id(supabase, user_id, payload)
    if saved_id:
        return WorkoutLogResponse(id=saved_id, status="saved")

    set_records = _build_workout_set_records(payload.exercises, user_id)

    plan = None
    if payload.plan_id:
        plan_rows = (
            supabase.table("workout_plans")
            .select("id,routine_id,title,ai_adjusted,ai_reasoning")
            .eq("id", str(payload.plan_id))
            .eq("user_id", str(user_id))
            .limit(1)
            .execute()
            .data or []
        )
        if not plan_rows:
            raise HTTPException(status_code=404, detail="Workout plan not found")
        plan = plan_rows[0]

    routine_id = payload.routine_id or (plan.get("routine_id") if plan else None)
    if routine_id:
        owned = (
            supabase.table("routines")
            .select("id")
            .eq("id", str(routine_id))
            .eq("user_id", str(user_id))
            .limit(1)
            .execute()
            .data or []
        )
        routine_id = routine_id if owned else None
    workout_id = None
    try:
        record = {
            "user_id": str(user_id),
            "routine_id": str(routine_id) if routine_id else None,
            "name": payload.name.strip(),
            "start_time": payload.started_at.isoformat(),
            "end_time": payload.completed_at.isoformat(),
            "fatigue_level": payload.fatigue_level,
        }
        if plan is not None:
            record["ai_adjusted"] = bool(plan.get("ai_adjusted"))
            record["ai_reasoning"] = plan.get("ai_reasoning")
        response = (
            supabase.table("workouts")
            .insert(record)
            .select("id")
            .execute()
        )
        inserted = response.data
        workout_row = inserted[0] if isinstance(inserted, list) and inserted else inserted
        if not isinstance(workout_row, dict) or not workout_row.get("id"):
            raise RuntimeError("Supabase did not return the saved workout ID")
        workout_id = workout_row["id"]
        if set_records:
            for set_item in set_records:
                set_item["workout_id"] = workout_id
            _insert_workout_sets(supabase, set_records)
        if plan is not None:
            supabase.table("workout_plans").delete().eq("id", str(payload.plan_id)).eq("user_id", str(user_id)).execute()
    except HTTPException:
        raise
    except Exception as err:
        if "23505" in str(err):
            saved_id = _saved_workout_id(supabase, user_id, payload)
            if saved_id:
                return WorkoutLogResponse(id=saved_id, status="saved")
        logger.exception("Failed to persist workout and workout sets")
        if workout_id:
            try:
                supabase.table("workouts").delete().eq("id", workout_id).execute()
            except Exception:
                pass
        raise HTTPException(status_code=502, detail="Could not save workout history") from err

    return WorkoutLogResponse(id=workout_id, status="saved")


def list_workout_history(user_id: UUID, limit: int = 30) -> WorkoutHistoryResponse:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    rows = (
        supabase.table("workouts")
        .select(
            "id,routine_id,name,start_time,end_time,fatigue_level,routines(name),"
            "workout_sets(exercise_id,exercise_order,set_number,reps,weight,rpe,is_done,duration_seconds,distance_km,exercises(name,muscle_group))"
        )
        .eq("user_id", str(user_id))
        .not_.is_("end_time", "null")
        .order("start_time", desc=True)
        .limit(limit)
        .execute()
        .data or []
    )

    history = []
    for row in rows:
        started_at = datetime.fromisoformat(row["start_time"].replace("Z", "+00:00"))
        completed_at = datetime.fromisoformat(row["end_time"].replace("Z", "+00:00")) if row.get("end_time") else None
        exercises: dict[str, dict] = {}
        for set_row in sorted(row.get("workout_sets") or [], key=lambda item: item.get("exercise_order") or 0):
            exercise_id = str(set_row["exercise_id"])
            exercise = set_row.get("exercises") or {}
            if isinstance(exercise, list):
                exercise = exercise[0] if exercise else {}
            ex_name = exercise.get("name") or "Exercise"
            is_cardio = (
                _is_cardio_exercise(exercise_id, exercise)
                or set_row.get("duration_seconds") is not None
                or set_row.get("distance_km") is not None
            )
            item = exercises.setdefault(exercise_id, {
                "exercise_id": exercise_id,
                "name": ex_name,
                "is_cardio": is_cardio,
                "sets": [],
            })
            if is_cardio:
                item["is_cardio"] = True
                raw_dur = set_row.get("duration_seconds")
                raw_dist = set_row.get("distance_km")
                dur_val = int(raw_dur) if raw_dur is not None else int(set_row.get("reps") or 0)
                dist_val = float(raw_dist) if raw_dist is not None else float(set_row.get("weight") or 0)
                item["sets"].append(WorkoutHistorySet(
                    set_number=set_row["set_number"],
                    reps=0,
                    weight_kg=0.0,
                    rpe=set_row.get("rpe"),
                    duration_seconds=dur_val if dur_val > 0 else None,
                    distance_km=dist_val if dist_val > 0 else None,
                    is_completed=bool(set_row.get("is_done")),
                ))
            else:
                item["sets"].append(WorkoutHistorySet(
                    set_number=set_row["set_number"],
                    reps=set_row["reps"],
                    weight_kg=float(set_row.get("weight") or 0),
                    rpe=set_row.get("rpe"),
                    is_completed=bool(set_row.get("is_done")),
                ))

        routine = row.get("routines") or {}
        if isinstance(routine, list):
            routine = routine[0] if routine else {}
        history.append(WorkoutHistoryEntry(
            id=row["id"],
            routine_id=row.get("routine_id"),
            name=row.get("name") or routine.get("name") or "Custom workout",
            started_at=started_at,
            completed_at=completed_at,
            duration_seconds=max(0, int((completed_at - started_at).total_seconds())) if completed_at else 0,
            fatigue_level=row.get("fatigue_level"),
            exercises=[WorkoutHistoryExercise(**exercise) for exercise in exercises.values()],
        ))
    return WorkoutHistoryResponse(items=history)


def update_workout_history_entry(
    user_id: UUID,
    workout_id: UUID,
    payload: WorkoutLogUpdate,
) -> WorkoutLogResponse:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    workout_rows = (
        supabase.table("workouts")
        .select("id")
        .eq("id", str(workout_id))
        .eq("user_id", str(user_id))
        .limit(1)
        .execute()
        .data or []
    )
    if not workout_rows:
        raise HTTPException(status_code=404, detail="Workout history entry not found")

    set_records = _build_workout_set_records(payload.exercises, user_id, workout_id=str(workout_id))

    existing_sets = (
        supabase.table("workout_sets")
        .select("exercise_id,exercise_order,set_number,reps,weight,rpe,is_done")
        .eq("workout_id", str(workout_id))
        .execute()
        .data or []
    )
    updated_sets = False
    try:
        supabase.table("workout_sets").delete().eq("workout_id", str(workout_id)).execute()
        updated_sets = True
        if set_records:
            _insert_workout_sets(supabase, set_records)
        workout_update = {"name": payload.name.strip()}
        if payload.fatigue_level is not None:
            workout_update["fatigue_level"] = payload.fatigue_level
        response = (
            supabase.table("workouts")
            .update(workout_update)
            .eq("id", str(workout_id))
            .eq("user_id", str(user_id))
            .select("id")
            .execute()
        )
        if not response.data:
            raise RuntimeError("Workout history entry was not updated")
    except Exception as err:
        if updated_sets:
            try:
                supabase.table("workout_sets").delete().eq("workout_id", str(workout_id)).execute()
                if existing_sets:
                    restored_sets = [
                        {"workout_id": str(workout_id), **set_item}
                        for set_item in existing_sets
                    ]
                    supabase.table("workout_sets").insert(restored_sets).execute()
            except Exception:
                logger.exception("Could not restore workout sets after edit failed")
        logger.exception("Failed to update workout history entry")
        raise HTTPException(status_code=502, detail="Could not update workout history") from err

    return WorkoutLogResponse(id=workout_id, status="updated")


def delete_workout_history_entry(user_id: UUID, workout_id: UUID) -> None:
    supabase = get_supabase(admin=True)
    if supabase is None:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    workout = (
        supabase.table("workouts")
        .select("id")
        .eq("id", str(workout_id))
        .eq("user_id", str(user_id))
        .execute()
        .data or []
    )
    if not workout:
        raise HTTPException(status_code=404, detail="Workout history entry not found")

    try:
        supabase.table("workout_sets").delete().eq("workout_id", str(workout_id)).execute()
        supabase.table("workouts").delete().eq("id", str(workout_id)).eq("user_id", str(user_id)).execute()
    except Exception as err:
        logger.exception("Failed to delete workout history entry")
        raise HTTPException(status_code=502, detail="Could not delete workout history entry") from err


def summarize_today_workouts(user_id: UUID | str, today_start: datetime, today_end: datetime) -> int:
    """Total completed-workout seconds whose end falls inside [today_start, today_end)."""
    supabase = get_supabase(admin=True)
    if supabase is None:
        return 0
    try:
        rows = (
            supabase.table("workouts")
            .select("start_time,end_time")
            .eq("user_id", str(user_id))
            .not_.is_("end_time", "null")
            .gte("end_time", today_start.isoformat())
            .lt("end_time", today_end.isoformat())
            .execute()
            .data or []
        )
        total = 0.0
        for row in rows:
            start = row.get("start_time")
            end = row.get("end_time")
            if not start or not end:
                continue
            started = datetime.fromisoformat(start.replace("Z", "+00:00"))
            completed = datetime.fromisoformat(end.replace("Z", "+00:00"))
            total += max(0.0, (completed - started).total_seconds())
        return int(total)
    except Exception as err:
        logger.warning("Could not summarize today's workouts: %s", err)
        return 0