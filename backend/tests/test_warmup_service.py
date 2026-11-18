from app.schemas.workout import WarmupExercise, WarmupRecommendationRequest
from app.services.warmup_service import _AIWarmupPlan, _validate_warmup_plan


def _ramp(working_weight: float, weights: list[float]) -> list[float | None]:
    payload = WarmupRecommendationRequest(
        exercises=[WarmupExercise(exercise_id="bench", name="Bench Press", working_weight_kg=working_weight)],
    )
    plan = _AIWarmupPlan.model_validate({
        "general_warmup_seconds": 120,
        "cardio_warmups": [],
        "exercise_warmups": [{"exercise_id": "bench", "sets": [{"weight_kg": w, "reps": 5} for w in weights]}],
    })
    step = _validate_warmup_plan(payload, plan).steps[1]
    return [warmup_set.weight_kg for warmup_set in step.sets]


def test_light_ramp_is_kept():
    assert _ramp(102, [40, 50, 60]) == [40, 50, 60]


def test_sets_above_sixty_percent_are_capped_to_a_plate_step():
    # 60% of 102 kg is 61.2 kg, rounded down to 60 kg.
    assert _ramp(102, [50, 70, 82]) == [50, 60, 60]
