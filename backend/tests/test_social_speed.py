"""Community requests must not wait on Supabase one query at a time.

The fake sleeps on every query like a real round trip, so a request's time shows how many
waves of queries it runs. Independent queries in one wave run together.
"""

import time

import pytest

from app.facades import social_facade
from tests.social_fakes import FakeSupabase
from tests.test_social_api import World

LATENCY = 0.15


@pytest.fixture
def world(monkeypatch):
    db = FakeSupabase(latency=LATENCY)
    monkeypatch.setattr(social_facade, "get_supabase", lambda admin=False: db)
    monkeypatch.setattr(social_facade, "get_storage", lambda: db.storage)
    monkeypatch.setattr("app.core.auth.get_supabase", lambda admin=False: None)
    world = World(db)
    world.me = db.make_user("viewer")
    world.friend = db.make_user("friend", private=True)
    db.follow(world.me, world.friend)
    world.post = db.make_post(world.friend)
    world.db.table("social_comments").insert({"post_id": world.post, "user_id": world.friend, "body": "hi"}).execute()
    world.get("/me", world.me)  # the first request in a process pays one-off start-up costs
    return world


def timed(send):
    started = time.perf_counter()
    response = send()
    assert response.status_code < 300, response.text
    return (time.perf_counter() - started) / LATENCY


@pytest.mark.parametrize("name,waves,send", [
    ("me", 2, lambda w: w.get("/me", w.me)),
    ("discover", 2, lambda w: w.get("/feed", w.me, params={"mode": "discover"})),
    ("following", 3, lambda w: w.get("/feed", w.me, params={"mode": "following"})),
    ("post", 2, lambda w: w.get(f"/posts/{w.post}", w.me)),
    ("comments", 2, lambda w: w.get(f"/posts/{w.post}/comments", w.me)),
    ("like", 4, lambda w: w.put(f"/posts/{w.post}/like", w.me)),
    ("profile", 2, lambda w: w.get("/users/friend", w.me)),
    ("member posts", 3, lambda w: w.get("/users/friend/posts", w.me)),
    ("followers", 3, lambda w: w.get("/users/friend/followers", w.me)),
])
def test_requests_run_their_queries_in_few_waves(world, name, waves, send):
    assert timed(lambda: send(world)) < waves + 0.6, name


def test_me_lists_who_you_follow_for_the_profile_card(world):
    blocked = world.db.make_user("blocked_one")
    world.db.follow(world.me, blocked)
    world.db.tables["social_blocks"].append({"blocker_id": blocked, "blocked_id": world.me})
    me = world.get("/me", world.me).json()
    assert [member["username"] for member in me["following_preview"]] == ["friend"]
    assert me["following"] == 2
