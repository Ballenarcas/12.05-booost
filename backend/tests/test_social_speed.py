"""Community requests must not wait on Supabase one query at a time.

The fake sleeps on every query like a real round trip, so a request's time shows how many
waves of queries it runs. Independent queries in one wave run together.
"""

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
    world.stranger = db.make_user("stranger")
    world.own_post = db.make_post(world.me)
    world.get("/me", world.me)  # the first request in a process pays one-off start-up costs
    return world


def measure_waves(world, send) -> int:
    world.db.round_trips.clear()
    response = send()
    assert response.status_code < 300, response.text
    waves = 0
    wave_end = -1.0
    for started, ended in sorted(world.db.round_trips, key=lambda span: span[1]):
        if started >= wave_end:
            waves += 1
            wave_end = ended
    return waves


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
    ("follow", 4, lambda w: w.put(f"/users/{w.stranger}/follow", w.me)),
    ("block", 4, lambda w: w.put(f"/users/{w.stranger}/block", w.me)),
    ("delete post", 3, lambda w: w.delete(f"/posts/{w.own_post}", w.me)),
])
def test_requests_run_their_queries_in_few_waves(world, name, waves, send):
    assert measure_waves(world, lambda: send(world)) <= waves, name


def test_me_lists_who_you_follow_for_the_profile_card(world):
    blocked = world.db.make_user("blocked_one")
    world.db.follow(world.me, blocked)
    world.db.tables["social_blocks"].append({"blocker_id": blocked, "blocked_id": world.me})
    me = world.get("/me", world.me).json()
    assert [member["username"] for member in me["following_preview"]] == ["friend"]
    assert me["following"] == 2


def test_photos_are_read_from_storage_once_and_never_after_delete(world):
    del world.post  # the fixture's post id hides the World.post method
    url = world.publish(world.me, photos=1).json()["image_urls"][0]
    downloads = world.db.storage.downloads

    assert world.client.get(url).status_code == 200
    assert world.client.get(url).status_code == 200
    assert world.db.storage.downloads == downloads + 1

    post_id = world.get("/feed", world.me, params={"mode": "following"}).json()["items"][0]["id"]
    assert world.delete(f"/posts/{post_id}", world.me).status_code == 204
    assert world.client.get(url).status_code == 404


def test_a_post_with_four_photos_uploads_them_together(world):
    del world.post  # the fixture's post id hides the World.post method
    # 4 photos one after another would be 4 more round trips on their own.
    assert measure_waves(world, lambda: world.publish(world.me, photos=4)) < 6
    assert world.db.storage.uploads == 4
