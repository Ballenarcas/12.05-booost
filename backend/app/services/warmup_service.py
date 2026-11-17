"""Rule-based warm-up recommendations for a workout in progress.

The plan is built from the exercise order and the working weights already in
the live session. It never raises the planned load, never prescribes medical
advice, and keeps every ramp-up set below the working weight.
"""

from app.schemas.workout import (
    WarmupRecommendationRequest,
    WarmupRecommendationResponse,
    WarmupSet,
    WarmupStep,
)

GENERAL_WARMUP_SECONDS = 300
CARDIO_BUILD_UP_SECONDS = 180
RAMP_SET_SECONDS = 50
PLATE_STEP_KG = 2.5
MAX_RAMPED_EXERCISES = 2


def _round_load(weight_kg: float) -> float:
    return max(PLATE_STEP_KG, round(weight_kg / PLATE_STEP_KG) * PLATE_STEP_KG)


def _bodyweight_sets(full: bool) -> list[WarmupSet]:
    return [WarmupSet(weight_kg=None, reps=10) for _ in range(2 if full else 1)]


def _ramp_sets(weight_kg: float | None, full: bool) -> list[WarmupSet]:
    if weight_kg is None or weight_kg < 10:
        return _bodyweight_sets(full)
    if not full:
        return [WarmupSet(weight_kg=_round_load(weight_kg * 0.5), reps=5)]
    if weight_kg < 25:
        candidates = [
            WarmupSet(weight_kg=_round_load(weight_kg * 0.5), reps=10),
            WarmupSet(weight_kg=_round_load(weight_kg * 0.75), reps=6),
        ]
    else:
        candidates = [
            WarmupSet(weight_kg=_round_load(weight_kg * 0.4), reps=8),
            WarmupSet(weight_kg=_round_load(weight_kg * 0.6), reps=5),
            WarmupSet(weight_kg=_round_load(weight_kg * 0.8), reps=3),
        ]
    unique: list[WarmupSet] = []
    seen: set[float] = set()
    for warmup_set in candidates:
        if warmup_set.weight_kg in seen:
            continue
        seen.add(warmup_set.weight_kg)
        unique.append(warmup_set)
    return unique or _bodyweight_sets(full)


def _ramp_detail(weight_kg: float | None, full: bool) -> str:
    if weight_kg is None or weight_kg < 10:
        if full:
            return "Two easy sets at a light effort. Stop well short of failure before your working sets."
        return "One easy set at a light effort to prime the movement."
    if full:
        return "Ramp up with these easy sets, then start your planned working weight. Stop each set 2-3 reps before failure."
    return "One feeder set to prime the movement before your working sets."


def build_warmup_recommendation(payload: WarmupRecommendationRequest) -> WarmupRecommendationResponse:
    steps: list[WarmupStep] = [
        WarmupStep(
            title="General warm-up",
            detail=(
                "Easy cardio (bike, rower or brisk walk) until you are warm, then dynamic mobility "
                "for the joints you will train: arm circles, leg swings and hip openers."
            ),
            duration_seconds=GENERAL_WARMUP_SECONDS,
        )
    ]

    cardio_exercises = [exercise for exercise in payload.exercises if exercise.is_cardio]
    if cardio_exercises:
        first_cardio = cardio_exercises[0].name
        steps.append(WarmupStep(
            title="Cardio build-up",
            detail=(
                f"Start {first_cardio} at an easy pace and build up gradually over the first few "
                "minutes. Stay below your target effort while you warm up."
            ),
            duration_seconds=CARDIO_BUILD_UP_SECONDS,
        ))

    strength_exercises = [exercise for exercise in payload.exercises if not exercise.is_cardio]
    for index, exercise in enumerate(strength_exercises[:MAX_RAMPED_EXERCISES]):
        full = index == 0
        warmup_sets = _ramp_sets(exercise.working_weight_kg, full)
        steps.append(WarmupStep(
            title=exercise.name,
            detail=_ramp_detail(exercise.working_weight_kg, full),
            duration_seconds=len(warmup_sets) * RAMP_SET_SECONDS,
            exercise_id=exercise.exercise_id,
            sets=warmup_sets,
        ))

    if len(strength_exercises) > MAX_RAMPED_EXERCISES:
        steps.append(WarmupStep(
            title="Remaining exercises",
            detail=(
                "Treat the first set of each remaining exercise as a feeler: use a slightly lighter "
                "load and stop 2-3 reps before failure."
            ),
        ))

    total_seconds = sum(step.duration_seconds or 0 for step in steps)
    minutes = max(1, round(total_seconds / 60))
    if strength_exercises and cardio_exercises:
        count = len(strength_exercises)
        focus = f"{count} strength exercise{'s' if count != 1 else ''} and your cardio work"
        summary = (
            f"About {minutes} min to prepare {focus}. Keep every warm-up set easy and "
            "stop if you feel sharp pain."
        )
    elif strength_exercises:
        count = len(strength_exercises)
        focus = f"{count} strength exercise{'s' if count != 1 else ''}"
        summary = (
            f"About {minutes} min to prepare {focus}. Keep every warm-up set easy and "
            "stop if you feel sharp pain."
        )
    else:
        summary = (
            f"About {minutes} min to prepare your cardio work. Build up gradually, keep the start "
            "easy, and stop if you feel sharp pain."
        )

    return WarmupRecommendationResponse(
        summary=summary,
        total_duration_seconds=total_seconds,
        steps=steps,
    )
