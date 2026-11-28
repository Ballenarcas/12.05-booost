"""In-memory Supabase (tables + Storage) for the Community tests.

It also copies the triggers of create_social_tables.sql (counters, author_private),
and it caps every select at ``max_rows`` the way Supabase does.
"""

import re
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

from app.services.exercise_catalog import load_cached_exercises, supabase_uuid_for

TABLES = (
    "users", "workouts", "workout_sets", "meals", "exercises",
    "social_posts", "social_post_likes", "social_comments", "social_follows", "social_blocks",
)
KEYS = {
    "social_post_likes": ("post_id", "user_id"),
    "social_follows": ("follower_id", "followee_id"),
    "social_blocks": ("blocker_id", "blocked_id"),
}
COUNTERS = {"social_post_likes": "like_count", "social_comments": "comment_count"}


def _comparable(value):
    if isinstance(value, str) and re.match(r"\d{4}-\d{2}-\d{2}T", value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def _like(pattern: str) -> re.Pattern[str]:
    out, chars = [], iter(pattern)
    for char in chars:
        if char == "\\":
            out.append(re.escape(next(chars, "")))
        else:
            out.append(".*" if char == "%" else "." if char == "_" else re.escape(char))
    return re.compile("".join(out), re.IGNORECASE | re.DOTALL)


class FakeTable:
    def __init__(self, db: "FakeSupabase", name: str) -> None:
        self.db, self.name = db, name
        self.filters, self.orders = [], []
        self.action, self.values, self.columns = "select", None, "*"
        self.window = self.count_mode = self.limit_to = None
        self.ignore_duplicates, self.conflict, self.negate = False, None, False

    def select(self, columns="*", count=None):
        self.columns, self.count_mode = columns, count
        self.db.selects.append((self.name, columns))
        return self

    def insert(self, values):
        self.action, self.values = "insert", values
        return self

    def upsert(self, values, on_conflict=None, ignore_duplicates=False):
        self.action, self.values = "upsert", values
        self.conflict, self.ignore_duplicates = on_conflict, ignore_duplicates
        return self

    def update(self, values):
        self.action, self.values = "update", values
        return self

    def delete(self):
        self.action = "delete"
        return self

    def _filter(self, check):
        negate, self.negate = self.negate, False
        self.filters.append((lambda row: not check(row)) if negate else check)
        return self

    @property
    def not_(self):
        self.negate = True
        return self

    def eq(self, column, value):
        return self._filter(lambda row: str(row.get(column)) == str(value))

    def neq(self, column, value):
        return self._filter(lambda row: str(row.get(column)) != str(value))

    def in_(self, column, values):
        assert values, "an empty in_() is invalid SQL on the real client"
        wanted = {str(value) for value in values}
        return self._filter(lambda row: str(row.get(column)) in wanted)

    def lt(self, column, value):
        return self._filter(lambda row: row.get(column) is not None and _comparable(row[column]) < _comparable(value))

    def gte(self, column, value):
        return self._filter(lambda row: row.get(column) is not None and _comparable(row[column]) >= _comparable(value))

    def is_(self, column, value):
        assert value == "null"
        return self._filter(lambda row: row.get(column) is None)

    def ilike(self, column, pattern):
        compiled = _like(pattern)
        return self._filter(lambda row: compiled.fullmatch(str(row.get(column) or "")) is not None)

    def order(self, column, desc=False):
        self.orders.append((column, desc))
        return self

    def limit(self, count):
        self.limit_to = count
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def execute(self):
        time.sleep(self.db.latency)  # a round trip to Supabase
        rows = self.db.tables[self.name]
        if self.action in ("insert", "upsert"):
            return SimpleNamespace(data=self._write(rows), count=None)
        matching = [row for row in rows if all(check(row) for check in self.filters)]
        if self.action == "update":
            self._update(matching)
        elif self.action == "delete":
            self.db.tables[self.name] = [row for row in rows if row not in matching]
            self.db.after_delete(self.name, matching)
        total = len(matching)
        for column, desc in reversed(self.orders):
            matching.sort(key=lambda row: _comparable(row.get(column)), reverse=desc)
        if self.window:
            matching = matching[self.window[0]:self.window[1] + 1]
        if self.limit_to is not None:
            matching = matching[: self.limit_to]
        if self.action == "select":
            matching = matching[: self.db.max_rows]
        return SimpleNamespace(data=[self._project(row) for row in matching],
                               count=total if self.count_mode == "exact" else None)

    def _project(self, row):
        if self.action != "select" or self.columns == "*":
            return dict(row)
        names = [name.strip().strip('"') for name in self.columns.split(",")]
        return {name: row.get(name) for name in names}

    def _write(self, rows):
        written = []
        for values in self.values if isinstance(self.values, list) else [self.values]:
            keys = tuple(self.conflict.split(",")) if self.conflict else KEYS.get(self.name)
            existing = keys and next(
                (row for row in rows if all(str(row.get(key)) == str(values.get(key)) for key in keys)), None)
            if existing:
                if self.action == "insert":
                    raise RuntimeError("23505 duplicate key")
                if not self.ignore_duplicates:
                    existing.update(values)
                    written.append(dict(existing))
                continue
            row = {"created_at": self.db.tick(), **values}
            if self.name not in KEYS:
                row.setdefault("id", str(uuid4()))
            if self.name == "social_posts":
                row = {"like_count": 0, "comment_count": 0, "image_paths": [], "card": None, "card_type": None, **row}
            rows.append(row)
            self.db.count(self.name, row, 1)
            written.append(dict(row))
        return written

    def _update(self, matching):
        username = self.values.get("username")
        if self.name == "users" and username:
            ids = {row["id"] for row in matching}
            if any(str(row.get("username") or "").lower() == username.lower() and row["id"] not in ids
                   for row in self.db.tables["users"]):
                raise RuntimeError("23505 duplicate key")
        for row in matching:
            row.update(self.values)
            if self.name == "users":
                row["search_text"] = search_text(row)
                for post in self.db.tables["social_posts"]:
                    if post["user_id"] == row["id"]:
                        post["author_private"] = bool(row.get("is_private"))


def search_text(row):
    return f"{row.get('username') or ''} {row.get('Name') or ''} {row.get('Surname') or ''}".lower()


class FakeBucket:
    def __init__(self, storage, name):
        self.storage, self.name = storage, name

    def upload(self, path, file, file_options=None):
        time.sleep(self.storage.latency)
        self.storage.uploads += 1
        if self.storage.fail_on_upload == self.storage.uploads:
            raise RuntimeError("upload failed")
        assert (self.name, path) not in self.storage.objects, "uploads must never overwrite"
        self.storage.objects[(self.name, path)] = file

    def download(self, path):
        time.sleep(self.storage.latency)
        self.storage.downloads += 1
        return self.storage.objects[(self.name, path)]

    def remove(self, paths):
        for path in paths:
            self.storage.objects.pop((self.name, path), None)


class FakeStorage:
    def __init__(self, latency=0.0):
        self.objects, self.uploads, self.downloads, self.fail_on_upload = {}, 0, 0, None
        self.latency = latency

    def from_(self, name):
        return FakeBucket(self, name)


class FakeSupabase:
    def __init__(self, max_rows=1000, latency=0.0):
        self.tables = {name: [] for name in TABLES}
        self.latency = latency
        self.max_rows, self.selects, self.storage, self._ticks = max_rows, [], FakeStorage(latency), 0

    def table(self, name):
        return FakeTable(self, name)

    def tick(self):
        self._ticks += 1
        return (datetime.now(timezone.utc) - timedelta(minutes=30) + timedelta(milliseconds=self._ticks)).isoformat()

    def count(self, table, row, step):
        if table in COUNTERS:
            for post in self.tables["social_posts"]:
                if post["id"] == row["post_id"]:
                    post[COUNTERS[table]] += step

    def after_delete(self, table, removed):
        for row in removed:
            self.count(table, row, -1)
        if table == "social_posts":
            gone = {row["id"] for row in removed}
            for child in ("social_post_likes", "social_comments"):
                self.tables[child] = [row for row in self.tables[child] if row["post_id"] not in gone]

    # --- seed helpers ---
    def make_user(self, username=None, *, joined=True, private=False, name="Ana", surname="Lopez"):
        user_id = str(uuid4())
        username = (username or f"u_{user_id[:8]}") if joined else None
        row = {
            "id": user_id, "email": f"{user_id[:8]}@example.test", "password_hash": "secret-hash-value",
            "is_premium": True, "weight": 71.5, "height": 180, "Name": name, "Surname": surname,
            "username": username, "is_private": private, "avatar_path": None,
            "community_joined_at": None, "username_changed_at": None,
        }
        row["search_text"] = search_text(row)
        self.tables["users"].append(row)
        return user_id

    def user(self, user_id):
        return next(row for row in self.tables["users"] if row["id"] == user_id)

    def make_post(self, user_id, body="hello", **extra):
        return self.table("social_posts").insert({
            "id": str(uuid4()), "user_id": user_id, "body": body,
            "author_private": self.user(user_id)["is_private"], **extra,
        }).execute().data[0]["id"]

    def follow(self, follower, followee, status="accepted"):
        self.table("social_follows").insert(
            {"follower_id": follower, "followee_id": followee, "status": status}).execute()

    def make_workout(self, user_id, sets, started_at=None, name="Push day", finished=True):
        """``sets`` holds (exercise_id, weight, reps, done) tuples."""
        started = started_at or datetime.now(timezone.utc) - timedelta(hours=2)
        workout_id = str(uuid4())
        self.tables["workouts"].append({
            "id": workout_id, "user_id": user_id, "name": name, "start_time": started.isoformat(),
            "end_time": (started + timedelta(minutes=45)).isoformat() if finished else None,
        })
        for number, (exercise_id, weight, reps, done) in enumerate(sets, start=1):
            self.tables["workout_sets"].append({
                "id": str(uuid4()), "workout_id": workout_id, "exercise_id": exercise_id, "exercise_order": 0,
                "set_number": number, "weight": weight, "reps": reps, "is_done": done,
                "duration_seconds": None, "distance_km": None,
            })
        return workout_id

    def make_meal(self, user_id, consumed_at):
        self.tables["meals"].append(
            {"id": str(uuid4()), "user_id": user_id, "consumed_at": consumed_at.isoformat(), "calories": 500})


def catalog_exercise(index=0):
    exercise = load_cached_exercises()[index]
    return supabase_uuid_for(exercise), exercise.name
