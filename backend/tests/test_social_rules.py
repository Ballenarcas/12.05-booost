from datetime import datetime, timedelta, timezone

import pytest

from app.core.local_day import LocalDay
from app.services import social_service as social
from tests.social_fakes import FakeSupabase, catalog_exercise

BENCH, BENCH_NAME = catalog_exercise(0)
SQUAT, _ = catalog_exercise(1)
NOW = datetime.now(timezone.utc)


def test_text_is_normalized():
    assert social.normalize_text("  café\r\n\n\n\n\nok  ") == "café\n\nok"
    assert social.normalize_text("a" * 280) == "a" * 280
    assert social.normalize_text("hi 👩‍🚀") == "hi 👩‍🚀"  # joined emoji stay allowed


@pytest.mark.parametrize("text", ["a‮b", "a⁦b", "a​b", "a﻿b", "a\x00b", "a\x1bb", "a" * 281])
def test_spoofing_and_long_text_are_rejected(text):
    with pytest.raises(ValueError):
        social.normalize_text(text)


def test_usernames():
    assert social.validate_username("  Ana_99 ") == "ana_99"
    for bad in ("ab", "a" * 21, "ana lopez", "ána", "admin", "BOOOST", "me", "null", "a-b-c", "abc\ndef"):
        with pytest.raises(ValueError):
            social.validate_username(bad)


def test_search_terms():
    assert social.search_term("  José Núñez ") == "josé núñez"
    for bad in ("a", "a" * 41, "a,b)", "100%", "x*y", "a.b", "(or)", "a\\b"):
        with pytest.raises(ValueError):
            social.search_term(bad)


def _ctx(blocked=(), following=()):
    return social.ViewerContext("viewer", set(blocked), set(following))


@pytest.mark.parametrize("author,ctx,expected", [
    ({"id": "a", "username": None, "is_private": False}, _ctx(following=["a"]), False),
    ({"id": "a", "username": "a", "is_private": False}, _ctx(blocked=["a"]), False),
    ({"id": "viewer", "username": "v", "is_private": True}, _ctx(), True),
    ({"id": "a", "username": "a", "is_private": False}, _ctx(), True),
    ({"id": "a", "username": "a", "is_private": True}, _ctx(following=["a"]), True),
    ({"id": "a", "username": "a", "is_private": True}, _ctx(), False),
    (None, _ctx(), False),
])
def test_can_view(author, ctx, expected):
    assert social.can_view(ctx, author) is expected


def test_pr_only_when_strictly_heavier_than_earlier_workouts():
    db = FakeSupabase()
    user, other = db.make_user(), db.make_user()
    db.make_workout(user, [(BENCH, 60, 5, True), (SQUAT, 100, 5, True)], NOW - timedelta(days=7))
    db.make_workout(user, [(BENCH, 200, 5, True)], NOW + timedelta(hours=1))  # later: ignored
    db.make_workout(other, [(BENCH, 300, 5, True)], NOW - timedelta(days=7))  # someone else: ignored
    current = db.make_workout(
        user, [(BENCH, 62.5, 3, True), (BENCH, 90, 1, False), (SQUAT, 100, 8, True)], NOW - timedelta(days=1))

    assert social.workout_prs(db, user, current) == [{
        "exercise_id": BENCH, "exercise_name": BENCH_NAME, "weight_kg": 62.5, "reps": 3, "previous_best_kg": 60.0}]
    assert social.pr_card(db, user, current, BENCH) == {
        "exercise_name": BENCH_NAME, "weight_kg": 62.5, "reps": 3, "previous_best_kg": 60.0}
    with pytest.raises(ValueError):
        social.pr_card(db, user, current, SQUAT)


def test_first_time_bodyweight_and_cardio_sets_are_not_prs():
    db = FakeSupabase()
    user = db.make_user()
    db.make_workout(user, [(SQUAT, 0, 10, True)], NOW - timedelta(days=7))
    current = db.make_workout(user, [(BENCH, 80, 5, True), (SQUAT, 0, 20, True)], NOW - timedelta(days=1))
    assert social.workout_prs(db, user, current) == []


def test_someone_elses_or_unfinished_workout_gives_no_card():
    db = FakeSupabase()
    owner, thief = db.make_user(), db.make_user()
    mine = db.make_workout(owner, [(BENCH, 60, 5, True)])
    unfinished = db.make_workout(owner, [(BENCH, 60, 5, True)], finished=False)
    for user, workout in ((thief, mine), (owner, unfinished)):
        with pytest.raises(LookupError):
            social.workout_card(db, user, workout)


def test_workout_card_holds_only_listed_keys():
    db = FakeSupabase()
    user = db.make_user()
    workout = db.make_workout(
        user, [(BENCH, 60, 5, True), (SQUAT, 100, 5, True), (SQUAT, 100, 5, False)], name="Leg‮ day")

    card = social.workout_card(db, user, workout)

    assert set(card) == {
        "name", "duration_seconds", "exercise_count", "completed_sets", "total_volume_kg", "completed_at"}
    assert card["name"] == "Leg day"
    assert (card["duration_seconds"], card["exercise_count"], card["completed_sets"], card["total_volume_kg"]) == (
        2700, 2, 2, 800.0)


def _day():
    start = datetime(2026, 11, 20, 22, 0, tzinfo=timezone.utc)  # local midnight at UTC+2
    return LocalDay(start.date() + timedelta(days=1), start, start + timedelta(days=1))


@pytest.mark.parametrize("hours,expected", [
    ([], 0),
    ([5], 1),
    ([1 - 24 * n for n in range(7)], 7),
    ([23 - 24 * n for n in range(1, 8)], 7),   # ends yesterday
    ([1, -47], 1),                              # a missed day breaks it
    ([-1, 1], 2),                               # either side of local midnight
    ([-47], 0),
    ([30], 0),                                  # tomorrow does not count
])
def test_logging_streak(hours, expected):
    db = FakeSupabase()
    user = db.make_user()
    for offset in hours:
        db.make_meal(user, _day().start + timedelta(hours=offset))
    assert social.logging_streak(db, user, _day()) == expected


def test_streak_card_needs_seven_days_and_pages_past_the_row_cap():
    db = FakeSupabase(max_rows=1000)
    user = db.make_user()
    for day in range(6):
        for minute in range(200):
            db.make_meal(user, _day().start - timedelta(days=day) + timedelta(minutes=minute))
    with pytest.raises(ValueError):
        social.streak_card(db, user, _day())
    db.make_meal(user, _day().start - timedelta(days=6) + timedelta(hours=1))
    assert social.streak_card(db, user, _day()) == {"days": 7}
