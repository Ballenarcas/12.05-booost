"""Community routes. Every route needs a session except /media, which needs a signed link."""

import hashlib
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Literal, TypeVar
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from pydantic import ValidationError

from app.core.auth import current_user
from app.core.local_day import LocalDay, local_day
from app.facades import social_facade as errors
from app.facades.social_facade import social_facade
from app.schemas.social import (
    Attachables,
    AuthorOut,
    CardRef,
    CommentCreate,
    CommentOut,
    FeedPage,
    JoinRequest,
    MeOut,
    MeUpdate,
    PostOut,
    ProfileOut,
)
from app.services.image_service import ImageTooLarge, InvalidImage, read_upload

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/social", tags=["social"])
Result = TypeVar("Result")


def _run(action: Callable[[], Result]) -> Result:
    try:
        return action()
    except errors.NotFound as error:
        raise HTTPException(status_code=404, detail="Not found.") from error
    except errors.NotJoined as error:
        raise HTTPException(status_code=403, detail="Join the Community first.") from error
    except errors.UsernameTaken as error:
        raise HTTPException(status_code=409, detail="That username is taken.") from error
    except errors.LimitReached as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except errors.InvalidCard as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except errors.Unavailable as error:
        raise HTTPException(status_code=503, detail="The Community is not available right now.") from error
    except ImageTooLarge as error:
        raise HTTPException(status_code=413, detail="That photo is too large. Use one under 8 MB.") from error
    except InvalidImage as error:
        raise HTTPException(status_code=415, detail="Use a JPEG, PNG, or WebP photo.") from error
    except ValidationError as error:  # before ValueError, which it subclasses
        raise HTTPException(status_code=422, detail="That card is not valid.") from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (HTTPException, httpx.HTTPError):
        raise  # main.py answers connection problems with 503
    except Exception as error:
        # A fixed message: post text, photos and links stay out of our log line.
        logger.exception("Community request failed")
        raise HTTPException(status_code=502, detail="Something went wrong. Try again.") from error


# --- me ---

@router.get("/me", response_model=MeOut)
def read_me(response: Response, user_id: UUID = Depends(current_user)) -> MeOut:
    result, timing = _run(lambda: social_facade.me_timed(str(user_id)))
    if timing:
        response.headers["Server-Timing"] = timing
    return result


@router.post("/me/join", response_model=MeOut)
def join_community(payload: JoinRequest, user_id: UUID = Depends(current_user)) -> MeOut:
    return _run(lambda: social_facade.join(str(user_id), payload.username, payload.is_private))


@router.patch("/me", response_model=MeOut)
def update_me(payload: MeUpdate, user_id: UUID = Depends(current_user)) -> MeOut:
    return _run(lambda: social_facade.update_me(str(user_id), payload.username, payload.is_private))


@router.put("/me/avatar", response_model=MeOut)
def upload_avatar(file: UploadFile = File(...), user_id: UUID = Depends(current_user)) -> MeOut:
    return _run(lambda: social_facade.set_avatar(str(user_id), read_upload(file)))


@router.delete("/me/avatar", response_model=MeOut)
def delete_avatar(user_id: UUID = Depends(current_user)) -> MeOut:
    return _run(lambda: social_facade.remove_avatar(str(user_id)))


# --- feed and posts ---

@router.get("/feed", response_model=FeedPage)
def read_feed(
    response: Response,
    mode: Literal["following", "discover"] = "discover",
    before: datetime | None = Query(None),
    limit: int = Query(errors.PAGE_POSTS, ge=1, le=errors.PAGE_POSTS),
    user_id: UUID = Depends(current_user),
) -> FeedPage:
    result, timing = _run(lambda: social_facade.feed_timed(str(user_id), mode, before, limit))
    if timing:
        response.headers["Server-Timing"] = timing
    return result


@router.get("/attachables", response_model=Attachables)
def read_attachables(user_id: UUID = Depends(current_user), day: LocalDay = Depends(local_day)) -> Attachables:
    return _run(lambda: social_facade.attachables(str(user_id), day))


@router.post("/posts", response_model=PostOut, status_code=201)
def create_post(
    body: str = Form("", max_length=2000),
    card: str | None = Form(None, max_length=500),
    images: list[UploadFile] = File(default=[]),
    user_id: UUID = Depends(current_user),
    day: LocalDay = Depends(local_day),
) -> PostOut:
    def create() -> PostOut:
        if len(images) > errors.MAX_PHOTOS:
            raise ValueError("A post can have up to 4 photos.")
        reference = CardRef.model_validate_json(card) if card else None
        return social_facade.create_post(str(user_id), day, body, reference, [read_upload(image) for image in images])

    return _run(create)


@router.get("/posts/{post_id}", response_model=PostOut)
def read_post(post_id: UUID, user_id: UUID = Depends(current_user)) -> PostOut:
    return _run(lambda: social_facade.post(str(user_id), str(post_id)))


@router.delete("/posts/{post_id}", status_code=204)
def delete_post(post_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.delete_post(str(user_id), str(post_id)))


@router.put("/posts/{post_id}/like", response_model=PostOut)
def like_post(post_id: UUID, user_id: UUID = Depends(current_user)) -> PostOut:
    return _run(lambda: social_facade.set_like(str(user_id), str(post_id), True))


@router.delete("/posts/{post_id}/like", response_model=PostOut)
def unlike_post(post_id: UUID, user_id: UUID = Depends(current_user)) -> PostOut:
    return _run(lambda: social_facade.set_like(str(user_id), str(post_id), False))


@router.get("/posts/{post_id}/comments", response_model=list[CommentOut])
def read_comments(post_id: UUID, user_id: UUID = Depends(current_user)) -> list[CommentOut]:
    return _run(lambda: social_facade.comments(str(user_id), str(post_id)))


@router.post("/posts/{post_id}/comments", response_model=CommentOut, status_code=201)
def create_comment(post_id: UUID, payload: CommentCreate, user_id: UUID = Depends(current_user)) -> CommentOut:
    return _run(lambda: social_facade.add_comment(str(user_id), str(post_id), payload.body))


@router.delete("/comments/{comment_id}", status_code=204)
def delete_comment(comment_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.delete_comment(str(user_id), str(comment_id)))


# --- members ---

@router.get("/users", response_model=list[AuthorOut])
def search_members(q: str = Query(..., max_length=80), user_id: UUID = Depends(current_user)) -> list[AuthorOut]:
    return _run(lambda: social_facade.search(str(user_id), q))


@router.get("/users/{username}", response_model=ProfileOut)
def read_profile(username: str, user_id: UUID = Depends(current_user)) -> ProfileOut:
    return _run(lambda: social_facade.profile(str(user_id), username))


@router.get("/users/{username}/posts", response_model=FeedPage)
def read_member_posts(
    username: str, before: datetime | None = Query(None), user_id: UUID = Depends(current_user),
) -> FeedPage:
    return _run(lambda: social_facade.user_posts(str(user_id), username, before))


@router.get("/users/{username}/followers", response_model=list[AuthorOut])
def read_followers(username: str, user_id: UUID = Depends(current_user)) -> list[AuthorOut]:
    return _run(lambda: social_facade.follow_list(str(user_id), username, "followers"))


@router.get("/users/{username}/following", response_model=list[AuthorOut])
def read_following(username: str, user_id: UUID = Depends(current_user)) -> list[AuthorOut]:
    return _run(lambda: social_facade.follow_list(str(user_id), username, "following"))


# --- follows ---

@router.put("/users/{target_id}/follow", response_model=ProfileOut)
def follow_member(target_id: UUID, user_id: UUID = Depends(current_user)) -> ProfileOut:
    return _run(lambda: social_facade.follow(str(user_id), str(target_id)))


@router.delete("/users/{target_id}/follow", status_code=204)
def unfollow_member(target_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.unfollow(str(user_id), str(target_id)))


@router.delete("/followers/{follower_id}", status_code=204)
def remove_follower(follower_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.remove_follower(str(user_id), str(follower_id)))


@router.get("/follow-requests", response_model=list[AuthorOut])
def read_follow_requests(user_id: UUID = Depends(current_user)) -> list[AuthorOut]:
    return _run(lambda: social_facade.follow_requests(str(user_id)))


@router.post("/follow-requests/{requester_id}/accept", status_code=204)
def accept_follow_request(requester_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.accept_request(str(user_id), str(requester_id)))


@router.delete("/follow-requests/{requester_id}", status_code=204)
def decline_follow_request(requester_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.decline_request(str(user_id), str(requester_id)))


# --- blocks ---

@router.put("/users/{target_id}/block", status_code=204)
def block_member(target_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.block(str(user_id), str(target_id)))


@router.delete("/users/{target_id}/block", status_code=204)
def unblock_member(target_id: UUID, user_id: UUID = Depends(current_user)) -> None:
    _run(lambda: social_facade.unblock(str(user_id), str(target_id)))


@router.get("/blocks", response_model=list[AuthorOut])
def read_blocks(user_id: UUID = Depends(current_user)) -> list[AuthorOut]:
    return _run(lambda: social_facade.blocks(str(user_id)))


# --- media ---

@router.get("/media/{token}")
def read_media(token: str, request: Request) -> Response:
    etag = f'"{hashlib.sha256(token.encode("utf-8")).hexdigest()[:20]}"'
    headers = {
        "Cache-Control": "private, max-age=3600, immutable",
        "ETag": etag,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    data = _run(lambda: social_facade.media(token))
    return Response(data, media_type="image/webp", headers=headers)
