"""AI-powered weekly routine generator and natural-language modifier (Premium)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from app.core.config import get_settings
from app.core.i18n import get_language, normalize_language
from app.core.local_day import LocalDay, utc_day
from app.db.supabase_client import get_supabase
from app.schemas.exercise import Exercise
from app.schemas.weekly_routine import (
    EquipmentKey,
    ExperienceLevel,
    TrainingPhilosophy,
    Weekday,
    WeeklyRoutineAcceptRequest,
    WeeklyRoutineAcceptResponse,
    WeeklyRoutineDay,
    WeeklyRoutineDraft,
    WeeklyRoutineExercise,
    WeeklyRoutineGenerateRequest,
    WeeklyRoutineModifyRequest,
)
from app.schemas.workout import RoutineCreate, RoutineExerciseCreate
from app.services import workout_service
from app.services.ai_service import get_ai_client
from app.services.exercise_catalog import load_cached_exercises, muscle_group_for, supabase_uuid_for
from app.services.workout_program import (
    MAX_REPS,
    MAX_SETS,
    MIN_REPS,
    MIN_SETS,
    TEMPLATES,
    load_staples,
    objective_guidance,
    prescription,
)

logger = logging.getLogger(__name__)

WEEKLY_AI_TIMEOUT_SECONDS = 28.0

_EXCLUDED_CATEGORIES = {"cardio", "stretching", "plyometrics"}

_EQUIPMENT_MAP: dict[EquipmentKey, set[str]] = {
    "barbell": {"barbell", "ez barbell", "olympic barbell"},
    "dumbbell": {"dumbbell"},
    "machine": {"leverage machine", "smith machine", "sled machine", "assisted"},
    "cable": {"cable", "rope"},
    "bodyweight": {"body weight", "weighted", "assisted"},
    "kettlebell": {"kettlebell"},
    "bands": {"band", "resistance band"},
}

_DAY_NAMES_EN: dict[Weekday, str] = {
    "mon": "Mon",
    "tue": "Tue",
    "wed": "Wed",
    "thu": "Thu",
    "fri": "Fri",
    "sat": "Sat",
    "sun": "Sun",
}
_DAY_NAMES_ES: dict[Weekday, str] = {
    "mon": "Lun",
    "tue": "Mar",
    "wed": "Mié",
    "thu": "Jue",
    "fri": "Vie",
    "sat": "Sáb",
    "sun": "Dom",
}

_TEMPLATE_TITLES_EN: dict[str, str] = {
    "full_body": "Full Body",
    "upper": "Upper Body",
    "lower": "Lower Body",
    "push": "Push",
    "pull": "Pull",
    "legs": "Legs",
}
_TEMPLATE_TITLES_ES: dict[str, str] = {
    "full_body": "Cuerpo completo",
    "upper": "Tren superior",
    "lower": "Tren inferior",
    "push": "Empuje",
    "pull": "Tirón",
    "legs": "Pierna",
}

_STOPWORDS = frozenset({
    "i", "me", "my", "dont", "don", "t", "do", "not", "like", "hate", "want", "please",
    "change", "swap", "replace", "with", "for", "instead", "of", "the", "a", "an", "to",
    "no", "me", "gusta", "quiero", "cambia", "cambiar", "por", "en", "vez", "de", "la",
    "el", "los", "las", "un", "una", "con", "sin", "more", "less", "mas", "más", "menos",
    "day", "days", "dia", "día", "días", "dias", "prefer", "prefiero", "similar", "exercise",
    "exercises", "ejercicio", "ejercicios", "or", "o", "and", "y",
})

_WEEKLY_PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "plan_title": {"type": "string"},
        "split_name": {"type": "string"},
        "summary": {"type": "string"},
        "change_summary": {"type": ["string", "null"]},
        "days": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "day": {"type": "string"},
                    "routine_name": {"type": "string"},
                    "focus": {"type": "string"},
                    "exercises": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "exercise_id": {"type": "string"},
                                "target_sets": {"type": "integer"},
                                "target_reps": {"type": "integer"},
                            },
                            "required": ["exercise_id", "target_sets", "target_reps"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["day", "routine_name", "focus", "exercises"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["plan_title", "split_name", "summary", "change_summary", "days"],
    "additionalProperties": False,
}


def _adjust_guidance_for_style(
    guidance: dict[str, Any],
    experience_level: ExperienceLevel = "intermediate",
    philosophy: TrainingPhilosophy | None = None,
) -> dict[str, Any]:
    adjusted = dict(guidance)
    if experience_level == "beginner":
        adjusted["min_sets"] = min(adjusted["min_sets"], 2)
        adjusted["max_sets"] = min(adjusted["max_sets"], 3)

    if philosophy == "heavy_duty":
        adjusted["min_sets"] = 1
        adjusted["max_sets"] = 2
        adjusted["min_reps"] = max(5, adjusted["min_reps"])
        adjusted["max_reps"] = min(10, max(adjusted["min_reps"] + 2, adjusted["max_reps"]))
        adjusted["rest_seconds"] = 180
        adjusted["summary"] = "Heavy Duty / HIT: 1–2 working sets near failure, controlled tempo, long rest"
    elif philosophy == "high_volume":
        max_sets = 4 if experience_level == "beginner" else 5
        adjusted["min_sets"] = 3
        adjusted["max_sets"] = max_sets
        adjusted["rest_seconds"] = max(60, adjusted["rest_seconds"] - 15)
        adjusted["summary"] = "High volume: higher set density across compounds & accessories at controlled RPE 7–8.5"
    elif philosophy == "powerbuilding":
        adjusted["rest_seconds"] = 150
        adjusted["summary"] = "Powerbuilding: heavy 3–5 rep primary compounds followed by 8–12 rep hypertrophy accessories"
    elif philosophy == "minimalist":
        adjusted["min_sets"] = 2
        adjusted["max_sets"] = min(adjusted["max_sets"], 3)
        adjusted["summary"] = "Minimalist: essential high-return compound lifts with lean total volume"

    return adjusted


def _exercises_per_session(
    duration_minutes: int,
    experience_level: ExperienceLevel = "intermediate",
    philosophy: TrainingPhilosophy | None = None,
) -> int:
    if duration_minutes <= 35:
        base = 4
    elif duration_minutes <= 50:
        base = 5
    elif duration_minutes <= 75:
        base = 6
    else:
        base = 7

    if philosophy == "minimalist":
        return 3 if duration_minutes <= 35 else min(base, 4)
    if philosophy == "heavy_duty":
        return 4 if duration_minutes <= 45 else min(base, 5)
    if experience_level == "beginner":
        return min(base, 5)
    if philosophy == "high_volume" and duration_minutes >= 60:
        return min(7, base + 1)
    return base


def _estimate_day_duration(exercises: list[WeeklyRoutineExercise], rest_seconds: int) -> int:
    total_sets = sum(ex.target_sets for ex in exercises)
    # ~45s working set + rest interval + 5 min transition/warmup buffer
    minutes = round((total_sets * (45 + rest_seconds)) / 60) + 5
    return max(15, min(180, minutes))


def _choose_weekly_split(
    days: list[Weekday],
    branch: str,
    experience_level: ExperienceLevel = "intermediate",
) -> tuple[str, list[str]]:
    count = len(days)
    if count == 1:
        return "Full Body (1x/wk)", ["full_body"]
    if count == 2:
        return "Full Body A/B", ["full_body", "full_body"]
    if count == 3:
        if experience_level == "beginner" or branch in ("strength", "fat_loss", "endurance"):
            return "Full Body 3-Day", ["full_body", "full_body", "full_body"]
        return "Push / Pull / Legs", ["push", "pull", "legs"]
    if count == 4:
        return "Upper / Lower (4-Day)", ["upper", "lower", "upper", "lower"]
    if count == 5:
        return "Upper / Lower / PPL", ["upper", "lower", "push", "pull", "legs"]
    if count == 6:
        return "Push / Pull / Legs (6-Day)", ["push", "pull", "legs", "push", "pull", "legs"]
    return "PPL + Upper/Lower/Full", ["push", "pull", "legs", "upper", "lower", "full_body", "upper"]


def _exercise_matches_equipment(exercise: Exercise, equipment_keys: list[EquipmentKey]) -> bool:
    if "full_gym" in equipment_keys:
        return True
    allowed_tags: set[str] = set()
    for key in equipment_keys:
        allowed_tags.update(_EQUIPMENT_MAP.get(key, set()))
    ex_tags = {tag.strip().lower() for tag in (exercise.equipment or []) if tag and tag.strip()}
    if not ex_tags:
        return "bodyweight" in equipment_keys
    return bool(ex_tags & allowed_tags)


def filter_exercises_by_equipment(equipment_keys: list[EquipmentKey]) -> list[dict[str, Any]]:
    """Return enriched catalog records permitted by the user's available equipment."""
    staples = load_staples()
    filtered: list[dict[str, Any]] = []
    for ex in load_cached_exercises():
        category = (ex.category or "").strip().lower()
        if category in _EXCLUDED_CATEGORIES:
            continue
        if not _exercise_matches_equipment(ex, equipment_keys):
            continue
        staple = staples.get(ex.id) or {}
        uid = supabase_uuid_for(ex)
        filtered.append({
            "exercise_id": uid,
            "slug": ex.id,
            "name": ex.name,
            "muscle_group": muscle_group_for(ex),
            "muscles": [m.lower() for m in (ex.muscles or [])],
            "equipment": list(ex.equipment or []),
            "movement": str(staple.get("movement") or "other"),
            "compound": bool(staple.get("compound")),
            "priority": int(staple.get("priority") or (60 if staple else 200)),
            "is_staple": bool(staple),
        })
    filtered.sort(key=lambda item: (item["priority"], not item["compound"], item["name"]))
    return filtered


def _tokens(text: str) -> set[str]:
    return {
        tok
        for tok in re.findall(r"[a-z0-9áéíóúüñ]+", (text or "").lower())
        if len(tok) >= 3 and tok not in _STOPWORDS
    }


def _build_candidate_pool(
    filtered: list[dict[str, Any]],
    feedback: str = "",
    current_draft: WeeklyRoutineDraft | None = None,
) -> list[dict[str, Any]]:
    """Build a compact prompt-sized candidate list preserving staples + feedback alternatives."""
    chosen: dict[str, dict[str, Any]] = {}

    def _add(item: dict[str, Any], limit: int = 85) -> None:
        if len(chosen) >= limit:
            return
        chosen.setdefault(item["exercise_id"], item)

    # 1. Include all exercises currently in draft (if valid under selected equipment).
    draft_muscles: set[str] = set()
    by_id = {item["exercise_id"]: item for item in filtered}
    if current_draft is not None:
        for day in current_draft.days:
            for ex in day.exercises:
                if ex.exercise_id in by_id:
                    _add(by_id[ex.exercise_id])
                draft_muscles.add(ex.muscle_group.lower())

    # 2. Match feedback keywords (e.g. "machine", "dumbbell", "bench", "cable", "squat") to find swaps.
    fb_tokens = _tokens(feedback)
    if fb_tokens:
        scored: list[tuple[int, dict[str, Any]]] = []
        for item in filtered:
            haystack = " ".join([
                item["name"].lower(),
                item["muscle_group"].lower(),
                " ".join(e.lower() for e in item["equipment"]),
            ])
            hits = sum(1 for tok in fb_tokens if tok in haystack)
            if hits > 0:
                scored.append((hits * 10 - (0 if item["is_staple"] else 3), item))
        scored.sort(key=lambda pair: (-pair[0], pair[1]["priority"], pair[1]["name"]))
        for _, item in scored[:25]:
            _add(item)

    # 3. Same-muscle alternatives (covering machines, dumbbells, cables, barbells, bodyweight) for draft muscles.
    if draft_muscles:
        for item in filtered:
            if item["muscle_group"].lower() in draft_muscles:
                _add(item)

    # 4. Core staples across movement patterns.
    by_movement: dict[str, list[dict[str, Any]]] = {}
    for item in filtered:
        if item["is_staple"]:
            by_movement.setdefault(item["movement"], []).append(item)
    for items in by_movement.values():
        for item in items[:5]:
            _add(item)

    # 5. Backfill up to 85 items for narrow equipment filters (e.g. kettlebell-only or bands-only).
    for item in filtered:
        if len(chosen) >= 85:
            break
        _add(item, limit=85)

    return [
        {
            "exercise_id": item["exercise_id"],
            "name": item["name"],
            "muscle_group": item["muscle_group"],
            "equipment": item["equipment"],
            "movement": item["movement"],
            "compound": item["compound"],
        }
        for item in chosen.values()
    ]


def _request_weekly_json(
    system_prompt: str,
    user_payload: dict[str, Any],
    schema: dict[str, Any] = _WEEKLY_PLAN_SCHEMA,
) -> dict[str, Any]:
    """Call the configured OpenAI-compatible client and return parsed JSON."""
    settings = get_settings()
    if not settings.ai_api_key:
        raise ValueError("AI is not configured")

    is_gpt_oss = "gpt-oss" in settings.ai_model.lower()
    client = get_ai_client().with_options(timeout=WEEKLY_AI_TIMEOUT_SECONDS, max_retries=0)
    request: dict[str, Any] = {
        "model": settings.ai_model,
        "temperature": 0.4,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload)},
        ],
    }
    if is_gpt_oss:
        request["reasoning_effort"] = "low"
        request["max_completion_tokens"] = 3000
        request["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "weekly_routine", "strict": True, "schema": schema},
        }
    else:
        request["max_tokens"] = 2400
        request["response_format"] = {"type": "json_object"}

    response = client.chat.completions.create(**request)
    raw = (response.choices[0].message.content or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("AI weekly routine response was not a JSON object")
    return parsed


def _fallback_day_exercises(
    template_key: str,
    target_count: int,
    guidance: dict[str, Any],
    filtered: list[dict[str, Any]],
    day_index: int,
    philosophy: TrainingPhilosophy | None = None,
) -> list[WeeklyRoutineExercise]:
    movements = TEMPLATES.get(template_key, TEMPLATES["full_body"])
    by_movement: dict[str, list[dict[str, Any]]] = {}
    for item in filtered:
        by_movement.setdefault(item["movement"], []).append(item)

    selected: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for movement in movements:
        if len(selected) >= target_count:
            break
        opts = [item for item in by_movement.get(movement, []) if item["exercise_id"] not in used_ids]
        if opts:
            pick_item = opts[day_index % len(opts)] if len(opts) > 1 and template_key in ("full_body", "upper", "lower") else opts[0]
            selected.append(pick_item)
            used_ids.add(pick_item["exercise_id"])

    # Fill up to target_count from matching muscle groups / compounds if staple slots were scarce
    if len(selected) < target_count:
        preferred_muscles = {
            "push": {"chest", "shoulders", "arms"},
            "pull": {"back", "shoulders", "arms"},
            "legs": {"legs", "calves", "abs"},
            "lower": {"legs", "calves", "abs"},
            "upper": {"chest", "back", "shoulders", "arms"},
        }.get(template_key)
        for item in filtered:
            if len(selected) >= target_count:
                break
            if item["exercise_id"] in used_ids:
                continue
            if preferred_muscles and item["muscle_group"].lower() not in preferred_muscles:
                continue
            selected.append(item)
            used_ids.add(item["exercise_id"])
    for item in filtered:
        if len(selected) >= target_count:
            break
        if item["exercise_id"] not in used_ids:
            selected.append(item)
            used_ids.add(item["exercise_id"])

    if philosophy == "minimalist":
        compounds = [item for item in selected if item["compound"]]
        if len(compounds) >= target_count:
            selected = compounds[:target_count]

    selected.sort(key=lambda item: (not item["compound"], item["priority"]))
    result: list[WeeklyRoutineExercise] = []
    for pos, item in enumerate(selected[:target_count]):
        if philosophy == "powerbuilding":
            if item["compound"] and pos < 2:
                sets, reps = (min(4, guidance["max_sets"] + 1) if guidance["max_sets"] < 4 else 4), 4
            else:
                sets, reps = max(guidance["min_sets"], 3), 10 + (pos % 2)
        else:
            sets, reps = prescription(item["movement"], item["compound"], guidance, pos)
        result.append(
            WeeklyRoutineExercise(
                exercise_id=item["exercise_id"],
                name=item["name"],
                muscle_group=item["muscle_group"],
                equipment=item["equipment"],
                target_sets=sets,
                target_reps=reps,
            )
        )
    return result


def _hydrate_draft(
    raw_plan: dict[str, Any] | None,
    preferences: WeeklyRoutineGenerateRequest,
    objective: str,
    filtered: list[dict[str, Any]],
    split_name: str,
    template_keys: list[str],
    is_es: bool,
    fallback_change_summary: str | None = None,
) -> WeeklyRoutineDraft:
    guidance = _adjust_guidance_for_style(
        objective_guidance(objective),
        preferences.experience_level,
        preferences.training_philosophy,
    )
    target_count = _exercises_per_session(
        preferences.duration_minutes,
        preferences.experience_level,
        preferences.training_philosophy,
    )
    max_ex_allowed = 4 if preferences.training_philosophy == "minimalist" else max(target_count, 7)
    max_sets_allowed = guidance["max_sets"] if preferences.training_philosophy == "heavy_duty" or preferences.experience_level == "beginner" else MAX_SETS
    min_sets_allowed = guidance["min_sets"] if preferences.training_philosophy == "high_volume" else MIN_SETS
    filtered_by_id = {item["exercise_id"]: item for item in filtered}
    day_labels = _DAY_NAMES_ES if is_es else _DAY_NAMES_EN
    tpl_labels = _TEMPLATE_TITLES_ES if is_es else _TEMPLATE_TITLES_EN

    raw_days_by_key: dict[str, dict[str, Any]] = {}
    if isinstance(raw_plan, dict) and isinstance(raw_plan.get("days"), list):
        for entry in raw_plan["days"]:
            if isinstance(entry, dict) and isinstance(entry.get("day"), str):
                raw_days_by_key[entry["day"].strip().lower()] = entry

    days_out: list[WeeklyRoutineDay] = []
    for idx, day_key in enumerate(preferences.days):
        tpl_key = template_keys[idx % len(template_keys)]
        raw_day = raw_days_by_key.get(day_key) or {}
        validated_exercises: list[WeeklyRoutineExercise] = []
        seen_ids: set[str] = set()

        for raw_ex in raw_day.get("exercises") or []:
            if not isinstance(raw_ex, dict):
                continue
            ex_id = str(raw_ex.get("exercise_id") or "").strip()
            catalog_item = filtered_by_id.get(ex_id)
            if catalog_item is None or ex_id in seen_ids:
                continue
            seen_ids.add(ex_id)
            raw_sets = raw_ex.get("target_sets")
            raw_reps = raw_ex.get("target_reps")
            sets = max(min_sets_allowed, min(max_sets_allowed, int(raw_sets))) if isinstance(raw_sets, int) and not isinstance(raw_sets, bool) else guidance["max_sets"]
            reps = max(MIN_REPS, min(MAX_REPS, int(raw_reps))) if isinstance(raw_reps, int) and not isinstance(raw_reps, bool) else guidance["min_reps"]
            validated_exercises.append(
                WeeklyRoutineExercise(
                    exercise_id=catalog_item["exercise_id"],
                    name=catalog_item["name"],
                    muscle_group=catalog_item["muscle_group"],
                    equipment=catalog_item["equipment"],
                    target_sets=sets,
                    target_reps=reps,
                )
            )
            if len(validated_exercises) >= max_ex_allowed:
                break

        if len(validated_exercises) < min(3, target_count):
            validated_exercises = _fallback_day_exercises(
                tpl_key,
                target_count,
                guidance,
                filtered,
                idx,
                philosophy=preferences.training_philosophy,
            )

        default_focus = tpl_labels.get(tpl_key, "Full Body")
        focus = str(raw_day.get("focus") or default_focus).strip()[:80] or default_focus
        default_name = f"{day_labels[day_key]} · {focus}"[:100]
        routine_name = str(raw_day.get("routine_name") or default_name).strip()[:100] or default_name
        days_out.append(
            WeeklyRoutineDay(
                day=day_key,
                routine_name=routine_name,
                focus=focus,
                estimated_duration_minutes=_estimate_day_duration(validated_exercises, guidance["rest_seconds"]),
                exercises=validated_exercises,
            )
        )

    plan_title = str((raw_plan or {}).get("plan_title") or (
        f"Plan semanal · {split_name}" if is_es else f"Weekly Plan · {split_name}"
    )).strip()[:120]
    resolved_split = str((raw_plan or {}).get("split_name") or split_name).strip()[:80]
    default_summary = (
        f"Plan de {len(days_out)} días (~{preferences.duration_minutes} min/sesión) enfocado en {objective}."
        if is_es
        else f"{len(days_out)}-day split (~{preferences.duration_minutes} min/session) tailored to {objective}."
    )
    summary = str((raw_plan or {}).get("summary") or default_summary).strip()[:400]
    raw_change = (raw_plan or {}).get("change_summary")
    change_summary = (str(raw_change).strip()[:400] if isinstance(raw_change, str) and raw_change.strip() else fallback_change_summary)

    return WeeklyRoutineDraft(
        plan_title=plan_title,
        split_name=resolved_split,
        objective=objective,
        experience_level=preferences.experience_level,
        training_philosophy=preferences.training_philosophy,
        summary=summary,
        change_summary=change_summary,
        days=days_out,
    )


def _deterministic_modify_fallback(
    payload: WeeklyRoutineModifyRequest,
    filtered: list[dict[str, Any]],
    is_es: bool,
) -> WeeklyRoutineDraft:
    """Apply basic deterministic swaps/resizing if the AI endpoint is unavailable."""
    fb = payload.feedback.lower()
    fb_words = _tokens(payload.feedback)
    prefer_machine = any(word in fb for word in ("machine", "maquina", "máquina"))
    prefer_dumbbell = any(word in fb for word in ("dumbbell", "mancuerna", "mancuernas"))
    prefer_cable = any(word in fb for word in ("cable", "polea"))

    swapped_notes: list[str] = []
    new_days: list[WeeklyRoutineDay] = []
    guidance = objective_guidance(payload.current_draft.objective)

    for day in payload.current_draft.days:
        used_in_day = {ex.exercise_id for ex in day.exercises}
        new_exercises: list[WeeklyRoutineExercise] = []
        for ex in day.exercises:
            ex_words = _tokens(ex.name)
            overlap = fb_words & ex_words
            wants_swap = len(overlap) >= 2 or (len(overlap) == 1 and any(tok in fb for tok in ("no ", "hate", "don't", "dont", "dislike", "gusta", "cambia", "swap", "replace")))
            if wants_swap:
                candidates = [
                    item
                    for item in filtered
                    if item["exercise_id"] not in used_in_day
                    and item["muscle_group"].lower() == ex.muscle_group.lower()
                    and not (_tokens(item["name"]) & overlap)
                ]
                if prefer_machine:
                    candidates.sort(key=lambda item: (0 if any("machine" in e.lower() for e in item["equipment"]) else 1, item["priority"]))
                elif prefer_dumbbell:
                    candidates.sort(key=lambda item: (0 if any("dumbbell" in e.lower() for e in item["equipment"]) else 1, item["priority"]))
                elif prefer_cable:
                    candidates.sort(key=lambda item: (0 if any("cable" in e.lower() for e in item["equipment"]) else 1, item["priority"]))
                if candidates:
                    alt = candidates[0]
                    used_in_day.add(alt["exercise_id"])
                    swapped_notes.append(f"{ex.name} → {alt['name']}")
                    new_exercises.append(
                        WeeklyRoutineExercise(
                            exercise_id=alt["exercise_id"],
                            name=alt["name"],
                            muscle_group=alt["muscle_group"],
                            equipment=alt["equipment"],
                            target_sets=ex.target_sets,
                            target_reps=ex.target_reps,
                        )
                    )
                    continue
            new_exercises.append(ex)
        new_days.append(
            WeeklyRoutineDay(
                day=day.day,
                routine_name=day.routine_name,
                focus=day.focus,
                estimated_duration_minutes=_estimate_day_duration(new_exercises, guidance["rest_seconds"]),
                exercises=new_exercises,
            )
        )

    change_summary = (
        (", ".join(swapped_notes) if swapped_notes else payload.feedback[:120])
        + (" (adaptado localmente)" if is_es and not swapped_notes else "")
    )[:400]
    return WeeklyRoutineDraft(
        plan_title=payload.current_draft.plan_title,
        split_name=payload.current_draft.split_name,
        objective=payload.current_draft.objective,
        experience_level=payload.preferences.experience_level,
        training_philosophy=payload.preferences.training_philosophy,
        summary=payload.current_draft.summary,
        change_summary=change_summary,
        days=new_days,
    )


def generate_weekly_routine(
    preferences: WeeklyRoutineGenerateRequest,
    user_objective: str | None = None,
    lang: str | None = None,
) -> WeeklyRoutineDraft:
    active_lang = normalize_language(lang) if lang is not None else get_language()
    is_es = active_lang == "es"
    objective = preferences.objective or (user_objective or "").strip() or "Hypertrophy"
    guidance = _adjust_guidance_for_style(
        objective_guidance(objective),
        preferences.experience_level,
        preferences.training_philosophy,
    )
    filtered = filter_exercises_by_equipment(preferences.equipment)
    if not filtered:
        raise HTTPException(status_code=400, detail="No exercises matched the selected equipment.")

    split_name, template_keys = _choose_weekly_split(
        preferences.days, guidance["branch"], preferences.experience_level
    )
    target_count = _exercises_per_session(
        preferences.duration_minutes,
        preferences.experience_level,
        preferences.training_philosophy,
    )
    pool = _build_candidate_pool(filtered, feedback=preferences.notes or "")

    style_note = (
        f"Training philosophy: {preferences.training_philosophy} ({guidance['summary']}). "
        if preferences.training_philosophy
        else ""
    )
    level_note = (
        "Experience level: beginner (keep exercise selection simple and stable, prioritize machines/dumbbells/basic compounds, controlled sets)."
        if preferences.experience_level == "beginner"
        else f"Experience level: {preferences.experience_level}."
    )
    lang_rule = "Write plan_title, split_name, summary, routine_name, and focus in natural Spanish." if is_es else "Write all text in natural English."
    system_prompt = (
        "You are BOOOST's AI strength and conditioning coach. Build a safe, well-structured weekly workout routine "
        "from the supplied candidate exercise catalog ONLY. Every exercise_id MUST appear verbatim in candidate_pool. "
        f"Match the user's goal ({objective}: {guidance['summary']}, {guidance['min_sets']}-{guidance['max_sets']} sets, "
        f"{guidance['min_reps']}-{guidance['max_reps']} reps), {level_note} {style_note}"
        f"Selected training days: {preferences.days}, target session length (~{preferences.duration_minutes} min, ~{target_count} exercises per day), "
        "and available equipment. Start each day with compound movements before isolation work, avoid duplicate exercises within the same day, "
        f"set change_summary to null, and reply with JSON matching the schema only. {lang_rule}"
    )
    user_payload = {
        "days": preferences.days,
        "recommended_split": split_name,
        "recommended_day_focuses": [{"day": d, "focus": template_keys[i % len(template_keys)]} for i, d in enumerate(preferences.days)],
        "duration_minutes": preferences.duration_minutes,
        "exercises_per_day": target_count,
        "equipment": preferences.equipment,
        "objective": objective,
        "experience_level": preferences.experience_level,
        "training_philosophy": preferences.training_philosophy,
        "notes": preferences.notes,
        "candidate_pool": pool,
    }

    raw_plan: dict[str, Any] | None = None
    try:
        raw_plan = _request_weekly_json(system_prompt, user_payload)
    except Exception as err:
        logger.warning("Weekly routine AI generation fell back to deterministic builder: %s", err)

    return _hydrate_draft(raw_plan, preferences, objective, filtered, split_name, template_keys, is_es)


def modify_weekly_routine(
    payload: WeeklyRoutineModifyRequest,
    lang: str | None = None,
) -> WeeklyRoutineDraft:
    active_lang = normalize_language(lang) if lang is not None else get_language()
    is_es = active_lang == "es"
    objective = payload.current_draft.objective
    guidance = _adjust_guidance_for_style(
        objective_guidance(objective),
        payload.preferences.experience_level,
        payload.preferences.training_philosophy,
    )
    filtered = filter_exercises_by_equipment(payload.preferences.equipment)
    if not filtered:
        raise HTTPException(status_code=400, detail="No exercises matched the selected equipment.")

    split_name, template_keys = _choose_weekly_split(
        payload.preferences.days, guidance["branch"], payload.preferences.experience_level
    )
    pool = _build_candidate_pool(
        filtered,
        feedback=payload.feedback,
        current_draft=payload.current_draft,
    )

    lang_rule = "Write plan_title, split_name, summary, change_summary, routine_name, and focus in natural Spanish." if is_es else "Write all text in natural English."
    system_prompt = (
        "You are BOOOST's AI trainer adapting a user's existing weekly routine draft based on their natural-language feedback. "
        "Preserve all days and exercises the user did NOT ask to change, and apply their requested replacements, volume adjustments, "
        "or focus shifts using ONLY exercise_ids present verbatim in candidate_pool (all pre-filtered for their available equipment). "
        "When swapping a disliked exercise (e.g. 'I don't like bench press'), replace it across every day it appears with a close biomechanical "
        "alternative (e.g. machine chest press, dumbbell bench press, or cable press). Populate change_summary with a short, concrete sentence "
        f"explaining what you changed. Reply with JSON matching the schema only. {lang_rule}"
    )
    user_payload = {
        "preferences": payload.preferences.model_dump(mode="json"),
        "current_draft": payload.current_draft.model_dump(mode="json"),
        "feedback_history": payload.feedback_history,
        "latest_feedback": payload.feedback,
        "candidate_pool": pool,
    }

    try:
        raw_plan = _request_weekly_json(system_prompt, user_payload)
        return _hydrate_draft(
            raw_plan,
            payload.preferences,
            objective,
            filtered,
            split_name,
            template_keys,
            is_es,
            fallback_change_summary=payload.feedback[:200],
        )
    except Exception as err:
        logger.warning("Weekly routine AI modification fell back cleanly: %s", err)
        return _deterministic_modify_fallback(payload, filtered, is_es)


def accept_weekly_routine(
    user_id: UUID,
    payload: WeeklyRoutineAcceptRequest,
    day: LocalDay | None = None,
) -> WeeklyRoutineAcceptResponse:
    active_day = day or utc_day()
    supabase = get_supabase(admin=True)
    if supabase is not None:
        try:
            # Replace any prior weekly schedule so older plan days stay in My Routines without colliding.
            supabase.table("routines").update({"scheduled_day": None}).eq("user_id", str(user_id)).not_.is_(
                "scheduled_day", "null"
            ).execute()
        except Exception as err:
            logger.warning("Could not clear prior weekly schedule before saving new plan: %s", err)

    saved = []
    for day_plan in payload.days:
        routine = RoutineCreate(
            name=day_plan.routine_name,
            scheduled_day=day_plan.day,
            exercises=[
                RoutineExerciseCreate(
                    exercise_id=ex.exercise_id,
                    target_sets=ex.target_sets,
                    target_reps=ex.target_reps,
                    reps_by_set=[ex.target_reps] * ex.target_sets,
                )
                for ex in day_plan.exercises
            ],
        )
        saved.append(workout_service.create_user_routine(user_id, routine))

    if supabase is not None:
        try:
            # Refresh today's AI workout plan on Home/Workouts so it picks up the newly accepted schedule.
            supabase.table("workout_plans").delete().eq("user_id", str(user_id)).eq(
                "plan_date", active_day.local_date.isoformat()
            ).execute()
        except Exception as err:
            logger.warning("Could not clear today's cached daily plan after saving weekly routine: %s", err)

    return WeeklyRoutineAcceptResponse(routines=saved)
