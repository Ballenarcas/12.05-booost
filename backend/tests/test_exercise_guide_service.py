import json

from app.schemas.exercise import Exercise
from app.services.exercise_guide_service import DATA_DIR, guide_for


def test_staple_uses_its_movement_guide():
    guide = guide_for(Exercise(id="0025", name="Barbell Bench Press", category="Chest"))
    assert guide and "elbows at about 45 degrees" in " ".join(guide.cues)
    assert guide.mistakes and guide.breathing and guide.safety


def test_other_exercise_falls_back_to_its_category():
    guide = guide_for(Exercise(id="9999", name="Odd Curl", category="Arms"))
    assert guide and guide.tip.startswith("Keep your elbows still")


def test_custom_and_unknown_get_no_guide():
    assert guide_for(Exercise(id="0025", name="x", category="Chest", is_custom=True)) is None
    assert guide_for(Exercise(id="9999", name="x", category="Nope")) is None


def test_workout_uuid_resolves_to_catalog_exercise_with_guide():
    from app.facades.workout_facade import workout_facade

    exercise = workout_facade.get_exercise_by_id("25a3744a-8012-5d8d-a900-7922272a4b59")  # Barbell Full Squat
    assert exercise and exercise.id == "0043" and exercise.guide


def test_every_staple_movement_and_catalog_category_has_a_guide():
    guides = json.loads((DATA_DIR / "exercise_guides.json").read_text(encoding="utf-8"))
    staples = json.loads((DATA_DIR / "exercise_staples.json").read_text(encoding="utf-8"))["exercises"]
    catalog = json.loads((DATA_DIR / "exercises_catalog.json").read_text(encoding="utf-8"))
    assert {row["movement"] for row in staples} <= guides["movements"].keys()
    assert {row["category"] for row in catalog} <= guides["categories"].keys()
