"""Community API: authorization, privacy, blocking, uploads and limits (plan S1-S15)."""

import json
import re
from datetime import datetime, timedelta, timezone
from io import BytesIO
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.facades import social_facade
from main import app
from tests.auth_helpers import auth_headers
from tests.social_fakes import FakeSupabase, catalog_exercise

API = "/api/v1/social"
BENCH, _ = catalog_exercise(0)
SECRET_KEYS = {"email", "password", "password_hash", "is_premium", "weight", "height",
               "avatar_path", "image_paths", "search_text"}


def jpeg(size=(60, 40)):
    buffer = BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buffer, format="JPEG")
    return buffer.getvalue()


class World:
    def __init__(self, db):
        self.db = db
        self.client = TestClient(app)

    def call(self, method, path, user=None, **kwargs):
        headers = auth_headers(user) if user else {}
        return self.client.request(method, f"{API}{path}", headers=headers, **kwargs)

    def get(self, path, user, **kwargs):
        return self.call("GET", path, user, **kwargs)

    def put(self, path, user, **kwargs):
        return self.call("PUT", path, user, **kwargs)

    def post(self, path, user, **kwargs):
        return self.call("POST", path, user, **kwargs)

    def delete(self, path, user):
        return self.call("DELETE", path, user)

    def publish(self, user, body="hello", card=None, photos=0, filename="a.jpg"):
        data = {"body": body}
        if card is not None:
            data["card"] = json.dumps(card)
        files = [("images", (filename, jpeg(), "image/jpeg")) for _ in range(photos)]
        return self.post("/posts", user, data=data, files=files or None)

    def feed(self, user, mode="discover", **params):
        response = self.get("/feed", user, params={"mode": mode, **params})
        assert response.status_code == 200, response.text
        return response.json()

    def feed_ids(self, user, mode="discover"):
        return [item["id"] for item in self.feed(user, mode)["items"]]


@pytest.fixture
def world(monkeypatch):
    db = FakeSupabase()
    monkeypatch.setattr(social_facade, "get_supabase", lambda admin=False: db)
    monkeypatch.setattr(social_facade, "get_storage", lambda: db.storage)
    monkeypatch.setattr("app.core.auth.get_supabase", lambda admin=False: None)
    return World(db)


ROUTES = [
    ("GET", "/me"), ("POST", "/me/join"), ("PATCH", "/me"), ("PUT", "/me/avatar"), ("DELETE", "/me/avatar"),
    ("GET", "/feed"), ("POST", "/posts"), ("GET", "/posts/{id}"), ("DELETE", "/posts/{id}"),
    ("PUT", "/posts/{id}/like"), ("DELETE", "/posts/{id}/like"), ("GET", "/posts/{id}/comments"),
    ("POST", "/posts/{id}/comments"), ("DELETE", "/comments/{id}"), ("GET", "/attachables"),
    ("GET", "/users?q=ana"), ("GET", "/users/ana"), ("GET", "/users/ana/posts"),
    ("GET", "/users/ana/followers"), ("GET", "/users/ana/following"), ("PUT", "/users/{id}/follow"),
    ("DELETE", "/users/{id}/follow"), ("DELETE", "/followers/{id}"), ("GET", "/follow-requests"),
    ("POST", "/follow-requests/{id}/accept"), ("DELETE", "/follow-requests/{id}"),
    ("PUT", "/users/{id}/block"), ("DELETE", "/users/{id}/block"), ("GET", "/blocks"),
]


@pytest.mark.parametrize("method,path", ROUTES)
def test_every_route_needs_a_session(world, method, path):
    response = world.call(method, path.replace("{id}", str(uuid4())))
    assert response.status_code == 401


def test_every_served_route_is_in_the_list():
    from app.api.social import router

    def shape(path):
        return re.sub(r"\{\w+\}|\bana\b", "x", path.split("?")[0])

    served = {(method, shape(route.path.removeprefix("/social"))) for route in router.routes for method in route.methods}
    assert served - {(method, shape(path)) for method, path in ROUTES} == {("GET", "/media/x")}


# --- joining (S2, S7) ---

def test_joining_makes_a_user_visible(world):
    viewer = world.db.make_user("viewer")
    newcomer = world.db.make_user(joined=False, name="Berta")
    assert world.get("/me", newcomer).json()["joined"] is False
    assert world.get("/users?q=berta", viewer).json() == []
    assert world.put(f"/users/{newcomer}/follow", viewer).status_code == 404
    assert world.get("/feed", newcomer).status_code == 403
    assert world.publish(newcomer).status_code == 403

    response = world.post("/me/join", newcomer, json={"username": "Berta_1", "is_private": False})

    assert response.status_code == 200, response.text
    assert (response.json()["joined"], response.json()["username"]) == (True, "berta_1")
    assert [user["username"] for user in world.get("/users?q=berta", viewer).json()] == ["berta_1"]


def test_username_must_be_free_and_valid(world):
    world.db.make_user("taken")
    newcomer = world.db.make_user(joined=False)
    assert world.post("/me/join", newcomer, json={"username": "TAKEN", "is_private": False}).status_code == 409
    assert world.post("/me/join", newcomer, json={"username": "admin", "is_private": False}).status_code == 422
    assert world.db.user(newcomer)["username"] is None


def test_username_changes_once_every_30_days(world):
    user = world.db.make_user("first")
    assert world.call("PATCH", "/me", user, json={"username": "second"}).status_code == 200
    assert world.call("PATCH", "/me", user, json={"username": "third"}).status_code == 429
    assert world.call("PATCH", "/me", user, json={"username": "second"}).status_code == 200  # unchanged
    world.db.user(user)["username_changed_at"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    assert world.call("PATCH", "/me", user, json={"username": "third"}).status_code == 200


@pytest.mark.parametrize("body", [{"is_premium": True}, {"avatar_path": "x"}, {"email": "a@b.c"}])
def test_extra_fields_are_refused(world, body):
    user = world.db.make_user()
    assert world.call("PATCH", "/me", user, json=body).status_code == 422
    assert world.db.user(user)["avatar_path"] is None


# --- no private data in any answer (S1) ---

def _keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from _keys(item)


def test_no_answer_leaks_account_data(world):
    ana, bea = world.db.make_user("ana"), world.db.make_user("bea", name="Bea")
    avatar = world.put("/me/avatar", ana, files={"file": ("a.jpg", jpeg(), "image/jpeg")})
    workout = world.db.make_workout(ana, [(BENCH, 60, 5, True)])
    post = world.publish(ana, card={"type": "workout", "workout_id": workout}, photos=1).json()["id"]
    world.put(f"/users/{ana}/follow", bea)
    world.post(f"/posts/{post}/comments", bea, json={"body": "nice @ana"})
    world.put(f"/users/{world.db.make_user('cleo')}/block", bea)
    answers = [avatar] + [world.get(path, bea) for path in (
        "/me", "/feed", f"/posts/{post}", f"/posts/{post}/comments", "/users?q=ana", "/users/ana",
        "/users/ana/posts", "/users/ana/followers", "/users/bea/following", "/follow-requests",
        "/blocks", "/attachables")]
    for answer in answers:
        assert answer.status_code == 200, answer.text
        assert not SECRET_KEYS & set(_keys(answer.json()))
        assert "@example.test" not in answer.text and "secret-hash-value" not in answer.text
    for table, columns in world.db.selects:
        if table == "users":
            assert columns != "*" and not {"email", "password_hash"} & set(columns.split(","))


# --- who can see what (S3, S4) ---

def _relationship(world, kind):
    author = world.db.make_user("author", private=kind in {"follower", "pending", "stranger"})
    viewer = author if kind == "self" else world.db.make_user("viewer")
    post = world.db.make_post(author)
    if kind in {"follower", "pending"}:
        world.db.follow(viewer, author, "accepted" if kind == "follower" else "pending")
    if kind == "blocked":
        world.db.tables["social_blocks"].append({"blocker_id": author, "blocked_id": viewer})
    if kind == "blocker":
        world.db.tables["social_blocks"].append({"blocker_id": viewer, "blocked_id": author})
    return author, viewer, post


@pytest.mark.parametrize("kind,visible", [
    ("self", True), ("public", True), ("follower", True), ("pending", False),
    ("stranger", False), ("blocked", False), ("blocker", False),
])
def test_visibility_matrix(world, kind, visible):
    _, viewer, post = _relationship(world, kind)
    status = 200 if visible else 404
    assert world.get(f"/posts/{post}", viewer).status_code == status
    assert world.get(f"/posts/{post}/comments", viewer).status_code == status
    assert world.put(f"/posts/{post}/like", viewer).status_code == status
    assert world.call("DELETE", f"/posts/{post}/like", viewer).status_code == status
    assert world.post(f"/posts/{post}/comments", viewer, json={"body": "hi"}).status_code == (201 if visible else 404)
    assert world.get("/users/author/posts", viewer).status_code == status
    assert world.get("/users/author/followers", viewer).status_code == status
    assert world.get("/users/author/following", viewer).status_code == status
    assert (post in world.feed_ids(viewer, "following")) is (kind in {"self", "follower"})
    header = world.get("/users/author", viewer)
    if kind in {"blocked", "blocker"}:
        assert header.status_code == 404
    else:
        assert header.status_code == 200
        assert header.json()["posts_visible"] is visible


def test_a_stale_privacy_flag_does_not_leak_a_post(world):
    author, viewer = world.db.make_user(private=True), world.db.make_user()
    post = world.db.make_post(author)
    world.db.tables["social_posts"][0]["author_private"] = False
    assert post not in world.feed_ids(viewer, "discover")


def test_a_missing_post_and_a_hidden_post_look_the_same(world):
    _, viewer, post = _relationship(world, "stranger")
    hidden, missing = world.get(f"/posts/{post}", viewer), world.get(f"/posts/{uuid4()}", viewer)
    assert (hidden.status_code, hidden.json()) == (missing.status_code, missing.json())


# --- blocking (S5) ---

@pytest.mark.parametrize("who", ["author_blocks", "reader_blocks"])
def test_blocking_cuts_every_surface_both_ways(world, who):
    ana, bea = world.db.make_user("ana"), world.db.make_user("bea", name="Bea")
    carl = world.db.make_user("carl", name="Carl", surname="Diaz")
    ana_post, bea_post, carl_post = (world.db.make_post(user) for user in (ana, bea, carl))
    for follower, followee in ((ana, bea), (bea, ana)):
        world.db.follow(follower, followee)
        world.db.follow(follower, carl)
    world.put(f"/posts/{ana_post}/like", bea)
    world.post(f"/posts/{ana_post}/comments", bea, json={"body": "from bea"})
    world.post(f"/posts/{carl_post}/comments", ana, json={"body": "from ana"})
    world.post(f"/posts/{carl_post}/comments", bea, json={"body": "from bea"})

    blocker, blocked = (ana, bea) if who == "author_blocks" else (bea, ana)
    assert world.put(f"/users/{blocked}/block", blocker).status_code == 204

    assert {row["followee_id"] for row in world.db.tables["social_follows"]} == {carl}
    assert world.db.tables["social_post_likes"] == []
    assert [row["post_id"] for row in world.db.tables["social_comments"]] == [carl_post, carl_post]
    for viewer, other, name, post in ((ana, bea, "bea", bea_post), (bea, ana, "ana", ana_post)):
        assert world.get(f"/posts/{post}", viewer).status_code == 404
        assert world.get(f"/users/{name}", viewer).status_code == 404
        assert world.get(f"/users?q={name}", viewer).json() == []
        assert world.put(f"/users/{other}/follow", viewer).status_code == 404
        assert post not in world.feed_ids(viewer, "discover")
        assert post not in world.feed_ids(viewer, "following")
        comments = world.get(f"/posts/{carl_post}/comments", viewer).json()
        assert {item["author"]["id"] for item in comments} == {viewer}
        listing = world.get("/users/carl/followers", viewer).json()
        assert [item["id"] for item in listing] == [viewer]
    assert [item["id"] for item in world.get("/blocks", blocker).json()] == [blocked]
    assert world.get("/blocks", blocked).json() == []
    assert world.delete(f"/users/{blocked}/block", blocker).status_code == 204
    assert world.get(f"/posts/{ana_post}", bea).status_code == 200


def test_blocks_beyond_one_page_still_hide(world):
    viewer, author = world.db.make_user(), world.db.make_user()
    post = world.db.make_post(author)
    world.db.tables["social_blocks"].extend(
        {"blocker_id": viewer, "blocked_id": f"00000000-0000-0000-0000-{n:012d}"} for n in range(1100))
    world.db.tables["social_blocks"].append({"blocker_id": viewer, "blocked_id": author})
    world.db.tables["social_blocks"].sort(key=lambda row: row["blocked_id"])
    assert post not in world.feed_ids(viewer)
    assert world.get(f"/posts/{post}", viewer).status_code == 404


def test_you_cannot_block_or_follow_yourself(world):
    user = world.db.make_user()
    assert world.put(f"/users/{user}/block", user).status_code == 422
    assert world.put(f"/users/{user}/follow", user).status_code == 422


# --- follows ---

def test_follow_flows(world):
    open_user, closed = world.db.make_user("open"), world.db.make_user("closed", private=True)
    fan = world.db.make_user("fan")
    post = world.db.make_post(closed)

    assert world.put(f"/users/{open_user}/follow", fan).json()["follow_state"] == "following"
    assert world.put(f"/users/{closed}/follow", fan).json()["follow_state"] == "pending"
    assert world.put(f"/users/{closed}/follow", fan).json()["follow_state"] == "pending"
    assert world.get(f"/posts/{post}", fan).status_code == 404
    assert [item["id"] for item in world.get("/follow-requests", closed).json()] == [fan]
    assert world.get("/me", closed).json()["pending_requests"] == 1

    assert world.post(f"/follow-requests/{fan}/accept", closed).status_code == 204
    assert world.get(f"/posts/{post}", fan).status_code == 200
    assert world.get("/users/open", fan).json()["follow_state"] == "following"

    assert world.delete(f"/followers/{fan}", closed).status_code == 204
    assert world.get(f"/posts/{post}", fan).status_code == 404

    world.put(f"/users/{closed}/follow", fan)
    assert world.delete(f"/follow-requests/{fan}", closed).status_code == 204
    assert world.post(f"/follow-requests/{fan}/accept", closed).status_code == 404
    world.put(f"/users/{closed}/follow", fan)
    assert world.delete(f"/users/{closed}/follow", fan).status_code == 204
    assert world.get("/follow-requests", closed).json() == []


def test_a_request_cannot_be_accepted_by_someone_else(world):
    closed, fan, other = world.db.make_user(private=True), world.db.make_user(), world.db.make_user()
    world.put(f"/users/{closed}/follow", fan)
    assert world.post(f"/follow-requests/{fan}/accept", other).status_code == 404
    assert world.db.tables["social_follows"][0]["status"] == "pending"


def test_going_public_accepts_pending_requests(world):
    closed, fan = world.db.make_user(private=True), world.db.make_user()
    post = world.db.make_post(closed)
    world.put(f"/users/{closed}/follow", fan)
    assert world.call("PATCH", "/me", closed, json={"is_private": False}).status_code == 200
    assert post in world.feed_ids(fan, "following")


def test_following_is_capped(world):
    fan, target = world.db.make_user(), world.db.make_user()
    for number in range(500):
        world.db.follow(fan, f"00000000-0000-0000-0000-{number:012d}")
    world.db.tables["social_follows"] = [
        {**row, "created_at": "2020-01-01T00:00:00+00:00"} for row in world.db.tables["social_follows"]]
    assert world.put(f"/users/{target}/follow", fan).status_code == 422


def test_follow_requests_are_rate_limited(world):
    fan, target = world.db.make_user(), world.db.make_user()
    for number in range(100):
        world.db.follow(fan, f"00000000-0000-0000-0000-{number:012d}")
    assert world.put(f"/users/{target}/follow", fan).status_code == 429


# --- posts, likes, comments ---

def test_posting_validates_input(world):
    user = world.db.make_user()
    assert world.publish(user, body="   ").status_code == 422
    assert world.publish(user, body="a" * 281).status_code == 422
    assert world.publish(user, body="a‮b").status_code == 422
    assert world.publish(user, photos=5).status_code == 422
    assert world.post("/posts", user, data={"body": "x"},
                      files=[("images", ("a.jpg", b"not an image", "image/jpeg"))]).status_code == 415
    assert world.db.tables["social_posts"] == [] and world.db.storage.objects == {}


def test_image_only_post_and_server_built_paths(world):
    user = world.db.make_user()
    response = world.publish(user, body="", photos=2, filename="../../evil.exe")
    assert response.status_code == 201, response.text
    post = response.json()
    paths = [path for _, path in world.db.storage.objects]
    assert paths == [f"{user}/{post['id']}/0.webp", f"{user}/{post['id']}/1.webp"]
    assert all(url.startswith(f"{API}/media/") for url in post["image_urls"])


def test_a_failed_upload_leaves_nothing_behind(world):
    user = world.db.make_user()
    world.db.storage.fail_on_upload = 2
    assert world.publish(user, photos=3).status_code == 502
    assert world.db.tables["social_posts"] == [] and world.db.storage.objects == {}


def test_deleting_a_post_removes_its_photos(world):
    user, other = world.db.make_user(), world.db.make_user()
    post = world.publish(user, photos=2).json()["id"]
    assert world.delete(f"/posts/{post}", other).status_code == 404
    assert world.delete(f"/posts/{post}", user).status_code == 204
    assert world.db.tables["social_posts"] == [] and world.db.storage.objects == {}


def test_likes_are_idempotent(world):
    ana, bea = world.db.make_user(), world.db.make_user()
    post = world.db.make_post(ana)
    world.put(f"/posts/{post}/like", bea)
    again = world.put(f"/posts/{post}/like", bea).json()
    assert (again["like_count"], again["liked_by_me"]) == (1, True)
    assert world.call("DELETE", f"/posts/{post}/like", bea).json()["like_count"] == 0


def test_comment_deletion_rights(world):
    ana, bea, carl = world.db.make_user(), world.db.make_user(), world.db.make_user()
    post = world.db.make_post(ana)
    mine = world.post(f"/posts/{post}/comments", bea, json={"body": "one"}).json()["id"]
    other = world.post(f"/posts/{post}/comments", bea, json={"body": "two"}).json()["id"]
    assert world.delete(f"/comments/{mine}", carl).status_code == 404
    assert world.delete(f"/comments/{mine}", bea).status_code == 204  # its author
    assert world.delete(f"/comments/{other}", ana).status_code == 204  # the post's author
    assert world.get(f"/posts/{post}", ana).json()["comment_count"] == 0


def test_comments_are_validated(world):
    user = world.db.make_user()
    post = world.db.make_post(user)
    for body in ({"body": "  "}, {"body": "a" * 281}, {"body": "x", "user_id": str(uuid4())}):
        assert world.post(f"/posts/{post}/comments", user, json=body).status_code == 422


# --- cards (S6) ---

def test_cards_come_from_the_database_only(world):
    user, other = world.db.make_user(), world.db.make_user()
    old = datetime.now(timezone.utc) - timedelta(days=7)
    world.db.make_workout(user, [(BENCH, 60, 5, True)], old)
    workout = world.db.make_workout(user, [(BENCH, 65, 4, True)])
    theirs = world.db.make_workout(other, [(BENCH, 500, 1, True)])

    forged = {"type": "pr", "workout_id": workout, "exercise_id": BENCH, "weight_kg": 999}
    assert world.publish(user, card=forged).status_code == 422
    assert world.publish(user, card={"type": "workout", "workout_id": theirs}).status_code == 404
    assert world.publish(other, card={"type": "pr", "workout_id": theirs, "exercise_id": BENCH}).status_code == 422
    assert world.publish(user, card={"type": "workout"}).status_code == 422
    assert world.publish(user, card={"type": "nutrition_streak"}).status_code == 422
    assert world.db.tables["social_posts"] == []

    post = world.publish(user, body="", card={"type": "pr", "workout_id": workout, "exercise_id": BENCH}).json()

    assert post["card_type"] == "pr"
    assert (post["card"]["weight_kg"], post["card"]["previous_best_kg"]) == (65.0, 60.0)
    options = world.get("/attachables", user).json()
    assert [item["workout_id"] for item in options["workouts"]][0] == workout
    assert options["workouts"][0]["prs"][0]["exercise_id"] == BENCH
    assert options["streak_days"] == 0


def test_streak_card(world):
    user = world.db.make_user()
    noon = datetime.now(timezone.utc).replace(hour=0, minute=0, second=1, microsecond=0)
    for day in range(7):
        world.db.make_meal(user, noon - timedelta(days=day))
    post = world.publish(user, card={"type": "nutrition_streak"}).json()
    assert post["card"] == {"days": 7}


# --- rate limits (S13) ---

@pytest.mark.parametrize("kind,limit", [("posts", 30), ("comments", 200)])
def test_daily_limits(world, monkeypatch, kind, limit):
    user = world.db.make_user()
    post = world.db.make_post(user)
    if kind == "posts":
        for _ in range(limit - 1):
            world.db.make_post(user)
        send = lambda: world.publish(user, photos=1)  # noqa: E731
        table = "social_posts"
    else:
        for _ in range(limit):
            world.db.table("social_comments").insert({"post_id": post, "user_id": user, "body": "x"}).execute()
        send = lambda: world.post(f"/posts/{post}/comments", user, json={"body": "x"})  # noqa: E731
        table = "social_comments"
    before = len(world.db.tables[table])

    assert send().status_code == 429
    assert len(world.db.tables[table]) == before and world.db.storage.objects == {}

    # Two requests that both passed the first check: the one over the limit is rolled back.
    real, calls = social_facade.social_facade._used, []

    def stale_first_count(*args):
        calls.append(args)
        return 0 if len(calls) == 1 else real(*args)

    monkeypatch.setattr(social_facade.social_facade, "_used", stale_first_count)
    assert send().status_code == 429
    assert len(world.db.tables[table]) == before and world.db.storage.objects == {}


# --- feeds and pagination ---

def test_discover_and_following(world):
    me, public, followed, private, quiet = (
        world.db.make_user(), world.db.make_user(), world.db.make_user(private=True),
        world.db.make_user(private=True), world.db.make_user(joined=False))
    posts = {user: world.db.make_post(user) for user in (me, public, followed, private, quiet)}
    world.db.follow(me, followed)
    assert set(world.feed_ids(me, "discover")) == {posts[me], posts[public]}
    assert set(world.feed_ids(me, "following")) == {posts[me], posts[followed]}


@pytest.mark.parametrize("mode", ["discover", "following"])
def test_pagination_has_no_gaps_or_repeats(world, mode):
    me, friend = world.db.make_user(), world.db.make_user()
    world.db.follow(me, friend)
    posts = [world.db.make_post(friend if n % 2 else me) for n in range(45)]
    seen, params = [], {}
    while True:
        page = world.feed(me, mode, **params)
        seen += [item["id"] for item in page["items"]]
        if not page["next_cursor"]:
            break
        params = {"before": page["next_cursor"]}
    # Following is by date; For you is ranked (here the followed friend's posts come first).
    assert len(seen) == len(set(seen)) == len(posts)
    if mode == "following":
        assert seen == posts[::-1]


def test_bad_feed_and_search_input(world):
    user = world.db.make_user()
    assert world.get("/feed", user, params={"mode": "everything"}).status_code == 422
    assert world.get("/feed", user, params={"before": "yesterday"}).status_code == 422
    for term in ("a", "a,b)", "100%"):
        assert world.get("/users", user, params={"q": term}).status_code == 422


def test_search_treats_underscore_literally(world):
    me = world.db.make_user("searcher", name="Zed")
    world.db.make_user("an_a", name="One")
    world.db.make_user("anxa", name="Two")
    assert [item["username"] for item in world.get("/users", me, params={"q": "an_a"}).json()] == ["an_a"]


# --- avatars and media (S8-S10) ---

def test_avatar_replacement_removes_the_old_file(world):
    user = world.db.make_user()
    for _ in range(2):
        assert world.put("/me/avatar", user, files={"file": ("../../x.png", jpeg(), "image/png")}).status_code == 200
    (bucket, path), = world.db.storage.objects
    assert bucket == "avatars" and path.startswith(f"{user}/") and path.endswith(".webp")
    assert world.delete("/me/avatar", user).status_code == 200
    assert world.db.storage.objects == {} and world.db.user(user)["avatar_path"] is None


def test_avatar_needs_a_real_image(world):
    user = world.db.make_user()
    assert world.put("/me/avatar", user, files={"file": ("a.jpg", b"nope", "image/jpeg")}).status_code == 415
    assert world.db.storage.objects == {}


def test_photo_processing_is_limited_per_day(world, monkeypatch):
    monkeypatch.setattr(social_facade, "PHOTOS_PER_DAY", 3)
    user = world.db.make_user()
    bad = {"file": ("a.jpg", b"nope", "image/jpeg")}
    good = {"file": ("a.jpg", jpeg(), "image/jpeg")}
    assert world.put("/me/avatar", user, files=bad).status_code == 415  # a failed try still costs
    assert world.put("/me/avatar", user, files=good).status_code == 200
    assert world.publish(user, photos=2).status_code == 429  # would make four
    assert world.publish(user, photos=1).status_code == 201
    assert world.put("/me/avatar", user, files=good).status_code == 429
    assert world.publish(user).status_code == 201  # text needs no processing
    assert world.put("/me/avatar", world.db.make_user(), files=good).status_code == 200


def test_media_is_served_only_with_a_valid_token(world):
    user = world.db.make_user()
    url = world.publish(user, photos=1).json()["image_urls"][0]

    good = world.client.get(url)

    assert good.status_code == 200
    assert good.headers["content-type"] == "image/webp"
    assert good.headers["cache-control"].startswith("private")
    assert good.headers["x-content-type-options"] == "nosniff"
    assert good.content[:4] == b"RIFF"
    assert world.client.get(url[:-2] + ("aa" if url[-2:] != "aa" else "bb")).status_code == 404
    assert world.client.get(f"{API}/media/nonsense").status_code == 404
    # A file gone from Storage (and from the served-photo cache) is "not found".
    social_facade._forget_media("post-images", [path for _, path in world.db.storage.objects])
    world.db.storage.objects.clear()
    assert world.client.get(url).status_code == 404


# --- "For you": the discover feed ranked by interest ---

def _ago(**delta):
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat()


def test_for_you_puts_a_liked_post_above_a_newer_quiet_one(world):
    me, author = world.db.make_user(), world.db.make_user()
    quiet = world.db.make_post(author, created_at=_ago(minutes=5))
    liked = world.db.make_post(author, created_at=_ago(hours=3), like_count=12, comment_count=4)
    assert world.feed_ids(me, "discover")[:2] == [liked, quiet]


def test_for_you_favours_people_you_follow_when_all_else_is_equal(world):
    me, followed, stranger = world.db.make_user(), world.db.make_user(), world.db.make_user()
    world.db.follow(me, followed)
    from_stranger = world.db.make_post(stranger, created_at=_ago(hours=1), like_count=2)
    from_followed = world.db.make_post(followed, created_at=_ago(hours=1, seconds=1), like_count=2)
    assert world.feed_ids(me, "discover")[:2] == [from_followed, from_stranger]


def test_for_you_pages_through_ranked_and_older_posts_without_repeats(world, monkeypatch):
    monkeypatch.setattr(social_facade, "FYP_CANDIDATES", 7)
    me, author = world.db.make_user(), world.db.make_user()
    posts = [world.db.make_post(author, like_count=n % 4) for n in range(31)]
    seen, params = [], {"limit": 5}
    while True:
        page = world.feed(me, "discover", **params)
        seen += [item["id"] for item in page["items"]]
        if not page["next_cursor"]:
            break
        params = {"limit": 5, "before": page["next_cursor"]}
    assert len(seen) == len(set(seen)) == len(posts)


def test_for_you_still_hides_private_and_blocked_authors(world):
    me, private, blocker = world.db.make_user(), world.db.make_user(private=True), world.db.make_user()
    hidden = world.db.make_post(private, like_count=50)
    blocked = world.db.make_post(blocker, like_count=50)
    world.db.tables["social_blocks"].append({"blocker_id": blocker, "blocked_id": me})
    assert not {hidden, blocked} & set(world.feed_ids(me, "discover"))


def test_bad_feed_cursors_are_refused(world):
    user = world.db.make_user()
    for mode, cursor in (("discover", "rank:-1"), ("discover", "rank:x"), ("discover", "rank:999999"),
                         ("following", "rank:3"), ("discover", "yesterday")):
        assert world.get("/feed", user, params={"mode": mode, "before": cursor}).status_code == 422, cursor
