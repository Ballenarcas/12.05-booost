"""Property-based tests: Hypothesis generates the inputs and shrinks any failure to a minimal case."""
import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from hypothesis import given, settings
from hypothesis import strategies as st

from app.services import overtraining_service
from app.services import workout_adjustment_service as workout_service
from app.services.calorie_adjustment_service import (
    FAT_LOSS_STEP, MAX_GOAL, MIN_GOAL, propose_adjustment,
)
from tests.test_workout_adjustment_service import FakeDatabase

metrics = st.fixed_dictionaries({
    "goal": st.integers(min_value=0, max_value=6000),
    "objective": st.sampled_from(["lose weight", "weight loss", "hypertrophy", "maintain", None]),
    "avg_intake": st.integers(min_value=0, max_value=8000),
    "days_logged": st.integers(min_value=0, max_value=7),
    "days_within": st.integers(min_value=0, max_value=7),
    "compliance": st.floats(min_value=0, max_value=1),
    "volume_this_week": st.integers(min_value=0, max_value=50_000),
    "volume_prev_week": st.integers(min_value=0, max_value=50_000),
    "deficit_floor": st.integers(min_value=0, max_value=4000),
    "maintenance": st.integers(min_value=0, max_value=4500),
    "fatigue_latest": st.one_of(st.none(), st.floats(min_value=0, max_value=10)),
})


@settings(max_examples=500)
@given(metrics)
def test_a_lowered_goal_never_passes_the_safety_floor(m):
    proposal = propose_adjustment(m)
    goal, proposed = m["goal"], proposal["proposed_goal"]
    if proposed < goal:
        assert proposed >= max(MIN_GOAL, m["deficit_floor"])
        assert goal - proposed <= FAT_LOSS_STEP


@settings(max_examples=500)
@given(metrics)
def test_a_proposal_is_consistent_and_bounded(m):
    proposal = propose_adjustment(m)
    assert proposal["has_change"] == (proposal["proposed_goal"] != m["goal"])
    assert proposal["proposed_goal"] <= max(m["goal"], MAX_GOAL)
    assert proposal["reason"]


@given(st.lists(st.fixed_dictionaries({
    "sets": st.integers(min_value=0, max_value=12),
    "previous_weight_kg": st.floats(min_value=0, max_value=400),
})), st.integers(min_value=5, max_value=50))
def test_a_deload_never_adds_sets_or_load(exercises, pct):
    for before, after in zip(exercises, overtraining_service._apply_deload_to_exercises(exercises, pct)):
        assert after["sets"] <= before["sets"]
        if before["sets"] >= 2:
            assert 1 <= after["sets"] < before["sets"]
        assert after["previous_weight_kg"] <= before["previous_weight_kg"] + 0.25  # rounded to 0.5 kg


@given(st.sets(st.integers(min_value=0, max_value=40)))
def test_a_training_streak_is_never_longer_than_the_days_trained(offsets):
    today = date(2026, 3, 1)
    days = {today - timedelta(days=n) for n in offsets}
    streak = overtraining_service._consecutive_training_days(days, today)
    assert 0 <= streak <= len(days)


json_values = st.recursive(
    st.none() | st.booleans() | st.integers() | st.text(max_size=20),
    lambda inner: st.lists(inner, max_size=4) | st.dictionaries(st.text(max_size=8), inner, max_size=4),
    max_leaves=10,
)


@given(json_values, st.sampled_from(["{}", "```json\n{}\n```", "```\n{}\n```"]))
def test_any_json_reply_survives_markdown_fences(value, wrapper):
    assert workout_service._parse_json(wrapper.replace("{}", json.dumps(value))) == value


@settings(max_examples=60, deadline=None)
@given(goal=st.integers(min_value=1200, max_value=4000), ratio=st.floats(min_value=0.3, max_value=2.0))
def test_the_48h_intake_is_classified_by_its_ratio_to_the_goal(goal, ratio):
    database = FakeDatabase()
    database.rows["users"][0]["calorie_goal"] = goal
    calories = round(goal * 2 * ratio)
    day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    database.rows["meals"] = [{"calories": calories, "proteins": 0, "carbs": 0, "fats": 0,
                               "consumed_at": (day_start - timedelta(hours=12)).isoformat()}]
    prompts = []

    async def recommend(prompt, _schema):
        prompts.append(json.loads(prompt))
        return {"routine_id": database.routine_id, "workout_name": "Routine", "rest_day": False,
                "adjusted": False, "reasoning": "ok",
                "exercises": [{"exercise_id": database.exercise_id, "sets": 2, "reps": 8}]}

    original_request, original_min = workout_service._request_json, workout_service.MIN_PLAN_EXERCISES
    workout_service._request_json, workout_service.MIN_PLAN_EXERCISES = recommend, 1
    workout_service._catalog_cache = None
    try:
        asyncio.run(workout_service.plan_daily_workout(UUID(database.rows["users"][0]["id"]), database))
    finally:
        workout_service._request_json, workout_service.MIN_PLAN_EXERCISES = original_request, original_min

    target = goal * 2
    expected = ("severe_deficit" if calories < target * 0.8
                else "severe_surplus" if calories > target * 1.2 else "near_target")
    assert prompts[0]["calorie_status"] == expected
