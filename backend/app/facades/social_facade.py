"""Community use cases. The only layer that writes to the database or to Storage.

Rule for every read or write that touches someone else's content: load the viewer's
context once, then ask ``can_view``. Anything the viewer may not see is "not found".
"""

import logging
from datetime import date, datetime, timedelta, timezone
from threading import Lock
from typing import Any
from uuid import uuid4

from app.core import media_token
from app.core.local_day import LocalDay
from app.db.supabase_client import get_storage, get_supabase
from app.schemas.social import (
    Attachables,
    AuthorOut,
    CardRef,
    CommentOut,
    FeedPage,
    MeOut,
    PostOut,
    ProfileOut,
    PrOption,
    WorkoutOption,
)
from app.services import social_service as rules
from app.services.exercise_catalog import exercise_label
from app.services.image_service import reencode

logger = logging.getLogger(__name__)

POSTS, LIKES, COMMENTS = "social_posts", "social_post_likes", "social_comments"
FOLLOWS, BLOCKS = "social_follows", "social_blocks"
AVATARS, PHOTOS = "avatars", "post-images"
POSTS_PER_DAY = 30
COMMENTS_PER_DAY = 200
FOLLOWS_PER_DAY = 100
PHOTOS_PER_DAY = 150
LIMIT_WINDOW = timedelta(hours=24)
USERNAME_COOLDOWN = timedelta(days=30)
PAGE_POSTS = 20
MAX_COMMENTS = 50
MAX_SEARCH = 20
MAX_LIST = 50
MAX_BLOCKS_SHOWN = 200
MAX_PHOTOS = 4
MAX_ATTACHABLE_WORKOUTS = 10
PREVIEW_MEMBERS = 4
POST_PHOTO_SIDE = 1080
PREVIEW_ROWS = 12  # a few spare rows for blocked or departed members
POST_COLUMNS = "id,user_id,body,image_paths,card_type,card,like_count,comment_count,created_at"


class NotFound(Exception):
    pass


class NotJoined(Exception):
    pass


class UsernameTaken(Exception):
    pass


class LimitReached(Exception):
    pass


class InvalidCard(Exception):
    pass


class Unavailable(Exception):
    pass


def _session() -> Any:
    session = get_supabase(admin=True)
    if session is None:
        raise Unavailable()
    return session


def _storage() -> Any:
    storage = get_storage()
    if storage is None:
        raise Unavailable()
    return storage


def _now() -> datetime:
    return datetime.now(timezone.utc)


# Decoding a large photo costs real memory and CPU, so attempts are counted, not just successes.
# shortcut: counts live in this process, so a restart resets them and each worker keeps its own.
# Move them to the database before raising WEB_CONCURRENCY above 1.
_processed: dict[str, tuple[date, int]] = {}
_processed_lock = Lock()


def _use_photo_quota(user_id: str, photos: int) -> None:
    if not photos:
        return
    today = _now().date()
    with _processed_lock:
        day, count = _processed.get(user_id, (today, 0))
        count = count if day == today else 0
        if count + photos > PHOTOS_PER_DAY:
            raise LimitReached("Daily limit reached. Try again tomorrow.")
        _processed[user_id] = (today, count + photos)


def _upload(bucket: str, path: str, data: bytes) -> None:
    _storage().from_(bucket).upload(path, data, {"content-type": "image/webp", "upsert": "false"})


def _remove_files(bucket: str, paths: list[str]) -> None:
    """Best effort: a leftover file is private and unreachable."""
    if not paths:
        return
    try:
        _storage().from_(bucket).remove(paths)
    except Exception:
        logger.exception("Could not delete stored files")


def _media_url(bucket: str, path: str) -> str:
    return f"/api/v1/social/media/{media_token.sign(bucket, path)}"


# --- reading users ---

def _user(session: Any, user_id: str) -> dict[str, Any] | None:
    rows = session.table("users").select(rules.AUTHOR_COLUMNS).eq("id", user_id).limit(1).execute().data or []
    return rows[0] if rows else None


def _authors(session: Any, user_ids: list[str]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for batch in rules.chunks(list(dict.fromkeys(str(value) for value in user_ids))):
        for row in session.table("users").select(rules.AUTHOR_COLUMNS).in_("id", batch).execute().data or []:
            found[str(row["id"])] = row
    return found


def _author_out(row: dict[str, Any]) -> AuthorOut:
    avatar = row.get("avatar_path")
    return AuthorOut(
        id=str(row["id"]),
        username=row.get("username") or "",
        name=rules.clean_label(f"{row.get('Name') or ''} {row.get('Surname') or ''}", 80),
        avatar_url=_media_url(AVATARS, avatar) if avatar else None,
        is_private=bool(row.get("is_private")),
    )


def _listed(session: Any, ctx: rules.ViewerContext, user_ids: list[str],
            authors: dict[str, dict[str, Any]] | None = None) -> list[AuthorOut]:
    """Members in the given order, without anyone blocked or not joined."""
    authors = _authors(session, user_ids) if authors is None else authors
    return [
        _author_out(authors[key]) for key in user_ids
        if key in authors and authors[key].get("username") and key not in ctx.blocked_ids
    ]


def _viewer(user_id: str, *extra: Any) -> tuple[Any, ...]:
    """The session, the viewer's row and context, plus any ``extra(session)`` reads, all in one wave.

    Returns ``(session, me, ctx, *extra_results)``.
    """
    session = _session()
    me, ctx, *rest = rules.together(
        lambda: _user(session, user_id),
        lambda: rules.load_context(session, user_id),
        *[lambda read=read: read(session) for read in extra],
    )
    if not me or not me.get("username"):
        raise NotJoined()
    return (session, me, ctx, *rest)


def _member_row(session: Any, column: str, value: str) -> dict[str, Any] | None:
    rows = session.table("users").select(rules.AUTHOR_COLUMNS).eq(column, value).limit(1).execute().data or []
    return rows[0] if rows else None


def _checked_member(ctx: rules.ViewerContext, row: dict[str, Any] | None) -> dict[str, Any]:
    """Another joined member the viewer is not blocked from or by."""
    if not row or not row.get("username") or str(row["id"]) in ctx.blocked_ids:
        raise NotFound()
    return row


def _member(session: Any, ctx: rules.ViewerContext, column: str, value: str) -> dict[str, Any]:
    return _checked_member(ctx, _member_row(session, column, value))


def _count(query: Any) -> int:
    return query.limit(1).execute().count or 0


def _follow_count(session: Any, column: str, user_id: str, status: str = "accepted") -> int:
    return _count(session.table(FOLLOWS).select(column, count="exact").eq(column, user_id).eq("status", status))


def _follow_row(session: Any, follower: str, followee: str) -> dict[str, Any] | None:
    rows = (session.table(FOLLOWS).select("status").eq("follower_id", follower)
            .eq("followee_id", followee).limit(1).execute().data or [])
    return rows[0] if rows else None


def _delete_follow(session: Any, follower: str, followee: str, status: str | None = None) -> None:
    query = session.table(FOLLOWS).delete().eq("follower_id", follower).eq("followee_id", followee)
    if status:
        query = query.eq("status", status)
    query.execute()


# --- posts ---

def _shown_card(card: dict[str, Any] | None) -> dict[str, Any] | None:
    if card and "exercise_name" in card:
        return {**card, "exercise_name": exercise_label(card["exercise_name"])}
    return card


def _liked(session: Any, viewer_id: str, post_ids: list[str]) -> set[str]:
    if not post_ids:
        return set()
    return {str(row["post_id"]) for row in session.table(LIKES).select("post_id").eq("user_id", viewer_id)
            .in_("post_id", post_ids).execute().data or []}


def _posts(session: Any, ctx: rules.ViewerContext, rows: list[dict[str, Any]],
           authors: dict[str, dict[str, Any]] | None = None, liked: set[str] | None = None) -> list[PostOut]:
    """Serializes posts, checking each one again: no image link is signed for a hidden post.

    Pass ``authors`` or ``liked`` when the caller already has them; the rest is read in one wave.
    """
    if not rows:
        return []
    ids = [str(row["id"]) for row in rows]
    authors, liked = rules.together(
        lambda: _authors(session, [row["user_id"] for row in rows]) if authors is None else authors,
        lambda: _liked(session, ctx.viewer_id, ids) if liked is None else liked,
    )
    return [
        PostOut(
            id=str(row["id"]),
            author=_author_out(authors[str(row["user_id"])]),
            body=row.get("body") or "",
            image_urls=[_media_url(PHOTOS, path) for path in row.get("image_paths") or []],
            card_type=row.get("card_type"),
            card=_shown_card(row.get("card")),
            like_count=max(0, row.get("like_count") or 0),
            comment_count=max(0, row.get("comment_count") or 0),
            liked_by_me=str(row["id"]) in liked,
            can_delete=str(row["user_id"]) == ctx.viewer_id,
            created_at=row["created_at"],
        )
        for row in rows if rules.can_view(ctx, authors.get(str(row["user_id"])))
    ]


def _post_query(session: Any, before: datetime | None) -> Any:
    query = session.table(POSTS).select(POST_COLUMNS)
    if before:
        before = before if before.tzinfo else before.replace(tzinfo=timezone.utc)
        query = query.lt("created_at", before.isoformat())
    return query.order("created_at", desc=True).limit(PAGE_POSTS + 1)


def _page(session: Any, ctx: rules.ViewerContext, rows: list[dict[str, Any]],
          authors: dict[str, dict[str, Any]] | None = None) -> FeedPage:
    # The cursor comes from the rows read, not the rows shown, so hidden posts never end the feed early.
    # shortcut: a created_at-only cursor can skip posts sharing a timestamp; add an id tiebreak if seen.
    shown = rows[:PAGE_POSTS]
    cursor = str(shown[-1]["created_at"]) if len(rows) > PAGE_POSTS else None
    return FeedPage(items=_posts(session, ctx, shown, authors), next_cursor=cursor)


def _post_row(session: Any, post_id: str) -> dict[str, Any] | None:
    rows = session.table(POSTS).select(POST_COLUMNS).eq("id", post_id).limit(1).execute().data or []
    return rows[0] if rows else None


def _visible(session: Any, ctx: rules.ViewerContext, row: dict[str, Any] | None, *extra: Any) -> tuple[Any, ...]:
    """Checks a post the viewer asked for; ``extra()`` reads run in the same wave as the author check.

    Returns ``(author, *extra_results)``. Raises NotFound when the post is hidden or missing.
    """
    if not row:
        raise NotFound()
    author, *rest = rules.together(lambda: _user(session, str(row["user_id"])), *extra)
    if not rules.can_view(ctx, author):
        raise NotFound()
    return (author, *rest)


def _card(session: Any, user_id: str, day: LocalDay, ref: CardRef | None) -> tuple[str | None, dict | None, str | None]:
    if ref is None:
        return None, None, None
    workout_id = str(ref.workout_id) if ref.workout_id else None
    try:
        if ref.type == "nutrition_streak":
            return ref.type, rules.streak_card(session, user_id, day), None
        if not workout_id or (ref.type == "pr" and not ref.exercise_id):
            raise InvalidCard("That card is not valid.")
        if ref.type == "workout":
            return ref.type, rules.workout_card(session, user_id, workout_id), workout_id
        return ref.type, rules.pr_card(session, user_id, workout_id, ref.exercise_id), workout_id
    except LookupError as error:
        raise NotFound() from error
    except ValueError as error:
        raise InvalidCard(str(error)) from error


def _forget_interactions(session: Any, owner: str, other: str) -> None:
    """Removes ``other``'s likes and comments from ``owner``'s posts."""
    post_ids = [str(row["id"]) for row in rules.paged(
        lambda: session.table(POSTS).select("id").eq("user_id", owner).order("id"))]
    for batch in rules.chunks(post_ids):
        for table in (LIKES, COMMENTS):
            session.table(table).delete().eq("user_id", other).in_("post_id", batch).execute()


class SocialFacade:
    def _used(self, session: Any, table: str, column: str, user_id: str) -> int:
        """Rows this user created in the last 24 hours."""
        since = (_now() - LIMIT_WINDOW).isoformat()
        return _count(session.table(table).select(column, count="exact").eq(column, user_id).gte("created_at", since))

    # --- me ---

    def me(self, user_id: str) -> MeOut:
        session = _session()
        row, ctx, followers, following, pending, followed = rules.together(
            lambda: _user(session, user_id),
            lambda: rules.load_context(session, user_id),
            lambda: _follow_count(session, "followee_id", user_id),
            lambda: _follow_count(session, "follower_id", user_id),
            lambda: _follow_count(session, "followee_id", user_id, "pending"),
            lambda: (session.table(FOLLOWS).select("followee_id").eq("follower_id", user_id)
                     .eq("status", "accepted").order("created_at", desc=True).limit(PREVIEW_ROWS)
                     .execute().data or []),
        )
        if not row:
            raise NotFound()
        author = _author_out(row)
        joined = bool(row.get("username"))
        preview = _listed(session, ctx, [str(item["followee_id"]) for item in followed])[:PREVIEW_MEMBERS]
        return MeOut(
            id=author.id,
            joined=joined,
            username=row.get("username"),
            name=author.name,
            is_private=author.is_private,
            avatar_url=author.avatar_url,
            followers=followers if joined else 0,
            following=following if joined else 0,
            pending_requests=pending if joined else 0,
            following_preview=preview if joined else [],
        )

    def _claim_username(self, session: Any, user_id: str, username: str, values: dict[str, Any]) -> None:
        taken = session.table("users").select("id").eq("username", username).limit(1).execute().data or []
        if taken and str(taken[0]["id"]) != user_id:
            raise UsernameTaken()
        try:
            session.table("users").update({**values, "username": username}).eq("id", user_id).execute()
        except Exception as error:
            if "23505" in str(error):  # someone claimed it a moment ago
                raise UsernameTaken() from error
            raise

    def join(self, user_id: str, username: str, is_private: bool) -> MeOut:
        session = _session()
        row = _user(session, user_id)
        if not row:
            raise NotFound()
        if row.get("username"):
            raise ValueError("You already joined the Community.")
        self._claim_username(session, user_id, rules.validate_username(username),
                             {"is_private": is_private, "community_joined_at": _now().isoformat()})
        return self.me(user_id)

    def update_me(self, user_id: str, username: str | None, is_private: bool | None) -> MeOut:
        session, row, _ = _viewer(user_id)
        values: dict[str, Any] = {} if is_private is None else {"is_private": is_private}
        new_name = rules.validate_username(username) if username is not None else None
        if new_name and new_name != row["username"]:
            stored = (session.table("users").select("username_changed_at").eq("id", user_id)
                      .limit(1).execute().data or [{}])[0].get("username_changed_at")
            if stored and _now() - datetime.fromisoformat(stored.replace("Z", "+00:00")) < USERNAME_COOLDOWN:
                raise LimitReached("You can change your username once every 30 days.")
            self._claim_username(session, user_id, new_name, {**values, "username_changed_at": _now().isoformat()})
        elif values:
            session.table("users").update(values).eq("id", user_id).execute()
        if is_private is False:
            session.table(FOLLOWS).update({"status": "accepted"}).eq("followee_id", user_id).eq(
                "status", "pending").execute()
        return self.me(user_id)

    def set_avatar(self, user_id: str, data: bytes) -> MeOut:
        session = _session()
        row = _user(session, user_id)
        if not row:
            raise NotFound()
        _use_photo_quota(user_id, 1)
        image = reencode(data, 512, square=True)
        path = f"{user_id}/{uuid4()}.webp"  # a new name each time, so no cache shows the old photo
        _upload(AVATARS, path, image)
        try:
            session.table("users").update({"avatar_path": path}).eq("id", user_id).execute()
        except Exception:
            _remove_files(AVATARS, [path])
            raise
        if row.get("avatar_path"):
            _remove_files(AVATARS, [row["avatar_path"]])
        return self.me(user_id)

    def remove_avatar(self, user_id: str) -> MeOut:
        session = _session()
        row = _user(session, user_id)
        if row and row.get("avatar_path"):
            session.table("users").update({"avatar_path": None}).eq("id", user_id).execute()
            _remove_files(AVATARS, [row["avatar_path"]])
        return self.me(user_id)

    # --- posts ---

    def attachables(self, user_id: str, day: LocalDay) -> Attachables:
        session, _, _, workouts, streak = _viewer(
            user_id,
            lambda s: (s.table("workouts").select("id,name,start_time,end_time").eq("user_id", user_id)
                       .not_.is_("end_time", "null").order("start_time", desc=True)
                       .limit(MAX_ATTACHABLE_WORKOUTS).execute().data or []),
            lambda s: rules.logging_streak(s, user_id, day),
        )
        records = rules.records_by_workout(session, user_id, workouts)
        return Attachables(
            workouts=[
                WorkoutOption(
                    workout_id=str(row["id"]),
                    name=rules.clean_label(row.get("name")) or "Workout",
                    completed_at=row["end_time"],
                    prs=[PrOption(**_shown_card(record)) for record in records.get(str(row["id"]), [])],
                )
                for row in workouts
            ],
            streak_days=streak,
            streak_to_share=rules.STREAK_TO_SHARE,
        )

    def create_post(self, user_id: str, day: LocalDay, body: str, card: CardRef | None,
                    images: list[bytes]) -> PostOut:
        # Order matters: check everything, insert, recount, and only then upload.
        session, me, ctx = _viewer(user_id)
        if self._used(session, POSTS, "user_id", user_id) >= POSTS_PER_DAY:
            raise LimitReached("Daily limit reached. Try again tomorrow.")
        text = rules.normalize_text(body)
        if len(images) > MAX_PHOTOS:
            raise ValueError("A post can have up to 4 photos.")
        card_type, card_data, workout_id = _card(session, user_id, day, card)
        if not (text or images or card_data):
            raise ValueError("Write something, add a photo or attach a card.")
        _use_photo_quota(user_id, len(images))
        # 1080 px stays sharp on a phone at 2x and is about half the bytes of 1600 px.
        encoded = [reencode(image, POST_PHOTO_SIDE) for image in images]

        post_id = str(uuid4())
        paths = [f"{user_id}/{post_id}/{number}.webp" for number in range(len(encoded))]
        row = session.table(POSTS).insert({
            "id": post_id, "user_id": user_id, "body": text, "image_paths": paths,
            "card_type": card_type, "card": card_data, "workout_id": workout_id,
            "author_private": bool(me.get("is_private")),
        }).execute().data[0]
        try:
            if self._used(session, POSTS, "user_id", user_id) > POSTS_PER_DAY:
                raise LimitReached("Daily limit reached. Try again tomorrow.")
            for path, image in zip(paths, encoded):
                _upload(PHOTOS, path, image)
        except Exception:
            session.table(POSTS).delete().eq("id", post_id).execute()
            _remove_files(PHOTOS, paths)
            raise
        return _posts(session, ctx, [row])[0]

    def feed(self, user_id: str, mode: str, before: datetime | None) -> FeedPage:
        if mode != "following":
            # Discover rows don't depend on who asks, so they are read with the viewer's context.
            # Blocked authors are dropped when serializing, which keeps them out of the query string.
            session, _, ctx, rows = _viewer(
                user_id, lambda s: _post_query(s, before).eq("author_private", False).execute().data or [])
            return _page(session, ctx, rows)
        session, _, ctx = _viewer(user_id)
        # In batches so the query string stays short; the newest of all batches win.
        batches = rules.together(*[
            lambda batch=batch: _post_query(session, before).in_("user_id", batch).execute().data or []
            for batch in rules.chunks([user_id, *sorted(ctx.following_ids)])
        ])
        rows = [row for batch in batches for row in batch]
        rows.sort(key=lambda row: datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00")), reverse=True)
        return _page(session, ctx, rows[:PAGE_POSTS + 1])

    def post(self, user_id: str, post_id: str) -> PostOut:
        session, _, ctx, row = _viewer(user_id, lambda s: _post_row(s, post_id))
        author, liked = _visible(session, ctx, row, lambda: _liked(session, user_id, [post_id]))
        return _posts(session, ctx, [row], {str(author["id"]): author}, liked)[0]

    def delete_post(self, user_id: str, post_id: str) -> None:
        session, _, _ = _viewer(user_id)
        rows = (session.table(POSTS).select("image_paths").eq("id", post_id).eq("user_id", user_id)
                .limit(1).execute().data or [])
        if not rows:
            raise NotFound()
        session.table(POSTS).delete().eq("id", post_id).eq("user_id", user_id).execute()
        _remove_files(PHOTOS, rows[0].get("image_paths") or [])

    def set_like(self, user_id: str, post_id: str, liked: bool) -> PostOut:
        session, _, ctx, row = _viewer(user_id, lambda s: _post_row(s, post_id))
        author, = _visible(session, ctx, row)
        if liked:
            session.table(LIKES).upsert({"post_id": post_id, "user_id": user_id},
                                        on_conflict="post_id,user_id", ignore_duplicates=True).execute()
        else:
            session.table(LIKES).delete().eq("post_id", post_id).eq("user_id", user_id).execute()
        # Read again for the new count; whether it is liked is what was just written.
        row = _post_row(session, post_id) or row
        return _posts(session, ctx, [row], {str(author["id"]): author}, {post_id} if liked else set())[0]

    # --- comments ---

    def comments(self, user_id: str, post_id: str) -> list[CommentOut]:
        # The comments are read with the post, but only returned once the post is known to be visible.
        session, _, ctx, post, rows = _viewer(
            user_id,
            lambda s: _post_row(s, post_id),
            lambda s: (s.table(COMMENTS).select("id,user_id,body,created_at").eq("post_id", post_id)
                       .order("created_at", desc=True).limit(MAX_COMMENTS).execute().data or [])[::-1],
        )
        commenters = [str(row["user_id"]) for row in rows]
        _, people = _visible(session, ctx, post, lambda: _authors(session, commenters))
        authors = {author.id: author for author in _listed(session, ctx, commenters, people)}
        owns_post = str(post["user_id"]) == user_id
        return [
            CommentOut(id=str(row["id"]), author=authors[str(row["user_id"])], body=row["body"],
                       can_delete=owns_post or str(row["user_id"]) == user_id, created_at=row["created_at"])
            for row in rows if str(row["user_id"]) in authors
        ]

    def add_comment(self, user_id: str, post_id: str, body: str) -> CommentOut:
        session, me, ctx, post, used = _viewer(
            user_id, lambda s: _post_row(s, post_id), lambda s: self._used(s, COMMENTS, "user_id", user_id))
        _visible(session, ctx, post)
        if used >= COMMENTS_PER_DAY:
            raise LimitReached("Daily limit reached. Try again tomorrow.")
        text = rules.normalize_text(body)
        if not text:
            raise ValueError("Write a comment first.")
        row = session.table(COMMENTS).insert({"post_id": post_id, "user_id": user_id, "body": text}).execute().data[0]
        if self._used(session, COMMENTS, "user_id", user_id) > COMMENTS_PER_DAY:
            session.table(COMMENTS).delete().eq("id", row["id"]).execute()
            raise LimitReached("Daily limit reached. Try again tomorrow.")
        return CommentOut(id=str(row["id"]), author=_author_out(me), body=text, can_delete=True,
                          created_at=row["created_at"])

    def delete_comment(self, user_id: str, comment_id: str) -> None:
        session, _, _ = _viewer(user_id)
        rows = session.table(COMMENTS).select("post_id,user_id").eq("id", comment_id).limit(1).execute().data or []
        if not rows:
            raise NotFound()
        if str(rows[0]["user_id"]) != user_id:
            owned = (session.table(POSTS).select("id").eq("id", rows[0]["post_id"]).eq("user_id", user_id)
                     .limit(1).execute().data or [])
            if not owned:
                raise NotFound()
        session.table(COMMENTS).delete().eq("id", comment_id).execute()

    # --- members ---

    def search(self, user_id: str, query: str) -> list[AuthorOut]:
        term = rules.search_term(query).replace("_", "\\_")  # "_" is a LIKE wildcard
        _, _, ctx, rows = _viewer(
            user_id,
            lambda s: (s.table("users").select(rules.AUTHOR_COLUMNS).not_.is_("username", "null")
                       .ilike("search_text", f"%{term}%").neq("id", user_id).order("username")
                       .limit(MAX_SEARCH).execute().data or []),
        )
        return [_author_out(row) for row in rows if str(row["id"]) not in ctx.blocked_ids]

    def _profile(self, session: Any, ctx: rules.ViewerContext, row: dict[str, Any]) -> ProfileOut:
        target = str(row["id"])
        mine, theirs, followers, following = rules.together(
            lambda: _follow_row(session, ctx.viewer_id, target),
            lambda: _follow_row(session, target, ctx.viewer_id),
            lambda: _follow_count(session, "followee_id", target),
            lambda: _follow_count(session, "follower_id", target),
        )
        state = "none" if not mine else "following" if mine["status"] == "accepted" else "pending"
        return ProfileOut(
            user=_author_out(row),
            followers=followers,
            following=following,
            posts_visible=rules.can_view(ctx, row),
            follow_state=state,
            follows_you=bool(theirs and theirs["status"] == "accepted"),
            is_me=target == ctx.viewer_id,
        )

    def profile(self, user_id: str, username: str) -> ProfileOut:
        session, _, ctx, row = _viewer(user_id, lambda s: _member_row(s, "username", username.lower()))
        return self._profile(session, ctx, _checked_member(ctx, row))

    def _readable_member(self, user_id: str, username: str) -> tuple[Any, rules.ViewerContext, dict[str, Any]]:
        session, _, ctx, row = _viewer(user_id, lambda s: _member_row(s, "username", username.lower()))
        row = _checked_member(ctx, row)
        if not rules.can_view(ctx, row):
            raise NotFound()
        return session, ctx, row

    def user_posts(self, user_id: str, username: str, before: datetime | None) -> FeedPage:
        session, ctx, member = self._readable_member(user_id, username)
        rows = _post_query(session, before).eq("user_id", str(member["id"])).execute().data or []
        return _page(session, ctx, rows, {str(member["id"]): member})

    def follow_list(self, user_id: str, username: str, kind: str) -> list[AuthorOut]:
        session, ctx, member = self._readable_member(user_id, username)
        mine, theirs = ("followee_id", "follower_id") if kind == "followers" else ("follower_id", "followee_id")
        rows = (session.table(FOLLOWS).select(theirs).eq(mine, str(member["id"])).eq("status", "accepted")
                .order("created_at", desc=True).limit(MAX_LIST).execute().data or [])
        return _listed(session, ctx, [str(row[theirs]) for row in rows])

    # --- follows ---

    def follow(self, user_id: str, target_id: str) -> ProfileOut:
        session, _, ctx = _viewer(user_id)
        if target_id == user_id:
            raise ValueError("You cannot follow yourself.")
        target = _member(session, ctx, "id", target_id)
        if not _follow_row(session, user_id, target_id):
            total = _count(session.table(FOLLOWS).select("follower_id", count="exact").eq("follower_id", user_id))
            if total >= rules.MAX_FOLLOWING:
                raise ValueError("You follow too many people. Unfollow someone first.")
            # shortcut: counts follows that still exist, so unfollowing frees the quota.
            if self._used(session, FOLLOWS, "follower_id", user_id) >= FOLLOWS_PER_DAY:
                raise LimitReached("Daily limit reached. Try again tomorrow.")
            status = "pending" if target.get("is_private") else "accepted"
            session.table(FOLLOWS).upsert(
                {"follower_id": user_id, "followee_id": target_id, "status": status},
                on_conflict="follower_id,followee_id", ignore_duplicates=True).execute()
            if self._used(session, FOLLOWS, "follower_id", user_id) > FOLLOWS_PER_DAY:
                _delete_follow(session, user_id, target_id)
                raise LimitReached("Daily limit reached. Try again tomorrow.")
            if status == "accepted":
                ctx.following_ids.add(target_id)
        return self._profile(session, ctx, target)

    def unfollow(self, user_id: str, target_id: str) -> None:
        session, _, _ = _viewer(user_id)
        _delete_follow(session, user_id, target_id)

    def remove_follower(self, user_id: str, follower_id: str) -> None:
        session, _, _ = _viewer(user_id)
        _delete_follow(session, follower_id, user_id)

    def follow_requests(self, user_id: str) -> list[AuthorOut]:
        session, _, ctx = _viewer(user_id)
        rows = (session.table(FOLLOWS).select("follower_id").eq("followee_id", user_id).eq("status", "pending")
                .order("created_at", desc=True).limit(MAX_LIST).execute().data or [])
        return _listed(session, ctx, [str(row["follower_id"]) for row in rows])

    def accept_request(self, user_id: str, requester_id: str) -> None:
        session, _, ctx = _viewer(user_id)
        _member(session, ctx, "id", requester_id)
        updated = (session.table(FOLLOWS).update({"status": "accepted"}).eq("follower_id", requester_id)
                   .eq("followee_id", user_id).eq("status", "pending").execute().data)
        if not updated:
            raise NotFound()

    def decline_request(self, user_id: str, requester_id: str) -> None:
        session, _, _ = _viewer(user_id)
        _delete_follow(session, requester_id, user_id, "pending")

    # --- blocks ---

    def block(self, user_id: str, target_id: str) -> None:
        session, _, _ = _viewer(user_id)
        if target_id == user_id:
            raise ValueError("You cannot block yourself.")
        # Not ``_member``: you may block someone who already blocked you.
        target = _user(session, target_id)
        if not target or not target.get("username"):
            raise NotFound()
        total = _count(session.table(BLOCKS).select("blocker_id", count="exact").eq("blocker_id", user_id))
        if total >= rules.MAX_BLOCKS:
            raise ValueError("You have blocked too many people.")
        # The block goes in first, so access is cut before the clean-up runs.
        session.table(BLOCKS).upsert({"blocker_id": user_id, "blocked_id": target_id},
                                     on_conflict="blocker_id,blocked_id", ignore_duplicates=True).execute()
        _delete_follow(session, user_id, target_id)
        _delete_follow(session, target_id, user_id)
        _forget_interactions(session, user_id, target_id)
        _forget_interactions(session, target_id, user_id)

    def unblock(self, user_id: str, target_id: str) -> None:
        session, _, _ = _viewer(user_id)
        session.table(BLOCKS).delete().eq("blocker_id", user_id).eq("blocked_id", target_id).execute()

    def blocks(self, user_id: str) -> list[AuthorOut]:
        session, _, _ = _viewer(user_id)
        rows = (session.table(BLOCKS).select("blocked_id").eq("blocker_id", user_id)
                .order("created_at", desc=True).limit(MAX_BLOCKS_SHOWN).execute().data or [])
        authors = _authors(session, [str(row["blocked_id"]) for row in rows])
        return [_author_out(authors[str(row["blocked_id"])]) for row in rows
                if str(row["blocked_id"]) in authors and authors[str(row["blocked_id"])].get("username")]

    # --- media ---

    def media(self, token: str) -> bytes:
        found = media_token.verify(token)
        if not found:
            raise NotFound()
        storage = _storage()
        try:
            return storage.from_(found[0]).download(found[1])
        except Exception as error:
            raise NotFound() from error


social_facade = SocialFacade()
